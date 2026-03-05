'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

// NEW: Alibaba POP Core for CreateToken
const { RPCClient } = require('@alicloud/pop-core');

const app = express();
const server = createServer(app);

// ---- Config (ENV ONLY) ----
const PORT = process.env.PORT || 8080;

// Alibaba NLS
const ALIBABA_APPKEY = process.env.ALIBABA_APPKEY;

// Prefer permanent credentials:
const ALIBABA_ACCESS_KEY_ID = process.env.ALIBABA_ACCESS_KEY_ID;
const ALIBABA_ACCESS_KEY_SECRET = process.env.ALIBABA_ACCESS_KEY_SECRET;

// Optional fallback (still supported) — but expires:
const ALIBABA_TOKEN_FALLBACK = process.env.ALIBABA_TOKEN;

// DeepSeek
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Alibaba websocket gateway (Singapore — keep since you said it works)
const ALIBABA_WS_BASE = 'wss://nls-gateway-ap-southeast-1.aliyuncs.com/ws/v1';

// Token service endpoint (CreateToken)
// Alibaba docs show nls-meta.cn-shanghai.aliyuncs.com for CreateToken.  [oai_citation:2‡static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com](https://static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com/download%2Fpdf%2F70465%2F%25E5%25BC%2580%25E5%258F%2591%25E6%258C%2587%25E5%258D%2597_cn_zh-CN.pdf)
const ALIBABA_TOKEN_ENDPOINT = 'http://nls-meta.cn-shanghai.aliyuncs.com';
const ALIBABA_TOKEN_API_VERSION = '2019-02-28';

function requireEnv(name, val) {
  if (!val) throw new Error(`[Startup] Missing env var: ${name}`);
}

requireEnv('ALIBABA_APPKEY', ALIBABA_APPKEY);
requireEnv('DEEPSEEK_API_KEY', DEEPSEEK_API_KEY);

// We require either permanent AKs OR a fallback token.
if (!(ALIBABA_ACCESS_KEY_ID && ALIBABA_ACCESS_KEY_SECRET) && !ALIBABA_TOKEN_FALLBACK) {
  throw new Error(
    '[Startup] Missing Alibaba auth. Provide (ALIBABA_ACCESS_KEY_ID + ALIBABA_ACCESS_KEY_SECRET) ' +
    'for auto-refresh tokens, OR provide ALIBABA_TOKEN (temporary).'
  );
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeJsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// --- Health endpoint (helps debugging on Railway) ---
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    hasAppKey: !!ALIBABA_APPKEY,
    hasAccessKeys: !!(ALIBABA_ACCESS_KEY_ID && ALIBABA_ACCESS_KEY_SECRET),
    hasFallbackToken: !!ALIBABA_TOKEN_FALLBACK,
    wsBase: ALIBABA_WS_BASE,
  });
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on ${PORT}`);
});

// WebSocket server on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

async function translateWithDeepSeek(cn) {
  const system = [
    'You are the official translator for True Buddha School (TBS). Translate Chinese to English.',
    'Rules:',
    '1) Output ONLY the English translation, nothing else.',
    '2) Key terms: 蓮生活佛=Living Buddha Lian-sheng, 師尊=Grand Master, 真佛宗=True Buddha School, 法王=Dharma King.',
    '3) Keep proper nouns unchanged.',
  ].join('\n');

  const resp = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: cn },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const out = resp.data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('DeepSeek returned empty response');
  return out;
}

/**
 * ----------------------------
 * Alibaba Token Auto-Refresh
 * ----------------------------
 * We keep a cached token and refresh when it’s near expiry.
 * CreateToken is called using AccessKeyId/Secret.
 * Endpoint + API version match Alibaba docs.  [oai_citation:3‡static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com](https://static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com/download%2Fpdf%2F70465%2F%25E5%25BC%2580%25E5%258F%2591%25E6%258C%2587%25E5%258D%2597_cn_zh-CN.pdf)
 */
let cachedAlibabaToken = null;
let cachedAlibabaTokenExpireAt = 0; // epoch ms

function tokenLooksValid() {
  // Refresh if token expires within the next 5 minutes.
  return cachedAlibabaToken && Date.now() < (cachedAlibabaTokenExpireAt - 5 * 60 * 1000);
}

async function fetchAlibabaTokenWithAccessKeys() {
  const client = new RPCClient({
    accessKeyId: ALIBABA_ACCESS_KEY_ID,
    accessKeySecret: ALIBABA_ACCESS_KEY_SECRET,
    endpoint: ALIBABA_TOKEN_ENDPOINT,
    apiVersion: ALIBABA_TOKEN_API_VERSION,
  });

  // Docs show: client.request('CreateToken') returns { Token, ExpireTime, ... }  [oai_citation:4‡static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com](https://static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com/download%2Fpdf%2F70465%2F%25E5%25BC%2580%25E5%258F%2591%25E6%258C%2587%25E5%258D%2597_cn_zh-CN.pdf)
  const result = await client.request('CreateToken');

  const token = result?.Token || result?.token;
  if (!token) {
    throw new Error(`CreateToken returned no Token. Raw result keys: ${Object.keys(result || {}).join(',')}`);
  }

  // ExpireTime sometimes comes as seconds since epoch, or a string.
  // If we can’t parse it reliably, assume 23 hours validity.
  let expireAtMs = 0;
  const expireTime = result?.ExpireTime || result?.expireTime || result?.ExpireTimeSec;

  if (expireTime) {
    const n = Number(expireTime);
    if (Number.isFinite(n) && n > 1e10) {
      // likely ms epoch
      expireAtMs = n;
    } else if (Number.isFinite(n) && n > 1e9) {
      // likely seconds epoch
      expireAtMs = n * 1000;
    } else {
      // unknown format
      expireAtMs = Date.now() + 23 * 60 * 60 * 1000;
    }
  } else {
    expireAtMs = Date.now() + 23 * 60 * 60 * 1000;
  }

  cachedAlibabaToken = token;
  cachedAlibabaTokenExpireAt = expireAtMs;

  console.log('[AlibabaToken] Refreshed token. Expires at:', new Date(expireAtMs).toISOString());
  return token;
}

async function getAlibabaToken() {
  if (ALIBABA_ACCESS_KEY_ID && ALIBABA_ACCESS_KEY_SECRET) {
    if (tokenLooksValid()) return cachedAlibabaToken;
    return await fetchAlibabaTokenWithAccessKeys();
  }

  // fallback (temporary token supplied by you)
  if (ALIBABA_TOKEN_FALLBACK) return ALIBABA_TOKEN_FALLBACK;

  throw new Error('No Alibaba token available');
}

// Optional: background refresh loop when using AKs (keeps system warm)
if (ALIBABA_ACCESS_KEY_ID && ALIBABA_ACCESS_KEY_SECRET) {
  // refresh every 2 hours if needed
  setInterval(() => {
    getAlibabaToken().catch((e) => console.error('[AlibabaToken] Refresh loop error:', e?.message || e));
  }, 2 * 60 * 60 * 1000);
}

wss.on('connection', (clientWs, req) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;

  // Buffer audio until Alibaba is ready
  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 2; // ~2 seconds PCM16 mono 16k

  let hasSeenAnyAudio = false;
  let lastAudioAt = 0;

  const taskId = newId();

  function closeAlibaba() {
    if (alibabaWs && alibabaWs.readyState === WebSocket.OPEN) {
      try {
        const stop = {
          header: {
            message_id: newId(),
            task_id: taskId,
            namespace: 'SpeechTranscriber',
            name: 'StopTranscriber',
            appkey: ALIBABA_APPKEY,
          },
          payload: {},
        };
        alibabaWs.send(JSON.stringify(stop));
      } catch (_) {}
    }
    try { alibabaWs?.close(); } catch (_) {}
    alibabaWs = null;
    alibabaReady = false;
  }

  async function connectAlibabaIfNeeded() {
    if (alibabaWs) return;

    let token;
    try {
      token = await getAlibabaToken();
    } catch (e) {
      console.error('[AlibabaToken] Unable to get token:', e?.message || e);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba token missing/invalid' });
      return;
    }

    const url = `${ALIBABA_WS_BASE}?token=${encodeURIComponent(token)}`;
    console.log('[Alibaba] Connecting:', url.replace(token, '***TOKEN***'));

    alibabaWs = new WebSocket(url);

    alibabaWs.on('open', () => {
      console.log('[Alibaba] WS open');

      const start = {
        header: {
          message_id: newId(),
          task_id: taskId,
          namespace: 'SpeechTranscriber',
          name: 'StartTranscriber',
          appkey: ALIBABA_APPKEY,
        },
        payload: {
          format: 'pcm',
          sample_rate: 16000,
          enable_intermediate_result: true,
          enable_punctuation_prediction: true,
          enable_inverse_text_normalization: true,
        },
      };

      alibabaWs.send(JSON.stringify(start));
    });

    alibabaWs.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.log('[Alibaba] Non-JSON message:', data.toString().slice(0, 200));
        return;
      }

      const eventName = msg?.header?.name;

      if (eventName === 'TranscriptionStarted') {
        alibabaReady = true;
        console.log('[Alibaba] Ready. Flushing buffered audio:', bufferedBytes, 'bytes');

        safeJsonSend(clientWs, { type: 'status', status: 'ready' });

        // Flush buffered audio immediately
        while (audioBufferQueue.length) {
          const chunk = audioBufferQueue.shift();
          bufferedBytes -= chunk.length;
          if (alibabaWs.readyState === WebSocket.OPEN) {
            alibabaWs.send(chunk);
          }
        }
      }

      if (eventName === 'TranscriptionResultChanged') {
        const result = msg?.payload?.result;
        if (result) safeJsonSend(clientWs, { type: 'live_cn', text: result });
      }

      if (eventName === 'SentenceEnd') {
        const result = msg?.payload?.result;
        if (result && result.trim().length >= 1) {
          try {
            const en = await translateWithDeepSeek(result);
            safeJsonSend(clientWs, { type: 'final', cn: result, en });
          } catch (err) {
            console.error('[DeepSeek] Translate error:', err?.message || err);
            safeJsonSend(clientWs, { type: 'error', message: 'Translation failed' });
          }
        }
      }

      if (eventName === 'TaskFailed') {
        const statusMsg = msg?.header?.status_message || 'unknown';
        console.error('[Alibaba] TaskFailed:', statusMsg);

        safeJsonSend(clientWs, {
          type: 'error',
          message: `Alibaba task failed: ${statusMsg}`,
        });

        // If token expired/invalid, force refresh and reconnect on next audio
        // (common message contains something like "token invalid" / "authentication failed")
        if (/token|auth|expired|invalid/i.test(statusMsg)) {
          cachedAlibabaToken = null;
          cachedAlibabaTokenExpireAt = 0;
          console.log('[AlibabaToken] Token probably expired; cache cleared.');
        }

        closeAlibaba();
      }
    });

    alibabaWs.on('close', (code, reason) => {
      console.log('[Alibaba] WS closed:', code, reason?.toString?.() || '');
      alibabaReady = false;
      alibabaWs = null;
    });

    alibabaWs.on('error', (err) => {
      console.error('[Alibaba] WS error:', err?.message || err);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba WS error' });
    });
  }

  // Client messages: binary audio or JSON commands
  clientWs.on('message', async (data, isBinary) => {
    // Binary audio
    if (isBinary) {
      const buf = Buffer.from(data);
      lastAudioAt = Date.now();

      if (!hasSeenAnyAudio) {
        hasSeenAnyAudio = true;
        console.log('[Audio] First audio chunk:', buf.length, 'bytes');
      }

      // Start Alibaba only when first audio arrives
      await connectAlibabaIfNeeded();

      // If Alibaba not ready yet, buffer (up to ~2 sec)
      if (!alibabaReady) {
        if (bufferedBytes + buf.length <= MAX_BUFFER_BYTES) {
          audioBufferQueue.push(buf);
          bufferedBytes += buf.length;
        }
        return;
      }

      // Alibaba ready: forward immediately
      if (alibabaWs && alibabaWs.readyState === WebSocket.OPEN) {
        alibabaWs.send(buf);
      }
      return;
    }

    // Text message: JSON command
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    if (msg?.type === 'manual_translate' && typeof msg?.text === 'string') {
      try {
        const en = await translateWithDeepSeek(msg.text);
        safeJsonSend(clientWs, { type: 'manual_result', cn: msg.text, en });
      } catch (err) {
        console.error('[DeepSeek] Manual translate error:', err?.message || err);
        safeJsonSend(clientWs, { type: 'error', message: 'Manual translation failed' });
      }
    }
  });

  // Keep-alive / monitoring: if client is live but no audio for 15s, warn
  const interval = setInterval(() => {
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;

    if (hasSeenAnyAudio) {
      const silenceMs = Date.now() - lastAudioAt;
      if (silenceMs > 15000) {
        safeJsonSend(clientWs, { type: 'status', status: 'no_audio' });
      }
    }
  }, 5000);

  clientWs.on('close', () => {
    clearInterval(interval);
    console.log('[WS] Client disconnected');
    closeAlibaba();
  });

  clientWs.on('error', (err) => {
    console.error('[WS] Client error:', err?.message || err);
    closeAlibaba();
  });
});

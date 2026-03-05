'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = createServer(app);

// -------------------- Config (ENV ONLY) --------------------
const PORT = process.env.PORT || 8080;

const ALIBABA_APPKEY = process.env.ALIBABA_APPKEY;

// Preferred: permanent creds (server will generate/refresh NLS token)
const ALIBABA_AK_ID = process.env.ALIBABA_AK_ID;
const ALIBABA_AK_SECRET = process.env.ALIBABA_AK_SECRET;

// Legacy: optional (24h token). If present, we’ll use it, but you should remove it.
const ALIBABA_TOKEN_ENV = process.env.ALIBABA_TOKEN;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Alibaba endpoints
const ALIBABA_WS_BASE = process.env.ALIBABA_WS_BASE || 'wss://nls-gateway-ap-southeast-1.aliyuncs.com/ws/v1';
const ALIBABA_TOKEN_META_ENDPOINT =
  process.env.ALIBABA_TOKEN_META_ENDPOINT || 'http://nls-meta.cn-shanghai.aliyuncs.com/';

// Token refresh behavior
const TOKEN_REFRESH_SAFETY_SECONDS = 5 * 60; // refresh 5 min before expiry

function requireEnv(name, val) {
  if (!val) throw new Error(`[Startup] Missing env var: ${name}`);
}

requireEnv('ALIBABA_APPKEY', ALIBABA_APPKEY);
requireEnv('DEEPSEEK_API_KEY', DEEPSEEK_API_KEY);

// If no ALIBABA_TOKEN provided, we require AK credentials
if (!ALIBABA_TOKEN_ENV) {
  requireEnv('ALIBABA_AK_ID', ALIBABA_AK_ID);
  requireEnv('ALIBABA_AK_SECRET', ALIBABA_AK_SECRET);
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeJsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// -------------------- Serve frontend --------------------
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on ${PORT}`);
  console.log(`[Alibaba] WS base: ${ALIBABA_WS_BASE}`);
});

// -------------------- DeepSeek translation --------------------
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

// -------------------- Alibaba NLS token management --------------------
// Aliyun signature percent-encoding rules (slightly different than encodeURIComponent in a few chars)
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\!/g, '%21')
    .replace(/\'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildAliyunSignedUrl({ endpoint, accessKeyId, accessKeySecret, params }) {
  // 1) add required params
  const fullParams = {
    ...params,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), // ISO8601 UTC
    Format: 'JSON',
  };

  // 2) sort + canonicalize
  const sortedKeys = Object.keys(fullParams).sort();
  const canonicalized = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(String(fullParams[k]))}`)
    .join('&');

  // 3) string to sign
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalized)}`;

  // 4) signature
  const hmac = crypto.createHmac('sha1', `${accessKeySecret}&`);
  hmac.update(stringToSign);
  const signature = hmac.digest('base64');

  // 5) final URL
  const finalQuery = `${canonicalized}&Signature=${percentEncode(signature)}`;
  return `${endpoint}?${finalQuery}`;
}

let cachedAlibabaToken = null; // string
let cachedAlibabaTokenExpireAtMs = 0; // epoch ms
let tokenRefreshTimer = null;

async function fetchAlibabaNlsTokenWithAK() {
  const url = buildAliyunSignedUrl({
    endpoint: ALIBABA_TOKEN_META_ENDPOINT,
    accessKeyId: ALIBABA_AK_ID,
    accessKeySecret: ALIBABA_AK_SECRET,
    params: {
      Action: 'CreateToken',
      Version: '2019-02-28',
      RegionId: 'cn-shanghai',
    },
  });

  const resp = await axios.get(url, { timeout: 20000 });
  const token = resp.data?.Token?.Id;
  const expireTimeSec = resp.data?.Token?.ExpireTime; // seconds since epoch

  if (!token || !expireTimeSec) {
    throw new Error(`Unexpected token response: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }

  const expireAtMs = Number(expireTimeSec) * 1000;
  return { token, expireAtMs };
}

async function ensureAlibabaTokenFresh() {
  // If user explicitly provided a token, just use it (but it will expire; recommended to remove)
  if (ALIBABA_TOKEN_ENV) {
    cachedAlibabaToken = ALIBABA_TOKEN_ENV;
    cachedAlibabaTokenExpireAtMs = Date.now() + 23 * 60 * 60 * 1000; // best guess
    return cachedAlibabaToken;
  }

  const now = Date.now();
  const safetyMs = TOKEN_REFRESH_SAFETY_SECONDS * 1000;

  if (cachedAlibabaToken && cachedAlibabaTokenExpireAtMs - now > safetyMs) {
    return cachedAlibabaToken;
  }

  const { token, expireAtMs } = await fetchAlibabaNlsTokenWithAK();
  cachedAlibabaToken = token;
  cachedAlibabaTokenExpireAtMs = expireAtMs;

  const secondsLeft = Math.max(0, Math.floor((expireAtMs - now) / 1000));
  console.log(`[Alibaba] Got new NLS token. Expires in ~${secondsLeft}s`);

  // schedule refresh
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  const refreshInMs = Math.max(30_000, expireAtMs - now - safetyMs);
  tokenRefreshTimer = setTimeout(async () => {
    try {
      await ensureAlibabaTokenFresh();
    } catch (e) {
      console.error('[Alibaba] Token auto-refresh failed:', e?.message || e);
      // try again soon
      tokenRefreshTimer = setTimeout(() => ensureAlibabaTokenFresh().catch(() => {}), 60_000);
    }
  }, refreshInMs);

  return cachedAlibabaToken;
}

// Prime token at startup (if using AK)
ensureAlibabaTokenFresh().catch((e) => {
  console.error('[Alibaba] Initial token fetch failed:', e?.message || e);
});

// -------------------- WebSocket server on /ws --------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;

  // Buffer audio until Alibaba is ready
  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 2; // ~2 seconds of PCM16 mono 16kHz

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
    try {
      alibabaWs?.close();
    } catch (_) {}
    alibabaWs = null;
    alibabaReady = false;
  }

  async function connectAlibabaIfNeeded() {
    if (alibabaWs) return;

    let token;
    try {
      token = await ensureAlibabaTokenFresh();
    } catch (e) {
      console.error('[Alibaba] Unable to get token:', e?.message || e);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba token fetch failed' });
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

        while (audioBufferQueue.length) {
          const chunk = audioBufferQueue.shift();
          bufferedBytes -= chunk.length;
          if (alibabaWs.readyState === WebSocket.OPEN) alibabaWs.send(chunk);
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

        // If token-related, refresh token and force reconnect
        const tokenLike =
          /token/i.test(statusMsg) ||
          /unauthorized/i.test(statusMsg) ||
          /auth/i.test(statusMsg) ||
          msg?.header?.status_code === 401;

        closeAlibaba();

        if (tokenLike && !ALIBABA_TOKEN_ENV) {
          try {
            console.log('[Alibaba] Token issue suspected. Refreshing token now...');
            // clear cached token and refresh
            cachedAlibabaToken = null;
            cachedAlibabaTokenExpireAtMs = 0;
            await ensureAlibabaTokenFresh();
          } catch (e) {
            console.error('[Alibaba] Token refresh after failure failed:', e?.message || e);
          }
        }
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

'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = createServer(app);

// ---- Config (ENV ONLY) ----
const PORT = process.env.PORT || 8080;

const ALIBABA_APPKEY = process.env.ALIBABA_APPKEY;

// Optional: if you still want to manually paste a temporary token for testing
const ALIBABA_TOKEN_FALLBACK = process.env.ALIBABA_TOKEN;

// Permanent credentials (recommended)
const ALIBABA_AK_ID = process.env.ALIBABA_AK_ID;
const ALIBABA_AK_SECRET = process.env.ALIBABA_AK_SECRET;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Alibaba region + endpoints
const ALIBABA_REGION_ID = process.env.ALIBABA_REGION_ID || 'ap-southeast-1';
const ALIBABA_WS_BASE =
  process.env.ALIBABA_WS_BASE || 'wss://nls-gateway-ap-southeast-1.aliyuncs.com/ws/v1';

// Token API endpoint per Alibaba docs (CreateToken POP API)
const ALIBABA_TOKEN_ENDPOINT =
  process.env.ALIBABA_TOKEN_ENDPOINT || `https://nlsmeta.${ALIBABA_REGION_ID}.aliyuncs.com/`;

function requireEnv(name, val) {
  if (!val) throw new Error(`[Startup] Missing env var: ${name}`);
}

requireEnv('ALIBABA_APPKEY', ALIBABA_APPKEY);
requireEnv('DEEPSEEK_API_KEY', DEEPSEEK_API_KEY);

// We require either (AK_ID + AK_SECRET) OR a fallback token
if (!(ALIBABA_AK_ID && ALIBABA_AK_SECRET) && !ALIBABA_TOKEN_FALLBACK) {
  throw new Error(
    '[Startup] Missing Alibaba auth. Provide ALIBABA_AK_ID + ALIBABA_AK_SECRET (recommended) OR ALIBABA_TOKEN (temporary).'
  );
}

function newId() {
  // Node 18+ has randomUUID
  return crypto.randomUUID().replace(/-/g, '');
}

function safeJsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------------------------
// DeepSeek Translation
// ---------------------------
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

// ---------------------------
// Alibaba Token: Auto-fetch + refresh (permanent)
// ---------------------------

let currentAlibabaToken = ALIBABA_TOKEN_FALLBACK || null;
let currentAlibabaTokenExpireMs = 0;
let tokenRefreshTimer = null;

function percentEncode(str) {
  // POP encoding rules: encodeURIComponent + special replacements
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function popSign(method, pathStr, params, accessKeySecret) {
  // 1) sort params by key
  const keys = Object.keys(params).sort();
  // 2) canonicalized query string
  const canonicalized = keys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');

  // 3) stringToSign
  const stringToSign = `${method}&${percentEncode(pathStr)}&${percentEncode(canonicalized)}`;

  // 4) HMAC-SHA1 with key = AccessKeySecret + '&'
  const hmac = crypto.createHmac('sha1', `${accessKeySecret}&`);
  hmac.update(stringToSign);
  return hmac.digest('base64');
}

async function fetchAlibabaToken() {
  if (!(ALIBABA_AK_ID && ALIBABA_AK_SECRET)) {
    if (ALIBABA_TOKEN_FALLBACK) {
      console.log('[AlibabaToken] Using fallback ALIBABA_TOKEN (temporary).');
      currentAlibabaToken = ALIBABA_TOKEN_FALLBACK;
      currentAlibabaTokenExpireMs = Date.now() + 60 * 60 * 1000; // unknown, just 1h placeholder
      return { token: currentAlibabaToken, expireMs: currentAlibabaTokenExpireMs };
    }
    throw new Error('No Alibaba AK creds and no fallback token.');
  }

  const method = 'GET';
  const pathStr = '/';

  const params = {
    AccessKeyId: ALIBABA_AK_ID,
    Action: 'CreateToken',
    Version: '2019-02-28',
    Format: 'JSON',
    RegionId: ALIBABA_REGION_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(), // must be unique
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  const signature = popSign(method, pathStr, params, ALIBABA_AK_SECRET);

  const fullParams = { ...params, Signature: signature };

  const url =
    ALIBABA_TOKEN_ENDPOINT +
    '?' +
    Object.keys(fullParams)
      .sort()
      .map((k) => `${percentEncode(k)}=${percentEncode(fullParams[k])}`)
      .join('&');

  console.log('[AlibabaToken] Fetching new token from', ALIBABA_TOKEN_ENDPOINT);

  const resp = await axios.get(url, { timeout: 15000 });
  const tokenId = resp.data?.Token?.Id;
  const expireTimeSec = resp.data?.Token?.ExpireTime;

  if (!tokenId || !expireTimeSec) {
    console.error('[AlibabaToken] Bad response:', resp.data);
    throw new Error('Alibaba token response missing Token.Id / Token.ExpireTime');
  }

  currentAlibabaToken = tokenId;
  currentAlibabaTokenExpireMs = expireTimeSec * 1000;

  const minsLeft = Math.round((currentAlibabaTokenExpireMs - Date.now()) / 60000);
  console.log(`[AlibabaToken] Token OK. Minutes left: ~${minsLeft}`);

  return { token: currentAlibabaToken, expireMs: currentAlibabaTokenExpireMs };
}

function scheduleAlibabaTokenRefresh() {
  if (!(ALIBABA_AK_ID && ALIBABA_AK_SECRET)) {
    console.log('[AlibabaToken] No AK creds; skipping auto-refresh schedule.');
    return;
  }

  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);

  // refresh 5 minutes before expiry (or in 1 minute if expiry is soon)
  const refreshAtMs = Math.max(currentAlibabaTokenExpireMs - 5 * 60 * 1000, Date.now() + 60 * 1000);
  const delay = Math.max(refreshAtMs - Date.now(), 10 * 1000);

  tokenRefreshTimer = setTimeout(async () => {
    try {
      await fetchAlibabaToken();
      scheduleAlibabaTokenRefresh();
    } catch (e) {
      console.error('[AlibabaToken] Refresh failed:', e?.message || e);
      // retry in 30s
      tokenRefreshTimer = setTimeout(async () => {
        try {
          await fetchAlibabaToken();
          scheduleAlibabaTokenRefresh();
        } catch (err2) {
          console.error('[AlibabaToken] Retry refresh failed:', err2?.message || err2);
        }
      }, 30000);
    }
  }, delay);

  console.log('[AlibabaToken] Next refresh scheduled in', Math.round(delay / 1000), 'sec');
}

async function ensureAlibabaTokenFresh() {
  // If using fallback token, just use it (may expire)
  if (!(ALIBABA_AK_ID && ALIBABA_AK_SECRET)) return currentAlibabaToken;

  const now = Date.now();
  const needs =
    !currentAlibabaToken ||
    !currentAlibabaTokenExpireMs ||
    now > currentAlibabaTokenExpireMs - 2 * 60 * 1000; // if <2 mins left, refresh

  if (needs) {
    await fetchAlibabaToken();
    scheduleAlibabaTokenRefresh();
  }
  return currentAlibabaToken;
}

// ---------------------------
// Server startup
// ---------------------------

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Server] Listening on ${PORT}`);

  // Prime token on boot if AK creds provided
  try {
    if (ALIBABA_AK_ID && ALIBABA_AK_SECRET) {
      await fetchAlibabaToken();
      scheduleAlibabaTokenRefresh();
    } else {
      console.log('[AlibabaToken] Running with ALIBABA_TOKEN fallback only (temporary).');
    }
  } catch (e) {
    console.error('[AlibabaToken] Initial token fetch failed:', e?.message || e);
  }
});

// WebSocket server on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;

  // Buffer audio until Alibaba is ready
  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 2; // ~2 seconds of PCM16 mono 16k

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
      console.error('[AlibabaToken] Could not ensure token:', e?.message || e);
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
      safeJsonSend(clientWs, { type: 'status', status: 'connecting_asr' });
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
        console.error('[Alibaba] TaskFailed:', msg?.header?.status_message || msg?.header);
        safeJsonSend(clientWs, {
          type: 'error',
          message: `Alibaba task failed: ${msg?.header?.status_message || 'unknown'}`,
        });
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

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

// Alibaba Speech (NLS)
const ALIBABA_APPKEY = process.env.ALIBABA_APPKEY;

// Option A (old): temp token (24h) - still supported
let ALIBABA_TOKEN = process.env.ALIBABA_TOKEN;

// Option B (recommended): permanent AccessKey pair -> server auto-creates token
const ALIYUN_AK_ID = process.env.ALIYUN_AK_ID;
const ALIYUN_AK_SECRET = process.env.ALIYUN_AK_SECRET;

// DeepSeek
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Alibaba WS endpoint (you said this region works for you)
const ALIBABA_WS_BASE = 'wss://nls-gateway-ap-southeast-1.aliyuncs.com/ws/v1';

// Alibaba token OpenAPI endpoint
const NLS_META_HOST = 'nls-meta.cn-shanghai.aliyuncs.com';
const NLS_META_BASE = `https://${NLS_META_HOST}/`;

// ---- Helpers ----
function requireEnv(name, val) {
  if (!val) throw new Error(`[Startup] Missing env var: ${name}`);
}
requireEnv('ALIBABA_APPKEY', ALIBABA_APPKEY);
requireEnv('DEEPSEEK_API_KEY', DEEPSEEK_API_KEY);

// Need either temp token OR AK/SK
if (!ALIBABA_TOKEN && !(ALIYUN_AK_ID && ALIYUN_AK_SECRET)) {
  throw new Error(
    '[Startup] Missing Alibaba auth. Provide either ALIBABA_TOKEN (temporary) OR ALIYUN_AK_ID + ALIYUN_AK_SECRET (recommended).'
  );
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeJsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---- Alibaba token manager (auto-refresh) ----
const tokenState = {
  id: ALIBABA_TOKEN || null,
  expireTimeSec: null, // epoch seconds
  refreshing: null,
};

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\!/g, '%21')
    .replace(/\'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildCanonicalizedQuery(params) {
  const sortedKeys = Object.keys(params).sort();
  return sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
}

function signAliyun(params, accessKeySecret) {
  // Aliyun POP signature: HMAC-SHA1 over "GET&%2F&<encodedQuery>"
  const canonicalized = buildCanonicalizedQuery(params);
  const stringToSign = `GET&%2F&${percentEncode(canonicalized)}`;
  const key = `${accessKeySecret}&`;
  const hmac = crypto.createHmac('sha1', key).update(stringToSign).digest('base64');
  return hmac;
}

async function createAlibabaNlsTokenViaOpenAPI() {
  if (!(ALIYUN_AK_ID && ALIYUN_AK_SECRET)) {
    throw new Error('ALIYUN_AK_ID/ALIYUN_AK_SECRET not set');
  }

  const params = {
    AccessKeyId: ALIYUN_AK_ID,
    Action: 'CreateToken',
    Version: '2019-02-28',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  const signature = signAliyun(params, ALIYUN_AK_SECRET);
  const qs = `Signature=${percentEncode(signature)}&${buildCanonicalizedQuery(params)}`;

  const url = `${NLS_META_BASE}?${qs}`;

  const resp = await axios.get(url, {
    timeout: 15000,
    headers: { Host: NLS_META_HOST, Accept: 'application/json' },
  });

  const tokenId = resp.data?.Token?.Id;
  const expireTime = resp.data?.Token?.ExpireTime;

  if (!tokenId || !expireTime) {
    throw new Error(`Unexpected token response: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }

  return { tokenId, expireTimeSec: Number(expireTime) };
}

async function ensureAlibabaTokenFresh() {
  // If using static ALIBABA_TOKEN only (no AK/SK), nothing to refresh
  if (!ALIYUN_AK_ID || !ALIYUN_AK_SECRET) {
    if (!tokenState.id) throw new Error('ALIBABA_TOKEN missing');
    return tokenState.id;
  }

  // If already have token and it's not close to expiring, reuse it
  const nowSec = Math.floor(Date.now() / 1000);
  const refreshWindowSec = 300; // refresh when <5 minutes left
  if (tokenState.id && tokenState.expireTimeSec && tokenState.expireTimeSec - nowSec > refreshWindowSec) {
    return tokenState.id;
  }

  // Prevent parallel refresh stampedes
  if (tokenState.refreshing) return tokenState.refreshing;

  tokenState.refreshing = (async () => {
    const { tokenId, expireTimeSec } = await createAlibabaNlsTokenViaOpenAPI();
    tokenState.id = tokenId;
    tokenState.expireTimeSec = expireTimeSec;

    console.log(
      `[AlibabaToken] Refreshed. Expires at epoch=${expireTimeSec} (in ~${expireTimeSec - nowSec}s)`
    );

    // also update ALIBABA_TOKEN var for any legacy usage
    ALIBABA_TOKEN = tokenId;

    return tokenId;
  })();

  try {
    return await tokenState.refreshing;
  } finally {
    tokenState.refreshing = null;
  }
}

// ---- DeepSeek translation ----
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

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Server] Listening on ${PORT}`);
  // Warm token on boot (if AK/SK configured)
  try {
    await ensureAlibabaTokenFresh();
  } catch (e) {
    console.log('[Startup] Token warmup skipped/failed:', e?.message || e);
  }
});

// WebSocket server on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;

  const taskId = newId();

  // Buffer audio until Alibaba is ready
  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 2; // ~2 sec PCM16 mono 16k

  let hasSeenAnyAudio = false;
  let lastAudioAt = 0;

  // Simple reconnect backoff
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason) {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    if (reconnectTimer) return;

    reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 15000); // 1s,2s,4s...max 15s
    console.log(`[Alibaba] Reconnect scheduled in ${delay}ms. Reason: ${reason}`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectAlibabaIfNeeded(true);
    }, delay);
  }

  function closeAlibaba() {
    clearReconnectTimer();

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

  async function connectAlibabaIfNeeded(force = false) {
    if (alibabaWs && !force) return;

    // reset if forcing
    if (force) closeAlibaba();

    // Ensure token is fresh (auto-refresh if AK/SK)
    let token;
    try {
      token = await ensureAlibabaTokenFresh();
    } catch (e) {
      console.error('[AlibabaToken] ensureAlibabaTokenFresh failed:', e?.message || e);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba token unavailable' });
      scheduleReconnect('token_unavailable');
      return;
    }

    const url = `${ALIBABA_WS_BASE}?token=${encodeURIComponent(token)}`;
    console.log('[Alibaba] Connecting:', url.replace(token, '***TOKEN***'));

    alibabaWs = new WebSocket(url);

    alibabaWs.on('open', () => {
      console.log('[Alibaba] WS open');
      reconnectAttempts = 0; // reset backoff on success

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

        safeJsonSend(clientWs, { type: 'error', message: `Alibaba task failed: ${statusMsg}` });

        // Very often this is token expiry/invalid. Refresh & reconnect.
        // If using AK/SK, ensureAlibabaTokenFresh() will fetch a new one.
        closeAlibaba();
        try {
          await ensureAlibabaTokenFresh();
        } catch (_) {}
        scheduleReconnect(`task_failed:${statusMsg}`);
      }
    });

    alibabaWs.on('close', (code, reason) => {
      console.log('[Alibaba] WS closed:', code, reason?.toString?.() || '');
      alibabaReady = false;
      alibabaWs = null;
      scheduleReconnect(`ws_close:${code}`);
    });

    alibabaWs.on('error', (err) => {
      console.error('[Alibaba] WS error:', err?.message || err);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba WS error' });
      // usually followed by close; but just in case:
      scheduleReconnect('ws_error');
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
      connectAlibabaIfNeeded().catch((e) => {
        console.error('[Alibaba] connect failed:', e?.message || e);
      });

      if (!alibabaReady) {
        if (bufferedBytes + buf.length <= MAX_BUFFER_BYTES) {
          audioBufferQueue.push(buf);
          bufferedBytes += buf.length;
        }
        return;
      }

      if (alibabaWs && alibabaWs.readyState === WebSocket.OPEN) {
        alibabaWs.send(buf);
      }
      return;
    }

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

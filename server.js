'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = createServer(app);

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 8080;

const ALIBABA_AK_ID = process.env.ALIBABA_AK_ID;
const ALIBABA_AK_SECRET = process.env.ALIBABA_AK_SECRET;
const ALIBABA_APPKEY = process.env.ALIBABA_APPKEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Keep everything in Singapore region
const REGION = 'ap-southeast-1';
const ALIBABA_WS_BASE = `wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1`;
const NLS_META_HOST = `nlsmeta.${REGION}.aliyuncs.com`;
const NLS_META_BASE = `https://${NLS_META_HOST}/`;

// --------------------
// Validation
// --------------------
function requireEnv(name, val) {
  if (!val) throw new Error(`[Startup] Missing env var: ${name}`);
}

requireEnv('ALIBABA_AK_ID', ALIBABA_AK_ID);
requireEnv('ALIBABA_AK_SECRET', ALIBABA_AK_SECRET);
requireEnv('ALIBABA_APPKEY', ALIBABA_APPKEY);
requireEnv('DEEPSEEK_API_KEY', DEEPSEEK_API_KEY);

// --------------------
// Helpers
// --------------------
function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeJsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function percentEncode(str) {
  return encodeURIComponent(String(str))
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
  const canonicalized = buildCanonicalizedQuery(params);
  const stringToSign = `GET&%2F&${percentEncode(canonicalized)}`;
  return crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
}

// --------------------
// Alibaba token manager
// --------------------
const tokenState = {
  id: null,
  expireTimeSec: null,
  refreshing: null,
};

async function createAlibabaNlsTokenViaOpenAPI() {
  const params = {
    AccessKeyId: ALIBABA_AK_ID,
    Action: 'CreateToken',
    Version: '2019-02-28',
    Format: 'JSON',
    RegionId: REGION,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  const signature = signAliyun(params, ALIBABA_AK_SECRET);
  const qs = `Signature=${percentEncode(signature)}&${buildCanonicalizedQuery(params)}`;
  const url = `${NLS_META_BASE}?${qs}`;

  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      Host: NLS_META_HOST,
      Accept: 'application/json',
    },
  });

  const tokenId = resp.data?.Token?.Id;
  const expireTime = resp.data?.Token?.ExpireTime;

  if (!tokenId || !expireTime) {
    throw new Error(`Unexpected token response: ${JSON.stringify(resp.data).slice(0, 400)}`);
  }

  return {
    tokenId,
    expireTimeSec: Number(expireTime),
  };
}

async function ensureAlibabaTokenFresh() {
  const nowSec = Math.floor(Date.now() / 1000);
  const refreshWindowSec = 300; // refresh if less than 5 mins left

  if (
    tokenState.id &&
    tokenState.expireTimeSec &&
    tokenState.expireTimeSec - nowSec > refreshWindowSec
  ) {
    return tokenState.id;
  }

  if (tokenState.refreshing) return tokenState.refreshing;

  tokenState.refreshing = (async () => {
    const { tokenId, expireTimeSec } = await createAlibabaNlsTokenViaOpenAPI();
    tokenState.id = tokenId;
    tokenState.expireTimeSec = expireTimeSec;

    console.log(
      `[AlibabaToken] Refreshed. Expires in ~${expireTimeSec - nowSec}s`
    );

    return tokenId;
  })();

  try {
    return await tokenState.refreshing;
  } finally {
    tokenState.refreshing = null;
  }
}

// Warm token on startup
ensureAlibabaTokenFresh().catch((e) => {
  console.error('[Startup] Alibaba token warmup failed:', e?.message || e);
});

// --------------------
// DeepSeek translation
// --------------------
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

// --------------------
// HTTP routes
// --------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    region: REGION,
    hasAlibabaKeys: !!(ALIBABA_AK_ID && ALIBABA_AK_SECRET),
    hasAppKey: !!ALIBABA_APPKEY,
    hasDeepSeek: !!DEEPSEEK_API_KEY,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// --------------------
// Start server
// --------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on ${PORT}`);
});

// --------------------
// WebSocket server
// --------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;
  let alibabaConnecting = false;

  const taskId = newId();

  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 2; // ~2 seconds at 16k mono PCM16

  let hasSeenAnyAudio = false;
  let lastAudioAt = 0;

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
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 15000);
    console.log(`[Alibaba] Reconnect scheduled in ${delay}ms. Reason: ${reason}`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectAlibabaIfNeeded(true).catch((e) => {
        console.error('[Alibaba] Reconnect failed:', e?.message || e);
      });
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
    alibabaConnecting = false;
  }

  async function connectAlibabaIfNeeded(force = false) {
    if (alibabaWs && !force) return;
    if (alibabaConnecting && !force) return;

    if (force) closeAlibaba();

    alibabaConnecting = true;

    let token;
    try {
      token = await ensureAlibabaTokenFresh();
    } catch (e) {
      alibabaConnecting = false;
      console.error('[AlibabaToken] ensureAlibabaTokenFresh failed:', e?.message || e);
      safeJsonSend(clientWs, {
        type: 'error',
        message: `Alibaba token unavailable: ${e?.message || 'unknown error'}`,
      });
      scheduleReconnect('token_unavailable');
      return;
    }

    const url = `${ALIBABA_WS_BASE}?token=${encodeURIComponent(token)}`;
    console.log('[Alibaba] Connecting:', url.replace(token, '***TOKEN***'));

    alibabaWs = new WebSocket(url);

    alibabaWs.on('open', () => {
      console.log('[Alibaba] WS open');
      reconnectAttempts = 0;

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
        alibabaConnecting = false;
        console.log('[Alibaba] Ready. Flushing buffered audio:', bufferedBytes, 'bytes');
        safeJsonSend(clientWs, { type: 'status', status: 'ready' });

        while (audioBufferQueue.length) {
          const chunk = audioBufferQueue.shift();
          bufferedBytes -= chunk.length;
          if (alibabaWs.readyState === WebSocket.OPEN) {
            alibabaWs.send(chunk);
          }
        }
        return;
      }

      if (eventName === 'TranscriptionResultChanged') {
        const result = msg?.payload?.result;
        if (result) {
          safeJsonSend(clientWs, { type: 'live_cn', text: result });
        }
        return;
      }

      if (eventName === 'SentenceEnd') {
        const result = msg?.payload?.result;
        if (result && result.trim().length >= 1) {
          try {
            const en = await translateWithDeepSeek(result);
            safeJsonSend(clientWs, { type: 'final', cn: result, en });
          } catch (err) {
            console.error('[DeepSeek] Translate error:', err?.message || err);
            safeJsonSend(clientWs, {
              type: 'error',
              message: `Translation failed: ${err?.message || 'unknown error'}`,
            });
          }
        }
        return;
      }

      if (eventName === 'TaskFailed') {
        const statusMsg = msg?.header?.status_message || 'unknown';
        console.error('[Alibaba] TaskFailed:', statusMsg);

        safeJsonSend(clientWs, {
          type: 'error',
          message: `Alibaba task failed: ${statusMsg}`,
        });

        closeAlibaba();

        // force refresh token next time
        tokenState.id = null;
        tokenState.expireTimeSec = null;

        scheduleReconnect(`task_failed:${statusMsg}`);
      }
    });

    alibabaWs.on('close', (code, reason) => {
      console.log('[Alibaba] WS closed:', code, reason?.toString?.() || '');
      alibabaReady = false;
      alibabaWs = null;
      alibabaConnecting = false;
      scheduleReconnect(`ws_close:${code}`);
    });

    alibabaWs.on('error', (err) => {
      console.error('[Alibaba] WS error:', err?.message || err);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba WS error' });
      scheduleReconnect('ws_error');
    });
  }

  clientWs.on('message', async (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      lastAudioAt = Date.now();

      if (!hasSeenAnyAudio) {
        hasSeenAnyAudio = true;
        console.log('[Audio] First audio chunk:', buf.length, 'bytes');
      }

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
        safeJsonSend(clientWs, {
          type: 'error',
          message: `Manual translation failed: ${err?.message || 'unknown error'}`,
        });
      }
    }
  });

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

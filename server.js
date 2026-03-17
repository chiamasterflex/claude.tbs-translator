'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const Core = require('@alicloud/pop-core');

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

const REGION = 'ap-southeast-1';
const ALIBABA_WS_BASE = `wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1`;
const ALIBABA_TOKEN_ENDPOINT = `https://nlsmeta.${REGION}.aliyuncs.com`;

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

function safeWsSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    return true;
  }
  return false;
}

// --------------------
// Alibaba token manager
// --------------------
const tokenState = {
  id: null,
  expireTimeSec: null,
  refreshing: null,
};

const alibabaClient = new Core({
  accessKeyId: ALIBABA_AK_ID,
  accessKeySecret: ALIBABA_AK_SECRET,
  endpoint: ALIBABA_TOKEN_ENDPOINT,
  apiVersion: '2019-07-17',
});

async function createAlibabaTokenViaSDK() {
  try {
    const result = await alibabaClient.request(
      'CreateToken',
      {},
      { method: 'POST' }
    );

    const tokenId = result?.Token?.Id;
    const expireTime = result?.Token?.ExpireTime;

    if (!tokenId || !expireTime) {
      throw new Error(`Unexpected token response: ${JSON.stringify(result).slice(0, 400)}`);
    }

    return {
      tokenId,
      expireTimeSec: Number(expireTime),
    };
  } catch (err) {
    console.error('❌ FULL ALIBABA SDK ERROR >>>');
    console.error(err?.data || err?.message || err);
    throw err;
  }
}

async function ensureAlibabaTokenFresh() {
  const nowSec = Math.floor(Date.now() / 1000);
  const refreshWindowSec = 300;

  if (
    tokenState.id &&
    tokenState.expireTimeSec &&
    tokenState.expireTimeSec - nowSec > refreshWindowSec
  ) {
    return tokenState.id;
  }

  if (tokenState.refreshing) return tokenState.refreshing;

  tokenState.refreshing = (async () => {
    const { tokenId, expireTimeSec } = await createAlibabaTokenViaSDK();
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

  let clientAlive = true;
  let alibabaWs = null;
  let alibabaConnecting = false;
  let alibabaStarted = false;   // StartTranscriber has been sent
  let alibabaReady = false;     // optional informational state
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  const taskId = newId();

  // Only buffer until Alibaba socket is open and StartTranscriber is sent.
  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 3; // ~3 seconds

  let hasSeenAnyAudio = false;
  let lastAudioAt = 0;

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function closeAlibaba(sendStop = true) {
    clearReconnectTimer();

    if (sendStop && alibabaWs && alibabaWs.readyState === WebSocket.OPEN) {
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
        safeWsSend(alibabaWs, JSON.stringify(stop));
      } catch (_) {}
    }

    try {
      if (
        alibabaWs &&
        (alibabaWs.readyState === WebSocket.OPEN ||
          alibabaWs.readyState === WebSocket.CONNECTING)
      ) {
        alibabaWs.close();
      }
    } catch (_) {}

    alibabaWs = null;
    alibabaConnecting = false;
    alibabaStarted = false;
    alibabaReady = false;
  }

  function scheduleReconnect(reason) {
    if (!clientAlive) return;
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;
    if (reconnectTimer) return;
    if (alibabaConnecting) return;
    if (alibabaWs) return;

    reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
    console.log(`[Alibaba] Reconnect scheduled in ${delay}ms. Reason: ${reason}`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!clientAlive) return;
      connectAlibabaIfNeeded(true).catch((e) => {
        console.error('[Alibaba] Reconnect failed:', e?.message || e);
      });
    }, delay);
  }

  async function flushBufferedAudio() {
    if (!alibabaWs || alibabaWs.readyState !== WebSocket.OPEN) return;
    if (!alibabaStarted) return;

    while (audioBufferQueue.length) {
      const chunk = audioBufferQueue.shift();
      bufferedBytes -= chunk.length;
      const ok = safeWsSend(alibabaWs, chunk);
      if (!ok) break;
    }
  }

  async function connectAlibabaIfNeeded(force = false) {
    if (!clientAlive) return;
    if (alibabaWs && !force) return;
    if (alibabaConnecting && !force) return;

    if (force) closeAlibaba(false);

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

    alibabaWs.on('open', async () => {
      console.log('[Alibaba] WS open');
      reconnectAttempts = 0;

      setTimeout(async () => {
        if (!alibabaWs || alibabaWs.readyState !== WebSocket.OPEN) {
          console.error('[Alibaba] Socket not open when trying to send StartTranscriber');
          return;
        }

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

        const ok = safeWsSend(alibabaWs, JSON.stringify(start));
        if (!ok) {
          console.error('[Alibaba] Failed to send StartTranscriber');
          return;
        }

        alibabaStarted = true;
        alibabaConnecting = false;
        console.log('[Alibaba] StartTranscriber sent');

        // IMPORTANT: flush real buffered audio immediately after start
        await flushBufferedAudio();
      }, 50);
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
        console.log('[Alibaba] Ready');
        safeJsonSend(clientWs, { type: 'status', status: 'ready' });
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
        console.error('[Alibaba] TaskFailed FULL >>>', JSON.stringify(msg));

        const statusMsg =
          msg?.header?.status_text ||
          msg?.header?.status_message ||
          msg?.header?.message ||
          'unknown';

        safeJsonSend(clientWs, {
          type: 'error',
          message: `Alibaba task failed: ${statusMsg}`,
        });

        closeAlibaba(false);

        tokenState.id = null;
        tokenState.expireTimeSec = null;

        scheduleReconnect(`task_failed:${statusMsg}`);
      }
    });

    alibabaWs.on('close', (code, reason) => {
      console.log('[Alibaba] WS closed:', code, reason?.toString?.() || '');
      alibabaWs = null;
      alibabaConnecting = false;
      alibabaStarted = false;
      alibabaReady = false;

      if (clientAlive) {
        scheduleReconnect(`ws_close:${code}`);
      }
    });

    alibabaWs.on('error', (err) => {
      console.error('[Alibaba] WS error:', err?.message || err);
      safeJsonSend(clientWs, { type: 'error', message: 'Alibaba WS error' });

      if (clientAlive) {
        scheduleReconnect('ws_error');
      }
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

      // If not started yet, buffer briefly.
      if (!alibabaStarted || !alibabaWs || alibabaWs.readyState !== WebSocket.OPEN) {
        if (bufferedBytes + buf.length <= MAX_BUFFER_BYTES) {
          audioBufferQueue.push(buf);
          bufferedBytes += buf.length;
        }
        return;
      }

      // Once started, forward immediately — do NOT wait for "ready"
      safeWsSend(alibabaWs, buf);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    // harmless browser keepalive ping
    if (msg?.type === 'ping') {
      safeJsonSend(clientWs, { type: 'status', status: alibabaReady ? 'ready' : 'alive' });
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
    clientAlive = false;
    clearInterval(interval);
    console.log('[WS] Client disconnected');
    closeAlibaba(false);
  });

  clientWs.on('error', (err) => {
    clientAlive = false;
    console.error('[WS] Client error:', err?.message || err);
    closeAlibaba(false);
  });
});

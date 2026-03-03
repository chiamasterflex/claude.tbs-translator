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
const ALIBABA_TOKEN = process.env.ALIBABA_TOKEN; // temporary token (24h)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Alibaba endpoint (keep as the one that worked for you previously)
const ALIBABA_WS_BASE = 'wss://nls-gateway-ap-southeast-1.aliyuncs.com/ws/v1';

function requireEnv(name, val) {
  if (!val) throw new Error(`[Startup] Missing env var: ${name}`);
}
requireEnv('ALIBABA_APPKEY', ALIBABA_APPKEY);
requireEnv('ALIBABA_TOKEN', ALIBABA_TOKEN);
requireEnv('DEEPSEEK_API_KEY', DEEPSEEK_API_KEY);

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeJsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

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

wss.on('connection', (clientWs, req) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;

  // Buffer audio until Alibaba is ready
  const audioBufferQueue = [];
  let bufferedBytes = 0;
  const MAX_BUFFER_BYTES = 16000 * 2 * 2; // ~2 seconds of PCM16 mono 16k (16k samples/sec * 2 bytes/sample * 2 sec)

  let hasSeenAnyAudio = false;
  let lastAudioAt = 0;

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

  const taskId = newId();

  function connectAlibabaIfNeeded() {
    if (alibabaWs) return;

    const url = `${ALIBABA_WS_BASE}?token=${encodeURIComponent(ALIBABA_TOKEN)}`;
    console.log('[Alibaba] Connecting:', url.replace(ALIBABA_TOKEN, '***TOKEN***'));

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
      const buf = Buffer.from(data); // ensure Node Buffer
      lastAudioAt = Date.now();

      if (!hasSeenAnyAudio) {
        hasSeenAnyAudio = true;
        console.log('[Audio] First audio chunk:', buf.length, 'bytes');
      }

      // Start Alibaba only when first audio arrives
      connectAlibabaIfNeeded();

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

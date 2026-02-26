const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 8080;

const ALIBABA_AK_ID = process.env.ALIBABA_AK_ID || 'LTAI5t74qfgT3PdVegZgTSoV';
const ALIBABA_AK_SECRET = process.env.ALIBABA_AK_SECRET || 'EtkgjYYhFd9YQ9Xej7u1etIVVDQy1Z';
const ALIBABA_APPKEY = process.env.ALIBABA_APPKEY || 'kNPPGUGiUNqBa7DB';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-43a90c6020b44e818013a112dd890b79';

app.use(express.static(path.join(__dirname, 'public')));

// --- ALIBABA TOKEN ---
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

async function fetchAlibabaToken() {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = {
    AccessKeyId: ALIBABA_AK_ID,
    Action: 'CreateToken',
    Version: '2019-07-17',
    Timestamp: timestamp,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Format: 'JSON'
  };

  const sortedKeys = Object.keys(params).sort();
  const canonicalizedQuery = sortedKeys
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');

  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonicalizedQuery)}`;
  const hmac = crypto.createHmac('sha1', ALIBABA_AK_SECRET + '&');
  hmac.update(stringToSign);
  params.Signature = hmac.digest('base64');

  const qs = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

  const response = await axios.post(
    `https://nlsmeta.ap-southeast-1.aliyuncs.com?${qs}`,
    null,
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );

  if (!response.data?.Token?.Id) {
    throw new Error('No token in response: ' + JSON.stringify(response.data));
  }
  return response.data.Token.Id;
}

// --- DEEPSEEK TRANSLATION ---
async function translateWithDeepSeek(chineseText) {
  const response = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `You are the official translator for True Buddha School (TBS). 
Translate Chinese to English. 
Rules: 
1. Output ONLY the English translation, nothing else. No explanations, no notes.
2. Key terms: 蓮生活佛=Living Buddha Lian-sheng, 師尊=Grand Master, 真佛宗=True Buddha School, 法王=Dharma King, 盧勝彥=Lu Sheng-yen, 師母=Holy Consort.
3. Keep proper nouns and Sanskrit terms unchanged.
4. Maintain the reverent tone of Buddhist teachings.`
        },
        { role: 'user', content: chineseText }
      ],
      temperature: 0.1,
      max_tokens: 500
    },
    {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );
  return response.data.choices[0].message.content.trim();
}

// --- WEBSOCKET SERVER ---
wss.on('connection', async (clientWs) => {
  console.log('[WS] Client connected');

  let alibabaWs = null;
  let alibabaReady = false;
  const taskId = crypto.randomUUID();
  // Buffer audio that arrives before Alibaba is ready
  const audioBuffer = [];

  function safeSend(ws, data) {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    } catch (e) {
      console.error('[WS] safeSend error:', e.message);
    }
  }

  // Connect to Alibaba
  try {
    console.log('[Alibaba] Fetching token...');
    const token = await fetchAlibabaToken();
    console.log('[Alibaba] Token obtained');

    alibabaWs = new WebSocket(
      `wss://nls-gateway-ap-southeast-1.aliyuncs.com/ws/v1?token=${token}`
    );

    alibabaWs.on('open', () => {
      console.log('[Alibaba] WebSocket connected, starting transcriber...');
      alibabaWs.send(JSON.stringify({
        header: {
          message_id: crypto.randomUUID(),
          task_id: taskId,
          namespace: 'SpeechTranscriber',
          name: 'StartTranscriber',
          appkey: ALIBABA_APPKEY
        },
        payload: {
          format: 'pcm',
          sample_rate: 16000,
          enable_intermediate_result: true,
          enable_punctuation_prediction: true,
          enable_inverse_text_normalization: true
        }
      }));
    });

    alibabaWs.on('message', async (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch (e) { return; }

      const eventName = message.header?.name;
      console.log('[Alibaba] Event:', eventName);

      if (eventName === 'TranscriptionStarted') {
        console.log('[Alibaba] Transcriber ready');
        alibabaReady = true;
        // Flush any buffered audio
        while (audioBuffer.length > 0) {
          const chunk = audioBuffer.shift();
          safeSend(alibabaWs, chunk);
        }
        safeSend(clientWs, JSON.stringify({ type: 'status', status: 'live' }));

      } else if (eventName === 'TranscriptionResultChanged') {
        const result = message.payload?.result;
        if (result) {
          safeSend(clientWs, JSON.stringify({ type: 'live_cn', text: result }));
        }

      } else if (eventName === 'SentenceEnd') {
        const result = message.payload?.result;
        if (result && result.trim().length >= 2) {
          safeSend(clientWs, JSON.stringify({ type: 'translating', cn: result }));
          try {
            const translation = await translateWithDeepSeek(result);
            safeSend(clientWs, JSON.stringify({ type: 'final', cn: result, en: translation }));
          } catch (err) {
            console.error('[DeepSeek] Translation error:', err.message);
            safeSend(clientWs, JSON.stringify({ type: 'final', cn: result, en: '[Translation error]' }));
          }
        }

      } else if (eventName === 'TaskFailed') {
        const msg = message.header?.status_message || 'Unknown error';
        console.error('[Alibaba] Task failed:', msg);
        safeSend(clientWs, JSON.stringify({ type: 'error', message: 'ASR failed: ' + msg }));
      }
    });

    alibabaWs.on('error', (err) => {
      console.error('[Alibaba] WebSocket error:', err.message);
      safeSend(clientWs, JSON.stringify({ type: 'error', message: 'ASR connection error' }));
    });

    alibabaWs.on('close', (code, reason) => {
      console.log('[Alibaba] WebSocket closed:', code, reason.toString());
      alibabaReady = false;
    });

  } catch (err) {
    console.error('[Alibaba] Setup error:', err.message);
    safeSend(clientWs, JSON.stringify({ type: 'error', message: 'Failed to connect to ASR: ' + err.message }));
  }

  // Handle messages from browser
  clientWs.on('message', async (data) => {
    // Binary = audio data
    if (Buffer.isBuffer(data)) {
      if (alibabaWs && alibabaWs.readyState === WebSocket.OPEN) {
        if (alibabaReady) {
          alibabaWs.send(data);
        } else {
          // Buffer until ready (max 100 chunks)
          if (audioBuffer.length < 100) audioBuffer.push(data);
        }
      }
      return;
    }

    // JSON messages
    let message;
    try { message = JSON.parse(data.toString()); } catch (e) { return; }

    if (message.type === 'manual_translate') {
      const text = message.text?.trim();
      if (!text) return;
      console.log('[Manual] Translating:', text);
      try {
        const translation = await translateWithDeepSeek(text);
        safeSend(clientWs, JSON.stringify({ type: 'manual_translation', cn: text, en: translation }));
      } catch (err) {
        safeSend(clientWs, JSON.stringify({ type: 'error', message: 'Manual translation failed' }));
      }

    } else if (message.type === 'stop') {
      console.log('[WS] Stop requested');
      if (alibabaWs && alibabaWs.readyState === WebSocket.OPEN) {
        try {
          alibabaWs.send(JSON.stringify({
            header: {
              message_id: crypto.randomUUID(),
              task_id: taskId,
              namespace: 'SpeechTranscriber',
              name: 'StopTranscriber',
              appkey: ALIBABA_APPKEY
            }
          }));
        } catch (e) { /* ignore */ }
      }
    }
  });

  clientWs.on('close', () => {
    console.log('[WS] Client disconnected');
    if (alibabaWs) {
      try { alibabaWs.close(); } catch (e) { /* ignore */ }
    }
  });

  clientWs.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`[Server] TBS Live Translator running on port ${PORT}`);
});

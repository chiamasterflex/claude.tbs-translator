# TBS Live Translator

Real-time Chinese → English live sermon translator for True Buddha School.

## Glitch Deployment (5 minutes)

1. Go to **glitch.com** and click "New Project" → "glitch-hello-node"
2. In the left file panel, click on each file and replace with the code below
3. Files you need:
   - `server.js` → paste server.js contents
   - `package.json` → paste package.json contents  
   - `public/index.html` → create a `public` folder, then create `index.html`
4. In Glitch, click the `.env` file and add your keys there (Glitch keeps these secret)
5. Click "Share" to get your live URL

## Files

- `server.js` — Node.js backend (Express + WebSocket + Alibaba ASR + DeepSeek)
- `public/index.html` — Complete frontend (no build step needed)
- `package.json` — Dependencies
- `.env` — API keys (keep secret)

## How It Works

1. Browser captures mic audio as raw PCM 16-bit mono 16000hz
2. Streams over WebSocket to Node server
3. Server forwards to Alibaba Cloud ASR (Singapore region)
4. Alibaba returns live Chinese transcription
5. On sentence completion, DeepSeek translates to English
6. Both panels update in real-time

## Mobile Use

Just open the URL in Chrome or Safari on any phone.
To install as app: tap Share → "Add to Home Screen"

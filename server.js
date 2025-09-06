// server.js
// LinasPedidos – Twilio Voice + Media Streams + Google STT (streaming)
// Responde en vivo usando Twilio REST (update de llamada) para decir algo y reanudar el stream.

const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const twilio = require('twilio');
const { SpeechClient } = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* ========== Credenciales GCP (desde env) ========== */
function getGcpCreds() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (!raw) {
    throw new Error('Falta GOOGLE_APPLICATION_CREDENTIALS(_JSON) con el JSON de service account.');
  }
  const info = JSON.parse(raw);
  if (info.private_key?.includes('\\n')) {
    info.private_key = info.private_key.replace(/\\n/g, '\n');
  }
  return {
    projectId: info.project_id,
    credentials: {
      client_email: info.client_email,
      private_key: info.private_key,
    },
  };
}

let speechClient;
try {
  speechClient = new SpeechClient(getGcpCreds());
  console.log('[GCP] Speech client OK');
} catch (e) {
  console.error('[GCP] Error credenciales:', e.message);
}

/* ========== Twilio REST para actualizar la llamada ========== */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const BASE_URL = process.env.PUBLIC_BASE_URL; // ej: https://linaspedidos-xxxx.herokuapp.com

async function sayToCall(callSid, text, { restart = true } = {}) {
  const url = `${BASE_URL}/twiml/say?text=${encodeURIComponent(text)}&restart=${
    restart ? 1 : 0
  }`;
  await twilioClient.calls(callSid).update({ url, method: 'GET' });
}

/* ========== Utilidades de audio: μ-law (Twilio) -> LINEAR16 (Google) ========== */
function muLawToLinearSample(u8) {
  // u-law to linear16 (Int16) – tabla estándar
  u8 = ~u8 & 0xff;
  const sign = (u8 & 0x80) ? -1 : 1;
  let exponent = (u8 >> 4) & 0x07;
  let mantissa = u8 & 0x0F;
  let magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
  return sign * (magnitude - 0x84);
}

function mulawBase64ToLinear16Buffer(b64) {
  const ulaw = Buffer.from(b64, 'base64');
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) {
    const s = muLawToLinearSample(ulaw[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

/* ========== Estado por stream ========== */
const states = new Map(); // streamSid -> { callSid, googleStream, open }

/* ========== Google STT streaming helpers ========== */
function startGoogleStream(state) {
  if (state.googleStream) return;

  // 1. Llama a streamingRecognize SIN argumentos para obtener el stream.
  const recognizeStream = speechClient
    .streamingRecognize()
    .on('error', (err) => {
      console.error('[STT][ERROR]', err.message);
      try { state.googleStream?.end?.(); } catch {}
      state.googleStream = null;
    })
    .on('data', (data) => {
      const result = data.results?.[0];
      if (!result) return;

      const transcript = result.alternatives?.[0]?.transcript?.trim() || '';
      const isFinal = result.isFinal;

      if (!transcript) return;

      if (isFinal) {
        console.log('[STT][FINAL]', transcript);
        // Responder y reanudar stream
        sayToCall(state.callSid, `Recibí: ${transcript}. Gracias.`, { restart: true })
          .catch((e) => console.error('[Twilio update error]', e.message));
      } else {
        console.log('[STT][PARTIAL]', transcript);
      }
    });

  // 2. Escribe la configuración como el PRIMER mensaje en el stream.
  recognizeStream.write({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 8000,
      languageCode: 'es-CO',
      model: 'phone_call',
      enableAutomaticPunctuation: true,
    },
    interimResults: true,
  });

  state.googleStream = recognizeStream;
  state.open = true;
}


function stopGoogleStream(state) {
  try { state.googleStream?.end?.(); } catch {}
  state.googleStream = null;
  state.open = false;
}

/* ========== Endpoints HTTP básicos ========== */
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

/* TwiML de arranque de llamada:
   - Inicia Media Stream (wss)
   - Habla un mensaje corto
   - Pausa (para quedar “escuchando”) */
app.get('/call', (req, res) => {
  const wssUrl = `wss://${req.get('host')}/media`;
  const twiml = `
<Response>
  <Start>
    <Stream url="${wssUrl}"/>
  </Start>
  <Say language="es-MX">Conectando con el asistente. Un momento por favor.</Say>
  <Pause length="60"/>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

/* TwiML de “decir y (opcional) reanudar stream” */
app.get('/twiml/say', (req, res) => {
  const text = (req.query.text || 'Listo.').slice(0, 500);
  const restart = req.query.restart !== '0';
  const wssUrl = `wss://${req.get('host')}/media`;

  const twiml = `
<Response>
  <Say language="es-MX">${text}</Say>
  ${restart ? `<Start><Stream url="${wssUrl}"/></Start><Pause length="60"/>` : `<Hangup/>`}
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

/* Call status webhook (solo logging) */
app.post('/status', (req, res) => {
  console.log('[STATUS]', JSON.stringify(req.body || {}, null, 2));
  res.sendStatus(200);
});

/* ========== Servidor HTTP + WebSocket para Twilio Media Streams ========== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (ws) => {
  let streamSid = null;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const event = data.event;

    if (event === 'start') {
      streamSid = data.start?.streamSid;
      const callSid = data.start?.callSid || data.start?.customParameters?.callSid;
      console.log('[WS] start', { streamSid, callSid });

      const state = { callSid, googleStream: null, open: false };
      states.set(streamSid, state);
      startGoogleStream(state);
      return;
    }

    if (event === 'media') {
      if (!streamSid) return;
      const state = states.get(streamSid);
      if (!state) return;

      // Audio de Twilio llega en μ-law base64 8kHz
      const linear16 = mulawBase64ToLinear16Buffer(data.media.payload);

      try {
        if (!state.googleStream) startGoogleStream(state);
        state.googleStream.write({ audioContent: linear16 });
      } catch (e) {
        // Evita “Cannot call write after a stream was destroyed”
        // solo loguea y continúa
        console.warn('[STT][WARN]', e.message);
      }
      return;
    }

    if (event === 'stop') {
      if (!streamSid) return;
      console.log('[WS] stop', { streamSid });
      const state = states.get(streamSid);
      if (state) {
        stopGoogleStream(state);
        states.delete(streamSid);
      }
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on('close', () => {
    if (streamSid) {
      const state = states.get(streamSid);
      if (state) stopGoogleStream(state);
      states.delete(streamSid);
    }
  });
});

/* ========== Arranque ========== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HTTP/WS listening on ${PORT}`));

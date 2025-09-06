// server.js
'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { WebSocketServer } = require('ws');

// --- Google TTS ---
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
// --- Google STT ---
const speech = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// =========================
// Credenciales Google (JSON embebido en env)
// =========================
function getGcpCreds() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS(_JSON)');
  const info = JSON.parse(raw);
  if (info.private_key && info.private_key.includes('\\n')) {
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

let ttsClient, sttClient;
try {
  const gcp = getGcpCreds();
  ttsClient = new TextToSpeechClient(gcp);
  sttClient = new speech.SpeechClient(gcp);
  console.log('[GCP] clientes TTS/STT listos para proyecto', gcp.projectId);
} catch (e) {
  console.error('[GCP] error de credenciales:', e.message);
}

// =========================
// TTS robusto
// =========================
const preferredVoices = [
  { languageCode: 'es-CO', name: 'es-CO-Wavenet-A' },
  { languageCode: 'es-MX', name: 'es-MX-Neural2-A' },
  { languageCode: 'es-ES', name: 'es-ES-Neural2-B' },
  { languageCode: 'es-CO', name: 'es-CO-Standard-A' },
];

async function synthesize(text) {
  for (const v of preferredVoices) {
    try {
      const [r] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: v,
        audioConfig: { audioEncoding: 'MP3' },
      });
      console.log('[TTS] ok con voz', v.name);
      return r.audioContent;
    } catch (e) {
      console.warn('[TTS] falla con voz', v.name, e.message);
    }
  }
  // default
  const [r] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'es-CO', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  });
  return r.audioContent;
}

// =========================
// Endpoints básicos
// =========================
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

// TwiML: anuncia y empieza streaming de medios
app.get('/call', (req, res) => {
  const base =
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get('host')}`; // fallback por si no pusiste PUBLIC_BASE_URL

  const wsUrl = base.replace('http://', 'ws://').replace('https://', 'wss://') + '/media';

  const say = 'Conectando con el asistente. Un momento por favor.';
  const twiml = `
<Response>
  <Say language="es-MX">${say}</Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <!-- mantenemos el canal abierto para escuchar -->
  <Pause length="60"/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// Status callback (opcional para debug)
app.post('/status', (req, res) => {
  console.log('[STATUS]', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// TTS directo
app.get('/tts', async (req, res) => {
  try {
    if (!ttsClient) throw new Error('TTS client not initialized');
    const text = (req.query.text || 'Hola de prueba.').slice(0, 500);
    const audio = await synthesize(text);
    res.set('Content-Type', 'audio/mpeg').send(Buffer.from(audio, 'base64'));
  } catch (err) {
    console.error('[TTS] error:', err?.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

// =========================
// WebSocket /media (Twilio Media Streams -> Google STT)
// =========================
const server = app.listen(process.env.PORT || 3000, () =>
  console.log('HTTP server listening on', server.address().port)
);

const wss = new WebSocketServer({ noServer: true });

// guardamos estado por streamSid
const streams = new Map();

/**
 * Crea un stream de Google STT configurado para Twilio:
 * - audio MULAW 8kHz mono
 * - español (CO)
 * - interimResults (parciales)
 */
function createGcpRecognizeStream(streamSid) {
  const gcpStream = sttClient
    .streamingRecognize({
      config: {
        encoding: 'MULAW',
        sampleRateHertz: 8000,
        languageCode: 'es-CO',
        enableAutomaticPunctuation: true,
      },
      interimResults: true,
      singleUtterance: false,
    })
    .on('error', (e) => {
      console.error(`[STT][${streamSid}] error:`, e.message);
    })
    .on('data', (data) => {
      // imprimir parciales/finales
      const results = data.results || [];
      if (!results.length) return;
      const alt = results[0].alternatives?.[0];
      const isFinal = results[0].isFinal;
      if (alt?.transcript) {
        console.log(
          `[STT][${streamSid}] ${isFinal ? 'FINAL' : 'parcial'}:`,
          alt.transcript
        );
      }
    })
    .on('end', () => {
      console.log(`[STT][${streamSid}] stream END`);
    });

  return gcpStream;
}

server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, 'http://x').pathname !== '/media') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  let streamSid;

  ws.on('message', (msg) => {
    // Twilio envía JSON por texto
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.warn('[WS] mensaje no-JSON, ignorado');
      return;
    }

    const { event } = data;

    // 1) START: crear el stream de Google
    if (event === 'start') {
      streamSid = data.start?.streamSid;
      console.log(`[WS] start streamSid=${streamSid}`);
      const gcpStream = createGcpRecognizeStream(streamSid);
      streams.set(streamSid, { gcpStream });
      return;
    }

    // 2) MEDIA: escribir payload en el stream de Google
    if (event === 'media') {
      if (!streamSid || !streams.has(streamSid)) return;
      const { gcpStream } = streams.get(streamSid);
      // Twilio manda base64 de mulaw 8kHz
      const audioBuf = Buffer.from(data.media.payload, 'base64');
      // Google espera { audioContent: <Buffer> } (camelCase)
      gcpStream.write({ audioContent: audioBuf });
      return;
    }

    // 3) MARK: opcional
    if (event === 'mark') {
      return;
    }

    // 4) STOP: cerrar stream
    if (event === 'stop') {
      console.log(`[WS] stop streamSid=${streamSid}`);
      const ctx = streams.get(streamSid);
      if (ctx?.gcpStream) {
        try { ctx.gcpStream.end(); } catch {}
      }
      streams.delete(streamSid);
      // Twilio cerrará el WS; nosotros también
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on('close', () => {
    if (streamSid && streams.has(streamSid)) {
      const ctx = streams.get(streamSid);
      try { ctx?.gcpStream?.end(); } catch {}
      streams.delete(streamSid);
      console.log(`[WS] closed streamSid=${streamSid}`);
    }
  });

  ws.on('error', (e) => {
    console.error('[WS] error', e.message);
  });
});

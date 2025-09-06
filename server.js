// server.js
// LinasPedidos Voice API — Twilio <Stream> + Google STT + Google TTS

// -------------------- Imports --------------------
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// -------------------- App & Middleware --------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- GCP Credentials Loader --------------------
function getGcpCreds() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (!raw) {
    throw new Error(
      'Missing GOOGLE_APPLICATION_CREDENTIALS(_JSON) env var with service-account JSON'
    );
  }

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

let gcp = null;
let sttClient = null;
let ttsClient = null;

try {
  gcp = getGcpCreds();
  sttClient = new SpeechClient(gcp);
  ttsClient = new TextToSpeechClient(gcp);
  console.log('[BOOT] GCP clients ready for project:', gcp.projectId);
} catch (e) {
  console.error('[BOOT][GCP] Unable to init credentials:', e.message);
}

// -------------------- TTS (robusto, con fallback) --------------------
const preferredVoices = [
  { languageCode: 'es-CO', name: 'es-CO-Wavenet-A' },
  { languageCode: 'es-MX', name: 'es-MX-Neural2-A' },
  { languageCode: 'es-ES', name: 'es-ES-Neural2-B' },
  { languageCode: 'es-CO', name: 'es-CO-Standard-A' }, // fallback adicional
];

async function synthesize(text) {
  for (const v of preferredVoices) {
    try {
      const [r] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: v,
        audioConfig: { audioEncoding: 'MP3' },
      });
      console.log('[TTS] OK with voice:', v.name);
      return r.audioContent;
    } catch (e) {
      console.warn(`[TTS] Failed ${v.name}: ${e.message}`);
    }
  }

  // Último recurso
  const fallback = { languageCode: 'es-CO', ssmlGender: 'FEMALE' };
  console.log('[TTS] Trying default voice…');
  const [r] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: fallback,
    audioConfig: { audioEncoding: 'MP3' },
  });
  console.log('[TTS] OK with default voice');
  return r.audioContent;
}

// -------------------- HTTP Endpoints --------------------
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

// Twilio status callback (opcional)
app.post('/status', (req, res) => {
  console.log('[STATUS]', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// TTS para <Play>
app.get('/tts', async (req, res) => {
  try {
    if (!ttsClient) throw new Error('TTS client not initialized');
    const text = (req.query.text || 'Hola de prueba.').slice(0, 500);
    const audio = await synthesize(text);
    res.set('Content-Type', 'audio/mpeg').send(Buffer.from(audio, 'base64'));
  } catch (err) {
    console.error('[TTS][HTTP] error:', err?.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

// Twilio webhook de llamada entrante (TwiML)
// Nota: <Stream> bloquea el TwiML siguiente. Reproducimos saludo y luego conectamos streaming.
app.all('/call', (req, res) => {
  const host = req.get('host');
  const proto = req.protocol; // en Heroku será 'https'
  const ttsUrl = `${proto}://${host}/tts?text=${encodeURIComponent(
    'Hola, bienvenido a Linas Pedidos. Un momento, por favor.'
  )}`;
  const wssUrl = `wss://${host}/media`;

  const twiml = `
<Response>
  <Play>${ttsUrl}</Play>
  <Start>
    <Stream url="${wssUrl}" />
  </Start>
  <Pause length="60"/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// -------------------- Twilio <Stream> ↔ Google STT --------------------
/**
 * Twilio Media Streams envía audio μ-law 8k (base64).
 * Configuramos Google STT: encoding MULAW + 8000 Hz + model "phone_call".
 * Gestionamos estado por conexión para evitar "write after end".
 */

function createGoogleStream(state) {
  const request = {
    config: {
      encoding: 'MULAW',
      sampleRateHertz: 8000,
      languageCode: 'es-CO',
      enableAutomaticPunctuation: true,
      model: 'phone_call',
    },
    interimResults: true,
  };

  state.googleStream = sttClient
    .streamingRecognize(request)
    .on('error', (err) => {
      console.error('[STT][gRPC][ERROR]', err.message);
      safeEnd(state);
    })
    .on('data', (data) => {
      const result = data.results?.[0];
      if (!result) return;
      const transcript = result.alternatives?.[0]?.transcript || '';
      if (result.isFinal) {
        console.log('[STT][FINAL]:', transcript);
        // TODO: Aquí puedes guardar intención, actualizar estado, etc.
      } else {
        console.log('[STT][PARCIAL]:', transcript);
      }
    });
}

function writeSafe(state, chunk) {
  if (!state.googleStream || state.ended) return;
  try {
    state.googleStream.write({ audio_content: chunk });
  } catch {
    console.warn('[STT][WARN] write after end (ignored)');
    safeEnd(state);
  }
}

function safeEnd(state) {
  if (state.ended) return;
  state.ended = true;
  if (state.googleStream) {
    try {
      state.googleStream.end();
    } catch {}
    state.googleStream.removeAllListeners();
    state.googleStream = null;
  }
}

// -------------------- WS Server (/media) --------------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`[BOOT] HTTP server listening on ${PORT}`)
);

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const state = { googleStream: null, ended: false, callSid: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        state.callSid = msg.start?.callSid;
        console.log('[WS] start', state.callSid || '');
        createGoogleStream(state);
        break;
      }
      case 'media': {
        if (state.ended || !state.googleStream) return;
        const audio = Buffer.from(msg.media.payload, 'base64'); // μ-law 8 kHz
        writeSafe(state, audio);
        break;
      }
      case 'mark':
        // opcional: marcas para sincronización
        break;
      case 'stop': {
        console.log('[WS] stop');
        safeEnd(state);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] close');
    safeEnd(state);
  });

  ws.on('error', (err) => {
    console.warn('[WS] error', err?.message);
    safeEnd(state);
  });
});

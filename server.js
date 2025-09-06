// server.js
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

// Google TTS (ya lo tenías)
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
// Google STT (streaming)
const { v1p1beta1: speech } = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// --- Cargar credenciales GCP desde env ---
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

let ttsClient, sttClient;
try {
  const gcp = getGcpCreds();
  ttsClient = new TextToSpeechClient(gcp);
  sttClient = new speech.SpeechClient(gcp);
  console.log('GCP clients OK. Project:', gcp.projectId);
} catch (e) {
  console.error('GCP creds init error:', e.message);
}

// ---------- TTS (robusto) ----------
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
      console.log(`TTS OK with voice: ${v.name}`);
      return r.audioContent;
    } catch (e) {
      console.warn(`TTS failed ${v.name}:`, e.message);
    }
  }
  // Default fallback
  const [r] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'es-CO', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  });
  return r.audioContent;
}

// ---------- Endpoints básicos ----------
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

// TwiML inicial: arranca Media Stream hacia wss://.../media
app.get('/call', (req, res) => {
  const wsUrl = `wss://${req.get('host')}/media`;
  const twiml = `
<Response>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Say language="es-MX">Conectando con el asistente. Un momento por favor.</Say>
  <!-- Mantén la llamada viva mientras el WS está abierto -->
  <Pause length="600"/>
</Response>`.trim();
  res.type('text/xml').send(twiml);
});

// (si lo sigues necesitando)
app.post('/stt', (req, res) => {
  console.log('STT webhook payload (no-WS path):', req.body);
  res.type('text/xml').send(
    `<Response><Say language="es-MX">Gracias. Estamos procesando tu pedido.</Say><Hangup/></Response>`
  );
});

// TTS HTTP (lo usa <Play> si quisieras)
app.get('/tts', async (req, res) => {
  try {
    if (!ttsClient) throw new Error('TTS client not initialized');
    const text = (req.query.text || 'Hola de prueba.').slice(0, 500);
    const audio = await synthesize(text);
    res.set('Content-Type', 'audio/mpeg').send(Buffer.from(audio, 'base64'));
  } catch (err) {
    console.error('TTS endpoint error:', err?.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

// ---------- WebSocket: Twilio Media Streams -> Google STT ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

// Helper: crea un stream de reconocimiento por llamada
function makeStreamingRequest({ languageCode = 'es-CO' } = {}) {
  return {
    config: {
      encoding: 'MULAW',          // Twilio envía PCMU (μ-law) 8kHz
      sampleRateHertz: 8000,
      languageCode,
      enableAutomaticPunctuation: true,
      model: 'phone_call',
      useEnhanced: true,
    },
    interimResults: true,
    singleUtterance: false,       // seguimos escuchando hasta que cerremos
  };
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  let recognizeStream = null;
  let callSid = null;
  let streamSid = null;

  // Abre un nuevo stream STT
  const openSttStream = (lang = 'es-CO') => {
    const request = makeStreamingRequest({ languageCode: lang });
    recognizeStream = sttClient
      .streamingRecognize(request)
      .on('error', (err) => {
        console.error('[STT] streaming error:', err.message);
        try { recognizeStream.destroy(); } catch {}
        recognizeStream = null;
      })
      .on('data', (data) => {
        // Maneja parciales/finales
        const results = data.results || [];
        if (!results.length) return;
        const alt = results[0].alternatives?.[0];
        if (!alt) return;

        if (results[0].isFinal) {
          console.log(`[STT][FINAL] ${alt.transcript}  (conf=${alt.confidence?.toFixed?.(2) ?? '-'})`);
          // Aquí: en siguientes iteraciones, invocar NLU o responder por voz
        } else {
          console.log(`[STT][PARCIAL] ${alt.transcript}`);
        }
      });
  };

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    switch (data.event) {
      case 'start': {
        callSid = data.start?.callSid;
        streamSid = data.start?.streamSid;
        console.log(`[WS] start  callSid=${callSid}  streamSid=${streamSid}`);
        // Idioma por defecto; puedes decidirlo por caller/country
        openSttStream('es-CO');
        break;
      }
      case 'media': {
        // Audio base64 μ-law 8kHz
        if (recognizeStream) {
          const audio = Buffer.from(data.media.payload, 'base64');
          recognizeStream.write({ audio_content: audio });
        }
        break;
      }
      case 'mark': {
        // Opcional: marcas que tú envíes
        break;
      }
      case 'stop': {
        console.log('[WS] stop');
        try { recognizeStream?.end(); } catch {}
        recognizeStream = null;
        ws.close();
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] closed');
    try { recognizeStream?.end(); } catch {}
    recognizeStream = null;
  });

  ws.on('error', (err) => {
    console.error('[WS] error:', err.message);
    try { recognizeStream?.end(); } catch {}
    recognizeStream = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HTTP+WS listening on ${PORT}`));

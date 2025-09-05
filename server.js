// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// --- Cargar credenciales GCP desde env (acepta dos nombres) ---
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

let ttsClient;
try {
  const gcp = getGcpCreds();
  ttsClient = new TextToSpeechClient(gcp);
  console.log('GCP TTS client inicializado para proyecto:', gcp.projectId);
} catch (e) {
  console.error('Error inicializando credenciales GCP:', e.message);
}

// --- Endpoints básicos ---
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

app.get('/call', (req, res) => {
  const msg =
    'Hola, bienvenido a Linas Pedidos. Por favor di tu pedido después del tono.';
  const ttsUrl = `${req.protocol}://${req.get('host')}/tts?text=${encodeURIComponent(
    msg
  )}`;

  const twiml = `
<Response>
  <Play>${ttsUrl}</Play>
  <Record action="${req.protocol}://${req.get('host')}/stt"
          method="POST" maxLength="8" playBeep="true" trim="trim-silence"/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// (Stub temporal) Recibe RecordingUrl y cuelga con un mensaje.
// Luego sustituimos por STT real descargando y transcribiendo el audio.
app.post('/stt', (req, res) => {
  console.log('STT webhook payload:', req.body);
  const twiml = `
<Response>
  <Say language="es-MX">Gracias. Estamos procesando tu pedido.</Say>
  <Hangup/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// TTS con Google: devuelve MP3 que Twilio <Play> soporta.
app.get('/tts', async (req, res) => {
  try {
    if (!ttsClient) throw new Error('TTS client not initialized');

    const text = String(req.query.text || 'Hola de prueba');
    const [resp] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'es-CO', name: 'es-CO-Wavenet-A' },
      audioConfig: { audioEncoding: 'MP3' },
    });

    const audio = Buffer.from(resp.audioContent, 'base64');
    res.set('Content-Type', 'audio/mpeg').send(audio);
  } catch (err) {
    console.error('TTS error:', err?.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

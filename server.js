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

// --- Nueva Lógica de Síntesis Robusta ---

const preferredVoices = [
  { languageCode: 'es-CO', name: 'es-CO-Wavenet-A' },
  { languageCode: 'es-MX', name: 'es-MX-Neural2-A' },
  { languageCode: 'es-ES', name: 'es-ES-Neural2-B' },
  { languageCode: 'es-CO', name: 'es-CO-Standard-A' } // Añadido como otra opción segura
];

async function synthesize(text) {
  for (const v of preferredVoices) {
    try {
      const [r] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: v,
        audioConfig: { audioEncoding: 'MP3' }
      });
      console.log(`TTS synthesised successfully with voice: ${v.name}`);
      return r.audioContent;
    } catch (e) {
      console.warn(`TTS failed for voice ${v.name}:`, e.message);
      // Intenta el siguiente
    }
  }

  // Último recurso: sin 'name' para que Google elija la voz por defecto
  try {
    console.log('All preferred voices failed. Trying default voice for es-CO...');
    const [r] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'es-CO', ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'MP3' }
    });
    console.log('TTS synthesised successfully with default voice.');
    return r.audioContent;
  } catch (e) {
    console.error('TTS default voice also failed:', e);
    throw e; // Si incluso el por defecto falla, lanza el error.
  }
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
app.post('/stt', (req, res) => {
  console.log('STT webhook payload:', req.body);
  const twiml = `
<Response>
  <Say language="es-MX">Gracias. Estamos procesando tu pedido.</Say>
  <Hangup/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// Endpoint TTS que ahora usa la lógica de síntesis robusta
app.get('/tts', async (req, res) => {
  try {
    if (!ttsClient) throw new Error('TTS client not initialized');
    
    const text = (req.query.text || 'Hola de prueba.').slice(0, 500);
    const audio = await synthesize(text);
    
    res.set('Content-Type', 'audio/mpeg').send(Buffer.from(audio, 'base64'));
  } catch (err) {
    console.error('TTS endpoint error after all fallbacks:', err?.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

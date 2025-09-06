// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

// Google Cloud TTS / STT
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { SpeechClient } = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ----------- Cargar credenciales GCP desde env (dos nombres posibles) -----------
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

let ttsClient, speechClient;
try {
  const gcp = getGcpCreds();
  ttsClient = new TextToSpeechClient(gcp);
  speechClient = new SpeechClient(gcp);
  console.log('GCP clients inicializados para proyecto:', gcp.projectId);
} catch (e) {
  console.error('Error inicializando credenciales GCP:', e.message);
}

// ----------- TTS robusto (Google) -----------
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
      console.log(`TTS OK con voz: ${v.name}`);
      return r.audioContent;
    } catch (e) {
      console.warn(`TTS falló con ${v.name}:`, e.message);
    }
  }
  // Último recurso: voz por defecto
  const [r] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'es-CO', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  });
  console.log('TTS OK con voz por defecto.');
  return r.audioContent;
}

// ----------- Utilidad: Descargar recording de Twilio (WAV o MP3) -----------
async function downloadRecording(recordingUrlBase) {
  const auth = {
    username: process.env.TWILIO_ACCOUNT_SID,
    password: process.env.TWILIO_AUTH_TOKEN,
  };

  // 1) Intento en WAV (lo recomendado para telefonía)
  const wavUrl = recordingUrlBase.endsWith('.wav')
    ? recordingUrlBase
    : `${recordingUrlBase}.wav`;

  try {
    const { data } = await axios.get(wavUrl, {
      auth,
      responseType: 'arraybuffer',
    });
    console.log('Recording descargado en WAV.');
    return { buffer: Buffer.from(data), format: 'wav' };
  } catch (e) {
    console.warn('Fallo descarga WAV, probando MP3:', e.message);
  }

  // 2) Fallback a MP3
  const mp3Url = recordingUrlBase.endsWith('.mp3')
    ? recordingUrlBase
    : `${recordingUrlBase}.mp3`;

  const { data } = await axios.get(mp3Url, {
    auth,
    responseType: 'arraybuffer',
  });
  console.log('Recording descargado en MP3.');
  return { buffer: Buffer.from(data), format: 'mp3' };
}

// ----------- STT (Google) -----------
async function transcribeWithGoogle(buffer, format) {
  // Para WAV 8 kHz de telefonía: LINEAR16 a 8000 Hz
  // Si fue MP3, Google lo acepta sin especificar sampleRate (deja que lo detecte)
  const audio = { content: buffer.toString('base64') };

  const config =
    format === 'wav'
      ? {
          encoding: 'LINEAR16',
          sampleRateHertz: 8000,
          languageCode: 'es-CO',
          enableAutomaticPunctuation: true,
        }
      : {
          // MP3 u otro contenedor comprimido
          encoding: 'ENCODING_UNSPECIFIED',
          languageCode: 'es-CO',
          enableAutomaticPunctuation: true,
        };

  const [resp] = await speechClient.recognize({ audio, config });
  const text = (resp.results || [])
    .map((r) => r.alternatives?.[0]?.transcript || '')
    .join(' ')
    .trim();

  return text;
}

// ----------- Endpoints básicos -----------
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

// Primer turno: saludo + grabación
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

// TTS endpoint (nuestro)
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

// Segundo turno: descargar recording, transcribir y responder
app.post('/stt', async (req, res) => {
  try {
    const { RecordingUrl, RecordingSid, From } = req.body || {};
    console.log('STT webhook body:', req.body);

    if (!RecordingUrl) {
      throw new Error('RecordingUrl ausente en el webhook de Twilio');
    }
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Faltan TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN en env');
    }

    // 1) Descargar audio desde Twilio (WAV o MP3)
    const { buffer, format } = await downloadRecording(RecordingUrl);

    // 2) Transcribir con Google Speech-to-Text
    const transcript = await transcribeWithGoogle(buffer, format);
    console.log('Transcripción:', transcript || '<vacía>');

    const respuesta =
      transcript && transcript.length > 0
        ? `Entendí: ${transcript}. Gracias por tu pedido.`
        : 'No pude entender tu mensaje. Por favor intenta de nuevo.';

    // 3) Responder con TwiML usando nuestro TTS (Play)
    const ttsUrl = `${req.protocol}://${req.get('host')}/tts?text=${encodeURIComponent(
      respuesta
    )}`;

    const twiml = `
<Response>
  <Play>${ttsUrl}</Play>
  <Hangup/>
</Response>`.trim();

    return res.type('text/xml').send(twiml);
  } catch (e) {
    console.error('Error en /stt:', e.message);
    const twiml = `
<Response>
  <Say language="es-MX">Tuvimos un problema procesando tu pedido. Gracias.</Say>
  <Hangup/>
</Response>`.trim();
    return res.type('text/xml').send(twiml);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

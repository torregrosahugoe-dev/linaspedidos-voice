// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { SpeechClient } = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true })); // Twilio envía x-www-form-urlencoded
app.use(bodyParser.json());

// --- Heroku detrás de proxy: respeta x-forwarded-proto (https) ---
app.set('trust proxy', true);

// --- Cargar credenciales GCP desde Config Vars (JSON COMPLETO) ---
let CREDS = null;
try {
  CREDS = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : null;
} catch (e) {
  console.error('ERROR: GOOGLE_APPLICATION_CREDENTIALS no es JSON válido.');
}
const gopts = CREDS ? { credentials: CREDS, projectId: CREDS.project_id } : {};
const ttsClient = new TextToSpeechClient(gopts);
const sttClient = new SpeechClient(gopts);

// --- Utilidades ---
function absUrl(req, path, qs = '') {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const scheme = proto === 'http' ? 'https' : proto; // fuerza https para Twilio <Play>
  return `${scheme}://${req.get('host')}${path}${qs}`;
}

function buildCallTwiml(req) {
  const ttsUrl = absUrl(
    req,
    '/tts',
    '?text=' +
      encodeURIComponent(
        'Hola, bienvenido a Linas Pedidos. Por favor di tu pedido después del tono.'
      )
  );
  const sttUrl = absUrl(req, '/stt');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl}</Play>
  <Record action="${sttUrl}" method="POST" maxLength="8" playBeep="true" trim="trim-silence"/>
</Response>`;
}

// Parseo simple de WAV para ubicar data y formato (PCM=1, μ-law=7)
function parseWav(buffer) {
  const toStr = (b) => b.toString('ascii');
  let pos = 12; // después de "RIFF....WAVE"
  let audioFormat = 1;
  let sampleRate = 8000;
  let dataStart = 44;

  // Buscar chunks genéricamente
  while (pos + 8 <= buffer.length) {
    const id = toStr(buffer.slice(pos, pos + 4));
    const size = buffer.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      audioFormat = buffer.readUInt16LE(pos + 8); // wFormatTag
      sampleRate = buffer.readUInt32LE(pos + 12); // nSamplesPerSec
    } else if (id === 'data') {
      dataStart = pos + 8;
      break;
    }
    pos += 8 + size;
  }
  return { audioFormat, sampleRate, dataStart };
}

// --- Rutas ---
app.get('/health', (_req, res) => res.type('text/plain').send('OK'));

app.get('/call', (req, res) => res.type('text/xml').send(buildCallTwiml(req)));
app.post('/call', (req, res) => res.type('text/xml').send(buildCallTwiml(req)));

// TTS: devuelve MP3 (más simple y 100% compatible con <Play>)
app.get('/tts', async (req, res) => {
  try {
    const text = String(req.query.text || 'Hola. Bienvenido a Linas.');
    const [resp] = await ttsClient.synthesizeSpeech({
      input: { text },
      // Puedes usar 'es-CO' si tu proyecto/voz lo soporta. 'es-ES' es universal.
      voice: { languageCode: 'es-ES' },
      audioConfig: { audioEncoding: 'MP3' }
    });
    const audio = Buffer.from(resp.audioContent, 'base64');
    res.set('Content-Type', 'audio/mpeg').send(audio);
  } catch (e) {
    console.error('TTS error:', e?.response?.data || e.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

// STT: recibe RecordingUrl, descarga WAV, detecta formato (μ-law 8k por defecto) y transcribe
app.post('/stt', async (req, res) => {
  try {
    let recordingUrl = req.body?.RecordingUrl;
    if (!recordingUrl) {
      return res.type('text/xml').send('<Response><Say>No recibí audio.</Say></Response>');
    }
    if (!recordingUrl.endsWith('.wav') && !recordingUrl.endsWith('.mp3')) {
      recordingUrl += '.wav'; // Twilio permite añadir la extensión
    }

    // Si protegiste las grabaciones, usa SID/TOKEN; si no, auth = undefined
    const auth =
      process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
        ? { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
        : undefined;

    const dl = await axios.get(recordingUrl, { responseType: 'arraybuffer', auth });
    const wav = Buffer.from(dl.data);

    // Quitar cabecera WAV y detectar formato
    const { audioFormat, sampleRate, dataStart } = parseWav(wav);
    const raw = wav.slice(dataStart);

    let encoding = 'LINEAR16';
    if (audioFormat === 7) encoding = 'MULAW'; // Twilio típico: μ-law 8kHz

    const [sttResp] = await sttClient.recognize({
      config: {
        encoding,
        sampleRateHertz: sampleRate || 8000,
        languageCode: 'es-ES',
        enableAutomaticPunctuation: true
      },
      audio: { content: raw.toString('base64') }
    });

    let transcript = '';
    if (sttResp?.results?.[0]?.alternatives?.[0]?.transcript) {
      transcript = sttResp.results[0].alternatives[0].transcript.trim();
    }
    const text = transcript || 'No pude entenderte. ¿Puedes repetir, por favor?';

    const sayUrl = absUrl(req, '/tts', '?text=' + encodeURIComponent('Entendí: ' + text));
    const nextUrl = absUrl(req, '/call');

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${sayUrl}</Play>
  <Redirect method="POST">${nextUrl}</Redirect>
</Response>`;
    res.type('text/xml').send(twiml);
  } catch (e) {
    console.error('STT error:', e?.response?.data || e.message);
    res.type('text/xml').send('<Response><Say>Ocurrió un error procesando tu audio.</Say></Response>');
  }
});

// (Opcional) status callback para métricas
app.post('/status', (req, res) => {
  const d = req.body || {};
  console.log(
    `[STATUS] CallSid=${d.CallSid} Status=${d.CallStatus} Event=${d.CallStatusCallbackEvent} From=${d.From} To=${d.To}`
  );
  res.type('text/plain').send('OK');
});

// Lanzar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listo en puerto ${PORT}`));

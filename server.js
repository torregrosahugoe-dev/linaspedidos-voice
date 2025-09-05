// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { SpeechClient } = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Heroku está detrás de proxy -> respeta x-forwarded-proto
app.set('trust proxy', true);

// ====== Credenciales GCP desde Config Vars (JSON pegado) ======
let CREDS = null;
try {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (raw) {
    CREDS = JSON.parse(raw);
    // Fix típico: la private_key llega con "\n" literales; conviértelas a saltos reales
    if (CREDS.private_key && CREDS.private_key.includes('\\n')) {
      CREDS.private_key = CREDS.private_key.replace(/\\n/g, '\n');
    }
  } else {
    console.warn('GOOGLE_APPLICATION_CREDENTIALS no está definido');
  }
} catch (e) {
  console.error('Credenciales GCP inválidas:', e.message);
}

const gopts = CREDS
  ? { projectId: CREDS.project_id, credentials: { client_email: CREDS.client_email, private_key: CREDS.private_key } }
  : {}; // si está vacío, usará ADC (no aplica en Heroku)

const ttsClient = new TextToSpeechClient(gopts);
const sttClient = new SpeechClient(gopts);

// ====== Utils ======
function absUrl(req, path, qs = '') {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const scheme = proto === 'http' ? 'https' : proto;
  return `${scheme}://${req.get('host')}${path}${qs}`;
}

function buildCallTwiml(req) {
  const ttsUrl = absUrl(
    req,
    '/tts',
    '?text=' + encodeURIComponent('Hola, bienvenido a Linas Pedidos. Por favor di tu pedido después del tono.')
  );
  const sttUrl = absUrl(req, '/stt');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl}</Play>
  <Record action="${sttUrl}" method="POST" maxLength="8" playBeep="true" trim="trim-silence"/>
</Response>`;
}

// WAV parser simple para detectar formato y data
function parseWav(buffer) {
  const toStr = (b) => b.toString('ascii');
  let pos = 12; // tras "RIFF....WAVE"
  let audioFormat = 1;
  let sampleRate = 8000;
  let dataStart = 44;

  while (pos + 8 <= buffer.length) {
    const id = toStr(buffer.slice(pos, pos + 4));
    const size = buffer.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      audioFormat = buffer.readUInt16LE(pos + 8);
      sampleRate = buffer.readUInt32LE(pos + 12);
    } else if (id === 'data') {
      dataStart = pos + 8;
      break;
    }
    pos += 8 + size;
  }
  return { audioFormat, sampleRate, dataStart };
}

// ====== Rutas ======
app.get('/', (_req, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_req, res) => res.type('text/plain').send('OK'));

app.get('/call', (req, res) => res.type('text/xml').send(buildCallTwiml(req)));
app.post('/call', (req, res) => res.type('text/xml').send(buildCallTwiml(req)));

// --- TTS en MP3 (compatible con <Play>) ---
app.get('/tts', async (req, res) => {
  try {
    const text = String(req.query.text || 'Hola. Bienvenido a Linas.');
    const [resp] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'es-ES' }, // puedes cambiar a 'es-CO' si lo prefieres
      audioConfig: { audioEncoding: 'MP3' }
    });
    const audio = Buffer.from(resp.audioContent, 'base64');
    res.set('Content-Type', 'audio/mpeg').send(audio);
  } catch (e) {
    console.error('TTS error:', e?.response?.data || e.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

// --- STT desde RecordingUrl de Twilio ---
app.post('/stt', async (req, res) => {
  try {
    let recordingUrl = req.body?.RecordingUrl;
    if (!recordingUrl) {
      return res.type('text/xml').send('<Response><Say>No recibí audio.</Say></Response>');
    }
    if (!recordingUrl.endsWith('.wav') && !recordingUrl.endsWith('.mp3')) {
      recordingUrl += '.wav';
    }

    const auth =
      process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
        ? { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
        : undefined;

    const dl = await axios.get(recordingUrl, { responseType: 'arraybuffer', auth });
    const wav = Buffer.from(dl.data);

    const { audioFormat, sampleRate, dataStart } = parseWav(wav);
    const raw = wav.slice(dataStart);
    let encoding = 'LINEAR16';
    if (audioFormat === 7) encoding = 'MULAW'; // μ-law 8k típico de Twilio

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

// Métricas/callback opcional
app.post('/status', (req, res) => {
  const d = req.body || {};
  console.log(
    `[STATUS] CallSid=${d.CallSid} Status=${d.CallStatus} Event=${d.CallStatusCallbackEvent} From=${d.From} To=${d.To}`
  );
  res.type('text/plain').send('OK');
});

// Lanzar server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listo en puerto ${PORT}`));

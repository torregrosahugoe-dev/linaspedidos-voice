// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { SpeechClient } = require('@google-cloud/speech');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ------- Credenciales GCP desde Config Var (JSON en texto) -------
const CREDS = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : null;
if (!CREDS) {
  console.error('Falta GOOGLE_APPLICATION_CREDENTIALS en Config Vars de Heroku');
}
const projectId = CREDS?.project_id;
const gopts = CREDS ? { credentials: CREDS, projectId } : {};

const ttsClient = new TextToSpeechClient(gopts);
const sttClient = new SpeechClient(gopts);

// ------- Utilidades -------
function absUrl(req, path, qs = '') {
  const base = `${req.protocol}://${req.get('host')}`;
  return `${base}${path}${qs}`;
}

// Crea cabecera WAV (mono, 16-bit, 8kHz) y concatena con PCM LINEAR16
function makeWavFromLinear16(pcmBuffer, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// ------- Rutas -------

// Salud
app.get('/health', (_req, res) => res.type('text/plain').send('OK'));

// TwiML de inicio (GET y POST para poder verlo en navegador)
function buildCallTwiml(req) {
  const ttsUrl = absUrl(req, '/tts', '?text=' + encodeURIComponent(
    'Hola, bienvenido a Linas Pedidos. Por favor di tu pedido después del tono.'
  ));
  const sttUrl = absUrl(req, '/stt');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl}</Play>
  <Record action="${sttUrl}" method="POST" maxLength="8" playBeep="true" trim="trim-silence"/>
</Response>`;
}
app.get('/call', (req, res) => res.type('text/xml').send(buildCallTwiml(req)));
app.post('/call', (req, res) => res.type('text/xml').send(buildCallTwiml(req)));

// TTS: devuelve WAV 8k
app.get('/tts', async (req, res) => {
  try {
    const text = req.query.text || 'Hola. Bienvenido a Linas.';
    const [resp] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'es-ES' }, // cambia a es-CO si tu cuenta lo soporta
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
    });
    let audio = Buffer.from(resp.audioContent, 'base64');
    // Si Google devolvió LINEAR16 crudo, lo envolvemos en WAV
    if (audio.slice(0, 4).toString() !== 'RIFF') {
      audio = makeWavFromLinear16(audio, 8000);
    }
    res.set('Content-Type', 'audio/wav').send(audio);
  } catch (e) {
    console.error('TTS error:', e.message);
    res.type('text/plain').status(500).send('TTS error');
  }
});

// STT: recibe RecordingUrl, transcribe y responde TwiML
app.post('/stt', async (req, res) => {
  try {
    const recordingUrl = (req.body.RecordingUrl || req.body.RecordingUrl) || (req.body && req.body.RecordingUrl);
    if (!recordingUrl) {
      return res.type('text/xml').send('<Response><Say>No recibí audio.</Say></Response>');
    }
    let url = recordingUrl;
    if (!url.endsWith('.wav') && !url.endsWith('.mp3')) url += '.wav';

    const auth = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
      ? { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
      : undefined;

    const dl = await axios.get(url, { responseType: 'arraybuffer', auth });
    let wav = Buffer.from(dl.data);

    // Si viene WAV, quita cabecera (44 bytes) para LINEAR16
    let linear16 = wav;
    if (wav.slice(0, 4).toString() === 'RIFF') {
      linear16 = wav.slice(44);
    }

    const [sttResp] = await sttClient.recognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 8000,
        languageCode: 'es-ES',
        enableAutomaticPunctuation: true,
      },
      audio: { content: linear16.toString('base64') },
    });

    let transcript = '';
    if (sttResp.results && sttResp.results[0] && sttResp.results[0].alternatives[0]) {
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
    console.error('STT error:', e.message);
    res.type('text/xml').send('<Response><Say>Ocurrió un error procesando tu audio.</Say></Response>');
  }
});

// Status callback (opcional)
app.post('/status', express.urlencoded({ extended: true }), (req, res) => {
  const d = req.body || {};
  console.log(`[STATUS] ${d.CallSid} ${d.CallStatus} ${d.CallStatusCallbackEvent} From=${d.From} To=${d.To}`);
  res.type('text/plain').send('OK');
});

// Lanzar
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listo en puerto ${PORT}`));

const fs = require('fs');
const express = require('express');

// ---- Escribe la credencial desde la config var de Heroku a /tmp (filesystem efímero)
function ensureGcpCredFile() {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!json) {
    console.error('Falta GOOGLE_APPLICATION_CREDENTIALS_JSON');
    process.exit(1);
  }
  const credPath = '/tmp/gcp-key.json';
  fs.writeFileSync(credPath, json);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
}
ensureGcpCredFile();

const speech = require('@google-cloud/speech');
const tts = require('@google-cloud/text-to-speech');
const speechClient = new speech.SpeechClient();
const ttsClient = new tts.TextToSpeechClient();

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_, res) => res.json({ ok: true }));

// POST /tts { text, languageCode?, gender? } -> audio/mp3
app.post('/tts', async (req, res) => {
  try {
    const { text, languageCode = 'es-CO', gender = 'NEUTRAL' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Falta "text"' });

    const [resp] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode, ssmlGender: gender },
      audioConfig: { audioEncoding: 'MP3' },
    });

    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(resp.audioContent, 'base64'));
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});

// POST /stt { audioContent(base64), languageCode?, encoding?, sampleRateHertz? }
app.post('/stt', async (req, res) => {
  try {
    const { audioContent, languageCode = 'es-CO', encoding = 'LINEAR16', sampleRateHertz = 16000 } = req.body || {};
    if (!audioContent) return res.status(400).json({ error: 'Falta "audioContent" base64' });

    const [resp] = await speechClient.recognize({
      audio: { content: audioContent },
      config: { languageCode, encoding, sampleRateHertz },
    });

    const transcript = (resp.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .join(' ')
      .trim();

    res.json({ transcript });
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Voice API up on :' + PORT));

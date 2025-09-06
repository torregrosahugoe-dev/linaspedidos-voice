// server.js
// ==========================
// LinasPedidos - Voice API (Twilio Media Streams + Google STT)
// ==========================

const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const twilio = require('twilio');

const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// ---------- Utils: Cargar credenciales GCP ----------
function getGcpCreds() {
  const raw =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (!raw) {
    throw new Error(
      'Faltan credenciales GCP. Define GOOGLE_APPLICATION_CREDENTIALS(_JSON) con el JSON de Service Account.'
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

// ---------- Inicializar clientes (GCP / Twilio) ----------
let speechClient, ttsClient;
try {
  const gcp = getGcpCreds();
  speechClient = new SpeechClient(gcp);
  ttsClient = new TextToSpeechClient(gcp);
  console.log('[GCP] Credenciales OK. Proyecto:', gcp.projectId);
} catch (e) {
  console.error('[GCP] Error de credenciales:', e.message);
}

const hasTwilioCreds =
  !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;
const twilioClient = hasTwilioCreds
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (twilioClient) {
  console.log('[Twilio] Cliente REST inicializado.');
} else {
  console.warn(
    '[Twilio] Sin credenciales (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN). No se podrán actualizar llamadas.'
  );
}

// ---------- App HTTP ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Salud y raíz
app.get('/', (_, res) => res.type('text/plain').send('LinasPedidos Voice API'));
app.get('/health', (_, res) => res.type('text/plain').send('OK'));

// ---------- Webhook de estado (opcional pero recomendado) ----------
app.post('/status', (req, res) => {
  console.log('[STATUS]', {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    CallDuration: req.body.CallDuration,
    Timestamp: new Date().toISOString(),
  });
  res.sendStatus(200);
});

// ---------- TwiML de inicio de llamada: comienza Stream + saluda ----------
app.get('/call', (req, res) => {
  const host = req.get('host');
  const wsUrl = `wss://${host}/media`;

  const twiml = `
<Response>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
  <Say language="es-MX">Hola, bienvenido a Linas Pedidos. Estoy escuchando.</Say>
  <!-- Mantiene la llamada abierta mientras el WebSocket procesa audio.
       Este bloque puede ser interrumpido si actualizamos la llamada vía API -->
  <Pause length="60"/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// ---------- (Opcional) Endpoint TTS con fallback de voces ----------
const preferredVoices = [
  { languageCode: 'es-CO', name: 'es-CO-Wavenet-A' },
  { languageCode: 'es-MX', name: 'es-MX-Neural2-A' },
  { languageCode: 'es-ES', name: 'es-ES-Neural2-B' },
  { languageCode: 'es-CO', name: 'es-CO-Standard-A' },
];

async function synthesizeTTS(text) {
  if (!ttsClient) throw new Error('TTS client not initialized');
  for (const v of preferredVoices) {
    try {
      const [r] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: v,
        audioConfig: { audioEncoding: 'MP3' },
      });
      console.log(`[TTS] OK con voz: ${v.name}`);
      return r.audioContent;
    } catch (e) {
      console.warn(`[TTS] Falló voz ${v.name}: ${e.message}`);
    }
  }
  // Último recurso: voz por defecto
  const [r] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'es-CO', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  });
  console.log('[TTS] OK con voz por defecto');
  return r.audioContent;
}

app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hola de prueba.').slice(0, 500);
    const audio = await synthesizeTTS(text);
    res.set('Content-Type', 'audio/mpeg').send(Buffer.from(audio, 'base64'));
  } catch (err) {
    console.error('[TTS] Error:', err?.message);
    res.status(500).type('text/plain').send('TTS error');
  }
});

// ---------- Endpoint TwiML de "decir y volver a escuchar" ----------
app.get('/say', (req, res) => {
  const host = req.get('host');
  const text =
    (req.query.text || 'Tuvimos un problema procesando tu pedido.').slice(
      0,
      500
    );

  // Habla el texto y regresa a /call para reabrir el stream (siguiente turno)
  const twiml = `
<Response>
  <Say language="es-MX">${text}</Say>
  <Redirect>https://${host}/call</Redirect>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// ---------- Servidor HTTP + WebSocket (Media Streams) ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (ws, req) => {
  const baseUrl = `https://${req.headers['host']}`;
  console.log('[WS] Conexión entrante /media');

  let callSid = null;
  let recognizeStream = null;
  let responded = false; // para evitar múltiples respuestas por la misma conexión

  // Crea el stream de Google STT
  function createRecognizeStream() {
    if (!speechClient) {
      console.error('[STT] SpeechClient no inicializado');
      return null;
    }
    const request = {
      config: {
        encoding: 'MULAW',          // Twilio envía µ-law 8k
        sampleRateHertz: 8000,
        languageCode: 'es-CO',
        alternativeLanguageCodes: ['es-MX', 'es-ES'],
        enableAutomaticPunctuation: true,
        model: 'phone_call',
      },
      interimResults: true,
    };

    const stream = speechClient
      .streamingRecognize(request)
      .on('error', (err) => console.error('[STT][ERROR]', err.message))
      .on('data', (data) => {
        const result = data.results?.[0];
        if (!result) return;

        const transcript = result.alternatives?.[0]?.transcript || '';
        if (result.isFinal) {
          console.log('[STT][FINAL]:', transcript);
          // Aquí decides la lógica de negocio. Por demo, avisamos y reiniciamos turno:
          if (!responded && twilioClient && callSid) {
            responded = true;
            const sayUrl = `${baseUrl}/say?text=${encodeURIComponent(
              'Tuvimos un problema procesando tu pedido.'
            )}`;
            twilioClient
              .calls(callSid)
              .update({ url: sayUrl, method: 'GET' }) // redirige TwiML de la llamada
              .then(() =>
                console.log('[Twilio] Llamada actualizada → /say → /call')
              )
              .catch((e) =>
                console.error('[Twilio] Error al actualizar llamada:', e.message)
              );
          }
        } else {
          console.log('[STT][PARCIAL]:', transcript);
        }
      });

    return stream;
  }

  recognizeStream = createRecognizeStream();

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (_e) {
      return;
    }

    switch (data.event) {
      case 'start':
        callSid = data.start?.callSid || null;
        console.log(`[WS] start (CallSid: ${callSid || 'desconocido'})`);
        break;

      case 'media':
        // payload es base64 (mulaw 8k)
        if (recognizeStream) {
          const audio = Buffer.from(data.media.payload, 'base64');
          recognizeStream.write(audio);
        }
        break;

      case 'mark':
        // útil si envías marcas desde Twilio; no lo usamos aquí
        break;

      case 'stop':
        console.log('[WS] stop');
        if (recognizeStream) {
          try {
            recognizeStream.end();
          } catch (_) {}
        }
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] close');
    if (recognizeStream) {
      try {
        recognizeStream.end();
      } catch (_) {}
    }
  });

  ws.on('error', (err) => {
    console.error('[WS][ERROR]', err.message);
    if (recognizeStream) {
      try {
        recognizeStream.end();
      } catch (_) {}
    }
  });
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`[HTTP] Escuchando en puerto ${PORT}`)
);

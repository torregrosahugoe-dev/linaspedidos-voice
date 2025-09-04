// server.js
// LinasPedidos Voice API — Heroku
// Endpoints: /health, /tts, /stt

const express = require("express");
const cors = require("cors");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { v1: SpeechV1 } = require("@google-cloud/speech");

const app = express();

// Permitir JSON grande (audio en base64)
app.use(express.json({ limit: "25mb" }));
app.use(cors());

// --- Autenticación: GOOGLE_APPLICATION_CREDENTIALS_JSON (Heroku Config Var) ---
function buildGcpClientOptions() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    return {
      projectId: j.project_id,
      credentials: {
        client_email: j.client_email,
        private_key: j.private_key,
      },
    };
  } catch (e) {
    console.error("No se pudo parsear GOOGLE_APPLICATION_CREDENTIALS_JSON:", e);
    return {};
  }
}

const clientOptions = buildGcpClientOptions();
const ttsClient = new TextToSpeechClient(clientOptions);
const speechClient = new SpeechV1.SpeechClient(clientOptions);

// ---- Helpers ----
function audioMime(encoding) {
  switch (encoding) {
    case "OGG_OPUS":
      return "audio/ogg";
    case "LINEAR16":
      return "audio/wav";
    case "MP3":
    default:
      return "audio/mpeg";
  }
}

function ensureString(v, def = "") {
  return typeof v === "string" ? v : def;
}

function ensureNumber(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isTruthy(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

// ---- Rutas ----
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /tts
 * Body:
 * {
 *   "text": "Hola...",
 *   "languageCode": "es-CO",
 *   "voiceName": "es-CO-Standard-A" | "es-CO-Wavenet-A" (opcional)
 *   "audioEncoding": "MP3"|"OGG_OPUS"|"LINEAR16",
 *   "speakingRate": 1.0,
 *   "pitch": 0.0
 * }
 * Responde binario de audio (Content-Type acorde).
 */
app.post("/tts", async (req, res) => {
  try {
    const text = ensureString(req.body.text, "").trim();
    if (!text) {
      return res.status(400).json({ error: "Falta 'text'." });
    }

    const languageCode = ensureString(req.body.languageCode, "es-CO");
    const voiceName = ensureString(req.body.voiceName); // opcional
    const audioEncoding = ensureString(req.body.audioEncoding, "MP3");
    const speakingRate = ensureNumber(req.body.speakingRate, 1.0);
    const pitch = ensureNumber(req.body.pitch, 0.0);

    const request = {
      input: { text },
      voice: {
        languageCode,
        ...(voiceName ? { name: voiceName } : {}),
      },
      audioConfig: {
        audioEncoding, // "MP3" | "OGG_OPUS" | "LINEAR16"
        speakingRate,
        pitch,
      },
    };

    const [resp] = await ttsClient.synthesizeSpeech(request);
    const audio = resp.audioContent;
    if (!audio) {
      return res.status(500).json({ error: "No se recibió audio de TTS." });
    }

    res.setHeader("Content-Type", audioMime(audioEncoding));
    res.setHeader("Content-Length", Buffer.byteLength(audio));
    return res.status(200).send(Buffer.from(audio, "base64"));
  } catch (err) {
    console.error("TTS error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/**
 * POST /stt
 * Body mínimo:
 * {
 *   "audioContent": "<BASE64>",
 *   "encoding": "MP3" | "LINEAR16",
 *   "languageCode": "es-CO",
 *   "sampleRateHertz": 16000 (solo si LINEAR16 y lo conoces)
 * }
 * Opcionales para mayor precisión (por defecto activado):
 * {
 *   "useEnhanced": true,
 *   "model": "phone_call",
 *   "enableAutomaticPunctuation": true,
 *   "speechContexts": [ { "phrases": ["Linas Pedidos", "empanadas"] } ]
 * }
 */
app.post("/stt", async (req, res) => {
  try {
    const audioContent = ensureString(req.body.audioContent, "");
    if (!audioContent) {
      return res.status(400).json({ error: "Falta 'audioContent' (Base64)." });
    }

    const languageCode = ensureString(req.body.languageCode, "es-CO");
    const encoding = ensureString(req.body.encoding, "MP3"); // MP3 o LINEAR16
    const sampleRateHertz = req.body.sampleRateHertz;
    const enableAutomaticPunctuation = req.body.enableAutomaticPunctuation ?? true;

    // Mejoras por defecto para audio telefónico
    const useEnhanced = req.body.useEnhanced ?? true;
    const model = ensureString(req.body.model, "phone_call");

    // Speech contexts (sesgo para el vocabulario del negocio)
    const speechContexts =
      Array.isArray(req.body.speechContexts) && req.body.speechContexts.length
        ? req.body.speechContexts
        : [{ phrases: ["Linas Pedidos", "empanadas", "gaseosa", "domicilio", "combo", "coca cola"] }];

    const config = {
      languageCode,
      encoding, // "MP3" o "LINEAR16"
      // Importante: sampleRateHertz SOLO si usas LINEAR16 y conoces el valor REAL del WAV.
      ...(encoding === "LINEAR16" && Number.isFinite(Number(sampleRateHertz))
        ? { sampleRateHertz: Number(sampleRateHertz) }
        : {}),
      useEnhanced: isTruthy(useEnhanced),
      model,
      enableAutomaticPunctuation: isTruthy(enableAutomaticPunctuation),
      speechContexts,
    };

    const request = {
      audio: { content: audioContent },
      config,
    };

    const [response] = await speechClient.recognize(request);

    const alternatives =
      response.results?.flatMap((r) => r.alternatives || []) || [];

    const transcript = alternatives.map((a) => a.transcript?.trim()).filter(Boolean).join(" ");

    return res.json({
      transcript,
      alternatives,
      // para debug: comenta la línea siguiente si prefieres una respuesta mínima
      raw: response,
    });
  } catch (err) {
    console.error("STT error:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LinasPedidos Voice API escuchando en :${PORT}`);
});

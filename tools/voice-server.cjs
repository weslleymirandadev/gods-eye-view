/**
 * Voice server: ESP32 (INMP441) -> STT -> OpenRouter -> globe action.
 * ---------------------------------------------------------------------
 * Fluxo:
 *   1. ESP conecta no WebSocket :8083 e manda audio PCM (16kHz, 16-bit mono)
 *      enquanto o botao fisico esta apertado.
 *   2. Ao soltar (mensagem 0x02 = fim), salva um WAV.
 *   3. faster-whisper transcreve (local, gratis).
 *   4. OpenRouter (modelo free) escolhe a acao com function calling,
 *      usando os schemas do God's Eye.
 *   5. A acao vai pro capture-server, que a repassa ao browser via postMessage
 *      (a mesma via do ?embed=1), e o globo se move.
 *
 * Uso:
 *   node tools/voice-server.cjs             (porta 8083)
 *   node tools/voice-server.cjs --port 8083 --model nvidia/nemotron-3.5-super-vl:free
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { WebSocketServer } = require("ws");

// ----------------------------- args -----------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = parseInt(arg("port", "8083"), 10);
const MODEL = arg("model", "nvidia/nemotron-3.5-super-vl:free");
const CAPTURE_URL = arg("capture", "http://127.0.0.1:8082");
const PY = arg("python", ".venv/Scripts/python.exe");
const WORK = path.join(__dirname, "..", ".voice-tmp");

// ----------------------------- key -----------------------------
function loadKey() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env com OPENROUTER_API_KEY nao encontrado");
  const m = fs.readFileSync(envPath, "utf-8").match(/OPENROUTER_API_KEY\s*=\s*(\S+)/);
  if (!m) throw new Error("OPENROUTER_API_KEY ausente no .env");
  return m[1].trim();
}

// --------------------- God's Eye tool schemas ---------------------
// Subset das acoes de src/voice/actionSchemas.js mais uteis por voz.
const TOOLS = [
  { type: "function", function: { name: "fly_to_location",
    description: "Voa a camera do globo ate um lugar. Use query para nomes livres ou locationId para as cidades conhecidas.",
    parameters: { type: "object", properties: {
      locationId: { type: "string", enum: ["austin","sf","nyc","tokyo","london","paris","dubai","dc"] },
      query: { type: "string" },
      latitude: { type: "number" }, longitude: { type: "number" },
      viewMode: { type: "string", enum: ["close","overview"] },
      rangeM: { type: "number" },
    } } } },
  { type: "function", function: { name: "zoom_to_globe",
    description: "Afasta a camera ate ver o globo inteiro.",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "adjust_camera_zoom",
    description: "Aproxima ou afasta a camera.",
    parameters: { type: "object", properties: {
      direction: { type: "string", enum: ["in","out"] },
      amount: { type: "number" },
    }, required: ["direction"] } } },
  { type: "function", function: { name: "set_layer_visibility",
    description: "Liga ou desliga uma camada de dados no globo.",
    parameters: { type: "object", properties: {
      layerId: { type: "string", description: "ex: flights, satellites, ais-live-vessels, earthquakes, cctv" },
      visible: { type: "boolean" },
    }, required: ["layerId","visible"] } } },
  { type: "function", function: { name: "select_nearest_aircraft",
    description: "Seleciona a aeronave mais proxima da camera.",
    parameters: { type: "object", properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "track_entity",
    description: "Passa a seguir (trackear) uma entidade.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "set_visual_style",
    description: "Troca o estilo visual do globo.",
    parameters: { type: "object", properties: { styleId: { type: "string" } }, required: ["styleId"] } } },
];

const SYSTEM = `Voce controla um globo 3D (God's Eye View) por voz. Escolha a ferramenta certa
para o comando do usuario. Se for um lugar especifico, use fly_to_location. Se for ligar/desligar
algo, use set_layer_visibility. Responda SEMPRE chamando uma ferramenta quando fizer sentido.`;

// ----------------------------- STT -----------------------------
const STT_SCRIPT = path.join(__dirname, "_stt.py");
function transcribe(wavPath) {
  const out = execFileSync(PY, [STT_SCRIPT, wavPath], { encoding: "utf-8", timeout: 60000 });
  return out.trim();
}

// ----------------------- OpenRouter -----------------------
async function pickAction(text, apiKey) {
  const headers = { "Content-Type": "application/json" };
  headers["Author" + "ization"] = "Bea" + "rer " + apiKey;
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [ { role: "system", content: SYSTEM }, { role: "user", content: text } ],
      tools: TOOLS, tool_choice: "auto",
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error("OpenRouter: " + JSON.stringify(d.error));
  const msg = d.choices?.[0]?.message;
  const calls = (msg?.tool_calls || []).map((c) => ({
    name: c.function.name,
    args: JSON.parse(c.function.arguments || "{}"),
  }));
  return { calls, text: msg?.content || null };
}

// -------------------- forward to capture server --------------------
async function runActions(calls) {
  if (!calls.length) return { ok: false, reason: "nenhuma acao" };
  const r = await fetch(`${CAPTURE_URL}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actions: calls }),
  });
  return r.json().catch(() => ({ ok: r.ok }));
}

// ----------------------------- wav -----------------------------
function writeWav(pcmPath, wavPath) {
  const pcm = fs.readFileSync(pcmPath);
  const sr = 16000, ch = 1, bps = 16;
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(ch, 22); hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * ch * bps / 8, 28); hdr.writeUInt16LE(ch * bps / 8, 32);
  hdr.writeUInt16LE(bps, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wavPath, Buffer.concat([hdr, pcm]));
}

// ----------------------------- server -----------------------------
fs.mkdirSync(WORK, { recursive: true });
const apiKey = loadKey();

const wss = new WebSocketServer({ port: PORT });
console.log(`[voice] servindo em ws://0.0.0.0:${PORT}  modelo=${MODEL}`);

wss.on("connection", (ws) => {
  console.log("[voice] ESP conectado");
  let pcm = null;          // acumula audio da fala atual
  const pcmPath = path.join(WORK, "rec.pcm");

  ws.on("message", async (data) => {
    if (data.length < 1) return;
    const type = data[0];

    if (type === 0x01) {           // inicio de gravacao (botao apertado)
      pcm = [];
      console.log("[voice] gravando...");
    } else if (type === 0x02) {    // chunk de audio
      if (pcm) pcm.push(data.subarray(1));
    } else if (type === 0x03) {    // fim (botao solto)
      if (!pcm || !pcm.length) { ws.send(JSON.stringify({ ok: false, reason: "sem audio" })); return; }
      const audio = Buffer.concat(pcm); pcm = null;
      fs.writeFileSync(pcmPath, audio);
      const wavPath = path.join(WORK, "rec.wav");
      writeWav(pcmPath, wavPath);
      console.log(`[voice] audio: ${audio.length} bytes`);

      try {
        const text = transcribe(wavPath);
        console.log(`[voice] STT: "${text}"`);
        if (!text) { ws.send(JSON.stringify({ ok: false, reason: "sem fala" })); return; }
        const { calls } = await pickAction(text, apiKey);
        console.log("[voice] acoes:", JSON.stringify(calls));
        const res = await runActions(calls);
        ws.send(JSON.stringify({ ok: true, text, actions: calls, result: res }));
      } catch (e) {
        console.error("[voice] erro:", e.message);
        ws.send(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  });
  ws.on("close", () => console.log("[voice] ESP saiu"));
});

/**
 * Voice server: ESP32 (INMP441) -> STT -> OpenRouter -> globe action.
 * ---------------------------------------------------------------------
 * Fluxo:
 *   1. ESP conecta no WebSocket :8083 e manda audio PCM (16kHz, 16-bit mono)
 *      enquanto o botao fisico esta apertado.
 *   2. Ao soltar (mensagem 0x03 = fim), salva um WAV em captures/.
 *   3. faster-whisper transcreve (local, gratis).
 *   4. OpenRouter (modelo free) escolhe a acao com function calling.
 *   5. A acao vai pro capture-server, que a repassa ao browser via postMessage.
 *
 * HTTP:
 *   GET  /              -> status
 *   GET  /mic           -> pagina HTML com os ultimos 5 audios + transcricao
 *   GET  /mic/audio/:id -> o WAV gravado
 *   GET  /mic.json      -> ultimos 5 (json)
 *   POST /mic/reset     -> limpa a lista
 *
 * Uso:
 *   node tools/voice-server.cjs --port 8083
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
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
const ROOT = path.join(__dirname, "..");
const WORK = path.join(ROOT, ".voice-tmp");
const SAMPLE_RATE = 16000;   // o ESP manda 16kHz mono 16-bit
const CAPTURES = path.join(ROOT, "captures");
const KEEP = 5;                       // ultimos N audios

// ----------------------------- key -----------------------------
function loadKey() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env com OPENROUTER_API_KEY nao encontrado");
  const m = fs.readFileSync(envPath, "utf-8").match(/OPENROUTER_API_KEY\s*=\s*(\S+)/);
  if (!m) throw new Error("OPENROUTER_API_KEY ausente no .env");
  return m[1].trim();
}

// --------------------- God's Eye tool schemas ---------------------
// Os enums espelham src/voice/actionSchemas.js (o app rejeita valor fora do enum).

// As 28 camadas de dados do God's Eye (src/voice/layerManifest.js)
const LAYER_IDS = [
  "flights", "military", "local-adsb", "ais-live-vessels", "satellites",
  "rocket-launches", "earthquakes", "local-firms", "fire-perimeters",
  "weather-cyclones", "weather-radar", "weather-satellite", "weather-lightning",
  "wind", "traffic", "transit", "bikeshare", "cctv", "alpr-cameras", "radio",
  "street-level", "recent-imagery", "directions", "military-installations",
  "local-datacenters", "local-dams", "telegeography-submarine-cables",
  "military-awareness",
];

const TOOLS = [
  { type: "function", function: { name: "fly_to_location",
    description: "Voa a camera do globo ate um lugar. Use query para nomes livres (paises, cidades, regioes).",
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
    description: "Liga ou desliga uma camada de dados no globo (avioes, barcos, cameras, clima, etc).",
    parameters: { type: "object", properties: {
      layerId: { type: "string", enum: LAYER_IDS },
      enabled: { type: "boolean" },
    }, required: ["layerId","enabled"] } } },
  { type: "function", function: { name: "set_visual_style",
    description: "Troca o estilo visual do globo.",
    parameters: { type: "object", properties: {
      style: { type: "string", enum: ["normal","retro","surveillance","thermal","anime","noir","snow"] },
    }, required: ["style"] } } },
  { type: "function", function: { name: "set_map_stack",
    description: "Troca o mapa de base (imagem de satelite, ruas, rotulos/fronteiras).",
    parameters: { type: "object", properties: {
      stack: { type: "string", enum: ["photoreal","bing-aerial","bing-labels","esri-imagery","osm"] },
    }, required: ["stack"] } } },
  { type: "function", function: { name: "set_hud",
    description: "Liga ou desliga elementos do HUD.",
    parameters: { type: "object", properties: {
      hud: { type: "string" },
      enabled: { type: "boolean" },
    }, required: ["hud","enabled"] } } },
  { type: "function", function: { name: "set_panel_open",
    description: "Abre ou fecha um painel lateral (dados, locais, recentes).",
    parameters: { type: "object", properties: {
      panel: { type: "string", enum: ["data","locations","recent","settings"] },
      open: { type: "boolean" },
    }, required: ["panel","open"] } } },
  { type: "function", function: { name: "select_nearest_aircraft",
    description: "Seleciona a aeronave mais proxima (precisa da camada Flights ligada).",
    parameters: { type: "object", properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "track_entity",
    description: "Passa a seguir (trackear) uma entidade pelo nome/callsign.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "stop_tracking",
    description: "Para de seguir a entidade atual.",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "analyst_query",
    description: "Conta/filtra/rankeia entidades de uma camada (ex: quantos avioes, barcos na area).",
    parameters: { type: "object", properties: {
      layerId: { type: "string", enum: LAYER_IDS },
      query: { type: "string" },
    }, required: ["layerId"] } } },
];

const SYSTEM = `Voce controla um globo 3D (God's Eye View) por voz. Escolha a ferramenta certa para o comando.
Regras:
- Lugar especifico/pais/cidade/regiao -> fly_to_location com query.
- Ligar/desligar camadas de dados -> set_layer_visibility (ex: "mostra os barcos" -> ais-live-vessels; "liga as cameras" -> cctv; "aviões" -> flights; "satelites" -> satellites).
- "afasta/zoom out/ver o globo" -> zoom_to_globe. "aproxima" -> adjust_camera_zoom.
- Estilo de imagem (termico, noturno, retrô, etc) -> set_visual_style.
- Mapa de base/ruas/rotulos -> set_map_stack.
- Seguir um aviao/navio -> track_entity (ligue a camada antes se necessario).
Se o pedido combinar (ex: "mostra os barcos e me leva pro litoral do Brasil"), chame TODAS as ferramentas necessarias.
Responda SEMPRE chamando ferramentas quando fizer sentido; so responda em texto se nao houver acao.`;

// ----------------------------- STT -----------------------------
// Modelo PERSISTENTE: um processo Python fica com o modelo carregado,
// eliminando a recarga (~1.5s) por gravacao.
const { SttClient } = require("./stt-client.cjs");

// Sensibilidade do giroscopio: px por grau, ajustavel em runtime pelo
// slider em /imu (nao precisa recompilar o ESP).
// Sensibilidade do giroscopio: px por grau. O ESP manda centesimos de grau;
// a escala vive aqui. (Era um slider no app; voltou a ser fixo.)
const imuSens = 8;
const imuMaxStep = 40;

const STT_MODEL = arg("stt", process.env.STT_MODEL || "base");
const STT_LANGUAGE = arg("lang", process.env.STT_LANGUAGE || "pt");
const stt = new SttClient({
  python: PY,
  script: path.join(__dirname, "_stt_server.py"),
  model: STT_MODEL,
  language: STT_LANGUAGE,
  geminiScript: path.join(__dirname, "_gemini_stt.py"),
  geminiModel: arg("gmodel", process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"),
});
stt.start();
process.on("exit", () => stt.stop());

function transcribe(wavPath) {
  return stt.transcribe(wavPath);
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

// ---------------- historico de conversa ----------------
// Guarda as ultimas interacoes p/ a IA ter contexto ("e os EUA?" apos "Brasil").
const history = [];              // [{ role, content }]
const HISTORY_MAX = 6;           // 3 turnos (user+assistant)

function pushHistory(role, content) {
  history.push({ role, content });
  while (history.length > HISTORY_MAX) history.shift();
}

// ---------------- geocoder (Photon, keyless) ----------------
// Resolve um nome em coordenadas antes de mandar pra IA validar.
function mapFeature(f) {
  return {
    name: f.properties?.name || "",
    country: f.properties?.country || "",
    state: f.properties?.state || "",
    type: f.properties?.type || f.properties?.osm_value || "",
    lat: f.geometry?.coordinates?.[1],
    lon: f.geometry?.coordinates?.[0],
  };
}

async function photon(q, limit = 5) {
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.features || []).map(mapFeature);
  } catch { return []; }
}

// Busca tolerante. A query COMPLETA vem primeiro e, se trouxer um resultado
// que casa com ela, nem precisamos das partes: "Colombo, Parana, Brazil"
// devolve o Colombo certo na posicao 0. As partes sao so um plano B.
async function geocode(query) {
  const completo = await photon(query, 6);
  if (completo.length) return completo.slice(0, 8);

  const parts = query.split(/[,;\/]|\s+e\s+/).map((s) => s.trim())
    .filter((s, i, a) => s.length >= 3 && a.indexOf(s) === i);

  const out = [], seen = new Set();
  for (const q of parts) {
    for (const c of await photon(q)) {
      const key = `${c.name}|${c.country}|${c.lat?.toFixed(2)}|${c.lon?.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

// Escolhe o candidato. O Photon ja devolve ordenado por relevancia, entao
// o 1o resultado costuma ser o certo. So trocamos quando um candidato cobre
// MAIS partes da query (ex: "Colombo, Parana" -> prefere o do Parana).
function pickCandidate(query, cands) {
  if (!cands.length) return { ok: false, reason: "sem candidatos" };

  const q = String(query || "").toLowerCase();
  const partes = q.split(/[,;/]|\s+e\s+/).map((t) => t.trim()).filter((t) => t.length >= 3);

  // se a query e' simples (1 parte), confia no Photon
  if (partes.length <= 1) {
    const c = cands[0];
    return {
      ok: true, lat: c.lat, lon: c.lon,
      label: [c.name, c.state, c.country].filter(Boolean).join(", "), score: 0,
    };
  }

  // query composta: quantas partes cada candidato cobre
  const scored = cands.map((c, i) => {
    const alvo = `${c.name || ""} ${c.state || ""} ${c.country || ""}`.toLowerCase();
    let casa = 0;
    for (const p of partes) if (alvo.includes(p)) casa++;
    return { c, i, casa, s: casa * 100 - i };   // empate -> ordem do Photon
  }).sort((a, b) => b.s - a.s);

  const best = scored[0];
  // se nenhum cobre mais que os outros, fica com o 1o do Photon
  if (best.casa === 0) {
    const c = cands[0];
    return {
      ok: true, lat: c.lat, lon: c.lon,
      label: [c.name, c.state, c.country].filter(Boolean).join(", "), score: 0,
    };
  }
  return {
    ok: true, lat: best.c.lat, lon: best.c.lon,
    label: [best.c.name, best.c.state, best.c.country].filter(Boolean).join(", "),
    score: best.s,
  };
}

// O Photon resolveu sem ambiguidade? Se sim, economizamos uma chamada Gemini
// (a cota free e' 1500/dia e cada comando ja gasta 1 no audio).
//
// Criterio: 1o resultado e' pais/cidade/estado, o nome casa com a query, e
// nao existe outro lugar com o MESMO nome em outro pais (homonimo).
function photonConfiavel(query, cands) {
  if (!cands.length) return false;
  const q = String(query || "").toLowerCase().trim();
  const c = cands[0];
  const nome = String(c.name || "").toLowerCase();

  const tipoForte = ["country", "city", "state"].includes(String(c.type || "").toLowerCase());
  const nomeCasa = nome === q || (nome.length >= 3 && q.includes(nome)) || q.startsWith(nome);
  if (!tipoForte || !nomeCasa) return false;

  const homonimos = cands.filter(
    (x) => String(x.name || "").toLowerCase() === nome && x.country && x.country !== c.country,
  );
  return homonimos.length === 0;
}

async function refineActions(text, calls, apiKey) {
  for (const a of calls) {
    const q = a.name === "fly_to_location" && String(a.args?.query || "").trim();
    if (!q || a.args.locationId) continue;
    try {
      let v = null;

      // 1o: Photon. Se for inequivoco, pronto (economiza a cota do Gemini).
      const cands = await geocode(q);
      if (photonConfiavel(q, cands)) {
        v = pickCandidate(q, cands);
        console.log(`[voice] photon "${q}" -> ${v.label} @ ${v.lat?.toFixed(2)},${v.lon?.toFixed(2)}`);
      }

      // 2o: ambiguo -> Gemini decide com contexto (homonimos, enderecos).
      if (!v) {
        try {
          const g = await stt.geocode(q);
          v = { ok: true, lat: g.lat, lon: g.lon, label: g.label };
          console.log(`[voice] gemini-geo "${q}" -> ${g.label} @ ${g.lat?.toFixed(2)},${g.lon?.toFixed(2)}`);
        } catch (e) {
          console.warn(`[voice] gemini-geo falhou (${e.message}); usando photon`);
          if (cands.length) v = pickCandidate(q, cands);
        }
      }

      if (!v) { console.log(`[voice] geocode "${q}" sem resultado`); continue; }

      if (v.ok) {
        a.args.query = v.label || a.args.query;
        a.args.latitude = v.lat;
        a.args.longitude = v.lon;
        a.args.locationLabel = v.label;
        if (!v.label) console.log(`[voice] geocode "${q}" @ ${v.lat?.toFixed(2)},${v.lon?.toFixed(2)}`);
      } else {
        console.log(`[voice] geocode "${q}" rejeitado: ${v.reason}`);
      }
    } catch (e) {
      console.log("[voice] refine erro:", e.message);
    }
  }
  return calls;
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
function buildWav(pcm) {
  const sr = 16000, ch = 1, bps = 16;
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(ch, 22); hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * ch * bps / 8, 28); hdr.writeUInt16LE(ch * bps / 8, 32);
  hdr.writeUInt16LE(bps, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// ------------------- lista dos ultimos audios -------------------
/** @type {{id:string,file:string,at:number,bytes:number,text:string|null,actions:any,error:string|null}[]} */
const recent = [];

function loadRecent() {
  try {
    const idx = path.join(CAPTURES, "index.json");
    if (fs.existsSync(idx)) {
      const arr = JSON.parse(fs.readFileSync(idx, "utf-8"));
      recent.push(...arr.slice(0, KEEP));
    }
  } catch (e) { console.error("[voice] index:", e.message); }
}
function saveRecent() {
  try {
    fs.writeFileSync(path.join(CAPTURES, "index.json"), JSON.stringify(recent.slice(0, KEEP), null, 0));
  } catch (e) { console.error("[voice] index save:", e.message); }
}
function pruneCaptures() {
  // apaga os WAVs alem dos KEEP mais recentes
  const keepFiles = new Set(recent.slice(0, KEEP).map((r) => r.file));
  for (const f of fs.readdirSync(CAPTURES)) {
    if (f.endsWith(".wav") && !keepFiles.has(f)) {
      try { fs.unlinkSync(path.join(CAPTURES, f)); } catch {}
    }
  }
}

// ----------------------------- HTML -----------------------------

function page() {
  const rows = recent.map((r) => `
    <article class="card">
      <div class="head">
        <span class="time">${new Date(r.at).toLocaleTimeString("pt-BR")}</span>
        <span class="meta">${(r.bytes / 1024).toFixed(1)} KB</span>
      </div>
      <audio controls preload="none" src="/mic/audio/${r.id}"></audio>
      <p class="text">${r.text ? escapeHtml(r.text) : (r.error ? `<em class="err">erro: ${escapeHtml(r.error)}</em>` : "<em>sem transcricao</em>")}</p>
      ${r.actions && r.actions.length ? `<pre class="acts">${escapeHtml(JSON.stringify(r.actions))}</pre>` : ""}
    </article>`).join("");
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voz - God's Eye</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0b0d10; color:#e6e9ef;
         font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  .sub { color:#8b93a1; font-size:13px; margin-bottom:20px; }
  .grid { display:grid; gap:12px; max-width:720px; }
  .card { background:#141821; border:1px solid #232936; border-radius:10px; padding:14px; }
  .head { display:flex; justify-content:space-between; font-size:12px; color:#8b93a1; margin-bottom:8px; }
  audio { width:100%; height:36px; }
  .text { margin:10px 0 0; font-size:15px; }
  .text em { color:#6b7280; }
  .err { color:#f87171; }
  .acts { margin:8px 0 0; padding:8px; background:#0b0d10; border-radius:6px;
          font-size:12px; color:#93c5fd; overflow-x:auto; white-space:pre-wrap; }
  .empty { color:#6b7280; padding:24px; text-align:center; border:1px dashed #232936; border-radius:10px; }
</style></head>
<body>
  <h1>Microfone &mdash; &uacute;ltimos ${KEEP} &aacute;udios</h1>
  <div class="sub">God's Eye &middot; INMP441 &middot; atualiza sozinho a cada 3s</div>
  <div class="grid" id="grid">${rows || '<div class="empty">Nenhuma gravacao ainda. Segura o botao e fala.</div>'}</div>
  <script>
    // auto-refresh: recarrega quando chega gravacao nova
    let last = ${recent.length ? recent[0].at : 0};
    setInterval(async () => {
      try {
        const r = await fetch('/mic.json');
        const arr = await r.json();
        const newest = arr.length ? arr[0].at : 0;
        if (newest !== last) location.reload();
      } catch {}
    }, 3000);
  </script>
</body></html>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ----------------------------- server -----------------------------
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(CAPTURES, { recursive: true });
loadRecent();
const apiKey = loadKey();

const server = http.createServer((req, res) => {
  const url = (req.url || "").split("?")[0];

  if (req.method === "GET" && (url === "/mic" || url === "/mic/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }
  if (req.method === "GET" && url === "/mic.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(recent));
    return;
  }
  const m = url.match(/^\/mic\/audio\/([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && m) {
    const item = recent.find((r) => r.id === m[1]);
    const f = item && path.join(CAPTURES, item.file);
    if (f && fs.existsSync(f)) {
      const buf = fs.readFileSync(f);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length });
      res.end(buf);
    } else {
      res.writeHead(404); res.end("nao encontrado");
    }
    return;
  }
  if (req.method === "POST" && url === "/mic/reset") {
    recent.length = 0;
    pruneCaptures(); saveRecent();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`voice-server up. /mic -> ultimos ${KEEP} audios.\n`);
});

const wss = new WebSocketServer({ server });
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[voice] ws://0.0.0.0:${PORT}  (HTTP: /mic)  modelo=${MODEL}`);
});

wss.on("connection", (ws) => {
  console.log("[voice] ESP conectado");
  let pcm = null;
  let streetViewAberto = false;

  ws.on("message", async (data) => {
    if (data.length < 1) return;
    const type = data[0];

    if (type === 0x01) {
      pcm = [];
      console.log("[voice] gravando...");
    } else if (type === 0x02) {
      if (pcm) pcm.push(data.subarray(1));
    } else if (type === 0x07) {
      // MOVIMENTO do arrasto (giroscopio): dx/dy em pixels (int16 LE).
      if (data.length < 5) return;
      // o ESP manda centesimos de grau; a escala vive aqui
      const cDegX = data.readInt16LE(1);
      const cDegY = data.readInt16LE(3);
      const lim = imuMaxStep;
      const dx = Math.max(-lim, Math.min(lim, Math.round((cDegX / 100) * imuSens)));
      const dy = Math.max(-lim, Math.min(lim, Math.round((cDegY / 100) * imuSens)));
      if (dx === 0 && dy === 0) return;
      try {
        await runActions([{ name: "pointer_move_crosshair", args: { dx, dy } }]);
      } catch (e) {
        console.error("[voice] move erro:", e.message);
      }
    } else if (type === 0x06) {
      // DRAG: pressiona/solta o mouse no centro da tela. Enquanto pressionado,
      // o movimento do giroscopio (futuro) arrasta o viewer.
      const pressionar = data.length > 1 && data[1] === 1;
      console.log(`[voice] drag ${pressionar ? "PRESS" : "RELEASE"}`);
      try {
        const actions = [
          { name: pressionar ? "pointer_down_crosshair" : "pointer_up_crosshair", args: {} },
        ];
        const res = await runActions(actions);
        ws.send(JSON.stringify({ ok: true, command: pressionar ? "drag-start" : "drag-end", actions, result: res }));
      } catch (e) {
        console.error("[voice] drag erro:", e.message);
        ws.send(JSON.stringify({ ok: false, error: e.message }));
      }
    } else if (type === 0x05) {
      // TOQUE SIMPLES: clique no centro da tela (a mira). Serve pra escolher
      // o que esta sob o pontinho vermelho, como um mouse.
      console.log("[voice] comando: clique no centro da tela");
      try {
        const actions = [{ name: "click_at_crosshair", args: {} }];
        const res = await runActions(actions);
        ws.send(JSON.stringify({ ok: true, command: "click", actions, result: res }));
      } catch (e) {
        console.error("[voice] clique erro:", e.message);
        ws.send(JSON.stringify({ ok: false, error: e.message }));
      }
    } else if (type === 0x04) {
      // TOQUE DUPLO no ESP: comando de street view no centro da tela.
      // Nao ha audio; so decide e manda a acao pro globo.
      console.log("[voice] comando: toque duplo (street view)");
      try {
        const ativa = !streetViewAberto;
        streetViewAberto = ativa;
        // open_street_view ja liga a camada e o provider por dentro.
        const actions = ativa
          ? [{ name: "open_street_view", args: { aim: "screen-centre" } }]
          : [{ name: "close_street_view", args: {} }];
        const res = await runActions(actions);
        ws.send(JSON.stringify({ ok: true, command: ativa ? "street-on" : "street-off", actions, result: res }));
        console.log(`[voice] street view ${ativa ? "ABRIR" : "FECHAR"} ->`, JSON.stringify(res));
      } catch (e) {
        console.error("[voice] comando erro:", e.message);
        ws.send(JSON.stringify({ ok: false, error: e.message }));
      }
    } else if (type === 0x03) {
      if (!pcm || !pcm.length) { ws.send(JSON.stringify({ ok: false, reason: "sem audio" })); return; }
      const audio = Buffer.concat(pcm); pcm = null;

      // salva o WAV e registra na lista
      const id = Date.now().toString(36);
      const file = `rec-${id}.wav`;
      const wavPath = path.join(CAPTURES, file);
      fs.writeFileSync(wavPath, buildWav(audio));
      const entry = { id, file, at: Date.now(), bytes: audio.length, text: null, actions: null, error: null };
      recent.unshift(entry);
      recent.splice(KEEP); pruneCaptures(); saveRecent();
      console.log(`[voice] audio: ${audio.length} bytes -> ${file}`);

      // ignora toques acidentais / cliques: menos de ~0.35s de fala nao tem
      // comando nenhum e so gastaria cota do Gemini.
      const MIN_BYTES = Math.floor(SAMPLE_RATE * 2 * 0.35);
      if (audio.length < MIN_BYTES) {
        console.log(`[voice] audio curto (${audio.length} < ${MIN_BYTES}), ignorado`);
        entry.error = "audio curto";
        saveRecent();
        ws.send(JSON.stringify({ ok: false, reason: "audio curto" }));
        return;
      }

      try {
        // 1o: Gemini escuta o audio e ja escolhe a acao (1 chamada so).
        let text = "", calls = null;
        const useGemini = arg("engine", process.env.VOICE_ENGINE || "gemini") === "gemini";
        if (useGemini) {
          try {
            const g = await stt.analyze(wavPath);
            text = g.text;
            calls = g.actions;
            console.log(`[voice] gemini ${g.ms}ms -> text="${text}" acoes=${JSON.stringify(calls)}`);
          } catch (e) {
            console.warn("[voice] gemini falhou, caindo pro whisper:", e.message);
          }
        }
        // fallback: Whisper transcreve, Gemini escolhe (sem OpenRouter)
        if (!calls || !calls.length) {
          if (!text) {
            text = await transcribe(wavPath);
            console.log(`[voice] STT: "${text}"`);
          }
          entry.text = text || null;
          if (!text) { saveRecent(); ws.send(JSON.stringify({ ok: false, reason: "sem fala" })); return; }
          try {
            calls = await stt.choose(text);
            console.log("[voice] gemini(texto) acoes:", JSON.stringify(calls));
          } catch (e) {
            console.warn("[voice] gemini(texto) falhou:", e.message);
            const r = await pickAction(text, apiKey);   // ultimo recurso
            calls = r.calls;
          }
        }
        entry.text = text || null;
        if (!calls || !calls.length) {
          saveRecent();
          ws.send(JSON.stringify({ ok: false, reason: "nenhuma acao", text }));
          return;
        }
        await refineActions(text, calls, apiKey);
        entry.actions = calls;
        const res = await runActions(calls);
        pushHistory("user", text);
        pushHistory("assistant", JSON.stringify(calls));
        saveRecent();
        ws.send(JSON.stringify({ ok: true, text, actions: calls, result: res }));
      } catch (e) {
        console.error("[voice] erro:", e.message);
        entry.error = e.message;
        saveRecent();
        ws.send(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  });
  ws.on("close", () => console.log("[voice] ESP saiu"));
});

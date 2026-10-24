/**
 * God's Eye View -> ESP32 ST7789 stream server
 * ---------------------------------------------------------------------
 * Renderiza o God's Eye View (Cesium) via Puppeteer headless (WebGL com
 * swiftshader), captura o canvas como RGB565 240x240 num loop a ~18fps e
 * envia por WebSocket pro ESP32 desenhar no ST7789.
 *
 * O viewport e 240x240 (tamanho do display) -> captura rapida, sem resize.
 *
 * Protocolo WS (server -> ESP):
 *   byte[0]=0x00 -> manifest JSON {width,height,format:"rgb565le"}
 *   byte[0]=0x02 -> frame RGB565 little-endian (240*240*2 = 115200 B)
 *
 * Uso:
 *   node tools/esp-capture-server.cjs [--port 8082] [--app http://localhost:4173]
 *       [--size 240] [--fps 18] [--layers flights,satellites]
 *       [--lat 20] [--lon -30] [--alt 12000000]
 */
const http = require("http");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");
const { WebSocketServer } = require("ws");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const WS_PORT   = parseInt(arg("port", "8082"), 10);
const APP_URL   = arg("app", "http://localhost:4173");
const VIEW_SIZE = parseInt(arg("size", "240"), 10);      // viewport = display
const FPS       = parseInt(arg("fps", "18"), 10);
const OUT_SIZE  = VIEW_SIZE;
const FRAME_MS  = Math.round(1000 / FPS);
const LAYERS    = arg("layers", "").split(",").filter(Boolean);   // vazio = nenhum data layer
const SKIP      = Math.max(1, parseInt(arg("skip", "1"), 10));    // envia 1 a cada SKIP frames
const CAM       = {
  lat: parseFloat(arg("lat", "20")),
  lon: parseFloat(arg("lon", "-30")),
  altitude_m: parseFloat(arg("alt", "12000000")),
};

let browser = null;
let page = null;
let frameBuf = Buffer.alloc(0);   // JPEG do screenshot (tamanho variavel)
let frameCount = 0;
let running = false;
let captureMs = 0;
const clients = new Set();

function localIP() {
  for (const n of Object.keys(os.networkInterfaces()))
    for (const net of os.networkInterfaces()[n])
      if (net.family === "IPv4" && !net.internal) return net.address;
  return "127.0.0.1";
}

// Perfil proprio do Puppeteer: com userDataDir dedicado o Chrome do projeto
// tem um diretorio exclusivo, entao da pra identifica-lo e mata-lo sem tocar
// no Chrome normal do usuario (que usa o perfil padrao).
const CAPTURE_PROFILE = path.join(os.tmpdir(), "gev-capture-chrome");

async function startBrowser() {
  console.log("[cap] abrindo Chromium HEADED (GPU real)...");
  browser = await puppeteer.launch({
    headless: false,                            // <- JANELA REAL: usa a GPU
    userDataDir: CAPTURE_PROFILE,               // perfil isolado (ver acima)
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=" + VIEW_SIZE + "," + VIEW_SIZE,
      "--window-position=0,0",
      // marcador no command line: o `gods stop` procura por essa string
      "--gev-capture",
    ],
  });
  page = await browser.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/gev|error|fail/i.test(t) && !/404|favicon/i.test(t))
      console.log("[browser]", t.slice(0, 160));
  });
  await page.setViewport({ width: VIEW_SIZE, height: VIEW_SIZE, deviceScaleFactor: 1 });

  const url = APP_URL.replace(/\/$/, "") + "/?embed=1";
  console.log(`[cap] carregando ${url} (${VIEW_SIZE}x${VIEW_SIZE})`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // esconde creditos/marca d'agua do Cesium (nao poluem o display do ESP).
  // O container real e' .cesium-widget-credits (creditDisplay.container);
  // os wrappers internos sao .cesium-credit-wrapper.
  await page.addStyleTag({ content: `
    .cesium-widget-credits,
    .cesium-credit-wrapper,
    .cesium-credit-container,
    .cesium-credit-logoContainer,
    .cesium-credit-expand-link,
    .cesium-credit-textContainer,
    .cesium-credit-imageContainer,
    #cesium-credits,
    #credit-container,
    [class*="cesium-credit"],
    [class*="cesium-widget-credit"] {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      height: 0 !important;
      width: 0 !important;
      overflow: hidden !important;
    }
  `});

  await page.waitForSelector("canvas", { timeout: 60000 });
  console.log("[cap] canvas pronto. aguardando init...");
  await new Promise((r) => setTimeout(r, 8000));

  // segunda passada: o Cesium recria o container de creditos ao inicializar,
  // entao removemos de novo depois que o viewer existir.
  await page.evaluate(() => {
    const kill = () => {
      document.querySelectorAll('.cesium-widget-credits, .cesium-credit-wrapper, [class*="cesium-credit"]')
        .forEach((el) => { el.style.display = "none"; el.remove(); });
    };
    kill();
    setInterval(kill, 1000);   // vigia: se recriar, some de novo
  });
  console.log("[cap] creditos do Cesium removidos");

  await applyView();
  console.log("[cap] view aplicada. aguardando feeds (8s)...");
  await new Promise((r) => setTimeout(r, 8000));

  console.log("[cap] iniciando captura");
  running = true;
  captureLoop();
}

async function applyView() {
  const view = {
    camera: { lat: CAM.lat, lon: CAM.lon, altitude_m: CAM.altitude_m,
              heading_deg: 0, pitch_deg: -90 },
    layers: LAYERS, style: null, map: null, follow: null,
  };
  const res = await page.evaluate((v) => new Promise((resolve) => {
    const id = "esp-" + Date.now();
    const onMsg = (e) => {
      if (e.data?.type === "gev:view-applied" && e.data.id === id) {
        window.removeEventListener("message", onMsg);
        resolve(e.data);
      }
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ type: "gev:view", id, view: v }, "*");
    setTimeout(() => resolve({ timeout: true }), 8000);
  }), view);
  console.log("[cap] view-applied:", JSON.stringify(res).slice(0, 180));
}

// --------------------------- capture loop ---------------------------
async function captureLoop() {
  while (running) {
    const t0 = Date.now();
    try {
      // screenshot JPEG (ja e JPEG) -> envia DIRETO (o ESP decodifica em hw)
      // ~10KB por frame em vez de 115KB RGB565
      const jpg = await page.screenshot({ type: "jpeg", quality: 75 });
      frameBuf = jpg;         // sem conversao
      frameCount++;
      if ((frameCount % SKIP) === 0) broadcast();
    } catch (e) {
      console.error("[cap] erro:", e.message.slice(0, 120));
    }
    captureMs = Date.now() - t0;
    const wait = FRAME_MS - captureMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

// fragmenta um frame (JPEG) em chunks e envia.
// Protocolo: [0x03][total0..3][off0..3][dados...]  (total e off 32-bit LE)
const CHUNK = 8 * 1024;   // 8KB por mensagem

// Envia SEM empilhar: se o cliente esta atrasado (buffer do socket cheio),
// pula o frame inteiro. Sem isso a fila do TCP cresce sem parar e o video
// vai ficando cada vez mais atrasado conforme o tempo passa.
//
// BACKLOG_MAX: quanto o socket pode ter pendente antes de pularmos o frame.
// ~1 frame (12KB) = ainda ok. Acima disso o ESP nao acompanha.
const BACKLOG_MAX = 24 * 1024;
let framesSkipped = 0;

function broadcast() {
  if (!frameBuf || !frameBuf.length) return;
  const total = frameBuf.length;

  for (const ws of clients) {
    if (ws.readyState !== 1) continue;

    // se ja tem 1+ frame nao enviado, este frame esta velho: descarta
    if (ws.bufferedAmount > BACKLOG_MAX) {
      framesSkipped++;
      continue;
    }

    for (let off = 0; off < total; off += CHUNK) {
      const end = Math.min(off + CHUNK, total);
      const msg = Buffer.concat([
        Buffer.from([0x03,
          total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff, (total >> 24) & 0xff,
          off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >> 24) & 0xff]),
        frameBuf.subarray(off, end),
      ]);
      ws.send(msg);
    }
  }
}

// ----------------------------- websocket -----------------------------
const server = http.createServer(async (req, res) => {
  // POST /action -> executa acoes no globo (vindo do voice-server)
  if (req.method === "POST" && req.url === "/action") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { actions } = JSON.parse(body || "{}");
        const applied = await applyActions(actions || []);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, applied }));
        console.log("[action] aplicadas:", JSON.stringify(actions));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`gev->ST7789 frames=${frameCount} clients=${clients.size} cap=${captureMs}ms\n`);
});

// repassa as acoes pro app via postMessage (mesma via do gev:view do embed)
async function applyActions(actions) {
  if (!page) return 0;
  return page.evaluate((acts) => {
    let n = 0;
    for (const a of acts) {
      // o app escuta 'gev:action' com { name, args } (ver src/voice/control.js)
      window.postMessage({ type: "gev:action", name: a.name, args: a.args || {} }, "*");
      n++;
    }
    return n;
  }, actions);
}

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[ws] ESP conectado (${clients.size})`);
  ws.send(Buffer.concat([Buffer.from([0x00]),
    Buffer.from(JSON.stringify({ width: OUT_SIZE, height: OUT_SIZE, format: "jpeg", fps: FPS }))]));
  ws.on("close", () => { clients.delete(ws); console.log(`[ws] ESP saiu (${clients.size})`); });
  ws.on("error", () => clients.delete(ws));
});

server.listen(WS_PORT, "0.0.0.0", async () => {
  console.log(`[ws] servindo em ws://${localIP()}:${WS_PORT}`);
  try { await startBrowser(); }
  catch (e) { console.error("[cap] FALHA:", e.message); process.exit(1); }
});

setInterval(() => {
  if (running) console.log(`[stats] frames=${frameCount} clients=${clients.size} cap=${captureMs}ms pulados=${framesSkipped}`);
}, 5000);

process.on("SIGINT", async () => { running = false; if (browser) await browser.close(); process.exit(0); });

/**
 * gods-panel-server — o display segue o PRIMEIRO cliente que entrar.
 * ---------------------------------------------------------------------
 * O cliente abre /panel no navegador (celular ou PC), que renderiza o globo
 * e envia frames JPEG (240x240) por WebSocket. O primeiro cliente a conectar
 * vira o "dono": os frames dele vao pro ESP32 (que desenha no ST7789).
 *
 * Rotas:
 *   GET  /                 -> status
 *   GET  /panel            -> a pagina que captura o globo (servida pelo Vite)
 *   WS   /panel            -> clientes (donos) mandam frames pra ca
 *   WS   /esp              -> o ESP32 conecta aqui pra RECEBER os frames
 *   POST /action           -> acoes de voz, repassadas ao cliente dono
 *
 * Uso: node tools/gods-panel-server.cjs --port 8082
 */

const http = require("http");
const os = require("os");
const { WebSocketServer } = require("ws");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = parseInt(arg("port", "8082"), 10);
const CHUNK = 8 * 1024;
const FRAME_TIMEOUT_MS = 3000;   // sem frame por 3s -> libera o dono

function localIP() {
  for (const n of Object.keys(os.networkInterfaces()))
    for (const net of os.networkInterfaces()[n])
      if (net.family === "IPv4" && !net.internal && net.address.startsWith("192."))
        return net.address;
  for (const n of Object.keys(os.networkInterfaces()))
    for (const net of os.networkInterfaces()[n])
      if (net.family === "IPv4" && !net.internal) return net.address;
  return "127.0.0.1";
}

// ----------------------------- estado -----------------------------
const panelClients = new Set();   // navegadores (dono + espectadores)
const espClients   = new Set();   // ESP32 (recebe)
let owner = null;                 // o cliente que manda os frames
let lastFrameAt = 0;
let framesIn = 0, framesOut = 0, lastJpeg = 0;
let jpegTotal = 0;

// ----------------------------- HTTP -----------------------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];

  if (req.method === "POST" && url === "/action") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // repassa a acao pro cliente dono (que tem o globo)
      let n = 0;
      const payload = body || "{}";
      for (const c of panelClients) {
        if (c.readyState === 1) { c.send(JSON.stringify({ type: "action", payload: JSON.parse(payload) })); n++; }
      }
      if (owner && owner.readyState === 1) n++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sent: n }));
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  const age = lastFrameAt ? ((Date.now() - lastFrameAt) / 1000).toFixed(1) : "-";
  res.end(
    `gods-panel  :${PORT}\n` +
    `painel:  http://${localIP()}:4173/panel\n` +
    `dono:    ${owner ? "sim" : "nenhum"}\n` +
    `esp:     ${espClients.size} conectado(s)\n` +
    `frames:  in=${framesIn} out=${framesOut}\n` +
    `ultimo frame: ${age}s atras\n`
  );
});

// --------------------------- websocket ---------------------------
const panelWss = new WebSocketServer({ noServer: true });
const espWss   = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = (req.url || "").split("?")[0];
  if (url === "/esp") {
    espWss.handleUpgrade(req, socket, head, (ws) => espWss.emit("connection", ws, req));
  } else if (url === "/panel" || url === "/") {
    panelWss.handleUpgrade(req, socket, head, (ws) => panelWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ESP32 conecta: recebe os frames do dono
espWss.on("connection", (ws) => {
  espClients.add(ws);
  console.log(`[esp] conectado (${espClients.size})`);
  ws.send(Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify({
    width: 240, height: 240, format: "jpeg",
  }))]));
  ws.on("close", () => { espClients.delete(ws); console.log(`[esp] saiu (${espClients.size})`); });
  ws.on("error", () => espClients.delete(ws));
});

// Painel (navegador) conecta: o PRIMEIRO vira o dono
panelWss.on("connection", (ws) => {
  panelClients.add(ws);
  const isFirst = !owner || owner.readyState !== 1;
  if (isFirst) {
    owner = ws;
    lastFrameAt = Date.now();
    console.log(`[panel] cliente virou DONO (${panelClients.size} painel(is))`);
    ws.send(JSON.stringify({ type: "role", role: "owner" }));
  } else {
    console.log(`[panel] espectador conectado (${panelClients.size})`);
    ws.send(JSON.stringify({ type: "role", role: "viewer" }));
  }

  ws.on("message", (data, isBinary) => {
    // frame binario (JPEG) do dono
    if (isBinary) {
      if (ws !== owner) return;            // so o dono manda frames
      lastFrameAt = Date.now();
      framesIn++;
      lastJpeg = data.length;
      broadcastToEsp(data);
      return;
    }
    // mensagem de controle (json)
    try {
      const m = JSON.parse(data.toString());
      if (m.type === "hello") console.log(`[panel] ${m.client || "cliente"}`);
    } catch {}
  });

  ws.on("close", () => {
    panelClients.delete(ws);
    if (ws === owner) {
      owner = null;
      console.log("[panel] dono saiu");
      // promove o proximo painel conectado a dono
      for (const c of panelClients) {
        if (c.readyState === 1) {
          owner = c;
          c.send(JSON.stringify({ type: "role", role: "owner" }));
          console.log("[panel] novo dono promovido");
          break;
        }
      }
    } else {
      console.log(`[panel] espectador saiu (${panelClients.size})`);
    }
  });
  ws.on("error", () => panelClients.delete(ws));
});

// envia um JPEG em chunks [0x03][total4][off4][dados...] pro ESP
function broadcastToEsp(jpeg) {
  if (!espClients.size) return;
  const total = jpeg.length;
  jpegTotal = total;
  for (const ws of espClients) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > 400000) continue;   // ESP atrasado: pula frame
    for (let off = 0; off < total; off += CHUNK) {
      const end = Math.min(off + CHUNK, total);
      ws.send(Buffer.concat([
        Buffer.from([0x03,
          total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff, (total >> 24) & 0xff,
          off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, (off >> 24) & 0xff]),
        jpeg.subarray(off, end),
      ]));
    }
    framesOut++;
  }
}

// vigia: se o dono parar de mandar, libera o posto
setInterval(() => {
  if (owner && Date.now() - lastFrameAt > FRAME_TIMEOUT_MS) {
    console.log("[panel] dono silencioso; liberando o posto");
    owner = null;
    for (const c of panelClients) {
      if (c.readyState === 1) {
        owner = c;
        c.send(JSON.stringify({ type: "role", role: "owner" }));
        console.log("[panel] novo dono promovido (timeout)");
        break;
      }
    }
  }
}, 1000);

setInterval(() => {
  if (framesIn) console.log(`[stats] in=${framesIn} out=${framesOut} jpeg=${lastJpeg}B dono=${owner ? "sim" : "nao"} esp=${espClients.size}`);
}, 5000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[panel] servindo em ws://${localIP()}:${PORT}`);
  console.log(`[panel] abra o painel:  http://${localIP()}:4173/panel`);
});

/**
 * panelMode — transforma este navegador na FONTE do display.
 * ---------------------------------------------------------------------
 * Carregado quando a URL tem ?panel=1 (ver index.html). O app ja subiu
 * normalmente; aqui so anexamos:
 *
 *   1. um HUD flutuante com o estado;
 *   2. a conexao com o gods-panel-server (:8082);
 *   3. o loop que captura o canvas do Cesium em 240x240 JPEG e envia.
 *
 * O PRIMEIRO navegador a entrar vira o "dono": seus frames vao pro ESP32.
 * Os demais ficam como espectadores (e assumem se o dono cair).
 *
 * O viewer e lido de window.__godsEyeView (o app expoe pra debug).
 */

const FPS = 15;
const FRAME_MS = 1000 / FPS;
const QUALITY = 0.72;
const OUT = 240;
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8082/panel`;

// ----------------------------- HUD -----------------------------
const hud = document.createElement('div');
hud.id = 'gods-panel-hud';
hud.innerHTML = `
  <span id="gp-dot"></span>
  <span id="gp-msg">painel: conectando…</span>
  <span id="gp-fps"></span>
  <button id="gp-toggle">pausar</button>`;
hud.style.cssText = `position:fixed;left:10px;bottom:10px;z-index:9999;
  display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;
  background:rgba(10,12,18,.85);border:1px solid rgba(120,180,255,.28);
  font:12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#dbe4f0;
  backdrop-filter:blur(8px);box-shadow:0 6px 22px rgba(0,0,0,.5)`;
document.body.appendChild(hud);

const dot = hud.querySelector('#gp-dot');
const msg = hud.querySelector('#gp-msg');
const fpsEl = hud.querySelector('#gp-fps');
const btn = hud.querySelector('#gp-toggle');
dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#f59e0b';
btn.style.cssText = `background:#1b2230;color:#cfe0f5;border:1px solid rgba(120,180,255,.28);
  padding:5px 10px;border-radius:999px;font:inherit;cursor:pointer`;

function state(kind, text) {
  dot.style.background = kind === 'live' ? '#22c55e' : kind === 'err' ? '#ef4444' : '#f59e0b';
  dot.style.boxShadow = kind === 'live' ? '0 0 8px #22c55e' : 'none';
  msg.textContent = text;
}

// --------------------------- viewer ---------------------------
function getViewer() {
  const dbg = window.__godsEyeView;
  return dbg?.viewer || null;
}

// -------------------------- websocket --------------------------
let ws = null, isOwner = false, sending = true;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', client: navigator.userAgent.slice(0, 50) }));
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const m = JSON.parse(ev.data);
      if (m.type === 'role') {
        isOwner = m.role === 'owner';
        state(isOwner ? 'live' : '', isOwner
          ? 'VOCE controla o display — mexa o globo'
          : 'espectador (outro aparelho controla)');
      }
      if (m.type === 'action') {
        // acao vinda da voz: aplica no globo deste navegador
        const acts = m.payload?.actions || [];
        const dbg = window.__godsEyeView;
        for (const a of acts) {
          // o app escuta gev:action no window (patch em embed.js)
          window.postMessage({ type: 'gev:action', name: a.name, args: a.args || {} }, '*');
        }
      }
    } catch {}
  };
  ws.onclose = () => { state('err', 'servidor caiu — reconectando…'); setTimeout(connect, 1500); };
  ws.onerror = () => state('err', 'erro de conexao');
}
connect();

// ------------------------ envia o globo ------------------------
let canvas = null, ctx = null, lastSent = 0, frames = 0, t0 = performance.now();

function grab() {
  const v = getViewer();
  const src = v?.scene?.canvas;
  if (!src || !src.width) return null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = OUT; canvas.height = OUT;
    ctx = canvas.getContext('2d');
  }
  const side = Math.min(src.width, src.height);
  const sx = (src.width - side) / 2, sy = (src.height - side) / 2;
  ctx.drawImage(src, sx, sy, side, side, 0, 0, OUT, OUT);
  return canvas;
}

async function tick() {
  if (ws && ws.readyState === 1 && isOwner && sending) {
    const now = performance.now();
    if (now - lastSent >= FRAME_MS) {
      lastSent = now;
      const c = grab();
      if (c) {
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', QUALITY));
        if (blob && ws.readyState === 1) { ws.send(await blob.arrayBuffer()); frames++; }
      }
    }
  }
  if (performance.now() - t0 >= 2000) {
    fpsEl.textContent = `${(frames * 1000 / (performance.now() - t0)).toFixed(1)} fps`;
    frames = 0; t0 = performance.now();
  }
  requestAnimationFrame(tick);
}
tick();

btn.onclick = () => {
  sending = !sending;
  btn.textContent = sending ? 'pausar' : 'enviar';
  state(sending && isOwner ? 'live' : '', sending ? 'enviando' : 'pausado');
};

console.log('[panel] modo painel ativo');

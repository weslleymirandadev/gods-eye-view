/**
 * Slider de sensibilidade do giroscópio, flutuando sobre o globo.
 *
 * Aparece só no modo embed (?embed=1), que é o que o ESP exibe. O valor vai
 * pro voice-server (/imu), onde a escala graus->pixels é aplicada — mexer no
 * slider muda o giro na hora, sem recompilar o firmware.
 */

const STORAGE_KEY = "gev.imu.sens";
const DEFAULT_SENS = 0.4;
const VOICE_URL = () =>
  globalThis.GEV_VOICE_URL ||
  `${location.protocol}//${location.hostname}:8083`;

export function installImuSensitivitySlider({
  doc = globalThis.document,
  signal = null,
} = {}) {
  if (!doc || doc.getElementById("gev-imu-sens")) return () => {};

  const wrap = doc.createElement("div");
  wrap.id = "gev-imu-sens";
  wrap.style.cssText = [
    "position:fixed",
    "top:10px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:2147482900", // abaixo do panorama (2147483000), acima do Cesium
    "display:flex",
    "align-items:center",
    "gap:10px",
    "padding:8px 14px",
    "border-radius:999px",
    "background:rgba(5,7,10,.82)",
    "border:1px solid rgba(56,224,123,.38)",
    "box-shadow:0 4px 18px rgba(0,0,0,.6)",
    "backdrop-filter:blur(8px)",
    "-webkit-backdrop-filter:blur(8px)",
    "font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace",
    "color:#8fa8bb",
    "letter-spacing:.08em",
    "user-select:none",
    "pointer-events:auto",
  ].join(";");

  const label = doc.createElement("span");
  label.textContent = "GIRO";

  const input = doc.createElement("input");
  input.type = "range";
  input.min = "0.05";
  input.max = "8";
  input.step = "0.05";
  input.style.cssText = "width:120px;accent-color:#38e07b;height:14px;cursor:pointer";

  const valor = doc.createElement("span");
  valor.style.cssText =
    "color:#38e07b;font-weight:700;min-width:44px;text-align:right;font-size:12px";

  wrap.append(label, input, valor);
  doc.body.appendChild(wrap);

  const salvo = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
  const inicial = Number.isFinite(salvo) && salvo > 0 ? salvo : DEFAULT_SENS;
  input.value = String(inicial);
  valor.textContent = `${inicial.toFixed(2)}`;

  let timer = null;
  let vivo = true;

  async function enviar() {
    if (!vivo) return;
    const sens = Number(input.value);
    valor.textContent = sens.toFixed(2);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, String(sens));
    } catch {
      /* storage bloqueado */
    }
    try {
      await fetch(`${VOICE_URL()}/imu`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sens }),
        mode: "cors",
      });
    } catch {
      /* servidor fora: o slider continua util, so nao persiste */
    }
  }

  input.addEventListener("input", () => {
    valor.textContent = Number(input.value).toFixed(2);
    clearTimeout(timer);
    timer = setTimeout(enviar, 150);
  });

  // aplica o valor guardado assim que o servidor responder
  fetch(`${VOICE_URL()}/imu.json`, { mode: "cors" })
    .then((r) => r.json())
    .then((j) => {
      if (!vivo || !Number.isFinite(j?.sens)) return;
      input.value = String(j.sens);
      valor.textContent = Number(j.sens).toFixed(2);
    })
    .catch(() => {});

  const limpar = () => {
    vivo = false;
    clearTimeout(timer);
    wrap.remove();
  };
  signal?.addEventListener?.("abort", limpar, { once: true });

  return limpar;
}

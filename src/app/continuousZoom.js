/**
 * Zoom contínuo com aceleração (estilo Unity).
 *
 * Segurar o botão começa devagar e ACELERA com o tempo, até um teto.
 * Soltar para o zoom e zera a aceleração.
 *
 * A cada frame (rAF) movemos a câmera uma fração do caminho até o alvo, então
 * a transição é suave (ease) em vez de um salto seco por evento.
 */

// aceleração: px/s de "altitude" por segundo segurado
const ZOOM_ACEL = 1.8;        // quanto acelera por segundo
const ZOOM_VEL_MIN = 0.5;     // fator/s no instante do press
const ZOOM_VEL_MAX = 7.0;     // teto (era 26: passava do chao em 4s)
const ZOOM_SUAVIZADO = 0.5;   // 0..1: quanto do alvo aplicamos por frame

const state = {
  raf: null,
  dir: null,
  vel: 0,
  inicio: 0,
  viewer: null,
  adjust: null,
};

/** Distância de câmera atual e limites (em metros). */
function altitudeAtual(viewer) {
  try {
    return viewer.camera.positionCartographic.height;
  } catch {
    return 0;
  }
}

export function stopContinuousZoom() {
  if (state.raf != null) cancelAnimationFrame(state.raf);
  state.raf = null;
  state.dir = null;
  state.vel = 0;
  state.inicio = 0;
}

/**
 * Começa o zoom contínuo.
 * @param {'in'|'out'} dir
 * @param {{viewer?: object, adjust?: (factor:number)=>boolean}} deps
 */
export function startContinuousZoom(dir, deps = {}) {
  const viewer = deps.viewer || state.viewer;
  if (!viewer) return false;

  if (state.raf != null && state.dir === dir) return true;
  stopContinuousZoom();

  state.viewer = viewer;
  state.dir = dir;
  state.vel = ZOOM_VEL_MIN;
  state.inicio = performance.now();

  let ultimo = performance.now();

  const passo = (agora) => {
    if (state.dir == null) return;
    const dt = Math.min(0.05, (agora - ultimo) / 1000); // teto 50ms
    ultimo = agora;

    // aceleração progressiva até o teto
    state.vel = Math.min(ZOOM_VEL_MAX, state.vel + ZOOM_ACEL * dt);

    // Eixo do zoom: altitude atual. Cada frame move uma FRAÇÃO dela, então
    // o ganho é igual em qualquer escala e a sensação é de aceleração.
    const cam = viewer.camera;
    let altura = 0;
    try {
      altura = cam.positionCartographic.height;
    } catch {
      return;
    }
    if (!Number.isFinite(altura) || altura <= 0) return;
    // Limites: nao desce abaixo de 20m (o Cesium se recupera e "pula") nem
    // sobe acima de 30.000km.
    const MIN_ALT = 20, MAX_ALT = 3.0e7;
    if (state.dir === 'in' && altura <= MIN_ALT) { stopContinuousZoom(); return; }
    if (state.dir === 'out' && altura >= MAX_ALT) { stopContinuousZoom(); return; }

    // fracao por frame: vel (1/s) * dt * suavizacao
    const fracao = Math.min(0.45, state.vel * dt * ZOOM_SUAVIZADO);
    const passoM = altura * fracao;
    if (passoM < 0.01) {
      state.raf = requestAnimationFrame(passo);
      return;
    }

    try {
      if (state.dir === 'out') cam.zoomOut(passoM);
      else cam.zoomIn(passoM);
      viewer.scene?.requestRender?.();
    } catch {
      /* camera ocupada neste frame */
    }

    state.raf = requestAnimationFrame(passo);
  };

  state.raf = requestAnimationFrame(passo);
  return true;
}

/** Estado para diagnóstico. */
export function continuousZoomState() {
  return {
    ativo: state.raf != null,
    dir: state.dir,
    vel: state.vel,
    decorrido: state.inicio ? performance.now() - state.inicio : 0,
    altitude: state.viewer ? altitudeAtual(state.viewer) : null,
  };
}

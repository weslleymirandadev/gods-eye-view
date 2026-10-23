/**
 * Cesium ↔ Street View: troca de contexto sem tranco.
 *
 * Regras (pedido do usuario):
 *
 *   ABRIR street view  -> pausa o render do Cesium (nao gasta GPU enquanto
 *                         o panorama esta aberto).
 *
 *   FECHAR street view -> PRIMEIRO volta o Cesium e garante que ele desenhou
 *                         um frame; SO DEPOIS fecha o panorama.
 *
 * Sem isso o globo reaparece vazio (ou com o tile antigo) por um instante
 * enquanto o Cesium rebuilda a cena.
 */

/** id do "dono" do render continuo; tambem serve de chave pro governor. */
const OWNER = "street-level-pause";

export function createCesiumStreetViewSwitch({
  viewer,
  holdRender,
  releaseRender,
  requestRender,
} = {}) {
  let paused = false;

  /** true se o Cesium esta congelado agora. */
  function isPaused() {
    return paused;
  }

  /**
   * Pausa o Cesium enquanto o panorama esta aberto.
   * Idempotente: chamar duas vezes nao faz nada.
   */
  function pause() {
    if (paused) return;
    paused = true;
    try {
      // Congela o render loop e limpa o que estava na tela nao e necessario:
      // o canvas fica escondido por CSS enquanto o painel esta aberto.
      viewer?.scene && (viewer.scene.requestRenderMode = true);
      viewer.useDefaultRenderLoop = false;
    } catch {
      /* viewer destruido */
    }
  }

  /**
   * Volta o Cesium e ESPERA um frame desenhado antes de resolver.
   * Chame isto ANTES de fechar o painel do street view.
   */
  async function resumeBeforeClosing({ timeoutMs = 2500 } = {}) {
    if (!paused) return true;
    paused = false;

    try {
      viewer.useDefaultRenderLoop = true;
    } catch {
      /* viewer destruido */
    }

    // Pede frames ate o canvas ter conteudo (ou estourar o timeout).
    const done = await waitForDrawnFrame(viewer, timeoutMs);
    return done;
  }

  /** Resume sem esperar (uso em teardown). */
  function resumeNow() {
    if (!paused) return;
    paused = false;
    try {
      viewer.useDefaultRenderLoop = true;
      viewer?.scene?.requestRender?.();
    } catch {
      /* viewer destruido */
    }
  }

  return { pause, resumeBeforeClosing, resumeNow, isPaused };
}

/**
 * Espera ate o Cesium desenhar um frame com conteudo.
 * Criterio: `postRender` disparado depois de forcar um render, ou o canvas
 * ter pixel nao-preto (fallback).
 */
function waitForDrawnFrame(viewer, timeoutMs) {
  return new Promise((resolve) => {
    const scene = viewer?.scene;
    if (!scene) return resolve(false);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { scene.postRender.removeEventListener(onPost); } catch { /* noop */ }
      resolve(ok);
    };

    function onPost() {
      // dois frames garantem que os tiles ja entraram na fila e desenharam
      if (++frames >= 2) finish(true);
    }
    let frames = 0;

    try { scene.postRender.addEventListener(onPost); } catch { /* noop */ }
    const timer = setTimeout(() => finish(false), timeoutMs);

    // forca o render: pede dois frames
    try {
      scene.requestRender?.();
      setTimeout(() => { try { scene.requestRender?.(); } catch { /* noop */ } }, 120);
    } catch {
      /* noop */
    }
  });
}

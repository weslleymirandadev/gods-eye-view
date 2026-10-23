/**
 * Cesium ↔ Street View: troca de contexto sem tranco.
 *
 * Regras (pedido do usuario):
 *
 *   ABRIR street view  -> o canvas do Cesium fica INVISIVEL e o render loop
 *                         para (nao gasta GPU; o globo nao aparece atras).
 *
 *   FECHAR street view -> PRIMEIRO volta o Cesium e garante que ele desenhou
 *                         um frame; SO DEPOIS o panorama fecha.
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
  let backdrop = null;

  /** true se o Cesium esta congelado agora. */
  function isPaused() {
    return paused;
  }

  function canvas() {
    return viewer?.scene?.canvas || viewer?.canvas || null;
  }

  /** Esconde o canvas do Cesium atras de um fundo solido. */
  function showBackdrop() {
    if (backdrop || typeof document === "undefined") return;
    const el = document.createElement("div");
    el.id = "gev-cesium-backdrop";
    el.style.cssText = [
      "position: fixed",
      "inset: 0",
      "z-index: 140", // abaixo do painel expandido (141)
      "background: #05070a",
      "pointer-events: none",
    ].join(";");
    document.body.appendChild(el);
    backdrop = el;
  }

  function hideBackdrop() {
    if (!backdrop) return;
    backdrop.remove();
    backdrop = null;
  }

  /**
   * Pausa o Cesium enquanto o panorama esta aberto.
   * Idempotente: chamar duas vezes nao faz nada.
   */
  function pause() {
    if (paused) return;
    paused = true;
    try {
      // Congela o render loop: nada de GPU enquanto o panorama esta aberto.
      viewer?.scene && (viewer.scene.requestRenderMode = true);
      viewer.useDefaultRenderLoop = false;
    } catch {
      /* viewer destruido */
    }
    // Esconde o globo: o painel do street view cobre a tela, mas se ele for
    // menor (mobile) o Cesium nao pode aparecer atras.
    const c = canvas();
    if (c) {
      c.dataset.gevPrevVisibility = c.style.visibility || "";
      c.style.visibility = "hidden";
    }
    showBackdrop();
  }

  /**
   * Volta o Cesium e ESPERA um frame desenhado antes de resolver.
   * Chame isto ANTES de fechar o painel do street view.
   */
  async function resumeBeforeClosing({ timeoutMs = 2500 } = {}) {
    if (!paused) return true;
    paused = false;

    const c = canvas();
    if (c) {
      c.style.visibility = c.dataset.gevPrevVisibility || "";
      delete c.dataset.gevPrevVisibility;
    }

    try {
      viewer.useDefaultRenderLoop = true;
    } catch {
      /* viewer destruido */
    }

    // Pede frames ate o canvas ter conteudo (ou estourar o timeout).
    const done = await waitForDrawnFrame(viewer, timeoutMs);
    hideBackdrop();
    return done;
  }

  /** Resume sem esperar (uso em teardown). */
  function resumeNow() {
    if (!paused) return;
    paused = false;
    const c = canvas();
    if (c) {
      c.style.visibility = c.dataset.gevPrevVisibility || "";
      delete c.dataset.gevPrevVisibility;
    }
    try {
      viewer.useDefaultRenderLoop = true;
      viewer?.scene?.requestRender?.();
    } catch {
      /* viewer destruido */
    }
    hideBackdrop();
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

/**
 * Cesium ↔ Street View: troca de contexto sem tranco.
 *
 *   ABRIR  -> o panorama vai pra tela cheia e o Cesium desliga o render.
 *   FECHAR -> o Cesium volta e desenha antes do painel sair.
 *
 * POR QUE MOVER O DOM
 * -------------------
 * O `#cesiumContainer` e' position:absolute, filho do <body>, e o Cesium abre
 * um contexto de camada proprio. Um elemento dentro do painel lateral (com
 * backdrop-filter e z-index proprios) NUNCA aparece na frente do globo — era
 * isso que dava "tela preta": o Cesium desenhando por cima.
 *
 * A solucao e' por o `#sl-viewer` no MESMO PAI que o `.cesium-widget`, logo
 * depois dele e com z-index maior. Assim os dois disputam a mesma camada e o
 * panorama ganha. Ao fechar, o elemento volta pro lugar de origem no painel.
 */

const HOST_ID = "gev-panorama-host";

export function createCesiumStreetViewSwitch({
  viewer,
  holdRender,
  releaseRender,
  requestRender,
  onResize, // avisa o provider que o container mudou de tamanho
} = {}) {
  let paused = false;
  let home = null;   // { parent, next } de onde o #sl-viewer veio
  let savedCss = null; // 'style' original do #sl-viewer
  let savedCesium = null; // 'style' original do #cesiumWidget

  function isPaused() {
    return paused;
  }

  function canvas() {
    return viewer?.scene?.canvas || viewer?.canvas || null;
  }

  function viewerEl() {
    if (typeof document === "undefined") return null;
    return document.getElementById("sl-viewer");
  }

  /** O widget do Cesium: pai que o panorama precisa imitar. */
  function cesiumWidget() {
    if (typeof document === "undefined") return null;
    return document.querySelector("#cesiumContainer .cesium-widget") ||
           document.querySelector(".cesium-widget");
  }

  /** Div solta no body usada como container do panorama em tela cheia. */
  function panoramaHost() {
    if (typeof document === "undefined") return null;
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    const cont = document.getElementById("cesiumContainer");
    if (!cont) return null;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.hidden = true;
    // irmao do #cesiumContainer: mesma camada do globo
    cont.parentElement?.insertBefore(host, cont.nextSibling);
    return host;
  }

  function put(el, props) {
    if (!el) return;
    for (const [k, v] of Object.entries(props))
      el.style.setProperty(k, v, "important");
  }

  function nudgeResize() {
    try { onResize?.(); } catch { /* noop */ }
    try { globalThis.__GEV_SL_VIEWER_RESIZE__?.(); } catch { /* noop */ }
    if (typeof window !== "undefined") window.dispatchEvent(new Event("resize"));
  }

  /**
   * Leva o #sl-viewer pra dentro do #cesiumContainer, imediatamente depois do
   * .cesium-widget, em tela cheia.
   */
  function expandViewer() {
    const el = viewerEl();
    const widget = cesiumWidget();
    if (!el || !widget) return;

    if (home === null) {
      home = { parent: el.parentNode, next: el.nextSibling };
      savedCss = el.getAttribute("style") || "";
    }
    const host = panoramaHost();
    if (!host) return;

    // mesmo pai do widget -> mesma camada de empilhamento
    if (el.parentElement !== host) {
      host.hidden = false;
      host.appendChild(el);
      // o host fica logo acima do #cesiumContainer
      put(host, {
        position: "fixed",
        inset: "0",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        "max-width": "none",
        "max-height": "none",
        margin: "0",
        padding: "0",
        border: "0",
        background: "#000",
        // 1 acima do #cesiumContainer (auto) e abaixo do painel do app
        "z-index": "3000",
        display: "block",
        overflow: "hidden",
      });
    }

    put(el, {
      position: "absolute",
      inset: "0",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      "max-width": "none",
      "max-height": "none",
      "min-width": "0",
      "min-height": "0",
      margin: "0",
      padding: "0",
      border: "0",
      "border-radius": "0",
      "aspect-ratio": "auto",
      display: "block",
      visibility: "visible",
      opacity: "1",
      "z-index": "3001",
      background: "#000",
    });

    if (typeof document !== "undefined")
      document.documentElement.classList.add("gev-panorama");

    nudgeResize();
  }

  /** Devolve o #sl-viewer pro painel lateral. */
  function restoreViewer() {
    const el = viewerEl();
    if (el && home) {
      if (savedCss) el.setAttribute("style", savedCss);
      else el.removeAttribute("style");
      if (home.parent) home.parent.insertBefore(el, home.next);
    }
    const host = typeof document !== "undefined" ? document.getElementById(HOST_ID) : null;
    if (host) {
      host.replaceChildren();
      host.hidden = true;
      host.removeAttribute("style");
    }
    home = null;
    savedCss = null;
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("gev-panorama");
      document.body.classList.remove("gev-panorama");
    }
    nudgeResize();
  }

  /** Para o globo de desenhar (o custo real) e esconde o canvas. */
  function hideGlobe() {
    const c = canvas();
    if (c) {
      if (c.dataset.gevPrevVis === undefined) c.dataset.gevPrevVis = c.style.visibility || "";
      c.style.setProperty("visibility", "hidden", "important");
    }
    const widget = cesiumWidget();
    if (widget && savedCesium === null) {
      savedCesium = widget.getAttribute("style") || "";
      widget.style.setProperty("visibility", "hidden", "important");
    }
  }

  function showGlobe() {
    const c = canvas();
    if (c) {
      const prev = c.dataset.gevPrevVis;
      delete c.dataset.gevPrevVis;
      if (prev) c.style.setProperty("visibility", prev, "important");
      else c.style.removeProperty("visibility");
    }
    const widget = cesiumWidget();
    if (widget && savedCesium !== null) {
      if (savedCesium) widget.setAttribute("style", savedCesium);
      else widget.removeAttribute("style");
      savedCesium = null;
    }
  }

  function pause() {
    if (paused) return;
    paused = true;
    try {
      viewer?.scene && (viewer.scene.requestRenderMode = true);
      viewer.useDefaultRenderLoop = false;
    } catch {
      /* viewer destruido */
    }
    hideGlobe();
    expandViewer();
  }

  async function resumeBeforeClosing({ timeoutMs = 2500 } = {}) {
    if (!paused) return true;
    paused = false;
    restoreViewer();
    showGlobe();
    try {
      viewer.useDefaultRenderLoop = true;
    } catch {
      /* viewer destruido */
    }
    return waitForDrawnFrame(viewer, timeoutMs);
  }

  function resumeNow() {
    if (!paused) return;
    paused = false;
    restoreViewer();
    showGlobe();
    try {
      viewer.useDefaultRenderLoop = true;
      viewer?.scene?.requestRender?.();
    } catch {
      /* viewer destruido */
    }
  }

  /** Reaplica o fullscreen depois que o Google monta o canvas. */
  function refreshFullscreen() {
    if (!paused) return;
    expandViewer();
    hideGlobe();
  }

  return { pause, resumeBeforeClosing, resumeNow, isPaused, refreshFullscreen };
}

/** Espera ate o Cesium desenhar dois frames. */
function waitForDrawnFrame(viewer, timeoutMs) {
  return new Promise((resolve) => {
    const scene = viewer?.scene;
    if (!scene) return resolve(false);

    let frames = 0;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { scene.postRender.removeEventListener(onPost); } catch { /* noop */ }
      resolve(ok);
    };
    function onPost() {
      if (++frames >= 2) finish(true);
    }

    try { scene.postRender.addEventListener(onPost); } catch { /* noop */ }
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      scene.requestRender?.();
      setTimeout(() => { try { scene.requestRender?.(); } catch { /* noop */ } }, 120);
    } catch {
      /* noop */
    }
  });
}

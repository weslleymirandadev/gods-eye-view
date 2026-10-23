/**
 * Cliente dos servidores Python persistentes.
 *
 *  - STT (Whisper): um processo com o modelo carregado, transcreve sob demanda.
 *  - Gemini: um processo que atende analyze / geocode / choose pelo stdin.
 *
 * Manter os processos vivos evita abrir uma janela de console (e pagar a
 * carga do modelo) a cada comando.
 */
const { spawn } = require("child_process");

const HIDE = process.platform === "win32" ? true : false;

/** Um processo Python conversando por linhas JSON no stdin/stdout. */
class PyWorker {
  constructor({ python, script, env = {}, onReady = null, label = "py" }) {
    this.python = python;
    this.script = script;
    this.env = env;
    this.onReady = onReady;
    this.label = label;
    this.proc = null;
    this.queue = [];
    this.buf = "";
    this.ready = false;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.python, [this.script], {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: HIDE,
    });
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString();
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) {
          this.ready = true;
          if (this.onReady) this.onReady(msg);
          continue;
        }
        const pending = this.queue.shift();
        if (pending) pending(msg);
      }
    });
    this.proc.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) console.error(`[${this.label}]`, s.slice(0, 200));
    });
    this.proc.on("exit", (code) => {
      this.proc = null;
      this.ready = false;
      while (this.queue.length) this.queue.shift()({ ok: false, error: `${this.label} caiu (${code})` });
    });
  }

  /** Envia um comando e espera a próxima resposta. */
  send(cmd, timeoutMs = 90000) {
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label} timeout`)), timeoutMs);
      this.queue.push((msg) => {
        clearTimeout(timer);
        if (msg.ok === false) return reject(new Error(msg.error || msg.reason || `${this.label} falhou`));
        resolve(msg);
      });
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    });
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.write('{"quit":true}\n'); } catch {} }
  }
}

class SttClient {
  constructor({
    python,
    script,
    model = "base",
    language = "pt",
    geminiScript = null,
    geminiModel = "gemini-3.5-flash-lite",
  } = {}) {
    this.python = python;
    this.geminiModel = geminiModel;

    this.stt = new PyWorker({
      python, script,
      env: { STT_MODEL: model, STT_LANGUAGE: language },
      label: "stt",
      onReady: (m) => console.log(`[stt] modelo pronto (${m.model})`),
    });

    this.gemini = geminiScript
      ? new PyWorker({
          python, script: geminiScript,
          env: { GEMINI_MODEL: geminiModel },
          label: "gemini",
          onReady: (m) => console.log(`[gemini] pronto (${m.model || geminiModel})`),
        })
      : null;
  }

  start() { this.stt.start(); if (this.gemini) this.gemini.start(); }
  stop() { this.stt.stop(); if (this.gemini) this.gemini.stop(); }

  /** Transcreve um WAV com Whisper. */
  async transcribe(wavPath, timeoutMs = 90000) {
    const msg = await this.stt.send({ wav: wavPath }, timeoutMs);
    return msg.text || "";
  }

  /** Gemini escuta o WAV e devolve { text, actions }. */
  async analyze(wavPath, timeoutMs = 90000) {
    const msg = await this.gemini.send({ wav: wavPath }, timeoutMs);
    return { text: msg.text || "", actions: msg.actions || [], ms: msg.ms };
  }

  /** Gemini resolve um nome de lugar em coordenadas. */
  async geocode(query, timeoutMs = 45000) {
    const msg = await this.gemini.send({ geocode: query }, timeoutMs);
    return { lat: msg.lat, lon: msg.lon, label: msg.label, confianca: msg.confianca };
  }

  /** Gemini escolhe a ação a partir de um texto já transcrito. */
  async choose(text, timeoutMs = 60000) {
    const msg = await this.gemini.send({ text }, timeoutMs);
    return msg.actions || [];
  }
}

module.exports = { SttClient, PyWorker };

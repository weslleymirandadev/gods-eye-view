/**
 * Cliente do servidor STT persistente (_stt_server.py).
 * Mantem UM processo Python com o modelo carregado e transcreve sob demanda.
 * Isso elimina os ~1.5s de carga do modelo por gravacao.
 */
const { spawn } = require("child_process");
const path = require("path");

class SttClient {
  constructor({ python, script, model = "base", language = "pt", geminiScript = null, geminiModel = "gemini-3.5-flash-lite" } = {}) {
    this.python = python;
    this.script = script;
    this.model = model;
    this.language = language;
    this.geminiScript = geminiScript;
    this.geminiModel = geminiModel;
    this.proc = null;
    this.queue = [];      // promessas aguardando resposta
    this.buf = "";
    this.ready = false;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.python, [this.script], {
      env: { ...process.env, STT_MODEL: this.model, STT_LANGUAGE: this.language },
      stdio: ["pipe", "pipe", "pipe"],
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
        if (msg.ready) { this.ready = true; console.log(`[stt] modelo pronto (${msg.model})`); continue; }
        const pending = this.queue.shift();
        if (pending) pending(msg);
      }
    });
    this.proc.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s && !/^\s*$/.test(s)) console.error("[stt]", s.slice(0, 200));
    });
    this.proc.on("exit", (code) => {
      console.log(`[stt] processo saiu (${code})`);
      this.proc = null; this.ready = false;
      // rejeita quem estava esperando
      while (this.queue.length) this.queue.shift()({ ok: false, error: "stt caiu" });
    });
  }

  /** Manda o WAV pro Gemini: devolve { text, actions } numa chamada so. */
  analyze(wavPath, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const g = spawn(this.python, [this.geminiScript], {
        env: { ...process.env, GEMINI_MODEL: this.geminiModel },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "", err = "";
      const timer = setTimeout(() => { try { g.kill(); } catch {} reject(new Error("gemini timeout")); }, timeoutMs);
      g.stdout.on("data", (d) => (out += d.toString()));
      g.stderr.on("data", (d) => (err += d.toString()));
      g.on("close", () => {
        clearTimeout(timer);
        const lines = out.trim().split("\n").filter(Boolean);
        const last = lines[lines.length - 1];
        if (!last) return reject(new Error("gemini sem resposta: " + err.slice(0, 200)));
        try {
          const msg = JSON.parse(last);
          if (!msg.ok) return reject(new Error(msg.error || "gemini falhou"));
          resolve({ text: msg.text || "", actions: msg.actions || [], ms: msg.ms });
        } catch (e) { reject(new Error("gemini json: " + last.slice(0, 150))); }
      });
      g.stdin.write(JSON.stringify({ wav: wavPath }) + "\n");
      g.stdin.end();
    });
  }

  /** Transcreve um WAV. Retorna o texto. */
  transcribe(wavPath, timeoutMs = 60000) {
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stt timeout")), timeoutMs);
      this.queue.push((msg) => {
        clearTimeout(timer);
        if (msg.ok) resolve(msg.text || "");
        else reject(new Error(msg.error || "stt falhou"));
      });
      this.proc.stdin.write(JSON.stringify({ wav: wavPath }) + "\n");
    });
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.write('{"quit":true}\n'); } catch {} }
  }
}

module.exports = { SttClient };

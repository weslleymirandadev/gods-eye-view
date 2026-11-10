/**
 * TTS local (Windows SAPI) -> PCM 16 kHz mono 16-bit.
 *
 * Usado pra tocar a resposta no MAX98357A do ESP (opcode 0x09).
 * Sem dependencia nova: usa o System.Speech que ja vem no Windows.
 *
 * O SAPI consegue escrever o WAV direto no formato que o ESP espera
 * (16 kHz, 16-bit, mono), entao nao precisa reamostrar nada.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAMPLE_RATE = 16000;

/** Sintetiza o texto e devolve so os bytes de PCM (sem cabecalho). */
function synthesizePcm(text, opts = {}) {
  if (!text || !String(text).trim()) return Buffer.alloc(0);

  const voice = opts.voice || process.env.TTS_VOICE || "";
  const rate = Number.isFinite(opts.rate) ? opts.rate : Number(process.env.TTS_RATE || 0);

  const tmp = path.join(os.tmpdir(), `gods-tts-${process.pid}-${Date.now()}.wav`);
  const esc = (s) => String(s).replace(/'/g, "''");
  const voiceLine = voice ? `$s.SelectVoice('${esc(voice)}');` : "";

  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  ${SAMPLE_RATE},
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${esc(tmp)}', $fmt)
$s.Rate = ${rate}
${voiceLine}
$s.Speak('${esc(text)}')
$s.Dispose()
`;

  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "pipe",
      timeout: 20000,
    });
    const wav = fs.readFileSync(tmp);
    return wavToPcm(wav);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ja foi */ }
  }
}

/** Extrai o chunk "data" de um WAV (ignora cabecalho, que tem tamanho variavel). */
function wavToPcm(wav) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") return Buffer.alloc(0);
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") {
      const start = off + 8;
      const end = Math.min(wav.length, start + size);
      return wav.subarray(start, end);
    }
    off += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

/** Fala se o SAPI estiver disponivel nesta maquina. */
function ttsAvailable() {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech; 'ok'"], {
      stdio: "pipe",
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { synthesizePcm, wavToPcm, ttsAvailable, SAMPLE_RATE };

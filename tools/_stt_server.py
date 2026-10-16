"""Servidor STT persistente: carrega o modelo UMA vez e transcreve sob demanda.

Protocolo (stdin/stdout, uma linha JSON por comando):
  -> {"wav": "/caminho/rec.wav"}
  <- {"ok": true, "text": "..."}  ou  {"ok": false, "error": "..."}
  -> {"quit": true}   encerra

Modelo via env STT_MODEL (default "tiny").
"""
import sys, json, os
from faster_whisper import WhisperModel

MODEL = os.environ.get("STT_MODEL", "tiny")
_model = None


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    return _model


def transcribe(path):
    segs, _ = get_model().transcribe(path, language=None, beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segs).strip()


def main():
    # carrega o modelo agora (o primeiro comando nao paga a carga)
    get_model()
    print(json.dumps({"ready": True, "model": MODEL}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "json: " + str(e)}), flush=True)
            continue
        if cmd.get("quit"):
            break
        wav = cmd.get("wav")
        if not wav or not os.path.exists(wav):
            print(json.dumps({"ok": False, "error": "wav nao encontrado"}), flush=True)
            continue
        try:
            text = transcribe(wav)
            print(json.dumps({"ok": True, "text": text}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()

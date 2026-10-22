"""Servidor STT persistente: carrega o modelo UMA vez e transcreve sob demanda.

Protocolo (stdin/stdout, uma linha JSON por comando):
  -> {"wav": "/caminho/rec.wav"}
  <- {"ok": true, "text": "..."}  ou  {"ok": false, "error": "..."}
  -> {"quit": true}   encerra

Variaveis de ambiente:
  STT_MODEL     modelo do whisper (default "small")
  STT_LANGUAGE  idioma forcado (default "pt"; "auto" = detectar)
"""
import sys, json, os
from faster_whisper import WhisperModel

MODEL = os.environ.get("STT_MODEL", "small")
LANGUAGE = os.environ.get("STT_LANGUAGE", "pt")
if LANGUAGE.strip().lower() in ("", "auto", "none"):
    LANGUAGE = None

_model = None


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    return _model


def transcribe(path):
    segs, info = get_model().transcribe(
        path,
        language=LANGUAGE,        # fixo em pt: nao deixa detectar errado
        beam_size=1,              # mais rapido (1 = greedy)
        vad_filter=True,          # corta silencio, acelera
        vad_parameters=dict(min_silence_duration_ms=300),
        condition_on_previous_text=False,   # evita "loop" de contexto
        temperature=0.0,          # deterministico
        # initial_prompt ajuda o modelo a ficar no idioma e no dominio
        initial_prompt=(
            "Comandos em portugues do Brasil sobre um globo 3D: "
            "me leva para o Brasil, mostra os barcos, liga as cameras, "
            "mostra os avioes, satelites, terremotos, aproxima, afasta."
        ),
    )
    return " ".join(s.text.strip() for s in segs).strip()


def main():
    get_model()   # carrega agora: o primeiro comando nao paga a carga
    print(json.dumps({"ready": True, "model": MODEL, "language": LANGUAGE or "auto"}),
          flush=True)

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

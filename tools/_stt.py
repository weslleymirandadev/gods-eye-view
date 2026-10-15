"""Transcreve um WAV (16kHz mono) com faster-whisper. Imprime o texto."""
import sys
from faster_whisper import WhisperModel

wav = sys.argv[1]
# modelo "small" = bom equilibrio pt/en; baixa na 1a vez (~500MB)
model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe(wav, language=None, beam_size=1, vad_filter=True)
text = " ".join(s.text.strip() for s in segments).strip()
print(text)

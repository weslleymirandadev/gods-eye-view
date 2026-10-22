"""STT + acao via Gemini: recebe um WAV, devolve a transcricao E a acao.

Protocolo (stdin/stdout, uma linha JSON por comando):
  -> {"wav": "/caminho/rec.wav"}
  <- {"ok": true, "text": "...", "actions": [{"name": "...", "args": {...}}]}
  -> {"quit": true}

O Gemini escuta o audio e, na MESMA chamada, escolhe a ferramenta do globo.
Isso elimina o passo Whisper->OpenRouter (menos latencia, melhor precisao).

Variaveis:
  GEMINI_API_KEY  (obrigatoria, lida do .env)
  GEMINI_MODEL    (default gemini-3.5-flash-lite)
"""
import sys, os, json, base64, time
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, ".env")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")

# As ferramentas que o Gemini pode chamar (mesmo contrato do voice-server).
TOOLS = [{
    "function_declarations": [
        {
            "name": "fly_to_location",
            "description": "Voa a camera do globo ate um lugar (pais, cidade, regiao).",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "query": {"type": "STRING", "description": "Nome do lugar, ex: Tokyo, Brasil, Guarulhos"},
                    "viewMode": {"type": "STRING", "enum": ["close", "overview"]},
                },
                "required": ["query"],
            },
        },
        {
            "name": "set_layer_visibility",
            "description": "Liga ou desliga uma camada de dados do globo.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "layerId": {
                        "type": "STRING",
                        "enum": [
                            "flights", "military", "local-adsb", "ais-live-vessels",
                            "satellites", "rocket-launches", "earthquakes", "local-firms",
                            "fire-perimeters", "weather-cyclones", "weather-radar",
                            "weather-satellite", "weather-lightning", "wind", "traffic",
                            "transit", "bikeshare", "cctv", "alpr-cameras", "radio",
                            "street-level", "recent-imagery", "directions",
                            "military-installations", "local-datacenters", "local-dams",
                            "telegeography-submarine-cables", "military-awareness",
                        ],
                    },
                    "enabled": {"type": "BOOLEAN"},
                },
                "required": ["layerId", "enabled"],
            },
        },
        {
            "name": "adjust_camera_zoom",
            "description": "Aproxima ou afasta a camera.",
            "parameters": {
                "type": "OBJECT",
                "properties": {"direction": {"type": "STRING", "enum": ["in", "out"]}},
                "required": ["direction"],
            },
        },
        {
            "name": "zoom_to_globe",
            "description": "Afasta ate ver o globo inteiro.",
            "parameters": {"type": "OBJECT", "properties": {}},
        },
        {
            "name": "set_visual_style",
            "description": "Troca o estilo visual.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "style": {"type": "STRING",
                              "enum": ["normal", "retro", "surveillance", "thermal", "anime", "noir", "snow"]},
                },
                "required": ["style"],
            },
        },
        {
            "name": "set_map_stack",
            "description": "Troca o mapa de base (satelite, ruas, rotulos).",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "stack": {"type": "STRING",
                              "enum": ["photoreal", "bing-aerial", "bing-labels", "esri-imagery", "osm"]},
                },
                "required": ["stack"],
            },
        },
    ]
}]

SYSTEM = (
    "Voce controla um globo 3D por voz. O usuario fala em portugues do Brasil.\n"
    "SEMPRE faca DUAS coisas no mesmo turno, nesta ordem:\n"
    "1) escreva um texto curto com a transcricao do que o usuario falou;\n"
    "2) chame a ferramenta correspondente ao pedido.\n"
    "Exemplo: texto \"Me leve para o Tóquio, Japão.\" e depois "
    "fly_to_location(query=\"Tokyo\").\n"
    "NUNCA traduza nem escreva em outro idioma: a transcricao e SEMPRE em "
    "portugues do Brasil, apenas o que o usuario falou.\n"
    "Regras:\n"
    "- Lugar/pais/cidade -> fly_to_location com query (use o nome CORRETO do lugar).\n"
    "  'Tokio'/'Tóquio' -> Tokyo. 'Japao' -> Japan. 'Brasil' -> Brazil. "
    "  'Estados Unidos' -> United States. 'Sao Paulo' -> Sao Paulo.\n"
    "- Ligar/desligar dados -> set_layer_visibility (barcos=ais-live-vessels, "
    "cameras=cctv, avioes=flights, satelites=satellites, terremotos=earthquakes).\n"
    "- 'aproxima' -> adjust_camera_zoom(in). 'afasta'/'ver o globo' -> zoom_to_globe.\n"
    "- Se o pedido combinar, chame TODAS as ferramentas necessarias.\n"
    "Normalize nomes de lugares para ingles/forma oficial quando for o caso, "
    "pois o geocoder entende melhor assim."
)


def load_key():
    for line in open(ENV, encoding="utf-8"):
        k, _, v = line.partition("=")
        if k.strip() == "GEMINI_API_KEY":
            return v.strip()
    return None


def call_gemini(key, wav_path):
    b64 = base64.b64encode(open(wav_path, "rb").read()).decode()
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{MODEL}:generateContent?key={key}")
    body = {
        "system_instruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"parts": [
            {"text": "Transcreva e execute o comando deste audio."},
            {"inline_data": {"mime_type": "audio/wav", "data": b64}},
        ]}],
        "tools": TOOLS,
        "generationConfig": {"temperature": 0},
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=90))

    cand = (d.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []

    text = ""
    actions = []
    for p in parts:
        if "text" in p:
            text += p["text"]
        fc = p.get("functionCall")
        if fc:
            actions.append({"name": fc.get("name"), "args": fc.get("args") or {}})
    return text.strip(), actions


def main():
    key = load_key()
    if not key:
        print(json.dumps({"ready": False, "error": "sem GEMINI_API_KEY no .env"}), flush=True)
        return
    print(json.dumps({"ready": True, "engine": "gemini", "model": MODEL}), flush=True)

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
        t0 = time.time()
        try:
            text, actions = call_gemini(key, wav)
            print(json.dumps({
                "ok": True, "text": text, "actions": actions,
                "ms": int((time.time() - t0) * 1000),
            }, ensure_ascii=False), flush=True)
        except urllib.error.HTTPError as e:
            print(json.dumps({"ok": False, "error": f"HTTP {e.code}: {e.read()[:200].decode(errors='replace')}"}), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()

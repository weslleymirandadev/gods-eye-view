"""Testa se o billing ativou e o Street View do Google responde."""
import json, urllib.request, urllib.error, urllib.parse, sys

ENV = r"C:\Users\user\Documents\projetos\gods-eye-view\.env"
key = None
for line in open(ENV, encoding="utf-8"):
    if line.split("=")[0].strip() == "GOOGLE_MAPS_API_KEY":
        key = line.split("=",1)[1].strip()

lat, lon = -25.2917, -49.2306
url = "https://maps.googleapis.com/maps/api/streetview/metadata?" + urllib.parse.urlencode({
    "location": f"{lat},{lon}", "key": key, "source": "outdoor"
})
try:
    d = json.load(urllib.request.urlopen(url, timeout=20))
    st = d.get("status")
    if st == "OK":
        print("OK! Street View do Google ATIVO")
        print("  pano_id :", d.get("pano_id"))
        print("  coords  :", d.get("location"))
        print("  data    :", d.get("date"))
        sys.exit(0)
    print("AINDA BLOQUEADO:", st)
    print("  ", d.get("error_message","")[:200])
    sys.exit(1)
except Exception as e:
    print("erro:", str(e)[:200])
    sys.exit(1)

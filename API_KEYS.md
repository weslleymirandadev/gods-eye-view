# APIs do God's Eye — o que é grátis e o que precisa de chave

Levantado varrendo `src/`, `server/` e `.env.example`. Coluna **Key?** diz o que
você precisa providenciar; **Grátis?** diz se dá pra usar sem pagar.

## As 4 chaves que valem a pena

| Chave | Pra quê | Custo | Onde pegar |
|-------|---------|-------|------------|
| `CESIUM_ION_TOKEN` | Globo com relevo, terreno e os basemaps **Bing Aerial / Bing Labels** | **Grátis** (10k req/mês, sem cartão) | https://ion.cesium.com/signup |
| `GOOGLE_MAPS_API_KEY` | Tiles 3D do Google (o "photoreal" bonito) + geocoding | Grátis até US$200/mês | https://console.cloud.google.com |
| `AISSTREAM_API_KEY` | **Barcos ao vivo** (`ais-live-vessels`) | **Grátis** | https://aisstream.io |
| `MAPILLARY_CLIENT_TOKEN` | Imagens de nível de rua (`street-level`) | **Grátis** | https://www.mapillary.com/dashboard/developers |

### Prioridade
1. **`CESIUM_ION_TOKEN`** — é o de maior impacto: destrava terreno/relevo **e** os rótulos de país/estado/cidade (Bing Labels). Sem ele, "mostra os rótulos" não faz nada.
2. **`AISSTREAM_API_KEY`** — sem ela a camada de barcos fica vazia.
3. `GOOGLE_MAPS_API_KEY` — deixa o globo bonito (tiles 3D). Opcional.
4. `MAPILLARY_CLIENT_TOKEN` — só pra street view. Opcional.

### OpenAI (só se usar a voz NATIVA do app)
`OPENAI_API_KEY` (+ `OPENAI_REALTIME_*`) é do sistema de voz **do próprio God's Eye**
(Realtime API, pago). **Não precisamos** — nossa voz usa Whisper local + OpenRouter free.

---

## Camadas e suas fontes

| Camada | Fonte | Key? | Grátis? |
|--------|-------|------|---------|
| `flights` | adsb.lol + OpenSky (+ adsbdb p/ rota) | OpenSky opcional | ✅ |
| `military` | adsb.lol | não | ✅ |
| `local-adsb` | seu próprio receptor (SDR) | não | ✅ |
| `ais-live-vessels` | AISStream | **sim** | ✅ grátis |
| `satellites` | Celestrak (TLE) | não | ✅ |
| `rocket-launches` | The Space Devs / Launch Library | não | ✅ |
| `earthquakes` | USGS | não | ✅ |
| `local-firms` | NASA FIRMS | não* | ✅ |
| `fire-perimeters` | NIFC / InciWeb | não | ✅ |
| `weather-radar` | RainViewer / tiles | não | ✅ |
| `weather-satellite` | NASA GIBS | não | ✅ |
| `weather-cyclones` | NOAA NHC | não | ✅ |
| `weather-lightning` | Blitzortung | não | ✅ |
| `wind` | Open-Meteo / ECMWF | não | ✅ |
| `traffic` | vários DOTs (TX, CA, BC, ON) | não | ✅ |
| `transit` | GBFS + agências locais | não | ✅ |
| `bikeshare` | GBFS (Lyft/Bcycle) | não | ✅ |
| `cctv` | câmeras públicas (DOTs, Digitraffic) | não | ✅ |
| `alpr-cameras` | dontgetflocked (Flock) | não | ✅ |
| `radio` | radio-browser.info | não | ✅ |
| `street-level` | Mapillary | **sim** | ✅ grátis |
| `recent-imagery` | NASA Worldview / GIBS | não | ✅ |
| `directions` | OSRM (routing.openstreetmap.de) | não | ✅ |
| `military-installations` | dados bundled | não | ✅ |
| `local-datacenters` | dados bundled | não | ✅ |
| `local-dams` | dados bundled | não | ✅ |
| `telegeography-submarine-cables` | TeleGeography (bundled) | não | ✅ |
| `military-awareness` | combinação das acima | não | ✅ |

\* NASA FIRMS tem key grátis para volume maior; o app usa o feed público.

## Mapas de base (`set_map_stack`)

| Stack | Key? | Funciona sem? |
|-------|------|---------------|
| `photoreal` (Google 3D) | Google (opcional) | ⚠️ cai pro globo keyless |
| `bing-aerial` | **Cesium Ion** | ❌ **não troca** |
| `bing-labels` (rótulos/fronteiras) | **Cesium Ion** | ❌ **não troca** |
| `esri-imagery` | não | ✅ |
| `osm` (ruas + rótulos) | não | ✅ |

> **Conclusão prática:** pra ver **nomes de países/estados** sem pagar, hoje use
> `osm`. Com o `CESIUM_ION_TOKEN` (grátis), o `bing-labels` passa a funcionar e
> fica bem melhor.

## Geocoding (nossa voz)

| Serviço | Key? | Grátis? |
|---------|------|---------|
| Photon (photon.komoot.io) | **não** | ✅ (fair use) |
| Nominatim (OSM) | não | ✅ (fair use) |
| Google Geocoding | Google | pago |
| Cesium Ion | sim | ✅ grátis |

Usamos **Photon** (sem key) — é o que já está no `voice-server.cjs`.

## Nossa stack de voz (independente do app)

| Peça | Custo |
|------|-------|
| STT: faster-whisper (local) | **grátis** |
| IA: OpenRouter free tier | **grátis** (rate-limited) |

## Resumo: o mínimo pra ficar "decente"

Adicione ao `.env`:
```
CESIUM_ION_TOKEN=<grátis em ion.cesium.com>
AISSTREAM_API_KEY=<grátis em aisstream.io>
```
Com essas **duas** você ganha: terreno/relevo, **rótulos de países** (bing-labels),
e **barcos ao vivo**. O resto do app já funciona sem chave nenhuma.

# Comandos de voz

Fale em portugues (ou ingles) segurando o botao no ESP. O servidor transcreve
(Whisper local), a IA escolhe as acoes e o globo obedece. Varias acoes numa frase
funcionam (`"mostra os barcos e me leva pro Brasil"`).

## Navegacao

| Fala | Acao |
|------|------|
| "me leva pro Brasil" / "vai pra Tóquio" / "mostra a Europa" | `fly_to_location` (pais, cidade, regiao) |
| "aproxima" / "da zoom" | `adjust_camera_zoom` (in) |
| "afasta" / "volta pro globo" / "zoom out" | `zoom_to_globe` |
| "segue o avião ABC123" / "rastreia esse navio" | `track_entity` |
| "para de seguir" | `stop_tracking` |
| "quantos aviões tem na tela?" | `analyst_query` |

## Camadas de dados (28)

Ligue/desligue por voz: *"mostra os barcos"*, *"liga as câmeras"*, *"desliga os satélites"*.

### Voos
| Camada | Fala (aliases) |
|--------|----------------|
| `flights` | aviões, voos, tráfego aéreo, aircraft |
| `military` | voos militares, aviões militares |
| `local-adsb` | meu receptor, meu sdr, minha antena, adsb local |

### Maritimo
| Camada | Fala |
|--------|------|
| `ais-live-vessels` | barcos, navios, embarcações, vessels, ais |
| `telegeography-submarine-cables` | cabos submarinos, cabos submarinos, telegeography |

### Espaco
| Camada | Fala |
|--------|------|
| `satellites` | satélites, sats |
| `rocket-launches` | lançamentos de foguete, lançamentos, missões espaciais |
| `recent-imagery` | imagens recentes, imagem de satélite recente |

### Clima
| Camada | Fala |
|--------|------|
| `weather-cyclones` | ciclones, furacões, tufões, tempestades tropicais |
| `weather-radar` | radar, chuva, clima |
| `weather-satellite` | satélite de clima, nuvens |
| `weather-lightning` | raios, descargas |
| `wind` | ventos, mapa de vento |

### Terra / eventos
| Camada | Fala |
|--------|------|
| `earthquakes` | terremotos, sismos, quakes |
| `local-firms` | focos de incêndio, incêndios, queimadas |
| `fire-perimeters` | perímetro de incêndio, área queimada |
| `local-dams` | barragens, represas |
| `local-datacenters` | data centers |

### Infraestrutura / mobilidade
| Camada | Fala |
|--------|------|
| `traffic` | trânsito, tráfego, congestionamento |
| `transit` | ônibus, trens, metrô, transporte público |
| `bikeshare` | bicicletas, bike share, estações de bike |
| `directions` | rotas, direções |

### Imagens
| Camada | Fala |
|--------|------|
| `cctv` | câmeras de trânsito, câmeras, webcams |
| `alpr-cameras` | câmeras flock, leitores de placa, alpr |
| `street-level` | street view, mapillary, nível de rua |

### Outros
| Camada | Fala |
|--------|------|
| `radio` | rádio, estações de rádio |
| `military-installations` | bases militares, instalações militares |
| `military-awareness` | consciência militar (camada combinada) |

## Estilo visual

*"coloca no modo térmico"*, *"deixa retrô"*, *"modo noturno"*.

| Estilo | Fala |
|--------|------|
| `normal` | normal, padrão |
| `thermal` | térmico, infravermelho |
| `surveillance` | vigilância, câmera de segurança |
| `noir` | noir, preto e branco, noturno |
| `retro` | retrô, crt, antigo |
| `anime` | anime |
| `snow` | neve |

## Mapa de base

*"coloca no mapa de ruas"*, *"imagem de satélite"*, *"mostra os rótulos"*.

| Stack | Fala |
|-------|------|
| `photoreal` | fotorrealista, globo padrão |
| `bing-aerial` | imagem aérea |
| `bing-labels` | rótulos, fronteiras, nomes |
| `esri-imagery` | esri, imagem esri |
| `osm` | ruas, openstreetmap |

## Painels

*"abre o painel de dados"*, *"fecha os locais"* — `set_panel_open` (`data`, `locations`, `recent`, `settings`).

## Como funciona

```
voz -> Whisper (STT local) -> IA (OpenRouter free, function calling)
    -> valida o geocode (pais vs cidade homonima)
    -> POST /action no capture-server -> postMessage -> globo se move
```

As acoes e seus enums espelham `src/voice/actionSchemas.js` e
`src/voice/layerManifest.js` do God's Eye View — se uma camada nova aparecer
la, adicione o id em `LAYER_IDS` no `tools/voice-server.cjs`.

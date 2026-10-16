#include "video_stream.h"
#include <WebSocketsClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include "esp_jpeg_dec.h"      // decoder JPEG de hardware do ESP32-S3
#include "esp_jpeg_common.h"   // jpeg_calloc_align

// O objeto do display vive aqui (o drawJpeg precisa dele).
Adafruit_ST7789 tft = Adafruit_ST7789(&SPI, TFT_CS, TFT_DC, TFT_RST);

static WebSocketsClient wsVideo;

static uint8_t*  jpgBuf = nullptr;      // ~32KB (JPEG recebido)
static uint8_t*  outBuf = nullptr;      // 115200 B (RGB565 decodificado, 16B-aligned)
static uint32_t  jpgTotal = 0;
static uint32_t  g_frames = 0;
static uint32_t  g_chunks = 0;

// decodifica o JPEG (hardware) e desenha no ST7789
static void drawJpeg() {
  jpeg_dec_config_t cfg = {};
  cfg.output_type = JPEG_PIXEL_FORMAT_RGB565_LE;
  cfg.rotate = JPEG_ROTATE_0D;
  cfg.block_enable = false;

  jpeg_dec_handle_t dec = NULL;
  if (jpeg_dec_open(&cfg, &dec) != JPEG_ERR_OK) return;

  jpeg_dec_io_t io = {};
  io.inbuf = jpgBuf;
  io.inbuf_len = jpgTotal;
  io.inbuf_remain = jpgTotal;

  jpeg_dec_header_info_t info = {};
  if (jpeg_dec_parse_header(dec, &io, &info) != JPEG_ERR_OK) { jpeg_dec_close(dec); return; }

  io.outbuf = outBuf;
  io.out_size = SCR_W * SCR_H * 2;
  jpeg_dec_process(dec, &io);
  jpeg_dec_close(dec);

  tft.drawRGBBitmap(0, 0, (uint16_t*)outBuf, SCR_W, SCR_H);
}

// Protocolo VIDEO (ESP <- capture-server :8082):
//   0x00 -> manifest JSON
//   0x03 -> chunk [0x03][total0..3][off0..3][dados...] (32-bit LE)
static void onVideoEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[video] conectado");
      break;
    case WStype_DISCONNECTED:
      Serial.println("[video] desconectado");
      break;

    case WStype_BIN:
    case WStype_TEXT: {
      if (len < 1) break;
      if (payload[0] == 0x03) {
        if (len < 10) break;
        uint32_t total = (uint32_t)payload[1]
                       | ((uint32_t)payload[2] << 8)
                       | ((uint32_t)payload[3] << 16)
                       | ((uint32_t)payload[4] << 24);
        uint32_t off = (uint32_t)payload[5]
                     | ((uint32_t)payload[6] << 8)
                     | ((uint32_t)payload[7] << 16)
                     | ((uint32_t)payload[8] << 24);
        size_t n = len - 9;
        total = total > JPG_MAX ? JPG_MAX : total;
        if (off + n > total) n = (off < total) ? (total - off) : 0;
        if (n) memcpy(jpgBuf + off, payload + 9, n);
        jpgTotal = total;

        g_chunks++;
        if (off + n >= total) {   // JPEG completo
          drawJpeg();
          g_frames++;
          g_chunks = 0;
        }
      } else if (payload[0] == 0x00) {
        Serial.printf("[video] manifest: %.*s\n", (int)(len - 1), payload + 1);
      }
      break;
    }
    default: break;
  }
}

// inicializa o display (fiacao comprovada + retry) e os buffers de video
void initDisplay() {
  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);
  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_RST, HIGH);

  for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    digitalWrite(TFT_RST, LOW);  delay(150);
    digitalWrite(TFT_RST, HIGH); delay(250);
    SPI.end(); delay(50);
    SPI.begin(TFT_SCL, -1, TFT_MOSI, -1); delay(100);
    tft.setSPISpeed(SPI_CLOCK_HZ);
    tft.init(240, 240, SPI_MODE3);
    tft.setRotation(2);
  }
}

void initVideoStream() {
  jpgBuf = (uint8_t*)malloc(JPG_MAX);
  outBuf = (uint8_t*)jpeg_calloc_align(SCR_W * SCR_H * 2, 16);   // alinhado 16B!
  if (!jpgBuf || !outBuf) {
    Serial.printf("[erro] malloc jpg=%p out=%p\n", jpgBuf, outBuf);
    tft.fillScreen(ST77XX_RED);
    while (true) delay(1000);
  }
  Serial.printf("[buf] jpg=%p out=%p heap=%u\n", jpgBuf, outBuf, (unsigned)ESP.getFreeHeap());

  wsVideo.begin(WS_HOST, WS_VIDEO_PORT, "/esp");
  wsVideo.onEvent(onVideoEvent);
  wsVideo.setReconnectInterval(2000);
}

void videoLoop() {
  wsVideo.loop();
}

uint32_t videoFrames() {
  return g_frames;
}

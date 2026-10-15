// =====================================================================
//  ESP32-S3 -> ST7789 240x240  |  STREAM DO GOD'S EYE VIEW via WEBSOCKET
// ---------------------------------------------------------------------
//  Servidor no PC: node tools/esp-capture-server.cjs   (porta 8082)
//  (Puppeteer captura o globo do God's Eye a 18fps -> RGB565 240x240)
//
//  Protocolo WS (chunks de 8KB, ver CHUNK no servidor):
//    byte[0] = 0x00 -> manifest JSON
//    byte[0] = 0x03 -> chunk: [0x03][off_lo][off_hi][dados...]
//                      (o ESP monta no frameBuf; desenha ao completar)
//
//  Board: ESP32S3 Dev Module | FlashSize=16M | FlashMode=QIO
//         Partition=Default | PSRAM=Disabled | 240MHz
// =====================================================================

// Chunks de 8KB (ver CHUNK no servidor). Buffer de sobra.
#define WEBSOCKETS_MAX_DATA_SIZE (16 * 1024)

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include "esp_jpeg_dec.h"      // decoder JPEG de hardware do ESP32-S3
#include "esp_jpeg_common.h"   // jpeg_calloc_align

// ---------------- WiFi ----------------
static const char* WIFI_SSID = "NEIVA";
static const char* WIFI_PASS = "Neiva1973!";

// ---------------- WebSocket server (IP local do PC) ----------------
static const char* WS_HOST = "192.168.100.2";
static const int   WS_PORT = 8082;

// ---------------- Display (fiacao comprovada) ----------------
#define TFT_SCL   42
#define TFT_MOSI  41
#define TFT_DC    38
#define TFT_RST   37
#define TFT_CS    -1
#define TFT_BLK    8
#define SPI_CLOCK_HZ 60000000
#define MAX_RETRIES  5

#define SCR_W 240
#define SCR_H 240


// &SPI = HARDWARE SPI (senao vira bit-bang ~600x mais lento)
Adafruit_ST7789 tft = Adafruit_ST7789(&SPI, TFT_CS, TFT_DC, TFT_RST);

WebSocketsClient webSocket;

// JPEG recebido em chunks + buffer de saida RGB565 pro decode
static uint8_t*  jpgBuf = nullptr;       // ~15KB (JPEG recebido)
static uint8_t*  outBuf = nullptr;       // 115200 B (RGB565 decodificado)
static uint32_t  g_frames = 0;
static uint32_t  g_chunks = 0;
static uint32_t  jpgTotal = 0;           // tamanho do JPEG do frame atual
#define JPG_MAX (32 * 1024)              // folga p/ JPEGs maiores

// decodifica o JPEG (hardware) e desenha
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

// ---------------------------------------------------------------------
static void wsEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:    Serial.println("[ws] conectado"); break;
    case WStype_DISCONNECTED: Serial.println("[ws] desconectado"); break;

    case WStype_BIN:
    case WStype_TEXT: {
      if (len < 1) break;

      if (payload[0] == 0x03) {
        // chunk: [0x03][total0..3][off0..3][dados...]  (total e off 32-bit LE)
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
        if (g_frames == 0 && g_chunks <= 5)
          Serial.printf("[chunk] #%lu off=%lu n=%u total=%lu\n",
                        (unsigned long)g_chunks, (unsigned long)off, (unsigned)n, (unsigned long)total);

        if (off + n >= total) {   // JPEG completo
          drawJpeg();
          g_frames++;
          g_chunks = 0;
        }
      } else if (payload[0] == 0x00) {
        Serial.printf("[ws] manifest: %.*s\n", (int)(len - 1), payload + 1);
      }
      break;
    }
    default: break;
  }
}

void initializeDisplay() {
  pinMode(TFT_BLK, OUTPUT);
  digitalWrite(TFT_BLK, HIGH);

  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_RST, HIGH);

  for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Garante que o controlador saia de um estado anterior.
    digitalWrite(TFT_RST, LOW);
    delay(150);
    digitalWrite(TFT_RST, HIGH);
    delay(250);

    // Reinicia o SPI usando os GPIOs definidos acima.
    SPI.end();
    delay(50);
    SPI.begin(TFT_SCL, -1, TFT_MOSI, -1);
    delay(100);

    // Reinicializa o controlador.
    tft.setSPISpeed(SPI_CLOCK_HZ);
    tft.init(240, 240, SPI_MODE3);
    tft.setRotation(2);
  }
}

// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=== ST7789 WS VIDEO ===");
  Serial.printf("PSRAM: %s\n", psramFound() ? "SIM" : "NAO");
  Serial.flush();

  initializeDisplay();
  
  // display
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  tft.setTextSize(2);
  tft.setCursor(8, 8);
  tft.println("WiFi...");

  // buffers: jpgBuf (JPEG recebido, ~32KB) + outBuf (RGB565 decodificado, 115200B)
  jpgBuf = (uint8_t*)malloc(JPG_MAX);
  outBuf = (uint8_t*)jpeg_calloc_align(SCR_W * SCR_H * 2, 16);  // alinhado 16B!
  if (!jpgBuf || !outBuf) {
    Serial.printf("[erro] malloc jpg=%p out=%p\n", jpgBuf, outBuf);
    tft.fillScreen(ST77XX_RED);
    while (true) delay(1000);
  }
  Serial.printf("[buf] jpg=%p out=%p heap=%u\n", jpgBuf, outBuf, (unsigned)ESP.getFreeHeap());

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] conectando"); Serial.flush();
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries++ < 60) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] FALHOU");
    tft.fillScreen(ST77XX_RED);
    while (true) delay(1000);
  }
  Serial.printf("[wifi] OK IP=%s\n", WiFi.localIP().toString().c_str());

  webSocket.begin(WS_HOST, WS_PORT, "/");
  webSocket.onEvent(wsEvent);
  webSocket.setReconnectInterval(2000);

  tft.fillScreen(ST77XX_BLACK);
  tft.setCursor(8, 8);
  tft.println("Stream!");
}

// ---------------------------------------------------------------------
void loop() {
  webSocket.loop();

  static uint32_t lastFps = millis(), lastCount = 0;
  if (millis() - lastFps >= 2000) {
    uint32_t fps = (g_frames - lastCount) * 1000 / (millis() - lastFps);
    Serial.printf("[fps] %lu total=%lu\n", (unsigned long)fps, (unsigned long)g_frames);
    lastCount = g_frames;
    lastFps = millis();
  }
}

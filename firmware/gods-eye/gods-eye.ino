// =====================================================================
//  GOD'S EYE no ESP32-S3  |  ST7789 (video) + INMP441 (voz) + botao
// ---------------------------------------------------------------------
//  VIDEO: capture-server (porta 8082) manda JPEG em chunks; o S3 decodifica
//         em hardware e desenha no ST7789.
//  VOZ:   botao apertado -> grava audio I2S e manda pro voice-server (8083);
//         solto -> o PC transcreve (whisper) e dirige o globo.
//
//  Protocolo VIDEO (WS :8082), ESP <- servidor:
//    0x00 -> manifest JSON
//    0x03 -> chunk [0x03][total0..3][off0..3][dados...] (32-bit LE)
//
//  Protocolo VOZ (WS :8083), ESP -> servidor:
//    0x01 -> inicio de gravacao (botao apertado)
//    0x02 -> chunk de audio PCM (16kHz, 16-bit, LE)
//    0x03 -> fim de gravacao (botao solto)
//
//  Fiacao:
//    ST7789:  SCL=42 MOSI=41 DC=38 RST=37 CS=-1 BLK=8
//    INMP441: SCK/BCLK=4  WS=5  SD=6  L/R=GND  VDD=3V3  GND=GND
//    Botao:   GPIO 7 -> GND (INPUT_PULLUP; apertado = LOW)
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
#include "driver/i2s.h"

// ---------------- WiFi ----------------
static const char* WIFI_SSID = "NEIVA";
static const char* WIFI_PASS = "Neiva1973!";

// ---------------- Servidores (PC) ----------------
static const char* WS_HOST      = "192.168.100.2";
static const int   WS_VIDEO_PORT = 8082;
static const int   WS_VOICE_PORT = 8083;

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

// ---------------- Microfone INMP441 (I2S) ----------------
#define I2S_BCLK   4
#define I2S_WS     5
#define I2S_SD     6
#define BTN_PIN    7          // apertado = LOW (INPUT_PULLUP)

#define SAMPLE_RATE   16000
#define MIC_SAMPLES   256     // amostras por leitura I2S (32-bit)
#define AUDIO_GAIN    75      // do INMP441-base
#define DC_FILTER_ALPHA 99

// &SPI = HARDWARE SPI (senao vira bit-bang ~600x mais lento)
Adafruit_ST7789 tft = Adafruit_ST7789(&SPI, TFT_CS, TFT_DC, TFT_RST);

WebSocketsClient wsVideo;
WebSocketsClient wsVoice;

// ---------------- buffers de video ----------------
static uint8_t*  jpgBuf = nullptr;       // ~32KB (JPEG recebido)
static uint8_t*  outBuf = nullptr;       // 115200 B (RGB565 decodificado)
static uint32_t  g_frames = 0;
static uint32_t  g_chunks = 0;
static uint32_t  jpgTotal = 0;
#define JPG_MAX (32 * 1024)

// ---------------- buffers de audio ----------------
static int32_t   micRaw[MIC_SAMPLES];    // amostras cruas 32-bit
static int16_t   micPcm[MIC_SAMPLES];    // convertidas 16-bit
static int32_t   dcOffset = 0;
static bool      dcCalibrated = false;
static uint32_t  voiceFrames = 0;

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
// VIDEO (WS :8082)
// ---------------------------------------------------------------------
static void wsVideoEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[video] conectado");
      wsVideo.sendTXT("video-ready");       // avisa (o servidor pula p/ cliente pronto)
      break;
    case WStype_DISCONNECTED: Serial.println("[video] desconectado"); break;

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

// ---------------------------------------------------------------------
// VOZ (WS :8083)
// ---------------------------------------------------------------------
static void wsVoiceEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:    Serial.println("[voz] conectado"); break;
    case WStype_DISCONNECTED: Serial.println("[voz] desconectado"); break;
    case WStype_TEXT: {
      // resposta do servidor (texto transcrito / acoes)
      Serial.printf("[voz] resp: %.*s\n", (int)len, payload);
      break;
    }
    default: break;
  }
}

// ------------------- I2S (INMP441) -------------------
static void initI2S() {
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate = SAMPLE_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 4;
  cfg.dma_buf_len = 512;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = false;
  cfg.fixed_mclk = 0;

  i2s_pin_config_t pins = {};
  pins.bck_io_num = I2S_BCLK;
  pins.ws_io_num = I2S_WS;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = I2S_SD;

  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
}

// calibra o DC offset (bias do mic) — do INMP441-base
static void calibrateDC() {
  Serial.print("[mic] calibrando DC");
  int64_t sum = 0; int count = 0;
  for (int c = 0; c < 20; c++) {
    size_t br = 0;
    i2s_read(I2S_NUM_0, micRaw, sizeof(micRaw), &br, portMAX_DELAY);
    int s = br / sizeof(int32_t);
    for (int i = 0; i < s; i++) { sum += (int16_t)(micRaw[i] >> 16); count++; }
    delay(2); Serial.print(".");
  }
  dcOffset = count ? (int32_t)(sum / count) : 0;
  dcCalibrated = true;
  Serial.printf(" -> %d\n", dcOffset);
}

// 32->16 bit (MSB) + remove DC + ganho + clipping (do INMP441-base)
static void processAudio(const int32_t* src, int16_t* dst, int n) {
  for (int i = 0; i < n; i++) {
    int16_t s = (int16_t)(src[i] >> 16);
    if (dcCalibrated) dcOffset = (dcOffset * DC_FILTER_ALPHA + s * (100 - DC_FILTER_ALPHA)) / 100;
    int32_t v = ((int32_t)s - dcOffset) * AUDIO_GAIN;
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    dst[i] = (int16_t)v;
  }
}

// ---------------------------------------------------------------------
void initializeDisplay() {
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

// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=== GOD'S EYE (video + voz) ===");
  Serial.printf("PSRAM: %s\n", psramFound() ? "SIM" : "NAO");
  Serial.flush();

  initializeDisplay();
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  tft.setTextSize(2);
  tft.setCursor(8, 8);
  tft.println("WiFi...");

  // buffers de video
  jpgBuf = (uint8_t*)malloc(JPG_MAX);
  outBuf = (uint8_t*)jpeg_calloc_align(SCR_W * SCR_H * 2, 16);  // alinhado 16B!
  if (!jpgBuf || !outBuf) {
    Serial.printf("[erro] malloc jpg=%p out=%p\n", jpgBuf, outBuf);
    tft.fillScreen(ST77XX_RED);
    while (true) delay(1000);
  }
  Serial.printf("[buf] jpg=%p out=%p heap=%u\n", jpgBuf, outBuf, (unsigned)ESP.getFreeHeap());

  // microfone + botao
  pinMode(BTN_PIN, INPUT_PULLUP);
  initI2S();
  delay(100);
  calibrateDC();

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

  // video (recebe JPEG)
  wsVideo.begin(WS_HOST, WS_VIDEO_PORT, "/");
  wsVideo.onEvent(wsVideoEvent);
  wsVideo.setReconnectInterval(2000);

  // voz (manda audio)
  wsVoice.begin(WS_HOST, WS_VOICE_PORT, "/");
  wsVoice.onEvent(wsVoiceEvent);
  wsVoice.setReconnectInterval(2000);

  tft.fillScreen(ST77XX_BLACK);
  tft.setCursor(8, 8);
  tft.println("Stream!");
}

// ---------------------------------------------------------------------
void loop() {
  wsVideo.loop();
  wsVoice.loop();

  // botao: apertado = grava e manda; solto = fecha
  static bool recording = false;
  bool pressed = (digitalRead(BTN_PIN) == LOW);

  if (pressed && !recording) {
    recording = true;
    uint8_t hdr = 0x01;
    wsVoice.sendBIN(&hdr, 1);            // inicio da gravacao
    Serial.println("[voz] gravando...");
  } else if (!pressed && recording) {
    recording = false;
    uint8_t end = 0x03;
    wsVoice.sendBIN(&end, 1);            // fim da gravacao
    Serial.println("[voz] enviado");
  }

  if (recording) {
    size_t br = 0;
    if (i2s_read(I2S_NUM_0, micRaw, sizeof(micRaw), &br, 0) == ESP_OK && br > 0) {
      int n = br / sizeof(int32_t);
      processAudio(micRaw, micPcm, n);
      // manda [0x02][pcm 16-bit LE]
      static uint8_t txbuf[1 + MIC_SAMPLES * 2];
      txbuf[0] = 0x02;
      memcpy(txbuf + 1, micPcm, n * 2);
      wsVoice.sendBIN(txbuf, 1 + n * 2);
      voiceFrames++;
    }
  }

  // fps do video
  static uint32_t lastFps = millis(), lastCount = 0;
  if (millis() - lastFps >= 2000) {
    uint32_t fps = (g_frames - lastCount) * 1000 / (millis() - lastFps);
    Serial.printf("[fps] %lu total=%lu  audio_blk=%lu\n",
                  (unsigned long)fps, (unsigned long)g_frames, (unsigned long)voiceFrames);
    lastCount = g_frames;
    lastFps = millis();
  }
}

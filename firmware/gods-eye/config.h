#ifndef CONFIG_H
#define CONFIG_H

// ===================== WiFi =====================
static const char* WIFI_SSID = "NEIVA";
static const char* WIFI_PASS = "Neiva1973!";

// ================== Servidores (PC) ==================
static const char* WS_HOST       = "192.168.100.2";
static const int   WS_VIDEO_PORT = 8082;
static const int   WS_VOICE_PORT = 8083;

// ================== ST7789 (fiacao comprovada) ==================
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

// ================== INMP441 (I2S) ==================
#define I2S_BCLK 17
#define I2S_WS   15
#define I2S_SD   16

#define BUTTON_PIN 36

// ================== Audio (do INMP441-base) ==================
#define SAMPLE_RATE 16000
#define CHANNELS 1
#define BUFFER_SAMPLES 512
#define SILENCE_TIMEOUT_MS 1500

#define VAD_THRESHOLD 500
#define DEBUG_VAD false
#define AUDIO_GAIN 75
#define USE_MSB_CONVERSION true

#define RMS_SMOOTHING_SAMPLES 4

#define DC_FILTER_ALPHA 99

// ================== Video ==================
#define WEBSOCKETS_MAX_DATA_SIZE (16 * 1024)   // chunks de 8KB cabem
#define JPG_MAX (32 * 1024)

#endif

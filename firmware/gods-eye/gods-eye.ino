// =====================================================================
//  GOD'S EYE no ESP32-S3  |  ST7789 (video) + INMP441 (voz) + botao
// ---------------------------------------------------------------------
//  Modulos:
//    config.h            -> WiFi, pinos e parametros
//    video_stream.*      -> ST7789 + decoder JPEG + WS de video (:8082)
//    i2s_handler.*       -> I2S RX do INMP441  (do INMP441-base)
//    audio_processor.*   -> 32->16 MSB, DC offset, ganho, RMS  (idem)
//    voice_client.*      -> WS de voz (:8083): manda PCM, recebe resposta
//    recorder.*          -> estado de gravacao (botao/VAD)  (idem base)
//
//  Fiacao:
//    ST7789:  SCL=42 MOSI=41 DC=38 RST=37 CS=-1 BLK=8
//    INMP441: SCK/BCLK=17  WS=15  SD=16  L/R=GND  VDD=3V3  GND=GND
//    Botao:   GPIO 36 -> GND (INPUT_PULLUP; apertado = LOW)
//
//  Board: ESP32S3 Dev Module | FlashSize=16M | FlashMode=QIO
//         Partition=Default | PSRAM=Disabled | 240MHz
// =====================================================================

#include <WiFi.h>
#include "driver/i2s.h"
#include "config.h"
#include "video_stream.h"
#include "i2s_handler.h"
#include "audio_processor.h"
#include "voice_client.h"
#include "recorder.h"

// chamada no .ino principal (declarada em video_stream.ino)
void initDisplay();

static int32_t rawI2sBuffer[BUFFER_SAMPLES];
static int16_t processedBuffer[BUFFER_SAMPLES];
static bool voiceButtonDown = false;

static void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] conectando"); Serial.flush();
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries++ < 60) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] FALHOU");
    while (true) delay(1000);
  }
  Serial.printf("[wifi] OK IP=%s\n", WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=== GOD'S EYE (video + voz) ===");
  Serial.printf("PSRAM: %s\n", psramFound() ? "SIM" : "NAO");
  Serial.flush();

  initDisplay();
  initVideoStream();

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  initAudioProcessor();
  initI2S();
  delay(100);
  calibrateDCOffset();

  connectWiFi();

  initVoiceClient();

  Serial.println("Sistema pronto (video + voz)");
}

void loop() {
  videoLoop();
  voiceLoop();

  // le o microfone continuamente (necessario p/ o RMS/VAD funcionar)
  size_t bytesRead = 0;
  i2s_read(I2S_NUM_0, rawI2sBuffer, sizeof(rawI2sBuffer), &bytesRead, portMAX_DELAY);
  int samplesRead = bytesRead / sizeof(int32_t);
  if (samplesRead == 0) return;

  convert32to16(rawI2sBuffer, processedBuffer, samplesRead);
  uint32_t rms = computeSmoothedRMS(computeRMS(processedBuffer, samplesRead));

  bool buttonPressed = !digitalRead(BUTTON_PIN);

  if (isVADMode()) {
    // modo VAD (deteccao de voz) — do INMP441-base
    if (rms > VAD_THRESHOLD) {
      if (!isRecording()) startRecording();
      updateLastVoiceTime();
    }
    if (isRecording()) writeAudioData(processedBuffer, samplesRead);
    checkSilenceTimeout(rms);
  } else {
    // push-to-talk: apertado grava, solto fecha
    if (buttonPressed && !voiceButtonDown) {
      voiceButtonDown = true;
      startRecording();
    } else if (!buttonPressed && voiceButtonDown) {
      voiceButtonDown = false;
      stopRecording();
    }
    if (isRecording()) writeAudioData(processedBuffer, samplesRead);
  }

  // fps do video
  static uint32_t lastFps = millis(), lastCount = 0;
  if (millis() - lastFps >= 2000) {
    uint32_t fps = (videoFrames() - lastCount) * 1000 / (millis() - lastFps);
    Serial.printf("[fps] %lu total=%lu rms=%lu%s\n",
                  (unsigned long)fps, (unsigned long)videoFrames(), (unsigned long)rms,
                  isRecording() ? " GRAVANDO" : "");
    lastCount = videoFrames();
    lastFps = millis();
  }
}

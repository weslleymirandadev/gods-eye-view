#include "recorder.h"

// Em vez de escrever no SPIFFS, o recorder agora envia o PCM pelo WebSocket
// para o voice-server no PC (que transcreve e escolhe a acao no globo).
// A logica de estado (recording, timeout de silencio) segue a do INMP441-base.

bool recording = false;
unsigned long lastVoiceTime = 0;
uint32_t dataBytesWritten = 0;
bool vadMode = false;

void startRecording() {
  if (recording) {
    return;
  }

  Serial.println("Voz detectada! Gravacao iniciada");

  voiceSendStart();
  recording = true;
  dataBytesWritten = 0;
  lastVoiceTime = millis();
}

void stopRecording() {
  if (!recording) {
    return;
  }

  Serial.printf("Fim da gravacao (%d bytes de audio)\n", dataBytesWritten);
  Serial.printf("Duracao aproximada: %.2f segundos\n", (float)dataBytesWritten / (SAMPLE_RATE * 2));

  voiceSendEnd();
  recording = false;
}

bool isRecording() {
  return recording;
}

void updateLastVoiceTime() {
  lastVoiceTime = millis();
}

void checkSilenceTimeout(uint32_t rms) {
  if (recording) {
    if (rms <= VAD_THRESHOLD) {
      if (millis() - lastVoiceTime > SILENCE_TIMEOUT_MS) {
        stopRecording();
      }
    }
  }
}

uint32_t getDataBytesWritten() {
  return dataBytesWritten;
}

void writeAudioData(int16_t* buffer, int samples) {
  if (!recording) {
    return;
  }

  // envia o bloco de PCM pelo WebSocket
  voiceSendChunk((uint8_t*)buffer, samples * sizeof(int16_t));
  dataBytesWritten += samples * sizeof(int16_t);
}

void setVADMode(bool enabled) {
  vadMode = enabled;
  Serial.printf("Modo alterado para: %s\n", enabled ? "VAD (deteccao de voz)" : "Botao");
}

bool isVADMode() {
  return vadMode;
}

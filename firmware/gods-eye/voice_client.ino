#include "voice_client.h"
#include <WebSocketsClient.h>

// Protocolo VOZ (ESP -> voice-server :8083):
//   0x01 -> inicio de gravacao
//   0x02 -> chunk PCM (16kHz, 16-bit, LE)
//   0x03 -> fim de gravacao

static WebSocketsClient wsVoice;
static uint8_t txbuf[1 + BUFFER_SAMPLES * 2];

static void onVoiceEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[voz] conectado");
      break;
    case WStype_DISCONNECTED:
      Serial.println("[voz] desconectado");
      break;
    case WStype_TEXT:
      Serial.printf("[voz] resp: %.*s\n", (int)len, payload);
      break;
    default:
      break;
  }
}

void initVoiceClient() {
  wsVoice.begin(WS_HOST, WS_VOICE_PORT, "/");
  wsVoice.onEvent(onVoiceEvent);
  wsVoice.setReconnectInterval(2000);
}

void voiceLoop() {
  wsVoice.loop();
}

void voiceSendStart() {
  uint8_t hdr = 0x01;
  wsVoice.sendBIN(&hdr, 1);
}

void voiceSendChunk(const uint8_t* pcm, size_t len) {
  if (len > BUFFER_SAMPLES * 2) len = BUFFER_SAMPLES * 2;
  txbuf[0] = 0x02;
  memcpy(txbuf + 1, pcm, len);
  wsVoice.sendBIN(txbuf, 1 + len);
}

void voiceSendEnd() {
  uint8_t end = 0x03;
  wsVoice.sendBIN(&end, 1);
}

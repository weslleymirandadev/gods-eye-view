#ifndef VOICE_CLIENT_H
#define VOICE_CLIENT_H

#include <Arduino.h>
#include <WebSocketsClient.h>
#include "config.h"

void initVoiceClient();
void voiceLoop();
void voiceSendStart();
void voiceSendChunk(const uint8_t* pcm, size_t len);
void voiceSendEnd();

#endif

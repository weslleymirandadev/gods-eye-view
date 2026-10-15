#ifndef RECORDER_H
#define RECORDER_H

#include <Arduino.h>
#include "config.h"
#include "voice_client.h"

void startRecording();
void stopRecording();
bool isRecording();
void updateLastVoiceTime();
void checkSilenceTimeout(uint32_t rms);
uint32_t getDataBytesWritten();
void writeAudioData(int16_t* buffer, int samples);
void setVADMode(bool enabled);
bool isVADMode();

#endif

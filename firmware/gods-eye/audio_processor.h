#ifndef AUDIO_PROCESSOR_H
#define AUDIO_PROCESSOR_H

#include <Arduino.h>
#include "config.h"

void convert32to16(int32_t* src, int16_t* dst, int samples);
uint32_t computeRMS(int16_t* buffer, int samples);
uint32_t computeSmoothedRMS(uint32_t currentRMS);
void initAudioProcessor();
void calibrateDCOffset();
int32_t getDCOffset();

#endif


#include "audio_processor.h"
#include "driver/i2s.h"
#include <math.h>

uint32_t rmsHistory[RMS_SMOOTHING_SAMPLES];
int rmsHistoryIndex = 0;

int32_t dcOffset = 0;
bool dcOffsetCalibrated = false;

void initAudioProcessor() {
  for (int i = 0; i < RMS_SMOOTHING_SAMPLES; i++) {
    rmsHistory[i] = 0;
  }
  
  dcOffset = 0;
  dcOffsetCalibrated = false;
}

void convert32to16(int32_t* src, int16_t* dst, int samples) {
  for (int i = 0; i < samples; i++) {
    int32_t raw = src[i];
    int16_t sample;
    
    #if USE_MSB_CONVERSION
      sample = (int16_t)(raw >> 16);
    #else
      sample = (int16_t)(raw & 0xFFFF);
    #endif
    
    if (dcOffsetCalibrated) {
      dcOffset = (dcOffset * DC_FILTER_ALPHA + sample * (100 - DC_FILTER_ALPHA)) / 100;
    } else {
      dcOffset = sample;
    }
    
    int32_t dcRemoved = (int32_t)sample - dcOffset;
    int32_t amplified = dcRemoved * AUDIO_GAIN;
    
    if (amplified > 32767) amplified = 32767;
    if (amplified < -32768) amplified = -32768;
    
    dst[i] = (int16_t)amplified;
  }
}

uint32_t computeRMS(int16_t* buffer, int samples) {
  uint64_t sum = 0;
  int validSamples = 0;
  
  for (int i = 0; i < samples; i++) {
    int32_t val = (int32_t)buffer[i];
    int32_t absVal = abs(val);
    
    if (absVal < 30000) {
      sum += (uint64_t)val * val;
      validSamples++;
    }
  }
  
  if (validSamples > 0) {
    uint64_t mean = sum / validSamples;
    return (uint32_t)sqrt(mean);
  }
  return 0;
}

uint32_t computeSmoothedRMS(uint32_t currentRMS) {
  rmsHistory[rmsHistoryIndex] = currentRMS;
  rmsHistoryIndex = (rmsHistoryIndex + 1) % RMS_SMOOTHING_SAMPLES;
  
  uint64_t sum = 0;
  for (int i = 0; i < RMS_SMOOTHING_SAMPLES; i++) {
    sum += rmsHistory[i];
  }
  return sum / RMS_SMOOTHING_SAMPLES;
}

void calibrateDCOffset() {
  Serial.println("Calibrando DC offset...");
  int32_t calibBuffer[256];
  dcOffsetCalibrated = false;
  dcOffset = 0;
  
  int64_t sum = 0;
  int count = 0;
  
  for (int calib = 0; calib < 100; calib++) {
    size_t bytesRead = 0;
    i2s_read(I2S_NUM_0, calibBuffer, sizeof(calibBuffer), &bytesRead, portMAX_DELAY);
    
    if (bytesRead > 0 && bytesRead % sizeof(int32_t) == 0) {
      int samples = bytesRead / sizeof(int32_t);
      for (int i = 0; i < samples && i < 256; i++) {
        int32_t raw = calibBuffer[i];
        int16_t sample;
        
        #if USE_MSB_CONVERSION
          sample = (int16_t)(raw >> 16);
        #else
          sample = (int16_t)(raw & 0xFFFF);
        #endif
        
        sum += sample;
        count++;
      }
    }
    delay(5);
  }
  
  if (count > 0) {
    dcOffset = sum / count;
  }
  
  dcOffsetCalibrated = true;
  Serial.printf("DC Offset calibrado: %d (de %d amostras)\n", dcOffset, count);
}

int32_t getDCOffset() {
  return dcOffset;
}


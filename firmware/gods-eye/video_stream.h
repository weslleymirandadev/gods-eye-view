#ifndef VIDEO_STREAM_H
#define VIDEO_STREAM_H

#include <Arduino.h>
#include <WebSocketsClient.h>
#include "config.h"

void initVideoStream();
void videoLoop();
uint32_t videoFrames();

#endif

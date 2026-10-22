#ifndef TOUCH_BUTTON_H
#define TOUCH_BUTTON_H

#include <Arduino.h>
#include "config.h"

// Botao TTP223 (modulo Catalex) — saida DIGITAL, nao touch nativo.
void initTouchButton();
bool touchPressed();        // true = tocado agora
int32_t touchBaseline();    // nivel de repouso (0 ou 1)
uint32_t touchRaw();        // leitura crua do pino

#endif

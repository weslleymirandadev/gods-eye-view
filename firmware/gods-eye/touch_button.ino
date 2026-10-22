#include "touch_button.h"

// Botao em modulo TTP223 (Catalex) no GPIO 36.
//
// ATENCAO: o TTP223 tem CI proprio — a saida SIG e DIGITAL (HIGH/LOW).
// Nao e o touch nativo do ESP32, entao NAO se usa touchRead aqui.
//
// Dois modos possiveis no TTP223 (jumper A):
//   - padrao: SIG = HIGH enquanto tocado
//   - jumper A fechado: SIG = LOW enquanto tocado (ativo em LOW)
//
// Este modulo detecta a polaridade sozinho no boot: le o pino 200x sem
// toque, guarda o nivel de repouso, e considera "tocado" o nivel OPOSTO.

static bool touchActiveLow = false;   // true = tocado quando LOW
static bool pressed = false;
static int confirmCount = 0;

#define TOUCH_CONFIRM 2   // leituras seguidas pra confirmar

void initTouchButton() {
  // TTP223 tem saida push-pull: pullup interno pode brigar com ela.
  pinMode(TOUCH_PIN, INPUT);

  // amostra o nivel de repouso (ninguem tocando durante o boot)
  int high = 0, low = 0;
  for (int i = 0; i < 200; i++) {
    if (digitalRead(TOUCH_PIN)) high++; else low++;
    delay(2);
  }
  touchActiveLow = (high > low);   // repouso HIGH -> ativo em LOW

  Serial.printf("[touch] TTP223 repouso=%s -> ativo em %s (H=%d L=%d)\n",
                touchActiveLow ? "HIGH" : "LOW",
                touchActiveLow ? "LOW" : "HIGH", high, low);
}

uint32_t touchRaw() {
  return (uint32_t)digitalRead(TOUCH_PIN);
}

int32_t touchBaseline() {
  return touchActiveLow ? 1 : 0;   // nivel de repouso
}

bool touchPressed() {
  bool level = digitalRead(TOUCH_PIN);
  bool nowPressed = touchActiveLow ? !level : level;

  if (nowPressed) {
    if (confirmCount < TOUCH_CONFIRM) confirmCount++;
    if (confirmCount >= TOUCH_CONFIRM) pressed = true;
  } else {
    confirmCount = 0;
    pressed = false;
  }
  return pressed;
}

#ifndef __LOGICANALYZER_BOARD_SETTINGS__
#define __LOGICANALYZER_BOARD_SETTINGS__

#include "pico/stdlib.h"

// Pico 2W WiFi — the only supported board
#define BOARD_NAME "2_WIFI"

#define INPUT_PIN_BASE 2
#define COMPLEX_TRIGGER_OUT_PIN 0
#define COMPLEX_TRIGGER_IN_PIN 1

// LED is controlled via CYW43 WiFi chip events
#define CYGW_LED

// WiFi support enabled
#define USE_CYGW_WIFI

#define PIN_MAP {2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,26,27,28,COMPLEX_TRIGGER_IN_PIN}

#define MAX_FREQ 100000000
#define MAX_BLAST_FREQ 200000000
#define CAPTURE_BUFFER_SIZE (448 * 1024)
#define MAX_CHANNELS 24

#endif

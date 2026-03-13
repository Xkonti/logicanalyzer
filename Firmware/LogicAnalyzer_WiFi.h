#ifndef __LOGICANALYZER_WIFI__
#define __LOGICANALYZER_WIFI__

#include "LogicAnalyzer_Board_Settings.h"
#include <stdint.h>
#include <stdbool.h>

typedef enum
{
    WIFI_DISABLED,
    VALIDATE_SETTINGS,
    WAITING_SETTINGS,
    CONNECTING_AP,
    STARTING_TCP_SERVER,
    WAITING_TCP_CLIENT,
    WS_DETECT_PROTOCOL,
    WS_HANDSHAKE_PENDING,
    TCP_CLIENT_CONNECTED

} WIFI_STATE_MACHINE;

extern bool ws_connection;

void runWiFiCore();
bool getVsysState();

/* Direct WiFi send from Core 1 — bypasses event queue.
 * Used by streaming path and sendResponse during streaming. */
void wifi_send_direct(const uint8_t* data, uint16_t len);

/* Two-segment variant: wraps d1+d2 in a single WS frame (or raw TCP). */
void wifi_send_direct_2(const uint8_t* d1, uint16_t l1,
                        const uint8_t* d2, uint16_t l2);

#endif

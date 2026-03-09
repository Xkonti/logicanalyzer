#ifndef __ANALYZER_STREAM__
#define __ANALYZER_STREAM__

#include "LogicAnalyzer_Board_Settings.h"
#include "LogicAnalyzer_Structs.h"
#include "LogicAnalyzer_Capture.h"

/* Ring buffer configuration */
#define STREAM_SLOTS            16
#define STREAM_MAX_CHUNK        512
#define STREAM_INPUT_SLOT_SIZE  (STREAM_MAX_CHUNK * 4)   /* 2048 bytes (24ch worst case) */
#define STREAM_OUTPUT_SLOT_SIZE 1560                      /* max compressed for 24ch/512 */

/*
 * Start streaming capture.
 * Sets up PIO, DMA ring buffer, launches Core 1 for compression,
 * sends STREAM_STARTED response + info header.
 * Returns true on success.
 */
bool StartStream(const STREAM_REQUEST *req, bool fromWiFi);

/*
 * Signal streaming to stop. Sets streaming flag to false.
 * Called from command handler when CMD_STOP_STREAM arrives.
 */
void StopStream(void);

/*
 * Blocking send loop. Runs on Core 0, sends compressed chunks over USB.
 * Returns when streaming stops (via StopStream or overflow).
 * Sends EOF marker and termination line before returning.
 */
void RunStreamSendLoop(bool fromWiFi);

/*
 * Cleanup: stop PIO, abort DMA, reset Core 1.
 * Called after RunStreamSendLoop returns.
 */
void CleanupStream(void);

/* Returns true if currently streaming */
bool IsStreamActive(void);

#endif

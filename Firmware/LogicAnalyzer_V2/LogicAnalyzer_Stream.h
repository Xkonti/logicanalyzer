#ifndef __ANALYZER_STREAM__
#define __ANALYZER_STREAM__

#include "LogicAnalyzer_Board_Settings.h"
#include "LogicAnalyzer_Structs.h"
#include "LogicAnalyzer_Capture.h"

/* Ring buffer configuration */
#define STREAM_SLOTS            62
#define STREAM_MAX_CHUNK        1024
#define STREAM_INPUT_SLOT_SIZE  (STREAM_MAX_CHUNK * 4)   /* 4096 bytes (24ch worst case) */
#define STREAM_OUTPUT_SLOT_SIZE 3080                      /* max compressed for 24ch/1024 */

/*
 * Start streaming capture.
 * Sets up PIO, DMA ring buffer, sends STREAM_STARTED response + info header,
 * sets stream_transmit_active for Core 1, enables PIO.
 * Returns true on success.
 */
bool StartStream(const STREAM_REQUEST *req, bool fromWiFi);

/*
 * Signal streaming to stop. Sets streaming flag to false.
 * Called from command handler when CMD_STOP_STREAM arrives.
 */
void StopStream(void);

/*
 * Compression loop — runs on Core 0.
 * Reads DMA input ring, compresses chunks, writes to compressed ring.
 * Returns when streaming stops (via StopStream).
 * Sets compress_done flag before returning.
 */
void RunCompressionLoop(void);

/*
 * Non-blocking transmit — called by Core 1 each iteration.
 * Reads compressed chunks from the compressed ring, sends via USB/WiFi.
 * Sends EOF + status when compression is done and all chunks are drained.
 * Sets stream_transmit_active = false when fully complete.
 */
void stream_process_transmit(void);

/*
 * Cleanup: stop PIO, abort DMA.
 * Called by Core 0 after stream_transmit_active becomes false.
 */
void CleanupStream(void);

/* Returns true if Core 1 transmission is still active */
extern volatile bool stream_transmit_active;

/* Returns true if currently streaming */
bool IsStreamActive(void);

#endif

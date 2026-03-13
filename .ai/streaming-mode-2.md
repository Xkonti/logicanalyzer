# Streaming Mode — Software/Frontend Perspective

This document describes how the "realtime/streaming" mode works from the host software side, covering the full data path from the start/stop handshake through decompression to on-screen rendering.

For firmware-side details (PIO, DMA, compression engine internals), see companion documentation. This document focuses on the complementary host-side concerns.

---

## Table of Contents

1. [Start/Stop Handshake Sequence](#startstop-handshake-sequence)
2. [Streaming Data Packet Format](#streaming-data-packet-format)
3. [Decompression Pipeline](#decompression-pipeline)
4. [Stream Store and Circular Buffer Management](#stream-store-and-circular-buffer-management)
5. [Real-Time Waveform Rendering](#real-time-waveform-rendering)
6. [Flow Control and Backpressure](#flow-control-and-backpressure)
7. [Frequency and Chunk Size Configuration](#frequency-and-chunk-size-configuration)
8. [Comparison with Old C# Client](#comparison-with-old-c-client)
9. [Known Issues and Limitations](#known-issues-and-limitations)

---

## Start/Stop Handshake Sequence

### Starting a Stream

The full startup flow involves three layers: UI dialog, stream store, and analyzer driver.

**1. User initiates from StreamDialog**
(`Software/Web/src/components/capture/StreamDialog.vue`, line 167-173)

The dialog commits local settings to the stream store and calls `stream.startStream()`, which delegates to the Pinia store:

```
StreamDialog.onStart()
  → stream.streamFrequency = localFrequency
  → stream.streamChunkSize = localChunkSize
  → stream.maxDisplaySamples = localMaxSamples
  → stream.startStream()          // composable
    → streamStore.startStream()   // Pinia store
```

**2. Store validates and calls driver**
(`Software/Web/src/stores/stream.js`, lines 158-229)

The store performs pre-flight checks:
- Driver must exist (device connected)
- Device must not be capturing or already streaming
- At least one channel must be selected
- Warns (but allows) if frequency exceeds recommended rate limit for the channel count

It then calls `device.driver.startStream(config, onChunk, onEnd)` with:
- `config.channels` — array of channel numbers (0-based)
- `config.frequency` — sampling frequency in Hz
- `config.chunkSamples` — chunk size (32-1024)
- `onChunk` — callback invoked per decompressed chunk
- `onEnd` — callback invoked when the stream terminates

**3. Driver sends command packet and reads handshake**
(`Software/Web/src/core/driver/analyzer.js`, lines 407-457)

The driver builds a 40-byte `StreamRequest` struct via `buildStreamRequest()` and wraps it in a framed `OutputPacket`:

```
[0x55 0xAA] [escaped: 0x0A + 40-byte StreamRequest] [0xAA 0x55]
```

Command byte `0x0A` is `CMD_START_STREAM` (`Software/Web/src/core/protocol/commands.js`, line 10).

The firmware responds with:
1. **Text line**: `"STREAM_STARTED\n"` — parsed via `transport.readLine()` (line 432)
2. **8-byte info header** — parsed via `transport.readBytes(8)` (line 440):

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 2 | `chunkSamples` | Actual chunk size (LE16), may differ from requested if clamped |
| 2 | 1 | `numChannels` | Number of active channels |
| 3 | 1 | reserved | Always 0 |
| 4 | 4 | `actualFrequency` | Actual PIO sample rate (LE32), may differ from requested due to clock divider rounding |

On the firmware side, this info header is assembled in `StartStream()` (`Firmware/LogicAnalyzer_Stream.c`, lines 316-331).

If the handshake response is not `"STREAM_STARTED"`, the driver returns `{ started: false, error: "Device error: ..." }`.

If the handshake succeeds, the driver:
- Sets `this.#streaming = true`
- Fires off `this.#readStreamLoop()` as a non-awaited async call (fire-and-forget)
- Returns `{ started: true, chunkSamples, numChannels, actualFrequency }`

The store then updates `streaming.value = true` and `device.streaming = true`. If the actual frequency differs from the requested one, the store updates `streamFrequency` to match (line 222).

### Stopping a Stream

**User-initiated stop:**
(`Software/Web/src/stores/stream.js`, lines 232-242)

```
streamStore.stopStream()
  → driver.stopStream()
```

**Driver stop sequence:**
(`Software/Web/src/core/driver/analyzer.js`, lines 498-532)

1. Sends `CMD_STOP_STREAM` (`0x0B`) in a framed OutputPacket
2. Polls `this.#streaming` for up to 5 seconds, waiting for the read loop to finish naturally
3. If the read loop doesn't finish in time, force-disconnects and reconnects the transport

On the firmware side, `StopStream()` (`Firmware/LogicAnalyzer_Stream.c`, line 336-339) simply sets `streaming = false`. The send loop in `RunStreamSendLoop()` detects this on its next iteration, flushes remaining chunks, sends the EOF marker and status line, then returns. The main loop in `LogicAnalyzer.c` (line 859) calls `CleanupStream()` to tear down PIO/DMA/Core 1.

**Natural termination (firmware-initiated):**

The read loop (`#readStreamLoop`, line 464-490) reads until it encounters a 2-byte EOF marker (`0x0000`). After EOF, it reads one more text line (the status/diagnostic line), then calls `onEnd(endStatus, null)`.

The `onStreamEnd` callback in the store (`Software/Web/src/stores/stream.js`, lines 91-108) parses the status line prefix to determine the termination reason:

| Status prefix | User-visible result |
|---------------|-------------------|
| `STREAM_OVERFLOW` | Warning: data rate exceeded device capacity |
| `STREAM_TIMEOUT` | Error: no data produced (debug info included) |
| `STREAM_DISCONN` | Error: device detected USB disconnect |
| `STREAM_DONE` | Clean stop, no error |

---

## Streaming Data Packet Format

After the handshake, the firmware sends a continuous stream of compressed chunk packets. Each packet has this wire format:

```
[compressedSize: uint16 LE]  [compressed payload: compressedSize bytes]
```

The firmware sends this from `RunStreamSendLoop()` (`Firmware/LogicAnalyzer_Stream.c`, lines 386-404):
- `size_bytes[2]` — 2-byte little-endian compressed size
- `stream_output[slot]` — the compressed chunk data

A `compressedSize` of `0x0000` signals EOF (end of stream).

After EOF, the firmware sends a diagnostic status line as text (newline-terminated), e.g.:
```
STREAM_DONE DMA=1234 CMP=1234 SEND=1234 LOOP=5678 CONN=1/1 CHUNKS=512 FREQ=250000
```

### Compressed Chunk Internal Format

Each compressed chunk contains per-channel data for one "chunk" of samples (e.g., 512 samples). The format is:

**Header:** `ceil(numChannels / 4)` bytes, encoding 2 bits per channel (LSB-first packing):

| Mode | Value | Meaning |
|------|-------|---------|
| `HDR_RAW` | `0x00` | Raw bitstream follows (`chunkSamples / 8` bytes) |
| `HDR_ALL_ZERO` | `0x01` | All samples are 0 (no data bytes) |
| `HDR_ALL_ONE` | `0x02` | All samples are 1 (no data bytes) |
| `HDR_NIBBLE_ENC` | `0x03` | Nibble-encoded compressed data follows |

**Per-channel data** follows the header, in channel order. Only channels with mode `HDR_RAW` or `HDR_NIBBLE_ENC` have data bytes.

For `HDR_RAW` channels: `chunkSamples / 8` bytes of transposed bitstream (each byte contains 8 consecutive samples for that channel, LSB = earliest sample).

For `HDR_NIBBLE_ENC` channels: nibble-encoded compressed data using prefix codes:

| Nibble | Code | Action |
|--------|------|--------|
| 0x0 | RAW1 | 1 raw data nibble follows |
| 0x1 | RAW2 | 2 raw data nibbles follow |
| 0x2 | RAW3 | 3 raw data nibbles follow |
| 0x3 | RAW6 | 6 raw data nibbles follow |
| 0x4 | RAW4 | 4 raw data nibbles follow |
| 0x5 | RAW8 | 8 raw data nibbles follow |
| 0x6 | ZERO2 | Emit 2 zero nibbles |
| 0x7 | ZERO4 | Emit 4 zero nibbles |
| 0x8 | ZERO8 | Emit 8 zero nibbles |
| 0x9 | ZERO16 | Emit 16 zero nibbles |
| 0xA | ZERO32 | Emit 32 zero nibbles |
| 0xB | ONE2 | Emit 2 all-ones nibbles |
| 0xC | ONE4 | Emit 4 all-ones nibbles |
| 0xD | ONE8 | Emit 8 all-ones nibbles |
| 0xE | ONE16 | Emit 16 all-ones nibbles |
| 0xF | ONE32 | Emit 32 all-ones nibbles |

Nibbles are packed MSB-first into the byte stream (high nibble of each byte is read first). After decoding, the nibble stream is repacked into transposed bytes using little-endian nibble order: `byte[j] = (nibble[2j+1] << 4) | nibble[2j]`.

Defined in:
- Firmware: `Firmware/stream_compress.h`, lines 35-57
- Decoder: `Software/Web/src/core/compression/decoder.js`, lines 8-33

---

## Decompression Pipeline

### Read Loop

The driver's `#readStreamLoop()` (`Software/Web/src/core/driver/analyzer.js`, lines 464-490) runs as an async function:

```javascript
while (true) {
    const sizeBytes = await this.#transport.readBytes(2)
    const compressedSize = sizeBytes[0] | (sizeBytes[1] << 8)
    if (compressedSize === 0) break   // EOF marker

    const compressed = await this.#transport.readBytes(compressedSize)
    const { channels } = decompressChunk(compressed, numChannels, chunkSamples)
    onChunk(channels, chunkSamples)
}
```

Each iteration:
1. Reads 2 bytes for the compressed size
2. Reads `compressedSize` bytes of compressed data
3. Calls `decompressChunk()` to produce per-channel bitstreams
4. Calls `onChunk()` callback with the decompressed channel data

### Decompression Function

`decompressChunk()` (`Software/Web/src/core/compression/decoder.js`, lines 77-144):

1. **Parse header**: Read 2-bit mode codes for each channel from the header bytes
2. **Per-channel decode**: Based on mode:
   - `ALL_ZERO`: Allocate zero-filled `Uint8Array(rawBytes)` where `rawBytes = chunkSamples / 8`
   - `ALL_ONE`: Allocate `Uint8Array(rawBytes)` filled with `0xFF`
   - `RAW`: Slice `rawBytes` directly from compressed data
   - `NIBBLE_ENC`: Use `NibbleReader` to decode prefix codes, produce nibble array, then repack into bytes
3. **Return**: `{ channels: Uint8Array[], bytesConsumed: number }` where `channels[ch]` is a transposed bitstream of `chunkSamples / 8` bytes

### Bit Unpacking

The decompressed data is in "transposed bitstream" format — each byte contains 8 consecutive samples for one channel. The store's `unpackBitstream()` function (`Software/Web/src/stores/stream.js`, lines 64-70) converts this to a per-sample `Uint8Array` of 0/1 values:

```javascript
function unpackBitstream(packed, chunkSamples) {
    const out = new Uint8Array(chunkSamples)
    for (let s = 0; s < chunkSamples; s++) {
        out[s] = (packed[s >> 3] >> (s & 7)) & 1
    }
    return out
}
```

This is done inside `onChunk()` (line 78) for all channels in the chunk.

---

## Stream Store and Circular Buffer Management

### Architecture

The stream store (`Software/Web/src/stores/stream.js`) manages sample data using a **sliding window** approach (not a true circular buffer). It keeps the most recent `maxDisplaySamples` samples in a `Uint8Array` per channel.

### Batching for Performance

The store uses **time-based synchronous batching** to avoid overwhelming Vue reactivity with per-chunk updates. This is critical because the read loop runs as a microtask chain that can starve `requestAnimationFrame` callbacks.

Non-reactive module-level state (lines 57-59):
```javascript
let pendingChunks = []
let lastFlushTime = 0
const FLUSH_INTERVAL_MS = 16   // ~60fps
```

When `onChunk()` is called (lines 77-86):
1. Unpacks the bitstream for each channel
2. Pushes the unpacked data into `pendingChunks`
3. Checks if `FLUSH_INTERVAL_MS` (16ms) has elapsed since the last flush
4. If yes, calls `flushChunks()` synchronously

### Flush Logic

`flushChunks()` (`Software/Web/src/stores/stream.js`, lines 110-156):

1. Takes all accumulated `pendingChunks` and clears the pending queue
2. Calculates `totalNew` samples across all batched chunks
3. For each channel:
   - Allocates a new `Uint8Array(existingLen + totalNew)`
   - Copies existing samples, then appends all new chunk data
   - If the combined length exceeds `maxDisplaySamples`, slices from the end: `combined.slice(combined.length - max)`
4. Replaces `streamChannels.value` with the updated channel array (triggers Vue reactivity)
5. Updates `sampleCount.value`
6. If `following` mode is active, auto-scrolls the viewport to show the latest data

The trimming at line 142 is what makes this a sliding window: older samples beyond `maxDisplaySamples` are discarded. Default is 50,000 samples (`Software/Web/src/stores/stream.js`, line 42).

### State Management

Key reactive state:
- `streaming` (ref): Whether a stream is currently active
- `streamChannels` (shallowRef): Array of channel objects with `.samples` Uint8Array
- `sampleCount` (ref): Length of the sample buffer (same for all channels)
- `following` (ref): Whether the viewport auto-scrolls to follow new data
- `streamFrequency` (useLocalStorage): Persisted across sessions
- `streamChunkSize` (useLocalStorage): Persisted across sessions
- `maxDisplaySamples` (useLocalStorage): Persisted across sessions
- `streamError` (ref): Error message or null
- `streamWarning` (ref): Warning message or null

---

## Real-Time Waveform Rendering

### Data Flow to Canvas

The rendering pipeline uses Vue's `watchEffect` to detect changes and re-render:

`WaveformCanvas.vue` (`Software/Web/src/components/viewer/WaveformCanvas.vue`, lines 28-31, 136-153):

```javascript
const activeChannels = computed(() => {
    if (stream.isStreaming || stream.streamChannels.length > 0)
        return stream.streamChannels
    return cap.capturedChannels
})
```

When `streamChannels` is updated by `flushChunks()`, the `watchEffect` fires and:
1. Maps channels to the renderer's expected format via `mapChannels()`
2. Sets viewport from the viewport store
3. Disables capture-specific markers (trigger, bursts, regions) during streaming
4. Calls `renderer.value.resize()` and `renderer.value.render()`

### WaveformRenderer

The `WaveformRenderer` class (`Software/Web/src/core/renderer/waveform-renderer.js`) renders using Canvas 2D with two modes:

**Detailed mode** (lines 298-321, used when `samplesPerPixel <= 2`):
- Draws individual signal transitions using RLE optimization
- Two-pass: semi-transparent fill, then signal line stroke
- Only emits `lineTo()` at transitions, skipping runs of identical values

**Decimated mode** (lines 350-407, used when `samplesPerPixel > 2`):
- Computes per-pixel-column summary via `computeColumnSummary()` (lines 46-71)
- Each column is classified as `0` (all low), `1` (all high), or `2` (mixed/transition)
- Renders batched fill rectangles and a signal trace with vertical transition bars

During streaming, the renderer is re-invoked on every flush cycle (~60fps target). The same `WaveformRenderer` instance is reused; only the data and viewport parameters change.

### Auto-Follow (Viewport Scrolling)

When `following` is true (default during streaming), `flushChunks()` auto-scrolls the viewport to keep the latest samples visible (`Software/Web/src/stores/stream.js`, lines 150-155):

```javascript
if (following.value) {
    const viewport = useViewportStore()
    const total = sampleCount.value
    const visible = viewport.visibleSamples
    viewport.setView(Math.max(0, total - visible), visible)
}
```

The user can disable following by scrolling or zooming manually (`WaveformCanvas.vue`, lines 71-73):
```javascript
if (stream.isStreaming) {
    stream.following = false
}
```

---

## Flow Control and Backpressure

### Firmware-Side Overflow Detection

The firmware uses a fixed-size ring buffer with 8 slots (`STREAM_SLOTS = 8` in `LogicAnalyzer_Stream.h`, line 9). Three monotonically-increasing counters track progress through the pipeline:

- `dma_complete_count` — incremented by DMA ISR when a slot finishes filling
- `compress_head` — incremented by Core 1 after compressing a slot
- `send_head` — incremented by Core 0 after sending a slot over USB

Overflow is detected in `RunStreamSendLoop()` (`Firmware/LogicAnalyzer_Stream.c`, lines 440-446):

```c
if (dma_complete_count - send_head >= STREAM_SLOTS - 1)
{
    exit_reason = STREAM_EXIT_OVERFLOW;
    overflow = true;
    streaming = false;
}
```

When overflow occurs, the firmware stops streaming, flushes remaining compressed chunks, sends EOF + `"STREAM_OVERFLOW ..."` status line.

### Host-Side Handling

The host has **no explicit flow control** — it does not send acknowledgments or request retransmission. The USB/serial transport buffers incoming data (1MB buffer configured in `SerialTransport`, `Software/Web/src/core/transport/serial.js`, line 37: `DEFAULT_BUFFER_SIZE = 1048576`).

If the host cannot process data fast enough:
1. The USB receive buffer fills up
2. USB flow control (hardware-level) eventually stalls the device
3. The firmware's DMA ring buffer overflows because the send loop is blocked waiting for USB
4. The firmware terminates the stream with `STREAM_OVERFLOW`

The stream store displays a warning to the user: `"Stream ended due to overflow — data rate exceeded device capacity"` (line 99).

### Timeout Detection

The firmware also has a 3-second timeout (`Firmware/LogicAnalyzer_Stream.c`, lines 448-453): if no compressed chunks are produced within 3 seconds, it exits with `STREAM_TIMEOUT`. This catches setup failures where PIO/DMA never start producing data.

### Disconnect Detection

The firmware checks `tud_cdc_connected()` each loop iteration (`Firmware/LogicAnalyzer_Stream.c`, lines 431-437). If USB disconnects, it exits with `STREAM_DISCONN`.

---

## Frequency and Chunk Size Configuration

### Rate Limits

The store defines per-channel-count recommended maximum frequencies (`Software/Web/src/stores/stream.js`, lines 11-36):

```javascript
export const STREAM_RATE_LIMITS = {
    1: 6310000,    // 6.3 MHz for 1 channel
    2: 3630000,    // 3.6 MHz for 2 channels
    ...
    24: 303000,    // 303 kHz for 24 channels
}
```

These are documented as "90% of USB benchmark" values. Exceeding them triggers a warning but does not prevent starting the stream.

### Chunk Size

Valid chunk sizes: 32, 64, 128, 256, 512, 1024 samples. Presented to the user as a dropdown in `StreamDialog.vue` (line 100).

The dialog calculates a recommended chunk size based on a target of 5 updates/second (`StreamDialog.vue`, lines 128-137):

```javascript
const maxChunk = Math.floor(freq / TARGET_FPS)
// Find largest valid chunk size <= maxChunk
```

The UI shows the expected update rate: `~${fps} updates/sec`.

On the firmware side, the requested chunk size is validated to `[32, STREAM_MAX_CHUNK(1024)]` and rounded down to a multiple of 32 (`Firmware/LogicAnalyzer_Stream.c`, lines 270-277). The actual chunk size is returned in the info header, and the driver uses that value for the read loop.

### Frequency Clamping

The firmware computes the actual PIO frequency from the system clock and a 16-bit clock divider (`Firmware/LogicAnalyzer_Stream.c`, lines 263-267):

```c
float clockDiv = (float)clock_get_hz(clk_sys) / (float)req->frequency;
if (clockDiv > 65535.0f) clockDiv = 65535.0f;
stream_actual_freq = (uint32_t)((float)clock_get_hz(clk_sys) / clockDiv);
```

This means:
- Very low requested frequencies may get clamped to a minimum (~3 kHz for a 200 MHz system clock)
- The actual frequency may differ slightly from the requested value due to integer divider rounding

The host receives the actual frequency in the info header and updates the stored frequency to match (line 222 in `stream.js`). The UI minimum is enforced at 3,000 Hz (`StreamDialog.vue`, line 157).

### StreamRequest Wire Format

`buildStreamRequest()` (`Software/Web/src/core/protocol/packets.js`, lines 101-117) builds a 40-byte struct:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 32 | `channels[32]` — zero-padded array of channel numbers |
| 32 | 1 | `channelCount` |
| 33 | 1 | padding (alignment) |
| 34 | 2 | `chunkSamples` (LE16) |
| 36 | 4 | `frequency` (LE32) |

This matches the firmware's `STREAM_REQUEST` struct (`Firmware/LogicAnalyzer_Structs.h`, lines 45-55).

---

## Comparison with Old C# Client

The old C# client (`Software/LogicAnalyzer/SharedDriver/LogicAnalyzerDriver.cs`) **does not implement streaming mode**. A search of the driver source reveals no `StartStream`, `StopStream`, `CMD_START_STREAM`, or streaming-related methods.

The C# client only supports the trigger-based capture mode:
- `StartCapture()` sends `CMD_START_CAPTURE`, waits for `"CAPTURE_STARTED"`, then blocks reading binary capture data
- `StopCapture()` sends raw `0xFF` to abort

Key architectural differences in the web client's streaming implementation:

| Aspect | C# Capture Mode | Web Streaming Mode |
|--------|-----------------|-------------------|
| Data flow | Batch: capture all, then transfer | Continuous: compress and stream in real-time |
| Firmware cores | Single core captures + transfers | Core 0 sends, Core 1 compresses |
| Compression | None (raw samples) | Per-channel nibble encoding with bit-transpose |
| Buffer | Fixed on-device buffer (262 KB typical) | 8-slot ring buffer on device, sliding window on host |
| UI update | One-shot render after complete capture | Continuous ~60fps updates during stream |
| Channel data | Packed multi-channel uint8/16/32 samples | Transposed per-channel bitstreams |

The streaming mode is an entirely new capability added for the web client, with no equivalent in the desktop application. The firmware commands `0x0A` (start stream) and `0x0B` (stop stream) were added alongside the PIO reuse of the BLAST_CAPTURE program and the Core 1 compression pipeline.

---

## Known Issues and Limitations

### 1. Memory allocation churn in flushChunks()

Every flush cycle allocates new `Uint8Array` buffers and copies existing data (`Software/Web/src/stores/stream.js`, lines 132-143). With `maxDisplaySamples = 50000` and 24 channels, this means allocating and copying ~1.2 MB per flush. At 60 fps, this creates significant GC pressure. A true circular buffer with pre-allocated memory would be more efficient but would complicate the rendering path.

### 2. No true circular buffer

The store uses `Array.slice()` to trim older samples (line 142), which creates new typed arrays rather than reusing memory. The comment at line 56 calls it "time-based batching" but the underlying data structure is a growing-then-trimmed linear buffer, not a ring buffer.

### 3. Batching can drop visual frames

The `FLUSH_INTERVAL_MS = 16` check in `onChunk()` (lines 82-83) uses `performance.now()` for synchronous time-gating. If the read loop processes many chunks in a single microtask burst, only the first and last flushes within each 16ms window will trigger a reactive update. Intermediate states are batched together, which is intentional for performance but means rapid transient signals within a single batch window are still captured in the data but not rendered individually.

### 4. Read loop starvation risk

The `#readStreamLoop()` is an async function that runs as a continuous `while(true)` loop with `await transport.readBytes()`. Since it runs on the main thread, each `await` yields to the microtask queue but not necessarily to the macrotask queue where `requestAnimationFrame` callbacks live. The time-based synchronous flush (rather than using `requestAnimationFrame`) was specifically designed to work around this — see comment at line 74: "Uses time-based synchronous flushing to avoid rAF starvation from microtask-driven read loops."

### 5. No backpressure signaling to firmware

The host cannot signal the firmware to slow down. If the host falls behind, the only outcome is a firmware-side overflow and stream termination. There is no retry or resume mechanism — the user must start a new stream.

### 6. stopStream timeout fallback

If the read loop does not terminate within 5 seconds after sending `CMD_STOP_STREAM`, the driver force-disconnects and reconnects the transport (`Software/Web/src/core/driver/analyzer.js`, lines 515-524). This is a brute-force recovery that discards any in-flight data and requires the device to be re-initialized.

### 7. Single-threaded decompression

Decompression runs on the main thread inside the read loop. For high channel counts and high frequencies, decompression time could become a bottleneck. Moving decompression to a Web Worker would help but would add complexity to the data transfer path (structured cloning or SharedArrayBuffer).

### 8. shallowRef reactivity granularity

`streamChannels` uses `shallowRef` (line 48), meaning Vue only detects when the entire array reference changes, not when individual channel `.samples` are modified. This is why `flushChunks()` creates a new array of new channel objects on every flush (lines 127-144) — it must replace the reference to trigger reactivity.

### 9. Maximum display samples limit

The `maxDisplaySamples` setting (default 50,000, max 500,000 per the UI at `StreamDialog.vue` line 39) limits how much history is kept. At 1 MHz with 50,000 samples, only 50ms of signal history is visible. Users who need longer history must increase this value at the cost of higher memory usage and slower rendering.

### 10. stdio_usb disabled during streaming

On the firmware side, `stdio_usb` is disabled before launching Core 1 (`LogicAnalyzer_Stream.c`, line 301: `stdio_usb_deinit()`). This means the firmware uses direct `cdc_transfer()` calls instead of `printf`/`stdio` during streaming. The `processUSBInputDirect()` function is used to check for incoming stop commands. This is re-enabled in `CleanupStream()` (line 365: `stdio_usb_init()`).

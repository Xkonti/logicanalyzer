# Frontend-to-Hardware Communication

This document describes how the LogicAnalyzer V2 web application communicates with the hardware device. The web app runs entirely in the browser (Chrome/Edge) with no backend server -- it talks directly to the Pico 2W board over USB (Web Serial API) or WiFi (WebSocket, planned but not yet implemented).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Layer Diagram](#layer-diagram)
3. [Transport Layer](#transport-layer)
4. [Protocol Layer](#protocol-layer)
5. [Driver Layer](#driver-layer)
6. [Streaming Data Pipeline](#streaming-data-pipeline)
7. [State Management and UI Integration](#state-management-and-ui-integration)
8. [Connection UI and User Flow](#connection-ui-and-user-flow)
9. [Error Handling and Reconnection](#error-handling-and-reconnection)
10. [WebSocket Transport (Planned)](#websocket-transport-planned)

---

## Architecture Overview

The communication stack follows a strict layered architecture enforced by project conventions:

```
UI Components (Vue/Quasar)
    |
Composables (useDevice, useCapture, useStream)
    |
Pinia Stores (device, capture, stream)
    |
Driver (AnalyzerDriver)
    |
Protocol (OutputPacket, parser, commands)
    |
Transport (SerialTransport / future WebSocketTransport)
    |
Browser API (Web Serial API / WebSocket API)
    |
USB / WiFi hardware link
```

Components never import from `core/` directly. They go through composables and stores. The `core/` layer is pure JS with no Vue/Quasar imports, making it independently testable.

---

## Layer Diagram

```
┌─────────────────────────────────────────────────────┐
│  ConnectionPanel.vue / CaptureDialog / StreamDialog │  UI
├─────────────────────────────────────────────────────┤
│  useDevice() / useCapture() / useStream()           │  Composables
├─────────────────────────────────────────────────────┤
│  deviceStore / captureStore / streamStore            │  Pinia Stores
├─────────────────────────────────────────────────────┤
│  AnalyzerDriver                                     │  Driver
│    ├── OutputPacket + buildCaptureRequest/           │
│    │   buildStreamRequest                            │  Protocol (packets)
│    ├── parseInitResponse / parseCaptureData /        │
│    │   parseCaptureStartResponse                     │  Protocol (parser)
│    └── decompressChunk (streaming)                   │  Compression
├─────────────────────────────────────────────────────┤
│  SerialTransport (ITransport interface)              │  Transport
├─────────────────────────────────────────────────────┤
│  navigator.serial (Web Serial API)                   │  Browser API
└─────────────────────────────────────────────────────┘
```

---

## Transport Layer

### ITransport Interface

**File:** `Software/Web/src/core/transport/types.js` (lines 1-13)

The transport layer defines a generic interface `ITransport` that abstracts the physical connection:

```
ITransport {
  connected: boolean
  connect(): Promise<void>
  disconnect(): Promise<void>
  write(data: Uint8Array): Promise<void>
  readLine(): Promise<string>          // newline-delimited text, strips \n and \r
  readBytes(count: number): Promise<Uint8Array>  // read exactly N bytes
  onDisconnect: (() => void) | null    // callback for unexpected disconnection
}
```

This interface is the abstraction boundary: the driver and protocol layers operate entirely through `ITransport`, allowing different physical transports (USB serial, WebSocket) to be swapped without changing higher layers.

A `createMockTransport()` factory (lines 23-79) provides a test double with FIFO queues for lines and binary chunks, plus counters for connect/disconnect calls.

### SerialTransport (Web Serial API)

**File:** `Software/Web/src/core/transport/serial.js`

The `SerialTransport` class implements `ITransport` using the browser's Web Serial API. It is the only transport currently implemented.

#### Construction (lines 34-46)

The constructor accepts optional overrides for:
- `baudRate` (default: 115200)
- `bufferSize` (default: 1,048,576 = 1 MB; the Web Serial default of 255 bytes is far too small)
- `vendorId` (default: `0x1209`)
- `productId` (default: `0x3020`)
- `port` -- a pre-selected `SerialPort` object (skips the browser picker dialog)

#### Connection Sequence (lines 52-86)

`connect()` performs these steps in order:

1. **Port selection** -- If no port was pre-provided, calls `navigator.serial.requestPort()` with a USB VID/PID filter (`{ usbVendorId: 0x1209, usbProductId: 0x3020 }`). This triggers the browser's device-picker dialog. (line 55-63)

2. **Port open** -- Opens the port with `{ baudRate: 115200, bufferSize: 1048576 }`. The 1 MB buffer is critical for high-throughput capture/streaming. (lines 65-68)

3. **Signal assertion** -- Sets `requestToSend: true` and `dataTerminalReady: true` via `port.setSignals()`. This matches the C# driver behavior and is required for the Pico's USB CDC to enumerate properly. (lines 70-73)

4. **Boot settle delay** -- Waits 200 ms for firmware boot messages to settle. This mirrors `Thread.Sleep(200)` in the C# driver. (line 76)

5. **Reader acquisition** -- Gets a `ReadableStreamDefaultReader` from `port.readable`. (line 78)

6. **Input buffer drain** -- Calls `#drainPendingData()` to discard any stale bytes left in the buffer from firmware boot noise (equivalent to C#'s `sp.DiscardInBuffer()`). (line 81)

7. **Writer acquisition** -- Gets a `WritableStreamDefaultWriter` from `port.writable`. (line 83)

8. **State reset** -- Clears the internal byte buffer and sets `#connected = true`. (lines 84-85)

#### Buffer Drain Mechanism (lines 202-225)

The drain loop is noteworthy: it reads chunks in a race with a 100 ms timeout. When no data arrives within the timeout, the pending `reader.read()` promise is saved to `#pendingRead` rather than abandoned. This prevents losing the first chunk of real data that may have been requested concurrently. The saved promise is consumed by `#consumePendingRead()` (lines 189-200) before any subsequent `readLine()` or `readBytes()` call.

#### Unified Byte Buffer (lines 21, 137-174)

Both `readLine()` and `readBytes()` share a single `#buffer: Uint8Array`. This avoids the buffering conflict that existed in the C# codebase between `StreamReader` (text) and `BinaryReader` (binary) on the same stream.

- **`readLine()`** (lines 131-155): Scans `#buffer` for `0x0A` (newline). If found, extracts and decodes the line (stripping trailing `\r`). If not found, reads more chunks from the serial reader until a newline appears.

- **`readBytes(count)`** (lines 162-175): Accumulates data in `#buffer` until it has at least `count` bytes, then slices exactly that many off the front.

Both methods call `#consumePendingRead()` first to incorporate any data from the drain phase.

#### Disconnection (lines 88-118)

`disconnect()` is idempotent. It:
1. Sets `#connected = false` immediately
2. Releases the reader lock (ignoring errors if already released)
3. Releases the writer lock
4. Closes the port
5. Clears the byte buffer

#### Write (lines 121-124)

`write(data)` delegates directly to the Web Serial writer. Throws if not connected.

---

## Protocol Layer

### Command Constants

**File:** `Software/Web/src/core/protocol/commands.js`

Defines all command IDs (first byte of an `OutputPacket` payload):

| Constant | Value | Description |
|---|---|---|
| `CMD_DEVICE_INIT` | `0x00` | Initialize device, request capabilities |
| `CMD_START_CAPTURE` | `0x01` | Start trigger-based capture |
| `CMD_NETWORK_CONFIG` | `0x02` | WiFi network configuration |
| `CMD_VOLTAGE_STATUS` | `0x03` | Query voltage status |
| `CMD_ENTER_BOOTLOADER` | `0x04` | Reboot into UF2 bootloader |
| `CMD_BLINK_LED_ON` | `0x05` | Turn on LED blink |
| `CMD_BLINK_LED_OFF` | `0x06` | Turn off LED blink |
| `CMD_START_STREAM` | `0x0A` | Start streaming capture |
| `CMD_STOP_STREAM` | `0x0B` | Stop streaming capture |
| `CMD_STOP_CAPTURE` | `0xFF` | Abort capture (raw byte, NOT framed) |

Packet framing constants (lines 15-19):
- Header: `0x55 0xAA`
- Footer: `0xAA 0x55`
- Escape byte: `0xF0`

Additional constants include trigger types (Edge=0, Complex=1, Fast=2, Blast=3), capture modes (8ch=0, 16ch=1, 24ch=2), serial defaults, minimum version (`V6_5`), and trigger delay values.

### Packet Building (OutputPacket)

**File:** `Software/Web/src/core/protocol/packets.js` (lines 16-59)

`OutputPacket` builds framed command packets with byte-stuffing. It ports `AnalyzerDriverBase.cs OutputPacket.Serialize`.

Wire format:
```
[0x55 0xAA] [escaped payload bytes] [0xAA 0x55]
```

Escaping rule: any payload byte that equals `0xAA`, `0x55`, or `0xF0` is replaced by `[0xF0, byte XOR 0xF0]`.

Builder methods:
- `addByte(byte)` -- append a single byte
- `addBytes(bytes)` -- append a Uint8Array or array of bytes
- `addString(str)` -- append ASCII string bytes
- `serialize()` -- produce the final `Uint8Array` with header, escaped payload, and footer

### CaptureRequest Building

**File:** `Software/Web/src/core/protocol/packets.js` (lines 119-145)

`buildCaptureRequest(session)` constructs a 56-byte little-endian binary struct matching the C firmware's `CAPTURE_REQUEST`:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | triggerType |
| 1 | 1 | triggerChannel |
| 2 | 1 | invertedOrCount |
| 3 | 1 | padding |
| 4 | 2 | triggerValue (LE) |
| 6 | 32 | channels[] (zero-padded) |
| 38 | 1 | channelCount |
| 39 | 1 | padding |
| 40 | 4 | frequency (LE) |
| 44 | 4 | preSamples (LE) |
| 48 | 4 | postSamples (LE) |
| 52 | 2 | loopCount (LE) |
| 54 | 1 | measure |
| 55 | 1 | captureMode |

### StreamRequest Building

**File:** `Software/Web/src/core/protocol/packets.js` (lines 101-117)

`buildStreamRequest(config)` constructs a 40-byte little-endian struct matching the firmware's `STREAM_REQUEST`:

| Offset | Size | Field |
|---|---|---|
| 0 | 32 | channels[] (zero-padded) |
| 32 | 1 | channelCount |
| 33 | 1 | padding |
| 34 | 2 | chunkSamples (LE) |
| 36 | 4 | frequency (LE) |

### Response Parsing

**File:** `Software/Web/src/core/protocol/parser.js`

#### Version Validation (lines 3-28)

`validateVersion(versionString)` checks version strings against a regex pattern `.*?V(\d+)_(\d+)$` and enforces a minimum of V6_5. Returns `{ valid, major, minor }`.

#### Init Handshake (lines 55-105)

`parseInitResponse(transport)` reads the 5-line device init handshake:

1. **Version line** (e.g., `"ANALYZER_V6_5"`) -- skips up to 20 non-version lines to handle firmware boot noise
2. `"FREQ:100000000"` -- max sampling frequency
3. `"BLASTFREQ:200000000"` -- blast mode frequency
4. `"BUFFER:262144"` -- sample buffer size in bytes
5. `"CHANNELS:24"` -- number of available channels

Returns a `DeviceInfo` object with all parsed values. Throws descriptive errors if any line doesn't match the expected regex.

#### Capture Start Response (lines 113-115)

`parseCaptureStartResponse(transport)` reads a single line. The driver checks if it equals `"CAPTURE_STARTED"`.

#### Capture Data Parsing (lines 133-175)

`parseCaptureData(transport, captureMode, loopCount, measureBursts)` reads the binary capture result:

1. **Sample count** -- 4 bytes, UInt32 LE
2. **Raw samples** -- `sampleCount * bytesPerSample` bytes (1/2/4 bytes per sample for 8ch/16ch/24ch modes)
3. **Timestamp flag** -- 1 byte (0 = no timestamps)
4. **Timestamps** (if flag > 0 and burst mode) -- `(loopCount + 2) * 4` bytes of UInt32 LE values

Returns `{ samples: Uint32Array, timestamps: Uint32Array }`.

#### Simple Response Check (lines 184-187)

`parseResponseLine(transport, expectedResponse)` reads one line and returns `true` if it matches the expected string. Used for LED blink and bootloader commands.

---

## Driver Layer

### Type Definitions

**File:** `Software/Web/src/core/driver/types.js`

Defines JSDoc typedefs for:
- `CaptureSession` -- full capture configuration (frequency, trigger settings, channels, etc.)
- `AnalyzerChannel` -- per-channel data (`channelNumber`, `channelName`, `samples: Uint8Array`)
- `CaptureLimits` -- min/max pre/post samples and total limits
- `BurstInfo` -- burst timing metadata

Factory function `createChannel(number, name, color)` creates channels with default values (lines 62-70).

`getTotalSamples(session)` computes total samples: `postTriggerSamples * (loopCount + 1) + preTriggerSamples` (lines 79-81).

### AnalyzerDriver

**File:** `Software/Web/src/core/driver/analyzer.js`

The `AnalyzerDriver` class is the high-level device driver, porting `AnalyzerDriverBase` + `LogicAnalyzerDriver` from the C# SharedDriver.

#### Properties (lines 35-78)

Exposes read-only state: `version`, `majorVersion`, `minorVersion`, `maxFrequency`, `blastFrequency`, `minFrequency` (derived), `bufferSize`, `channelCount`, `capturing`, `streaming`, `connected`.

#### connect(transport) (lines 84-99)

Performs the device init handshake:

1. Creates and serializes an `OutputPacket` containing `CMD_DEVICE_INIT` (0x00)
2. Writes the framed packet to the transport
3. Calls `parseInitResponse(transport)` to read the 5-line handshake
4. Stores all device capability values

This is the only place where the driver acquires its transport reference.

#### disconnect() (lines 101-107)

Resets `capturing` and `streaming` flags, then calls `transport.disconnect()`.

#### getCaptureMode(channelNumbers) (lines 114-117)

Determines capture mode from channel numbers: `max < 8` = 8CH, `max < 16` = 16CH, else 24CH.

#### getLimits(channelNumbers) (lines 124-136)

Computes sample limits based on buffer size and bytes-per-sample for the inferred capture mode.

#### validateSettings(session) (lines 164-233)

Comprehensive validation ported from `LogicAnalyzerDriver.cs` lines 734-799. Checks differ by trigger type:
- **Edge**: validates channel ranges, sample limits, frequency bounds, burst constraints
- **Blast**: preSamples must be 0, frequency must exactly equal blastFrequency, no looping
- **Complex/Fast**: additional trigger bit count and channel constraints

#### composeRequest(session) (lines 242-283)

Translates a high-level `CaptureSession` into the low-level fields for `buildCaptureRequest()`. For Complex/Fast triggers, applies a trigger delay offset to compensate for firmware pipeline latency.

#### startCapture(session, onComplete) (lines 291-349)

Full capture flow:

1. Guard checks (not already capturing/streaming, connected, channels selected, settings valid)
2. Compose request and determine capture mode
3. Build `OutputPacket` with `CMD_START_CAPTURE` (0x01) + 56-byte `CaptureRequest`
4. Write serialized packet to transport
5. Read and verify `"CAPTURE_STARTED"` response line
6. Set `#capturing = true`
7. Read binary capture data via `parseCaptureData()`
8. Extract per-channel samples using `extractSamples()` (bit masking from packed uint32 values)
9. Process burst timestamps if present
10. Call `onComplete({ success: true, session })` with populated channel samples

On error, calls `onComplete({ success: false, session, error })`.

#### stopCapture() (lines 355-369)

Sends raw `0xFF` byte (not framed in an OutputPacket), waits 2 seconds, then disconnects and reconnects the transport. This mirrors the C# behavior where aborting a capture requires a full transport reset.

#### blinkLed() / stopBlinkLed() (lines 372-385)

Sends `CMD_BLINK_LED_ON`/`CMD_BLINK_LED_OFF` in an OutputPacket, then reads and verifies the `"BLINKON"`/`"BLINKOFF"` response.

#### enterBootloader() (lines 388-394)

Sends `CMD_ENTER_BOOTLOADER`, expects `"RESTARTING_BOOTLOADER"` response.

#### startStream(config, onChunk, onEnd) (lines 407-457)

Streaming capture initiation:

1. Guard checks (not capturing/streaming, connected, 1-24 channels)
2. Build `StreamRequest` (40 bytes) with channels, chunk size, frequency
3. Wrap in `OutputPacket` with `CMD_START_STREAM` (0x0A)
4. Write to transport
5. Read handshake line, verify `"STREAM_STARTED"`
6. Read 8-byte info header: `[chunkSamples LE16][numChannels u8][reserved u8][actualFreq LE32]`
7. Set `#streaming = true`
8. Fire-and-forget the async `#readStreamLoop()` method
9. Return `{ started: true, chunkSamples, numChannels, actualFrequency }`

The `actualFrequency` may differ from the requested frequency due to PIO clock divider rounding.

#### #readStreamLoop(numChannels, chunkSamples, onChunk, onEnd) (lines 464-490)

The async read loop for streaming mode:

1. Read 2-byte compressed chunk size (LE16)
2. If size == 0, this is the EOF marker -- break
3. Read `compressedSize` bytes of compressed data
4. Decompress via `decompressChunk()` into per-channel bitstreams
5. Call `onChunk(channels, chunkSamples)`
6. Repeat from step 1

On EOF: read a final status line (e.g., `"STREAM_COMPLETE"`, `"STREAM_OVERFLOW"`), call `onEnd(endStatus, null)`.
On error: call `onEnd(null, errorMessage)`.

#### stopStream() (lines 498-532)

1. Send `CMD_STOP_STREAM` in an OutputPacket
2. Poll-wait up to 5 seconds for `#streaming` to become false (the read loop handles it)
3. If timeout: force disconnect and reconnect the transport

### Sample Extraction

**File:** `Software/Web/src/core/driver/samples.js`

#### extractSamples(rawSamples, channelIndex) (lines 15-22)

Extracts a single channel's data from packed uint32 samples using bit masking: `(rawSamples[i] & (1 << channelIndex)) !== 0 ? 1 : 0`. Returns a `Uint8Array` of 0/1 values.

#### processBurstTimestamps(timestamps, session, blastFrequency) (lines 36-98)

Processes raw SysTick timestamps from the firmware (200 MHz clock, lower 24 bits counting down) into `BurstInfo` entries with sample positions and nanosecond-resolution gap measurements. Handles rollover correction and jitter compensation.

---

## Streaming Data Pipeline

### Compression Format

**File:** `Software/Web/src/core/compression/decoder.js`

The firmware compresses streaming data per-channel using a nibble-encoding scheme produced by `stream_compress.c`. Each chunk is encoded as:

1. **Header** -- 2 bits per channel (LSB-first packed into bytes), one of:
   - `HDR_RAW` (0x00): raw uncompressed bytes follow
   - `HDR_ALL_ZERO` (0x01): entire channel is all zeros
   - `HDR_ALL_ONE` (0x02): entire channel is all ones
   - `HDR_NIBBLE_ENC` (0x03): nibble-encoded data follows

2. **Per-channel data** -- for `HDR_NIBBLE_ENC`, uses a 16-entry nibble prefix code table (lines 16-33) where each nibble either specifies "read N raw data nibbles" or "emit N fill nibbles (zero or one)". The `NibbleReader` class (lines 39-66) reads nibbles MSB-first from the byte stream.

`decompressChunk(data, numChannels, chunkSamples)` (lines 77-144) decompresses one chunk, returning per-channel transposed bitstreams (`chunkSamples / 8` bytes per channel).

### Stream Store Data Processing

**File:** `Software/Web/src/stores/stream.js`

The stream store receives decompressed chunks from the driver and processes them for display:

#### Time-Based Batching (lines 56-59, 77-86)

To avoid overwhelming Vue reactivity during high-frequency streaming, chunks are buffered in a non-reactive `pendingChunks` array and flushed synchronously when `FLUSH_INTERVAL_MS` (16 ms, ~60 fps) has elapsed since the last flush. This avoids `requestAnimationFrame` starvation from microtask-driven read loops.

#### Bitstream Unpacking (lines 64-70)

`unpackBitstream(packed, chunkSamples)` converts transposed bitstreams (packed bits) into per-sample `Uint8Array` of 0/1 values for rendering.

#### Chunk Flush (lines 110-156)

`flushChunks()` concatenates all pending unpacked chunks into each channel's `samples` buffer, trims to `maxDisplaySamples` from the end, and triggers a reactive update of `streamChannels.value`. If `following` mode is active, it auto-scrolls the viewport to the latest data.

#### Stream End Status Handling (lines 91-108)

Handles firmware end-of-stream status lines:
- `"STREAM_OVERFLOW"` -- data rate exceeded device capacity (shown as warning)
- `"STREAM_TIMEOUT"` -- no data produced (shown as error)
- `"STREAM_DISCONN"` -- USB disconnect detected (shown as error)

#### Rate Limits (lines 11-36)

`STREAM_RATE_LIMITS` maps channel count to recommended maximum streaming frequency (90% of USB benchmark). For example: 1ch = 6.31 MHz, 8ch = 910 kHz, 24ch = 303 kHz. The UI warns users when they exceed these limits.

---

## State Management and UI Integration

### Device Store

**File:** `Software/Web/src/stores/device.js`

The Pinia device store owns the driver instance and connection lifecycle:

#### connect(transportOptions) (lines 21-43)

1. Clears any previous error
2. Disconnects if already connected
3. Creates a `SerialTransport` (wrapped with `markRaw` to prevent Vue reactivity proxying)
4. Calls `transport.connect()` (triggers browser USB picker)
5. Creates an `AnalyzerDriver` (also `markRaw`)
6. Calls `driver.connect(transport)` (sends init command, parses handshake)
7. Stores the driver, sets `connected = true`, caches `deviceInfo`
8. On error: resets all state and stores error message

The `markRaw()` calls on lines 29 and 32 are essential -- without them, Vue's reactivity system would wrap the transport/driver in a Proxy, breaking Web Serial API calls that require the original object identity.

#### disconnect() (lines 46-60)

Calls `driver.disconnect()`, resets all state (driver, connected, capturing, streaming, deviceInfo, error).

### Capture Store

**File:** `Software/Web/src/stores/capture.js`

#### startCapture() (lines 83-117)

1. Gets driver from device store
2. Clears stream data (capture takes priority in display)
3. Builds a `CaptureSession` from current config values
4. Calls `driver.startCapture(session, callback)`
5. On success: stores captured channels and bursts
6. On failure: stores error message
7. Always resets `device.capturing` in `finally` block

#### stopCapture() (lines 119-125)

Delegates to `driver.stopCapture()` and resets `device.capturing`.

### Stream Store

**File:** `Software/Web/src/stores/stream.js`

#### startStream(channelsToStream) (lines 158-230)

1. Validates preconditions (connected, not busy, channels selected)
2. Warns if frequency exceeds recommended rate limit
3. Creates empty channel objects with `createChannel()`
4. Calls `driver.startStream(config, onChunk, onStreamEnd)`
5. On success: updates `streaming` state, may adjust frequency if PIO clamped it
6. On failure: stores error, clears channels

#### stopStream() (lines 232-242)

Delegates to `driver.stopStream()`, forces cleanup if read loop doesn't finish.

### Composables

#### useDevice()

**File:** `Software/Web/src/composables/useDevice.js`

Thin reactive wrapper around the device store. Exposes: `isWebSerialAvailable`, `isConnected`, `isCapturing`, `deviceInfo`, `error`, `connect()`, `disconnect()`, `blinkLed()`, `stopBlinkLed()`, `enterBootloader()`. Adds a local `connecting` ref that tracks the async connect operation.

#### useCapture()

**File:** `Software/Web/src/composables/useCapture.js`

Exposes capture configuration as writable computed refs (for v-model binding), capture results, device-derived limits, and convenience computed values like `canCapture`, `captureMode`, `isBlastMode`, etc.

#### useStream()

**File:** `Software/Web/src/composables/useStream.js`

Wraps stream store with config refs, state, and computed `canStartStream` / `isOverRecommended`.

---

## Connection UI and User Flow

### Boot-Time Detection

**File:** `Software/Web/src/boot/webserial.js`

At app startup, the `webserial` boot file checks `navigator.serial` availability. If absent (Firefox, Safari, non-Chromium browsers), it shows a persistent Quasar notification warning. The `webSerialAvailable` ref is exported for components to check.

### ConnectionPanel Component

**File:** `Software/Web/src/components/connection/ConnectionPanel.vue`

The connection panel appears in the app toolbar and provides the primary connection UI:

**Disconnected state:**
- Shows a "Connect" button with USB icon (line 13-23)
- Button is disabled if Web Serial is unavailable
- Shows a loading spinner during connection via `device.connecting`
- Clicking triggers `device.connect()`, which opens the browser's USB device picker

**Connected state:**
- Shows a green chip with the device version string (e.g., `"ANALYZER_V6_5"`) (lines 26-46)
- Clicking the chip opens a dropdown showing device details: channel count, max frequency, buffer size
- Shows a red "Disconnect" button (lines 48-55)

**Error state:**
- If `device.error` is set, shows a red removable chip with the error message (lines 58-68)

### Connection Flow (User Perspective)

1. User clicks "Connect" button
2. Browser opens the USB device picker dialog (filtered to VID `0x1209`, PID `0x3020`)
3. User selects the logic analyzer device
4. The app opens the serial port, runs the init handshake, and displays device info
5. If connection fails (no device selected, port busy, version mismatch), an error chip appears
6. User can dismiss the error and retry

### Capture Dialog

**File:** `Software/Web/src/components/capture/CaptureDialog.vue`

Provides capture configuration UI. When the user clicks "Start Capture", it calls `capture.startCapture()` which ultimately invokes `driver.startCapture()`.

### Stream Dialog

**File:** `Software/Web/src/components/capture/StreamDialog.vue`

Provides streaming configuration:
- Frequency input (min 3000 Hz, max 10 MHz)
- Chunk size selector (32, 64, 128, 256, 512, 1024 samples)
- Max display samples input
- Channel selector
- Warnings when frequency exceeds recommended limits for the selected channel count
- "Start Realtime" button triggers `stream.startStream()`

---

## Error Handling and Reconnection

### Transport-Level Errors

- **Write errors**: `write()` throws `"Transport not connected"` if called while disconnected (serial.js line 122)
- **Read errors**: Both `readLine()` and `readBytes()` throw `"Serial stream closed while reading"` if the reader signals `done` (serial.js lines 152, 168)
- **Disconnect errors**: `disconnect()` silently catches all errors during reader/writer release and port close (serial.js lines 91-117)

### Driver-Level Errors

- **Capture failures**: The `startCapture()` method catches all errors and passes them to the `onComplete` callback with `success: false` (analyzer.js lines 345-348)
- **Capture abort**: `stopCapture()` sends raw `0xFF`, waits 2 seconds, then fully disconnects and reconnects the transport. Errors during this sequence are silently caught (analyzer.js lines 355-369)
- **Stream stop timeout**: `stopStream()` waits up to 5 seconds for the read loop to finish. If it doesn't, it forcefully disconnects and reconnects the transport (analyzer.js lines 514-525)
- **Stream read errors**: The `#readStreamLoop` catches errors and reports them through `onEnd(null, errorMessage)` (analyzer.js lines 485-489)

### Store-Level Error Handling

- **Device store**: Catches connection errors and stores them in `error` ref for display (device.js lines 38-43)
- **Capture store**: Wraps `startCapture()` in try/catch, stores errors in `captureError` (capture.js lines 112-114)
- **Stream store**: Handles firmware end-status codes (`STREAM_OVERFLOW`, `STREAM_TIMEOUT`, `STREAM_DISCONN`) with appropriate user-facing messages (stream.js lines 91-108)

### Reconnection Strategy

There is no automatic reconnection. If a connection is lost:
- The user must manually click "Connect" again
- The `stopCapture()` and `stopStream()` methods perform disconnect-reconnect cycles to reset the transport, but this is for session cleanup, not recovery from unexpected disconnects
- The `onDisconnect` callback on `ITransport` is defined in the interface but not currently wired up in the SerialTransport or device store

---

## WebSocket Transport (Planned)

The `ITransport` interface comment (types.js line 3) mentions "future WebSocketTransport" as a planned implementation. The WiFi-based Pico 2W connection would use WebSocket to provide the same `connect()`, `disconnect()`, `write()`, `readLine()`, and `readBytes()` interface over a network socket. The `CMD_NETWORK_CONFIG` command (0x02) exists in the command constants for WiFi configuration but no WebSocket transport implementation exists yet.

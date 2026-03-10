# LogicAnalyzer V2 Communication Protocol Overview

This document describes the firmware-to-host communication protocol used by the LogicAnalyzer V2 project. It covers packet framing, command dispatch, response formats, transport abstraction (USB serial vs WiFi), and the streaming sub-protocol.

---

## 1. Transport Layer

The firmware supports two transport mechanisms: **USB CDC serial** and **WiFi (TCP)**. Both carry the same protocol bytes; the firmware abstracts them through a `fromWiFi` boolean parameter threaded through all command handling and response functions.

### 1.1 USB Serial (CDC)

- **Implementation:** TinyUSB CDC device class. The Pico presents itself as a USB serial device with vendor ID `0x1209` and product ID `0x3020`.
- **Baud rate:** 115200 (configured by the host; see `Software/Web/src/core/protocol/commands.js` line 33).
- **Input path:** During idle, `processUSBInput()` reads one byte at a time via `getchar_timeout_us(0)` (stdio). During streaming/capture transfer, `stdio_usb` is deinitialized and direct TinyUSB calls are used instead (`processUSBInputDirect()` via `tud_cdc_read()`, and `cdc_transfer()` for output).
  - `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c` lines 499-536.
- **Output path for text responses:** `printf()` via stdio (calls `sendResponse()`, line 171).
- **Output path for binary data:** `cdc_transfer()` (lines 177-207), which loops over `tud_cdc_write()` with flush until all bytes are sent.
- **Host side:** The web client uses the Web Serial API (`SerialTransport` class at `Software/Web/src/core/transport/serial.js`). It opens the port with a 1 MB buffer size (line 68), sets RTS/DTR signals (line 70-73), waits 200 ms for firmware boot, drains pending data, then begins normal communication.

### 1.2 WiFi (TCP)

- **Enabled by:** `USE_CYGW_WIFI` compile flag (Pico W and Pico 2 W WiFi builds).
- **Architecture:** A dual-core design where **Core 0** runs the main protocol logic and **Core 1** runs the WiFi/lwIP stack (`runWiFiCore()` at `Firmware/LogicAnalyzer_V2/LogicAnalyzer_WiFi.c` line 295).
- **Inter-core communication:** Two event queues (`wifiToFrontend` and `frontendToWifi`) using a `queue_t`-based event machine (`Firmware/LogicAnalyzer_V2/Event_Machine.h`). Events carry up to 128 bytes (WiFi-to-frontend) or 32 bytes (frontend-to-WiFi) of data.
- **Connection flow:**
  1. Core 1 initializes CYW43, connects to the configured AP, binds a TCP server on the configured port (`Firmware/LogicAnalyzer_V2/LogicAnalyzer_WiFi.c` lines 173-187).
  2. When a TCP client connects, it pushes a `CONNECTED` event to Core 0. Core 0 sets `usbDisabled = true`, disabling USB input processing (`LogicAnalyzer.c` line 571-572).
  3. Incoming TCP data arrives via lwIP callback `serverReceiveData()` (line 118), chunked into 128-byte `DATA_RECEIVED` events pushed to Core 0.
  4. Outgoing data is pushed from Core 0 as `SEND_DATA` events (32 bytes max per event) to Core 1, which calls `tcp_write()` (line 99).
- **WiFi settings** (SSID, password, IP, port, hostname) are stored in flash (`storeSettings()`, `LogicAnalyzer.c` lines 109-150) and validated via a checksum on boot.

### 1.3 Transport Abstraction (Software Side)

The web client defines an `ITransport` interface (`Software/Web/src/core/transport/types.js` lines 1-13) with methods:
- `connect()` / `disconnect()`
- `write(data: Uint8Array)`
- `readLine()` - reads a newline-delimited string (strips `\r\n`)
- `readBytes(count)` - reads exactly N binary bytes

Both text responses and binary data transfers share the same byte stream. The `SerialTransport` uses a unified internal buffer so `readLine()` and `readBytes()` can be interleaved without data loss (lines 131-174).

---

## 2. Packet Framing (Host-to-Device)

All host-to-device commands use a binary framing protocol. The firmware describes this in comments at `LogicAnalyzer.c` lines 478-494.

### 2.1 Frame Structure

```
[0x55 0xAA] [escaped payload] [0xAA 0x55]
```

| Field | Bytes | Description |
|-------|-------|-------------|
| Header | `0x55 0xAA` | Start-of-frame marker |
| Payload | Variable | Command byte + optional struct data, with byte-stuffing |
| Footer | `0xAA 0x55` | End-of-frame marker |

### 2.2 Byte-Stuffing (Escaping)

Because the frame delimiters (`0x55`, `0xAA`) and the escape byte (`0xF0`) can appear in payload data, they are escaped:

| Original Byte | Escaped Sequence | Explanation |
|---------------|-----------------|-------------|
| `0x55` | `0xF0 0xA5` | `0x55 XOR 0xF0 = 0xA5` |
| `0xAA` | `0xF0 0x5A` | `0xAA XOR 0xF0 = 0x5A` |
| `0xF0` | `0xF0 0x00` | `0xF0 XOR 0xF0 = 0x00` |

**Encoding** (host side): Implemented in `OutputPacket.serialize()` at `Software/Web/src/core/protocol/packets.js` lines 43-58.

**Decoding** (firmware side): After detecting the stop condition `0xAA 0x55`, the firmware unescapes in-place by scanning for `0xF0` and XOR-ing the following byte with `0xF0`:
```c
// LogicAnalyzer.c lines 264-276
for(int src = 0; src < bufferPos; src++)
{
    if(messageBuffer[src] == 0xF0)
    {
        messageBuffer[dest] = messageBuffer[src + 1] ^ 0xF0;
        src++;
    }
    else
        messageBuffer[dest] = messageBuffer[src];
    dest++;
}
```

### 2.3 Frame Reception State Machine

The firmware processes incoming bytes one at a time in `processData()` (`LogicAnalyzer.c` lines 240-494):

1. **Byte 1:** Must be `0x55`, otherwise reset (`bufferPos = 0`).
2. **Byte 2:** Must be `0xAA`, otherwise reset.
3. **Bytes 3+:** Accumulate into `messageBuffer[160]`. On each byte, check:
   - If `bufferPos >= 160`: send `ERR_MSG_OVERFLOW\n` and reset.
   - If the last two bytes are `0xAA 0x55`: frame complete -- unescape and dispatch.

The message buffer is 160 bytes, sized to accommodate the largest command payload (`WIFI_SETTINGS_REQUEST` = 148 bytes + framing overhead).

### 2.4 USB Reconnection Handling

On USB reconnection, `bufferPos` is reset to 0 to prevent partial message corruption from a previous connection (`LogicAnalyzer.c` lines 621-625).

---

## 3. Command Dispatch

After unescaping, `messageBuffer[2]` contains the command byte (offset 2 because bytes 0-1 are the header `0x55 0xAA`). The switch statement at `LogicAnalyzer.c` line 278 dispatches commands.

### 3.1 Command Table

| Cmd Byte | Name | Software Constant | Payload | Response | Reference |
|----------|------|-------------------|---------|----------|-----------|
| `0x00` | Device ID/Init | `CMD_DEVICE_INIT` | None (frame is exactly 5 bytes: header + cmd + footer) | Multi-line text (see 4.1) | `LogicAnalyzer.c` lines 281-299 |
| `0x01` | Start Capture | `CMD_START_CAPTURE` | `CAPTURE_REQUEST` struct (56 bytes) | `CAPTURE_STARTED\n` or `CAPTURE_ERROR\n` or `ERR_BUSY\n` | `LogicAnalyzer.c` lines 302-347 |
| `0x02` | WiFi Config | `CMD_NETWORK_CONFIG` | `WIFI_SETTINGS_REQUEST` struct (148 bytes) | `SETTINGS_SAVED\n` or `ERR_UNSUPPORTED\n` | `LogicAnalyzer.c` lines 349-410 |
| `0x03` | Power/Voltage Status | `CMD_VOLTAGE_STATUS` | None | Async voltage string (WiFi only) or `ERR_UNSUPPORTED\n` | `LogicAnalyzer.c` lines 390-401 |
| `0x04` | Enter Bootloader | `CMD_ENTER_BOOTLOADER` | None | `RESTARTING_BOOTLOADER\n`, then device resets to USB boot mode | `LogicAnalyzer.c` lines 413-418 |
| `0x05` | Blink LED On | `CMD_BLINK_LED_ON` | None | `BLINKON\n` | `LogicAnalyzer.c` lines 420-424 |
| `0x06` | Blink LED Off | `CMD_BLINK_LED_OFF` | None | `BLINKOFF\n` | `LogicAnalyzer.c` lines 426-432 |
| `0x0A` | Start Stream | `CMD_START_STREAM` | `STREAM_REQUEST` struct (40 bytes) | `STREAM_STARTED\n` + 8-byte info header, or `STREAM_ERROR\n` / `ERR_BUSY\n` / `ERR_PARAMS\n` | `LogicAnalyzer.c` lines 435-459 |
| `0x0B` | Stop Stream | `CMD_STOP_STREAM` | None | Terminates the active stream (EOF marker + status line) | `LogicAnalyzer.c` lines 461-462 |
| `0xFF` | Stop Capture | `CMD_STOP_CAPTURE` | N/A -- raw byte, NOT framed | Any received data during capture triggers cancel | `analyzer.js` line 360 |

Command constants are defined in `Software/Web/src/core/protocol/commands.js` lines 3-12.

---

## 4. Response Formats

The firmware uses **two distinct response formats** depending on the operation:

### 4.1 Text Responses (Newline-Terminated Strings)

Most command acknowledgments are ASCII strings terminated by `\n` (newline). Sent via `sendResponse()` (`LogicAnalyzer.c` lines 157-172), which uses `printf()` for USB or event queue for WiFi.

**Device Init response** (command `0x00`) sends 5 lines:
```
LOGIC_ANALYZER_<BOARD_NAME>_V<MAJOR>_<MINOR>\n
FREQ:<max_frequency>\n
BLASTFREQ:<max_blast_frequency>\n
BUFFER:<capture_buffer_size>\n
CHANNELS:<max_channels>\n
```

Example:
```
LOGIC_ANALYZER_PICO_2_V6_5
FREQ:100000000
BLASTFREQ:200000000
BUFFER:393216
CHANNELS:24
```

Parsed by `parseInitResponse()` in `Software/Web/src/core/protocol/parser.js` lines 55-105.

**Error responses:**
- `ERR_MSG_OVERFLOW\n` -- message buffer overflow (>160 bytes)
- `ERR_UNKNOWN_MSG\n` -- unrecognized command byte or malformed message
- `ERR_UNSUPPORTED\n` -- command not supported on this build (e.g., WiFi commands on non-WiFi firmware)
- `ERR_BUSY\n` -- device is already capturing or streaming
- `ERR_PARAMS\n` -- invalid stream parameters
- `CAPTURE_ERROR\n` -- capture failed to start
- `STREAM_ERROR\n` -- stream failed to start

### 4.2 Binary Responses (Capture Data Transfer)

After a successful capture completes (trigger fires and all samples are collected), the firmware sends raw binary data **without framing**:

**Capture data wire format** (`LogicAnalyzer.c` lines 710-813):

| Segment | Size | Format | Description |
|---------|------|--------|-------------|
| Sample count | 4 bytes | uint32 LE | Total number of samples captured |
| Sample data | `sampleCount * bytesPerSample` | Raw bytes | Capture mode determines bytes/sample: 8ch=1, 16ch=2, 24ch=4 |
| Timestamp flag | 1 byte | uint8 | 0 = no timestamps, >0 = timestamps follow |
| Timestamps | `stampLength * 4` bytes | uint32 LE array | Burst measurement timestamps (only if flag > 1) |

The `stdio_usb` subsystem is **deinitialized** before binary transfer (`stdio_usb_deinit()`, line 728) and **reinitialized** after (`stdio_usb_init()`, line 816). This prevents the TinyUSB background task from interfering with bulk data transfer.

Parsed by `parseCaptureData()` in `Software/Web/src/core/protocol/parser.js` lines 133-175.

### 4.3 Streaming Data (Compressed Binary Chunks)

The streaming sub-protocol sends a continuous sequence of compressed data chunks:

**Stream handshake:**
1. Host sends `CMD_START_STREAM` with `STREAM_REQUEST` payload.
2. Firmware responds with text: `STREAM_STARTED\n`
3. Firmware sends 8-byte binary info header:

| Offset | Size | Format | Description |
|--------|------|--------|-------------|
| 0 | 2 bytes | uint16 LE | Actual chunk size in samples |
| 2 | 1 byte | uint8 | Number of active channels |
| 3 | 1 byte | uint8 | Reserved (zero) |
| 4 | 4 bytes | uint32 LE | Actual sampling frequency (after clock divider clamping) |

(`LogicAnalyzer_Stream.c` lines 309-331)

**Stream data loop:**

Each chunk is transmitted as:
```
[compressed_size: uint16 LE] [compressed_data: compressed_size bytes]
```

The compression uses per-channel nibble encoding with a 2-bit-per-channel header indicating the mode for each channel:
- `0x00` (RAW): raw bitstream bytes follow
- `0x01` (ALL_ZERO): channel is all zeros, no data bytes
- `0x02` (ALL_ONE): channel is all ones, no data bytes
- `0x03` (NIBBLE_ENC): nibble-prefix-coded run-length data

Decompression is implemented in `Software/Web/src/core/compression/decoder.js`.

**Stream termination:**

When the stream ends (via stop command, overflow, disconnect, or timeout):
1. Any remaining compressed chunks are flushed.
2. An **EOF marker** is sent: `0x00 0x00` (compressed_size = 0).
3. A **status line** is sent as text: `STREAM_<REASON> DMA=<n> CMP=<n> SEND=<n> LOOP=<n> CONN=<0|1>/<0|1> CHUNKS=<n> FREQ=<n>\n`

Reason codes: `DONE`, `OVERFLOW`, `DISCONN`, `TIMEOUT` (`LogicAnalyzer_Stream.c` lines 368-510).

---

## 5. Command/Response Data Structures

### 5.1 CAPTURE_REQUEST (56 bytes, C struct with natural alignment)

Defined at `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h` lines 9-42. Built by `buildCaptureRequest()` at `Software/Web/src/core/protocol/packets.js` lines 119-145.

| Offset | Size | Type | Field | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | triggerType | 0=Edge, 1=Complex, 2=Fast, 3=Blast |
| 1 | 1 | uint8 | trigger | Trigger channel (or base channel for pattern) |
| 2 | 1 | uint8 | inverted/count | Union: inverted flag (Edge/Blast) or bit count (Complex/Fast) |
| 3 | 1 | - | padding | Alignment padding before uint16 |
| 4 | 2 | uint16 LE | triggerValue | Pattern value for Complex/Fast triggers |
| 6 | 32 | uint8[32] | channels | Channel numbers to capture (zero-padded) |
| 38 | 1 | uint8 | channelCount | Number of active channels |
| 39 | 1 | - | padding | Alignment padding before uint32 |
| 40 | 4 | uint32 LE | frequency | Sampling frequency in Hz |
| 44 | 4 | uint32 LE | preSamples | Number of pre-trigger samples |
| 48 | 4 | uint32 LE | postSamples | Number of post-trigger samples |
| 52 | 2 | uint16 LE | loopCount | Number of capture loops |
| 54 | 1 | uint8 | measure | 0 or 1 (measure burst times) |
| 55 | 1 | uint8 | captureMode | 0=8ch, 1=16ch, 2=24ch |

### 5.2 STREAM_REQUEST (40 bytes, C struct with natural alignment)

Defined at `LogicAnalyzer_Structs.h` lines 44-55. Built by `buildStreamRequest()` at `packets.js` lines 101-117.

| Offset | Size | Type | Field | Description |
|--------|------|------|-------|-------------|
| 0 | 32 | uint8[32] | channels | Channel numbers (zero-padded) |
| 32 | 1 | uint8 | channelCount | 1-24 |
| 33 | 1 | - | padding | Alignment padding |
| 34 | 2 | uint16 LE | chunkSamples | Chunk size (32-1024, multiple of 32) |
| 36 | 4 | uint32 LE | frequency | Desired sampling frequency in Hz |

### 5.3 WIFI_SETTINGS_REQUEST (148 bytes)

Defined at `LogicAnalyzer_Structs.h` lines 70-78. Sent with command `0x02`.

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 33 | char[33] | apName (SSID, null-terminated) |
| 33 | 64 | char[64] | passwd (WPA2 password) |
| 97 | 16 | char[16] | ipAddress (static IP string) |
| 113 | 2 | uint16 | port (TCP server port) |
| 115 | 33 | char[33] | hostname |

---

## 6. Capture Cancel Mechanism

Capture cancellation does not use the framing protocol. During an active capture, the firmware polls for **any** incoming data via `processCancel()` (`LogicAnalyzer.c` lines 639-650). If any byte is received (USB or WiFi), the capture is stopped:

```c
// LogicAnalyzer.c line 827
if(processCancel())
{
    StopCapture();
    capturing = false;
    LED_ON();
}
```

The `processUSBInput(true)` and `processWiFiInput(true)` calls pass `skipProcessing=true`, meaning the received data is consumed but not parsed as a command -- its mere presence serves as the cancel signal.

On the software side, the driver sends a raw `0xFF` byte (not framed) and then reconnects the transport:
```js
// analyzer.js lines 360-366
await this.#transport.write(new Uint8Array([CMD_STOP_CAPTURE]))
await new Promise(r => setTimeout(r, 2000))
await this.#transport.disconnect()
await this.#transport.connect()
```

The firmware also detects USB disconnect during capture (`LogicAnalyzer.c` lines 835-840) and auto-cancels.

---

## 7. Device Init Handshake

The full connection handshake sequence:

1. **Host opens transport** (USB serial port or TCP socket).
2. **Host drains pending data** -- discards any boot noise or leftover bytes.
3. **Host sends CMD_DEVICE_INIT** (`0x00`) in a framed packet: `[0x55 0xAA 0xF0 0xA5 0xF0 0x5A 0xA5]` (note: `0x00` does not need escaping, so the actual wire bytes are `55 AA 00 AA 55` unescaped, but after escaping the `0xAA` and `0x55` in the footer: the packet is `55 AA 00 AA 55` which would be ambiguous -- the escaping ensures correctness).
4. **Firmware responds** with 5 newline-terminated text lines (version, freq, blast freq, buffer size, channels).
5. **Host validates version** against minimum `V6_5` using regex `.*?V(\d+)_(\d+)$` (`parser.js` line 3). Up to 20 non-matching lines are skipped to handle firmware boot noise (`parser.js` lines 58-65).
6. **Host parses device capabilities** and stores them in the `AnalyzerDriver` instance.

---

## 8. Capture Mode Flow (Complete Sequence)

### 8.1 Trigger-Based Capture

```
Host                              Firmware
  |                                  |
  |-- [0x55 0xAA CMD=0x01 ...] ---->|  Framed CAPTURE_REQUEST
  |                                  |
  |<---- "CAPTURE_STARTED\n" --------|  Text ack
  |                                  |  (firmware waits for trigger)
  |                                  |  (host can send any byte to cancel)
  |                                  |
  |<---- [4 bytes: sample count] ----|  Binary: uint32 LE
  |<---- [N bytes: sample data] -----|  Binary: raw samples
  |<---- [1 byte: timestamp flag] ---|  Binary: uint8
  |<---- [M bytes: timestamps] ------|  Binary: uint32 LE array (conditional)
  |                                  |
```

The firmware disables `stdio_usb` before binary transfer and re-enables it after. There is a 100 ms delay before the first binary write (USB) or 2000 ms (WiFi) to allow the host to prepare for binary reception.

### 8.2 Streaming Capture

```
Host                              Firmware
  |                                  |
  |-- [0x55 0xAA CMD=0x0A ...] ---->|  Framed STREAM_REQUEST
  |                                  |
  |<---- "STREAM_STARTED\n" ---------|  Text ack (via cdc_transfer, not printf)
  |<---- [8 bytes: info header] -----|  Binary: chunkSamples, numChannels, freq
  |                                  |
  |<---- [2B size][NB data] ---------|  Compressed chunk (repeats)
  |<---- [2B size][NB data] ---------|  ...
  |                                  |
  |-- [0x55 0xAA CMD=0x0B ...] ---->|  Framed CMD_STOP_STREAM
  |                                  |
  |<---- [remaining chunks] ---------|  Flush
  |<---- [0x00 0x00] ----------------|  EOF marker
  |<---- "STREAM_DONE ...\n" --------|  Text status line
  |                                  |
```

During streaming, `stdio_usb` is disabled. The send loop on Core 0 uses `processUSBInputDirect()` (TinyUSB direct reads) to check for stop commands. Core 1 handles compression in parallel.

---

## 9. Firmware Build Variants

The `BOARD_NAME` and feature set vary by build target (`LogicAnalyzer_Board_Settings.h`):

| Build Define | Board Name | WiFi | Complex Trigger | Max Channels | Buffer |
|-------------|------------|------|-----------------|-------------|--------|
| `BUILD_PICO` | PICO | No | Yes | 24 | 128 KB |
| `BUILD_PICO_2` | PICO_2 | No | Yes | 24 | 384 KB |
| `BUILD_PICO_W` | W | No | Yes | 24 | 128 KB |
| `BUILD_PICO_W_WIFI` | WIFI | Yes | Yes | 24 | 128 KB |
| `BUILD_PICO_2_W` | 2_W | No | Yes | 24 | 384 KB |
| `BUILD_PICO_2_W_WIFI` | 2_WIFI | Yes | Yes | 24 | 384 KB |
| `BUILD_ZERO` | ZERO | No | Yes | 24 | 128 KB |
| `BUILD_INTERCEPTOR` | INTERCEPTOR | No | Yes | 28 | 128 KB |

Non-WiFi builds respond to commands `0x02` and `0x03` with `ERR_UNSUPPORTED\n`.

---

## 10. Key Implementation Files

| File | Role |
|------|------|
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c` | Main loop, frame parsing, command dispatch, USB/WiFi I/O |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h` | C struct definitions for all request/response types |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c` | Streaming mode: PIO/DMA setup, Core 1 compression, send loop |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.h` | Stream API declarations |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Capture.h` | Capture API declarations (simple, complex, fast, blast) |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_WiFi.c` | WiFi Core 1 loop: TCP server, lwIP callbacks, event handling |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_WiFi.h` | WiFi state machine enum |
| `Firmware/LogicAnalyzer_V2/Event_Machine.h` | Inter-core event queue mechanism |
| `Firmware/LogicAnalyzer_V2/Shared_Buffers.h` | Shared variables between cores (WiFi settings, event machines) |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Board_Settings.h` | Per-board compile-time configuration |
| `Software/Web/src/core/protocol/commands.js` | Command byte constants, framing constants |
| `Software/Web/src/core/protocol/packets.js` | `OutputPacket` (framing/escaping), `buildCaptureRequest()`, `buildStreamRequest()` |
| `Software/Web/src/core/protocol/parser.js` | Response parsers: init handshake, capture data, generic response lines |
| `Software/Web/src/core/transport/serial.js` | `SerialTransport` -- Web Serial API implementation |
| `Software/Web/src/core/transport/types.js` | `ITransport` interface definition |
| `Software/Web/src/core/driver/analyzer.js` | `AnalyzerDriver` -- high-level driver orchestrating commands and responses |
| `Software/Web/src/core/compression/decoder.js` | Stream chunk decompression (nibble-encoded per-channel bitstreams) |

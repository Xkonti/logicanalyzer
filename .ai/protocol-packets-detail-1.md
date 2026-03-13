# LogicAnalyzer V2 Communication Protocol Reference

This document is the definitive reference for the binary communication protocol between the LogicAnalyzer V2 firmware (running on Raspberry Pi Pico 2W) and the software client (web or desktop).

---

## Table of Contents

1. [Transport Layer](#1-transport-layer)
2. [Packet Framing](#2-packet-framing)
3. [Command Codes](#3-command-codes)
4. [Response Format](#4-response-format)
5. [Command Details](#5-command-details)
   - [0x00 Device Init](#0x00-device-init)
   - [0x01 Start Capture](#0x01-start-capture)
   - [0x02 Network Config](#0x02-network-config-wifi-only)
   - [0x03 Voltage Status](#0x03-voltage-status-wifi-only)
   - [0x04 Enter Bootloader](#0x04-enter-bootloader)
   - [0x05 Blink LED On](#0x05-blink-led-on)
   - [0x06 Blink LED Off](#0x06-blink-led-off)
   - [0x0A Start Stream](#0x0a-start-stream)
   - [0x0B Stop Stream](#0x0b-stop-stream)
   - [0xFF Stop Capture](#0xff-stop-capture)
6. [Capture Data Transfer](#6-capture-data-transfer)
7. [Streaming Data Transfer](#7-streaming-data-transfer)
8. [Stream Compression Format](#8-stream-compression-format)
9. [Firmware Struct Definitions](#9-firmware-struct-definitions)
10. [Sequence Diagrams](#10-sequence-diagrams)
11. [WiFi-Specific Protocol Details](#11-wifi-specific-protocol-details)
12. [Error Responses](#12-error-responses)

---

## 1. Transport Layer

The protocol operates over two possible transports:

### USB Serial (CDC)
- Baud rate: 115200
- USB Vendor ID: `0x1209`
- USB Product ID: `0x3020`
- Software receive buffer: 1,048,576 bytes (1 MB) -- the Web Serial API default of 255 bytes is insufficient
- RTS/DTR signals are set to `true` on connection
- After opening the port, the software waits 200ms then drains any pending boot messages

### WiFi (TCP)
- The firmware runs a TCP server on the Pico 2W's CYW43 WiFi module
- Connection settings (AP name, password, static IP, port, hostname) are stored in flash
- TCP operates on a configurable port (stored in `WIFI_SETTINGS.port`)
- The WiFi module runs on Core 1 of the RP2350, communicating with the main firmware on Core 0 via an inter-core event queue
- Data is chunked into 32-byte events when crossing the inter-core boundary
- When a WiFi client connects, USB input processing is disabled; when it disconnects, USB is re-enabled

---

## 2. Packet Framing

### Host-to-Device (Request Packets)

All commands from the host to the device are framed as binary packets with byte-stuffing. The firmware receives data byte-by-byte and assembles packets in a 160-byte `messageBuffer`.

#### Frame Structure

```
[HEADER] [ESCAPED PAYLOAD] [FOOTER]
```

| Field | Bytes | Value | Description |
|-------|-------|-------|-------------|
| Header | 2 | `0x55 0xAA` | Start-of-frame marker |
| Payload | variable | escaped bytes | Command byte + optional data |
| Footer | 2 | `0xAA 0x55` | End-of-frame marker |

#### Byte-Stuffing (Escaping)

Three byte values are reserved and must be escaped within the payload:

| Byte | Escaped As | XOR Operation |
|------|-----------|---------------|
| `0x55` | `0xF0 0xA5` | `0x55 ^ 0xF0 = 0xA5` |
| `0xAA` | `0xF0 0x5A` | `0xAA ^ 0xF0 = 0x5A` |
| `0xF0` | `0xF0 0x00` | `0xF0 ^ 0xF0 = 0x00` |

**Escaping rule:** If a payload byte is `0x55`, `0xAA`, or `0xF0`, it is replaced by a two-byte sequence: the escape byte `0xF0` followed by the original byte XORed with `0xF0`.

**Unescaping (firmware side):** After detecting the footer `0xAA 0x55`, the firmware walks the buffer. When it encounters `0xF0`, it replaces it and the next byte with `next_byte ^ 0xF0`, compacting the buffer in place.

#### Payload Structure

After unescaping, the payload has this layout:

| Offset | Size | Description |
|--------|------|-------------|
| 0 | 1 | Command byte (see [Command Codes](#3-command-codes)) |
| 1 | variable | Command-specific data (struct bytes) |

Note: The firmware accesses the command byte at `messageBuffer[2]` (offsets 0-1 are the header bytes) and the data starts at `messageBuffer[3]`.

#### Maximum Packet Size

The firmware's `messageBuffer` is 160 bytes. This limits the maximum unescaped payload to approximately 156 bytes (160 minus header and footer). The largest payload is the `WIFI_SETTINGS_REQUEST` at 148 bytes.

### Device-to-Host (Response Messages)

The firmware uses **two different response formats** depending on the context:

1. **Text responses:** Newline-terminated ASCII strings sent via `printf()` (USB) or WiFi event queue. Used for command acknowledgments and error messages.
2. **Binary responses:** Raw byte streams sent via `cdc_transfer()` (USB) or `wifi_transfer()` (WiFi). Used for capture data and streaming data. These are **NOT** framed with the `0x55 0xAA` / `0xAA 0x55` envelope.

---

## 3. Command Codes

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| `0x00` | `CMD_DEVICE_INIT` | Host -> Device | Request device identification and capabilities |
| `0x01` | `CMD_START_CAPTURE` | Host -> Device | Start a trigger-based capture session |
| `0x02` | `CMD_NETWORK_CONFIG` | Host -> Device | Update WiFi settings (WiFi builds only) |
| `0x03` | `CMD_VOLTAGE_STATUS` | Host -> Device | Request power/voltage status (WiFi only) |
| `0x04` | `CMD_ENTER_BOOTLOADER` | Host -> Device | Reboot into USB bootloader mode |
| `0x05` | `CMD_BLINK_LED_ON` | Host -> Device | Start LED blinking |
| `0x06` | `CMD_BLINK_LED_OFF` | Host -> Device | Stop LED blinking |
| `0x0A` | `CMD_START_STREAM` | Host -> Device | Start real-time streaming capture |
| `0x0B` | `CMD_STOP_STREAM` | Host -> Device | Stop streaming capture |
| `0xFF` | `CMD_STOP_CAPTURE` | Host -> Device | Cancel an active capture (raw byte, NOT framed) |

---

## 4. Response Format

All text responses are ASCII strings terminated by `\n` (line feed, 0x0A). The software strips any trailing `\r` (0x0D) before processing.

---

## 5. Command Details

### 0x00 Device Init

Requests the device identity and capabilities. No command data beyond the command byte.

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x00` | Command byte |

Total unescaped payload: 1 byte. Total framed packet: 5 bytes (header 2 + payload 1 + footer 2). The firmware validates `bufferPos == 5` for this command.

#### Response

The firmware sends 5 newline-terminated text lines in sequence:

| Line | Format | Example | Description |
|------|--------|---------|-------------|
| 1 | `LOGIC_ANALYZER_{BOARD}_{VERSION}` | `LOGIC_ANALYZER_2_WIFI_V6_5` | Device name with board type and firmware version |
| 2 | `FREQ:{maxFreq}` | `FREQ:100000000` | Maximum capture frequency in Hz |
| 3 | `BLASTFREQ:{blastFreq}` | `BLASTFREQ:200000000` | Maximum blast mode frequency in Hz |
| 4 | `BUFFER:{bufSize}` | `BUFFER:393216` | Capture buffer size in bytes |
| 5 | `CHANNELS:{chanCount}` | `CHANNELS:24` | Maximum number of capture channels |

**Board names by build target:**
- `BUILD_PICO` -> `PICO`
- `BUILD_PICO_2` -> `PICO_2`
- `BUILD_PICO_W` -> `W`
- `BUILD_PICO_W_WIFI` -> `WIFI`
- `BUILD_PICO_2_W` -> `2_W`
- `BUILD_PICO_2_W_WIFI` -> `2_WIFI`
- `BUILD_ZERO` -> `ZERO`
- `BUILD_INTERCEPTOR` -> `INTERCEPTOR`

**Version validation (software side):** The version string is parsed with regex `.*?V(\d+)_(\d+)$`. The minimum required version is `V6_5` (major >= 6, minor >= 5 when major == 6).

---

### 0x01 Start Capture

Starts a trigger-based capture. The device waits for the configured trigger condition, captures pre-trigger and post-trigger samples, then transfers the complete buffer.

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x01` | Command byte |
| 1-56 | 56 | CAPTURE_REQUEST | struct | Capture parameters (see below) |

#### CAPTURE_REQUEST Struct (56 bytes, little-endian, natural alignment)

| Offset | Size | Type | Field | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `triggerType` | 0=Edge, 1=Complex, 2=Fast, 3=Blast |
| 1 | 1 | uint8 | `triggerChannel` | Trigger pin number (or base pin for pattern triggers) |
| 2 | 1 | uint8 | `invertedOrCount` | Edge/Blast: inverted flag (0/1). Complex/Fast: bit count |
| 3 | 1 | -- | padding | Alignment padding before uint16 |
| 4 | 2 | uint16 LE | `triggerValue` | Pattern trigger value (Complex/Fast only) |
| 6 | 32 | uint8[32] | `channels` | Channel pin numbers, zero-padded |
| 38 | 1 | uint8 | `channelCount` | Number of active channels |
| 39 | 1 | -- | padding | Alignment padding before uint32 |
| 40 | 4 | uint32 LE | `frequency` | Sampling frequency in Hz |
| 44 | 4 | uint32 LE | `preSamples` | Samples to store before trigger |
| 48 | 4 | uint32 LE | `postSamples` | Samples to store after trigger |
| 52 | 2 | uint16 LE | `loopCount` | Number of capture loops (burst mode) |
| 54 | 1 | uint8 | `measure` | Measure burst timing: 0=no, 1=yes |
| 55 | 1 | uint8 | `captureMode` | 0=8ch, 1=16ch, 2=24ch |

#### Trigger Types

| Value | Name | Description |
|-------|------|-------------|
| 0 | Edge | Simple edge trigger on a single pin. `invertedOrCount` = inverted flag |
| 1 | Complex | Pattern trigger using up to 16 consecutive pins. `triggerChannel` = base pin, `invertedOrCount` = pin count, `triggerValue` = pattern to match |
| 2 | Fast | Fast pattern trigger using up to 5 consecutive pins. Same fields as Complex but lower latency |
| 3 | Blast | Full-speed capture triggered by edge on a single pin. No pre-samples. `frequency` must equal `blastFrequency` |

#### Capture Modes

| Value | Name | Bytes/Sample | GPIO Bits |
|-------|------|-------------|-----------|
| 0 | 8-channel | 1 | bits 0-7 |
| 1 | 16-channel | 2 | bits 0-15 |
| 2 | 24-channel | 4 | bits 0-23 (stored in 32-bit words) |

The capture mode is determined by the highest channel number in the `channels` array: channels 0-7 -> 8ch mode, 8-15 -> 16ch mode, 16-23 -> 24ch mode.

#### Response

One text line:
- `CAPTURE_STARTED\n` -- capture is now waiting for trigger
- `CAPTURE_ERROR\n` -- capture could not be started (invalid parameters, unsupported trigger type)
- `ERR_BUSY\n` -- streaming is already active

After `CAPTURE_STARTED`, the firmware enters capture mode. The device LED blinks while waiting for the trigger. Once the trigger fires and all samples are captured, the binary capture data is transferred (see [Capture Data Transfer](#6-capture-data-transfer)).

---

### 0x02 Network Config (WiFi Only)

Updates the WiFi configuration stored in flash. Only available on WiFi-enabled firmware builds.

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x02` | Command byte |
| 1-148 | 148 | WIFI_SETTINGS_REQUEST | struct | WiFi settings |

#### WIFI_SETTINGS_REQUEST Struct (148 bytes)

| Offset | Size | Type | Field | Description |
|--------|------|------|-------|-------------|
| 0 | 33 | char[33] | `apName` | WiFi AP/SSID name (null-terminated) |
| 33 | 64 | char[64] | `passwd` | WiFi password (null-terminated) |
| 97 | 16 | char[16] | `ipAddress` | Static IP address string (null-terminated, e.g., "192.168.1.100") |
| 113 | 2 | uint16 LE | `port` | TCP server port number |
| 115 | 33 | char[33] | `hostname` | mDNS hostname (null-terminated) |

The firmware computes a checksum over all fields: sum of all bytes in `apName[0..32]`, `passwd[0..63]`, `ipAddress[0..15]`, `port`, `hostname[0..32]`, plus the constant `0x0F0F`. This checksum is stored alongside the settings in flash as `WIFI_SETTINGS.checksum` and validated on boot to detect corrupt/uninitialized flash.

#### Response

- `SETTINGS_SAVED\n` -- settings stored to flash, WiFi will reconnect
- `ERR_UNSUPPORTED\n` -- non-WiFi firmware build

---

### 0x03 Voltage Status (WiFi Only)

Requests the battery/power status. Only works over WiFi connections.

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x03` | Command byte |

#### Response

If called over WiFi, the response is a text line:
```
{voltage}_{vbus}\n
```
- `{voltage}`: VSYS voltage as a decimal string (e.g., `4.85`)
- `{vbus}`: `1` if USB VBUS is connected, `0` if running on battery

Example: `4.85_1\n`

If called over USB: `ERR_UNSUPPORTED\n`

---

### 0x04 Enter Bootloader

Reboots the device into USB bootloader mode for firmware updates.

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x04` | Command byte |

#### Response

`RESTARTING_BOOTLOADER\n`

The device waits 1 second, then calls `reset_usb_boot()`. The USB connection will be lost.

---

### 0x05 Blink LED On

Starts LED blinking (for device identification).

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x05` | Command byte |

#### Response

`BLINKON\n`

The LED toggles on/off in the main loop at approximately 2-3 Hz.

---

### 0x06 Blink LED Off

Stops LED blinking and turns the LED on (steady state).

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x06` | Command byte |

#### Response

`BLINKOFF\n`

---

### 0x0A Start Stream

Starts a real-time streaming capture with on-device compression.

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x0A` | Command byte |
| 1-40 | 40 | STREAM_REQUEST | struct | Streaming parameters |

#### STREAM_REQUEST Struct (40 bytes, little-endian, natural alignment)

| Offset | Size | Type | Field | Description |
|--------|------|------|-------|-------------|
| 0 | 32 | uint8[32] | `channels` | Channel pin numbers, zero-padded |
| 32 | 1 | uint8 | `channelCount` | Number of channels (1-24) |
| 33 | 1 | -- | padding | Alignment padding before uint16 |
| 34 | 2 | uint16 LE | `chunkSamples` | Samples per chunk (32-1024, multiple of 32) |
| 36 | 4 | uint32 LE | `frequency` | Sampling frequency in Hz |

#### Response

**Text handshake** (one line):
- `STREAM_STARTED\n` -- streaming has begun
- `STREAM_ERROR\n` -- could not start streaming
- `ERR_BUSY\n` -- capture or streaming already active
- `ERR_PARAMS\n` -- invalid channel count

**Binary info header** (immediately after `STREAM_STARTED\n`, 8 bytes):

| Offset | Size | Type | Field | Description |
|--------|------|------|-------|-------------|
| 0 | 2 | uint16 LE | `chunkSamples` | Actual chunk size in samples (may be clamped/rounded) |
| 2 | 1 | uint8 | `numChannels` | Number of active channels |
| 3 | 1 | uint8 | reserved | Always 0 |
| 4 | 4 | uint32 LE | `actualFrequency` | Actual PIO sample rate after clock divider clamping |

After the info header, the device begins sending compressed stream chunks continuously (see [Streaming Data Transfer](#7-streaming-data-transfer)).

---

### 0x0B Stop Stream

Signals the device to stop streaming. This is a framed packet (uses the standard `0x55 0xAA` / `0xAA 0x55` envelope).

#### Request Packet (after unescaping)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 1 | uint8 | `0x0B` | Command byte |

#### Response

The device processes this command during its stream send loop. It sets the `streaming` flag to false, which causes the send loop to exit gracefully. The stream EOF marker and status line are then sent (see [Streaming Data Transfer](#7-streaming-data-transfer)).

Note: During streaming, the firmware receives and processes incoming framed packets via `processUSBInputDirect()` (which bypasses stdio since it is disabled during streaming).

---

### 0xFF Stop Capture

Cancels an active capture that is waiting for a trigger. This is a **raw byte** -- it is NOT wrapped in the standard frame envelope.

#### Request

A single raw byte `0xFF` is sent directly on the wire.

#### Behavior

The firmware treats any incoming data during capture wait as a cancel signal (via `processCancel()` which calls `processUSBInput(true)` -- the `true` means "skip processing, just detect activity"). The specific byte value does not matter; any incoming data cancels the capture.

After cancellation, the software waits 2 seconds, disconnects, and reconnects the transport to reset state.

#### Response

None. The firmware calls `StopCapture()`, resets the `capturing` flag, and returns to the idle main loop. The software must reconnect to re-establish communication.

---

## 6. Capture Data Transfer

After a successful capture (trigger fired, all samples collected), the firmware transfers the captured data as a raw binary stream. This data is NOT framed -- it flows directly over the USB CDC or WiFi TCP connection.

The firmware disables `stdio_usb` before transfer and uses direct `cdc_transfer()` to avoid conflicts with the TinyUSB background task.

### Transfer Sequence

#### Step 1: Sample Count (4 bytes)

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 4 | uint32 LE | Total number of samples captured |

Note: This is the sample count, not byte count. The byte count depends on the capture mode.

#### Step 2: Sample Data (variable)

Raw sample bytes, `sampleCount * bytesPerSample` total:

| Capture Mode | Bytes/Sample | Data Layout |
|-------------|-------------|-------------|
| 8-channel (0) | 1 | Each byte = 8 channel states |
| 16-channel (1) | 2 | Each uint16 LE = 16 channel states |
| 24-channel (2) | 4 | Each uint32 LE = 24 channel states (upper 8 bits unused) |

The sample buffer is a circular buffer. The firmware handles wrap-around internally -- the software receives a contiguous linear stream of `sampleCount * bytesPerSample` bytes.

#### Step 3: Timestamp Flag (1 byte)

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 1 | uint8 | Number of timestamp entries. 0 or 1 = no timestamps. >1 = has timestamps |

#### Step 4: Timestamps (conditional)

Only sent if `stampLength > 1`:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | `stampLength * 4` | uint32 LE[] | SysTick timestamp values |

The number of timestamp entries is `loopCount + 2` (one sync timestamp, one per burst end, one final). Each timestamp is a raw SysTick counter value from a 200MHz clock. The lower 24 bits count down and must be inverted during processing: `(raw & 0xFF000000) | (0x00FFFFFF - (raw & 0x00FFFFFF))`.

### Timing Gaps

After sending the sample count, the firmware inserts:
- 100ms delay (USB) or 2000ms delay (WiFi) before sample data
- 100ms delay after sample count before the main data transfer

---

## 7. Streaming Data Transfer

Once streaming starts (after the `STREAM_STARTED` handshake and 8-byte info header), the device continuously sends compressed data chunks until streaming stops.

### Chunk Transfer Format

Each chunk is prefixed with its compressed size:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 2 | uint16 LE | Compressed chunk size in bytes |
| 2 | N | uint8[N] | Compressed chunk data |

The software reads the 2-byte size, then reads exactly that many bytes of compressed data. It then decompresses the chunk (see [Stream Compression Format](#8-stream-compression-format)).

### EOF Marker

When streaming ends (stop command, overflow, disconnect, or timeout), the firmware sends:

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 2 | uint16 LE | `0x0000` | EOF marker (compressed size = 0) |

### Termination Status Line

Immediately after the EOF marker, a text status line is sent:

```
STREAM_{REASON} DMA={dmaCount} CMP={cmpCount} SEND={sendCount} LOOP={loopCount} CONN={connAtEntry}/{connNow} CHUNKS={chunkSamples} FREQ={actualFreq}\n
```

Where `{REASON}` is one of:
- `DONE` -- normal stop (via `CMD_STOP_STREAM`)
- `OVERFLOW` -- ring buffer overflow (DMA producing faster than USB can transmit)
- `DISCONN` -- USB disconnection detected
- `TIMEOUT` -- no data produced within 3 seconds

Diagnostic fields:
- `DMA` -- total DMA-completed slot count
- `CMP` -- total compressed slot count (Core 1)
- `SEND` -- total sent slot count (Core 0)
- `LOOP` -- main loop iteration count
- `CONN` -- CDC connection status at entry and at exit (1/0)
- `CHUNKS` -- chunk sample size
- `FREQ` -- actual PIO sampling frequency

### Ring Buffer Architecture

The streaming system uses an 8-slot ring buffer:

| Constant | Value | Description |
|----------|-------|-------------|
| `STREAM_SLOTS` | 8 | Number of ring buffer slots |
| `STREAM_MAX_CHUNK` | 1024 | Maximum samples per chunk |
| `STREAM_INPUT_SLOT_SIZE` | 4096 | Bytes per input slot (worst case: 1024 samples * 4 bytes) |
| `STREAM_OUTPUT_SLOT_SIZE` | 3080 | Bytes per output slot (max compressed size) |

Pipeline:
1. **DMA (ISR):** Two chained DMA channels ping-pong write raw PIO data into ring buffer input slots. Increments `dma_complete_count`.
2. **Core 1 (compression):** Reads completed input slots, compresses via `stream_compress_chunk_mapped()`, writes to output slots. Increments `compress_head`.
3. **Core 0 (send loop):** Reads completed output slots, sends 2-byte size prefix + compressed data over USB/WiFi. Increments `send_head`.

Overflow is detected when `dma_complete_count - send_head >= STREAM_SLOTS - 1`.

---

## 8. Stream Compression Format

Each compressed chunk contains a per-channel header followed by per-channel encoded data.

### Chunk Layout

```
[HEADER: ceil(numChannels/4) bytes] [channel 0 data] [channel 1 data] ... [channel N-1 data]
```

### Header

The header uses 2 bits per channel, packed LSB-first into bytes:

| Bits | Position | Description |
|------|----------|-------------|
| `[1:0]` of byte 0 | Channel 0 | Mode for channel 0 |
| `[3:2]` of byte 0 | Channel 1 | Mode for channel 1 |
| `[5:4]` of byte 0 | Channel 2 | Mode for channel 2 |
| `[7:6]` of byte 0 | Channel 3 | Mode for channel 3 |
| `[1:0]` of byte 1 | Channel 4 | Mode for channel 4 |
| ... | ... | ... |

Header size: `ceil(numChannels / 4)` bytes.

### Channel Mode Codes (2 bits)

| Value | Name | Data Size | Description |
|-------|------|----------|-------------|
| `0x00` | `HDR_RAW` | `chunkSamples/8` bytes | Raw transposed bitstream (no compression) |
| `0x01` | `HDR_ALL_ZERO` | 0 bytes | All samples are 0 (constant low) |
| `0x02` | `HDR_ALL_ONE` | 0 bytes | All samples are 1 (constant high) |
| `0x03` | `HDR_NIBBLE_ENC` | variable | Nibble-encoded compressed data |

### Raw Mode (`HDR_RAW`)

The channel's transposed bitstream is copied verbatim. Each byte contains 8 consecutive samples for this channel, LSB = earliest sample. Total: `chunkSamples / 8` bytes.

### Nibble Encoding (`HDR_NIBBLE_ENC`)

The transposed bitstream is treated as a sequence of 4-bit nibbles (`chunkSamples / 4` nibbles total). These are encoded using prefix codes packed MSB-first into a byte stream.

#### Nibble Prefix Codes (4 bits each)

| Code | Name | Meaning | Following Data |
|------|------|---------|---------------|
| `0x0` | `RAW1` | 1 raw nibble | 1 data nibble (4 bits) |
| `0x1` | `RAW2` | 2 raw nibbles | 2 data nibbles (8 bits) |
| `0x2` | `RAW3` | 3 raw nibbles | 3 data nibbles (12 bits) |
| `0x3` | `RAW6` | 6 raw nibbles | 6 data nibbles (24 bits) |
| `0x4` | `RAW4` | 4 raw nibbles | 4 data nibbles (16 bits) |
| `0x5` | `RAW8` | 8 raw nibbles | 8 data nibbles (32 bits) |
| `0x6` | `ZERO2` | 2 zero nibbles | none |
| `0x7` | `ZERO4` | 4 zero nibbles | none |
| `0x8` | `ZERO8` | 8 zero nibbles | none |
| `0x9` | `ZERO16` | 16 zero nibbles | none |
| `0xA` | `ZERO32` | 32 zero nibbles | none |
| `0xB` | `ONE2` | 2 all-ones nibbles | none |
| `0xC` | `ONE4` | 4 all-ones nibbles | none |
| `0xD` | `ONE8` | 8 all-ones nibbles | none |
| `0xE` | `ONE16` | 16 all-ones nibbles | none |
| `0xF` | `ONE32` | 32 all-ones nibbles | none |

#### Bit Packing

Nibbles are packed MSB-first into bytes using a bit accumulator:
- First nibble goes into bits [7:4] of the output byte
- Second nibble goes into bits [3:0]
- If the total number of nibbles is odd, the final byte is left-shifted to fill the MSB

#### Nibble-to-Byte Repacking (Decoder)

After decoding the nibble stream, the decoder repacks nibbles into transposed bytes in little-endian nibble order:
```
byte[j] = (nibble[2*j+1] << 4) | nibble[2*j]
```

### Bit Transpose

Before compression, interleaved DMA samples are transposed into per-channel bitstreams using an 8x8 delta-swap butterfly algorithm. Each group of 8 samples is transposed: rows (samples) become columns (channels). The result for each channel is a bitstream where bit `k` in the byte at index `k/8` represents sample `k`.

---

## 9. Firmware Struct Definitions

Source: `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h`

### CAPTURE_REQUEST

```c
typedef struct _CAPTURE_REQUEST {
    uint8_t  triggerType;      // 0=edge, 1=complex, 2=fast, 3=blast
    uint8_t  trigger;          // trigger channel (or base channel)
    union {
        uint8_t inverted;      // edge/blast: inverted flag
        uint8_t count;         // complex/fast: pin count
    };
    uint16_t triggerValue;     // pattern trigger value
    uint8_t  channels[32];    // channel pin numbers
    uint8_t  channelCount;     // number of active channels
    uint32_t frequency;        // sampling frequency in Hz
    uint32_t preSamples;       // pre-trigger sample count
    uint32_t postSamples;      // post-trigger sample count
    uint16_t loopCount;        // burst loop count
    uint8_t  measure;          // measure burst timing (0/1)
    uint8_t  captureMode;      // 0=8ch, 1=16ch, 2=24ch
} CAPTURE_REQUEST;
```

### STREAM_REQUEST

```c
typedef struct _STREAM_REQUEST {
    uint8_t  channels[32];    // channel pin numbers
    uint8_t  channelCount;     // 1-24
    uint16_t chunkSamples;     // 32-1024, multiple of 32
    uint32_t frequency;        // sampling frequency in Hz
} STREAM_REQUEST;
```

### WIFI_SETTINGS

```c
typedef struct _WIFI_SETTINGS {
    char     apName[33];
    char     passwd[64];
    char     ipAddress[16];
    uint16_t port;
    char     hostname[33];
    uint16_t checksum;         // validation checksum
} WIFI_SETTINGS;
```

### WIFI_SETTINGS_REQUEST

```c
typedef struct _WIFI_SETTINGS_REQUEST {
    char     apName[33];
    char     passwd[64];
    char     ipAddress[16];
    uint16_t port;
    char     hostname[33];
} WIFI_SETTINGS_REQUEST;
```

### POWER_STATUS

```c
typedef struct _POWER_STATUS {
    float vsysVoltage;     // VSYS rail voltage
    bool  vbusConnected;   // USB VBUS present
} POWER_STATUS;
```

### CHANNEL_MODE (enum)

```c
typedef enum {
    MODE_8_CHANNEL,   // 0
    MODE_16_CHANNEL,  // 1
    MODE_24_CHANNEL   // 2
} CHANNEL_MODE;
```

---

## 10. Sequence Diagrams

### Connect and Device Initialization

```
Software                              Firmware
   |                                     |
   |--- USB CDC open (115200 baud) ----->|
   |--- Set RTS=true, DTR=true -------->|
   |--- Wait 200ms -------------------->|
   |--- Drain pending boot data -------->|
   |                                     |
   |--- [0x55 0xAA] [0x00] [0xAA 0x55] ->|  CMD_DEVICE_INIT
   |                                     |
   |<-- "LOGIC_ANALYZER_..._V6_5\n" ----|  Version string
   |<-- "FREQ:100000000\n" -------------|  Max frequency
   |<-- "BLASTFREQ:200000000\n" --------|  Blast frequency
   |<-- "BUFFER:393216\n" --------------|  Buffer size
   |<-- "CHANNELS:24\n" ----------------|  Channel count
   |                                     |
```

### Start and Receive Capture (Edge Trigger)

```
Software                              Firmware
   |                                     |
   |--- [0x55 0xAA] [0x01] [56-byte   ->|  CMD_START_CAPTURE
   |     CAPTURE_REQUEST] [0xAA 0x55]    |
   |                                     |
   |<-- "CAPTURE_STARTED\n" ------------|  Ack
   |                                     |
   |    (firmware waits for trigger,     |
   |     LED blinks during wait)         |
   |                                     |
   |    ... trigger fires ...            |
   |    ... pre+post samples captured .. |
   |                                     |
   |<-- [uint32 LE: sampleCount] -------|  4 bytes: sample count
   |                                     |
   |    (100ms delay)                    |
   |                                     |
   |<-- [raw sample data] --------------|  sampleCount * bytesPerSample
   |<-- [uint8: stampLength] ------------|  1 byte: timestamp count
   |<-- [uint32 LE[]: timestamps] ------|  (only if stampLength > 1)
   |                                     |
```

### Cancel Capture

```
Software                              Firmware
   |                                     |
   |    (capture waiting for trigger)    |
   |                                     |
   |--- [0xFF] (raw, unframed) -------->|  Any data = cancel
   |                                     |
   |    (firmware calls StopCapture())   |
   |                                     |
   |--- Wait 2000ms ------------------->|
   |--- Disconnect transport ---------->|
   |--- Reconnect transport ----------->|
   |                                     |
```

### Start Streaming

```
Software                              Firmware
   |                                     |
   |--- [0x55 0xAA] [0x0A] [40-byte   ->|  CMD_START_STREAM
   |     STREAM_REQUEST] [0xAA 0x55]     |
   |                                     |
   |    (firmware sets up PIO, DMA,      |
   |     launches Core 1 compressor,     |
   |     disables stdio_usb)             |
   |                                     |
   |<-- "STREAM_STARTED\n" -------------|  Text handshake
   |<-- [8-byte info header] ------------|  Binary: chunkSamples, numChannels, freq
   |                                     |
   |<-- [uint16 LE: size] [compressed] --|  Chunk 1
   |<-- [uint16 LE: size] [compressed] --|  Chunk 2
   |<-- [uint16 LE: size] [compressed] --|  Chunk 3
   |    ...                              |
   |                                     |
```

### Stop Streaming

```
Software                              Firmware
   |                                     |
   |    (stream chunks flowing...)       |
   |                                     |
   |--- [0x55 0xAA] [0x0B] [0xAA 0x55] ->|  CMD_STOP_STREAM
   |                                     |
   |    (firmware sets streaming=false)   |
   |                                     |
   |<-- [remaining chunks] -------------|  Flush pending chunks
   |<-- [0x00 0x00] --------------------|  EOF marker (size=0)
   |<-- "STREAM_DONE DMA=... \n" -------|  Termination status
   |                                     |
   |    (firmware cleans up PIO, DMA,    |
   |     re-enables stdio_usb)           |
   |                                     |
```

### WiFi Connection Flow

```
WiFi Core (Core 1)                     Main Firmware (Core 0)
   |                                     |
   |  cyw43_arch_init()                  |
   |  enable STA mode                    |
   |                                     |
   |--- CYW_READY event --------------->|
   |                                     |
   |  Validate flash settings            |
   |  Connect to AP                      |
   |  Set static IP                      |
   |  Start TCP server                   |
   |                                     |
   |  ... TCP client connects ...        |
   |                                     |
   |--- CONNECTED event --------------->|  (disables USB input)
   |                                     |
   |  ... TCP data received ...          |
   |                                     |
   |--- DATA_RECEIVED event ----------->|  (processData with fromWiFi=true)
   |                                     |
   |<-- SEND_DATA event ----------------|  (response data, 32 bytes at a time)
   |                                     |
   |  ... TCP client disconnects ...     |
   |                                     |
   |--- DISCONNECTED event ------------>|  (re-enables USB input)
   |                                     |
```

### LED Blink

```
Software                              Firmware
   |                                     |
   |--- [0x55 0xAA] [0x05] [0xAA 0x55] ->|  CMD_BLINK_LED_ON
   |<-- "BLINKON\n" --------------------|
   |                                     |
   |    (LED toggles in main loop)       |
   |                                     |
   |--- [0x55 0xAA] [0x06] [0xAA 0x55] ->|  CMD_BLINK_LED_OFF
   |<-- "BLINKOFF\n" -------------------|
   |                                     |
```

### Enter Bootloader

```
Software                              Firmware
   |                                     |
   |--- [0x55 0xAA] [0x04] [0xAA 0x55] ->|  CMD_ENTER_BOOTLOADER
   |<-- "RESTARTING_BOOTLOADER\n" ------|
   |                                     |
   |    (1 second delay)                 |
   |    (firmware calls reset_usb_boot)  |
   |    (USB connection lost)            |
   |                                     |
```

---

## 11. WiFi-Specific Protocol Details

### WiFi State Machine

The WiFi module on Core 1 runs a state machine:

| State | Description |
|-------|-------------|
| `VALIDATE_SETTINGS` | Read flash settings, verify checksum |
| `WAITING_SETTINGS` | No valid settings found; waiting for USB-delivered config |
| `CONNECTING_AP` | Attempting WPA2 connection to configured AP |
| `STARTING_TCP_SERVER` | Binding TCP server to configured IP:port |
| `WAITING_TCP_CLIENT` | Listening for incoming TCP connections (backlog=1) |
| `TCP_CLIENT_CONNECTED` | Active TCP session; processing protocol data |

### WiFi Events (Core 1 -> Core 0)

| Event | Payload | Description |
|-------|---------|-------------|
| `CYW_READY` | none | CYW43 module initialized, ready for operation |
| `CONNECTED` | none | TCP client connected; USB input disabled |
| `DISCONNECTED` | none | TCP client disconnected; USB input re-enabled |
| `DATA_RECEIVED` | up to 128 bytes | Raw protocol data from TCP client |
| `POWER_STATUS_DATA` | `POWER_STATUS` struct | ADC voltage reading + VBUS state |

### Frontend Events (Core 0 -> Core 1)

| Event | Payload | Description |
|-------|---------|-------------|
| `LED_ON` | none | Turn on CYW43 GPIO LED |
| `LED_OFF` | none | Turn off CYW43 GPIO LED |
| `CONFIG_RECEIVED` | none | WiFi settings changed; trigger reconnect |
| `SEND_DATA` | up to 32 bytes | Protocol response data to send to TCP client |
| `GET_POWER_STATUS` | none | Request ADC voltage reading |

### WiFi Data Chunking

When sending large binary data over WiFi (capture data, stream chunks), the firmware chunks it into 32-byte `SEND_DATA` events via `wifi_transfer()`. The WiFi module reassembles and sends these over TCP using `tcp_write()`.

When receiving data, the WiFi module delivers up to 128 bytes per `DATA_RECEIVED` event via `pbuf_copy_partial()`.

### WiFi Capture Timing

WiFi transfers have a 2000ms initial delay (vs. 100ms for USB) before sending capture sample data, to allow the TCP connection to stabilize.

---

## 12. Error Responses

All error responses are newline-terminated text strings.

| Response | Cause |
|----------|-------|
| `ERR_MSG_OVERFLOW\n` | Received packet exceeded the 160-byte message buffer |
| `ERR_UNKNOWN_MSG\n` | Unrecognized command byte, or malformed Device Init packet |
| `ERR_BUSY\n` | Attempted to start capture while streaming, or stream while capturing |
| `ERR_UNSUPPORTED\n` | WiFi-only command sent to non-WiFi firmware, or voltage status requested over USB |
| `ERR_PARAMS\n` | Invalid stream parameters (channel count out of range) |
| `CAPTURE_ERROR\n` | Capture could not start (PIO/DMA setup failure, or unsupported trigger type on this firmware build) |
| `STREAM_ERROR\n` | Stream could not start (PIO/DMA setup failure) |

---

## Appendix A: Software Packet Builder Reference

Source: `Software/Web/src/core/protocol/packets.js`

### OutputPacket Class

The `OutputPacket` class builds framed packets:

```javascript
const pkt = new OutputPacket()
pkt.addByte(CMD_DEVICE_INIT)        // add command byte
pkt.addBytes(structBytes)            // add struct data
const wire = pkt.serialize()         // returns Uint8Array with framing + escaping
```

`serialize()` produces: `[0x55, 0xAA, ...escaped_payload..., 0xAA, 0x55]`

### buildCaptureRequest(session)

Returns a 56-byte `Uint8Array` matching the `CAPTURE_REQUEST` struct layout with proper alignment padding at offsets 3 and 39.

### buildStreamRequest(config)

Returns a 40-byte `Uint8Array` matching the `STREAM_REQUEST` struct layout with alignment padding at offset 33.

## Appendix B: Software Parser Reference

Source: `Software/Web/src/core/protocol/parser.js`

### parseInitResponse(transport)

Reads 5 text lines: version, FREQ, BLASTFREQ, BUFFER, CHANNELS. Validates version against minimum `V6_5`. Skips up to 20 non-version lines (firmware boot noise).

### parseCaptureStartResponse(transport)

Reads one text line. Caller checks for `"CAPTURE_STARTED"`.

### parseCaptureData(transport, captureMode, loopCount, measureBursts)

Reads binary capture data:
1. 4 bytes -> uint32 LE sample count
2. `sampleCount * bytesPerSample` bytes -> raw samples
3. 1 byte -> timestamp flag
4. If flag > 0 and loopCount > 0 and measureBursts: `(loopCount + 2) * 4` bytes -> timestamps

### parseResponseLine(transport, expectedResponse)

Reads one text line, returns `true` if it matches the expected string.

## Appendix C: Constants Reference

Source: `Software/Web/src/core/protocol/commands.js`

| Constant | Value | Description |
|----------|-------|-------------|
| `FRAME_HEADER_0` | `0x55` | First byte of frame header |
| `FRAME_HEADER_1` | `0xAA` | Second byte of frame header |
| `FRAME_FOOTER_0` | `0xAA` | First byte of frame footer |
| `FRAME_FOOTER_1` | `0x55` | Second byte of frame footer |
| `ESCAPE_BYTE` | `0xF0` | Escape prefix byte |
| `DEFAULT_BAUD_RATE` | `115200` | USB serial baud rate |
| `DEFAULT_BUFFER_SIZE` | `1048576` | Software receive buffer (1 MB) |
| `DEFAULT_VENDOR_ID` | `0x1209` | USB vendor ID |
| `DEFAULT_PRODUCT_ID` | `0x3020` | USB product ID |
| `MIN_MAJOR_VERSION` | `6` | Minimum firmware major version |
| `MIN_MINOR_VERSION` | `5` | Minimum firmware minor version |
| `COMPLEX_TRIGGER_DELAY` | `5` | Complex trigger delay (clock cycles) |
| `FAST_TRIGGER_DELAY` | `3` | Fast trigger delay (clock cycles) |

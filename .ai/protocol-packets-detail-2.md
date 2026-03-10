# Communication Protocol — Detailed Behavioral Documentation

This document describes the dynamic/behavioral aspects of the communication protocol between the LogicAnalyzer V2 firmware (running on Raspberry Pi Pico 2W) and the software client (web application). It covers sequence diagrams, timing constraints, exact byte sequences, flow control, and error handling.

## Table of Contents

1. [Protocol Overview](#1-protocol-overview)
2. [Frame Format and Byte Escaping](#2-frame-format-and-byte-escaping)
3. [Device Identification / Handshake](#3-device-identification--handshake)
4. [Configuring and Starting a Capture with Simple Trigger](#4-configuring-and-starting-a-capture-with-simple-trigger)
5. [Configuring and Starting a Capture with Complex Trigger](#5-configuring-and-starting-a-capture-with-complex-trigger)
6. [Receiving Capture Data After Trigger Fires](#6-receiving-capture-data-after-trigger-fires)
7. [Starting a Streaming Session](#7-starting-a-streaming-session)
8. [Receiving Streaming Data Chunks](#8-receiving-streaming-data-chunks)
9. [Stopping a Streaming Session](#9-stopping-a-streaming-session)
10. [WiFi Configuration and Connection](#10-wifi-configuration-and-connection)
11. [WiFi Event Notifications](#11-wifi-event-notifications)
12. [Error Scenarios and Recovery](#12-error-scenarios-and-recovery)
13. [Other Commands](#13-other-commands)
14. [Timing Constraints Summary](#14-timing-constraints-summary)

---

## 1. Protocol Overview

The protocol is asymmetric:

- **Software -> Firmware**: Binary framed packets with byte-stuffing
- **Firmware -> Software**: Newline-terminated ASCII strings for status/responses, raw binary for bulk data (capture samples, streaming chunks)

Communication occurs over either USB CDC (serial) or TCP over WiFi. The same protocol messages are used on both transports.

### Transport Parameters (USB Serial)

| Parameter    | Value       |
|-------------|-------------|
| Baud rate   | 115200      |
| Buffer size | 1,048,576 (1 MB) |
| USB VID     | 0x1209      |
| USB PID     | 0x3020      |
| RTS/DTR     | Both asserted on connect |

### Direction Convention

Throughout this document:
- `SW` = Software client (web app)
- `FW` = Firmware (Pico 2W)
- `-->` = data sent to firmware
- `<--` = data sent to software

---

## 2. Frame Format and Byte Escaping

### Binary Frame Structure (SW -> FW)

All commands from software to firmware use this framing:

```
+------+------+---------...--------+------+------+
| 0x55 | 0xAA | escaped payload    | 0xAA | 0x55 |
+------+------+---------...--------+------+------+
  header (2B)    variable length      footer (2B)
```

- **Start condition**: `0x55 0xAA`
- **Stop condition**: `0xAA 0x55`
- **Escape byte**: `0xF0`

### Byte-Stuffing Rules

Any payload byte that is `0x55`, `0xAA`, or `0xF0` must be escaped:

| Original byte | Escaped as         | Calculation        |
|--------------|--------------------|--------------------|
| `0x55`       | `0xF0 0xA5`        | `0x55 XOR 0xF0 = 0xA5` |
| `0xAA`       | `0xF0 0x5A`        | `0xAA XOR 0xF0 = 0x5A` |
| `0xF0`       | `0xF0 0x00`        | `0xF0 XOR 0xF0 = 0x00` |

### Payload Structure

The first byte after unescaping is the **command ID**. Remaining bytes are command-specific data.

```
payload = [command_id] [command_data...]
```

### Firmware Response Format

Responses from firmware are **newline-terminated ASCII strings** (`\n`). The software strips `\r` and `\n` on receipt. For bulk binary data transfers (capture data, streaming chunks), raw binary is sent without framing.

### Firmware Receive Buffer

The firmware has a 160-byte receive buffer (`messageBuffer[160]`). If the buffer overflows before the stop condition is received, the firmware responds with:

```
ERR_MSG_OVERFLOW\n
```

---

## 3. Device Identification / Handshake

### Command: `CMD_DEVICE_INIT` (0x00)

This is always the first command sent after connecting. No payload beyond the command byte.

### Sequence Diagram

```
SW                                           FW
 |                                            |
 |  [connect serial port]                     |
 |  [set RTS=true, DTR=true]                  |
 |  [wait 200ms for boot messages]            |
 |  [drain pending bytes (100ms timeout)]     |
 |                                            |
 |--- 0x55 0xAA 0x00 0xAA 0x55 ------------->|  CMD_DEVICE_INIT (5 bytes)
 |                                            |
 |<-- "LOGIC_ANALYZER_PICO_2_V6_5\n" --------|  version string
 |<-- "FREQ:100000000\n" --------------------|  max capture frequency
 |<-- "BLASTFREQ:200000000\n" ---------------|  max blast frequency
 |<-- "BUFFER:393216\n" ---------------------|  capture buffer size (bytes)
 |<-- "CHANNELS:24\n" -----------------------|  max channels
 |                                            |
```

### Hex Dump — Init Request

```
Direction: SW -> FW
Bytes:     55 AA 00 AA 55
           ^^ ^^ ^^ ^^ ^^
           |  |  |  |  +-- footer byte 2
           |  |  |  +----- footer byte 1
           |  |  +-------- command ID (0x00 = DEVICE_INIT)
           |  +----------- header byte 2
           +-------------- header byte 1
```

### Hex Dump — Init Response (example for Pico 2)

```
Direction: FW -> SW (ASCII text, newline-delimited)

4C 4F 47 49 43 5F 41 4E 41 4C 59 5A 45 52 5F   "LOGIC_ANALYZER_"
50 49 43 4F 5F 32 5F 56 36 5F 35 0A             "PICO_2_V6_5\n"
46 52 45 51 3A 31 30 30 30 30 30 30 30 30 0A     "FREQ:100000000\n"
42 4C 41 53 54 46 52 45 51 3A 32 30 30 30 30     "BLASTFREQ:200000"
30 30 30 30 30 0A                                 "00000\n"
42 55 46 46 45 52 3A 33 39 33 32 31 36 0A        "BUFFER:393216\n"
43 48 41 4E 4E 45 4C 53 3A 32 34 0A             "CHANNELS:24\n"
```

### Version String Format

```
LOGIC_ANALYZER_<BOARD_NAME>_V<MAJOR>_<MINOR>
```

Board names: `PICO`, `PICO_2`, `W`, `WIFI`, `2_W`, `2_WIFI`, `ZERO`, `INTERCEPTOR`

### Version Validation

The software validates the version string against regex `.*?V(\d+)_(\d+)$` and requires minimum version **V6_5**. Up to 20 lines are skipped to find a valid version string (handles firmware boot noise).

### Error Handling

If the firmware receives a malformed init command (wrong length), it responds:

```
ERR_UNKNOWN_MSG\n
```

---

## 4. Configuring and Starting a Capture with Simple Trigger

### Command: `CMD_START_CAPTURE` (0x01) with `triggerType = 0` (Edge)

### CAPTURE_REQUEST Struct Layout (56 bytes, after command byte)

```
Offset  Size    Field           Description
------  ----    -----           -----------
 0      1       triggerType     0 = Edge trigger
 1      1       trigger         Trigger channel number
 2      1       inverted        0 = rising edge, 1 = falling edge
 3      1       (padding)       Alignment for triggerValue
 4      2       triggerValue    Unused for edge (0x0000, LE)
 6      32      channels[32]    Channel numbers (zero-padded)
38      1       channelCount    Number of active channels
39      1       (padding)       Alignment for frequency
40      4       frequency       Sampling frequency in Hz (LE)
44      4       preSamples      Pre-trigger sample count (LE)
48      4       postSamples     Post-trigger sample count (LE)
52      2       loopCount       Number of capture loops (LE)
54      1       measure         0 or 1 (burst measurement)
55      1       captureMode     0=8ch, 1=16ch, 2=24ch
```

Total wire size: `2 (header) + escaped(1 + 56) + 2 (footer)` = 5 to ~120 bytes after escaping.

### Sequence Diagram

```
SW                                           FW
 |                                            |
 |--- [0x55 0xAA] [0x01] [56B capture_req]    |
 |    [0xAA 0x55] ------------------------------>  CMD_START_CAPTURE
 |                                            |
 |                                            |  FW validates request
 |                                            |  FW configures PIO + DMA
 |                                            |
 |<-- "CAPTURE_STARTED\n" -------------------|  Capture is now armed
 |                                            |
 |         ... waiting for trigger ...        |
 |         ... (LED blinks OFF/ON @ 1s) ...   |
 |                                            |
 |  [SW may send any byte to cancel]          |
 |                                            |
 |                                            |  Trigger fires!
 |                                            |  FW captures pre+post samples
 |                                            |  FW re-orders channel bits
 |                                            |
 |<-- [4 bytes: sample_count (LE)] ----------|  Binary: total sample count
 |<-- [N bytes: raw sample data] ------------|  Binary: capture buffer
 |<-- [1 byte: timestamp_count] -------------|  Binary: timestamp flag
 |<-- [M bytes: timestamps (if any)] --------|  Binary: loop timestamps
 |                                            |
```

### Hex Dump — Capture Request Example

Capturing channels 0-3 at 1 MHz, rising edge trigger on channel 0, 100 pre-samples, 1000 post-samples, no loops:

```
Direction: SW -> FW (before escaping)

Command byte:  01
Payload (56 bytes):
  00                          triggerType = 0 (edge)
  00                          trigger = channel 0
  00                          inverted = 0 (rising)
  00                          padding
  00 00                       triggerValue = 0 (LE)
  00 01 02 03 00 00 00 00     channels[0..7] (ch 0,1,2,3, rest zero)
  00 00 00 00 00 00 00 00     channels[8..15]
  00 00 00 00 00 00 00 00     channels[16..23]
  00 00 00 00 00 00 00 00     channels[24..31]
  04                          channelCount = 4
  00                          padding
  40 42 0F 00                 frequency = 1000000 (0x000F4240, LE)
  64 00 00 00                 preSamples = 100 (0x00000064, LE)
  E8 03 00 00                 postSamples = 1000 (0x000003E8, LE)
  00 00                       loopCount = 0 (LE)
  00                          measure = 0
  00                          captureMode = 0 (8ch)
```

After framing and escaping (noting that 0x55 at offset becomes 0xF0 0xA5, etc.):

```
55 AA  01 00 00 00 00 00 00 00 01 02 03 00 ... [escaped] ... AA 55
```

### Cancel During Trigger Wait

While waiting for the trigger, the firmware polls for incoming data every 2 seconds (1s LED off + 1s LED on). If **any byte** is received, the capture is aborted:

```
SW                                           FW
 |                                            |
 |<-- "CAPTURE_STARTED\n" -------------------|
 |                                            |
 |         ... waiting for trigger ...        |
 |                                            |
 |--- [any byte, e.g. 0xFF] ---------------->|  Cancel signal
 |                                            |  FW calls StopCapture()
 |                                            |  FW returns to idle
 |                                            |
```

The cancel mechanism uses `processCancel()` which calls `processUSBInput(true)` (skipProcessing=true). The data is read but not processed as a command; it simply triggers the cancel.

The software sends `CMD_STOP_CAPTURE = 0xFF` (raw, not framed). After a 2-second wait, the software disconnects and reconnects the transport.

### USB Disconnect During Capture

If the USB cable is disconnected during trigger wait, the firmware detects `!tud_cdc_connected()` and:
- Calls `StopCapture()`
- Resets `capturing = false`
- Resets `bufferPos = 0`
- Returns to idle

---

## 5. Configuring and Starting a Capture with Complex Trigger

### Trigger Types

| triggerType | Name     | Description |
|------------|----------|-------------|
| 0          | Edge     | Simple rising/falling edge on one pin |
| 1          | Complex  | Multi-bit pattern match (up to 16 bits) |
| 2          | Fast     | Multi-bit pattern match (up to 5 bits, lower latency) |
| 3          | Blast    | Maximum frequency capture, simple edge trigger |

### Complex/Fast Trigger CAPTURE_REQUEST

For complex/fast triggers, the struct fields have different semantics:

```
Offset  Field           Complex/Fast Meaning
------  -----           -------------------
 0      triggerType     1 (complex) or 2 (fast)
 1      trigger         Base trigger pin number (0-15)
 2      count           Number of trigger bits (1-16 for complex, 1-5 for fast)
 4      triggerValue    Bit pattern to match (LE, up to 16 bits)
```

### Trigger Delay Compensation

For complex and fast triggers, the software applies a trigger delay offset to preSamples/postSamples to compensate for PIO trigger detection latency:

```
delay_ns = (1 / maxFrequency) * 1e9 * DELAY_CYCLES
offset = round(delay_ns / sample_period_ns + 0.3)

preSamples_adjusted  = preSamples + offset
postSamples_adjusted = postSamples - offset
```

Constants:
- `COMPLEX_TRIGGER_DELAY = 5` cycles
- `FAST_TRIGGER_DELAY = 3` cycles

### Sequence Diagram (Complex Trigger)

```
SW                                           FW
 |                                            |
 |--- [0x55 0xAA] [0x01] [56B capture_req]    |
 |    [triggerType=1, count=4,                 |
 |     triggerValue=0x000A, ...]               |
 |    [0xAA 0x55] ------------------------------>  CMD_START_CAPTURE (complex)
 |                                            |
 |                                            |  FW loads COMPLEX_TRIGGER PIO
 |                                            |  FW configures pattern match
 |                                            |  FW starts DMA + PIO
 |                                            |
 |<-- "CAPTURE_STARTED\n" -------------------|
 |                                            |
 |         ... waiting for pattern ...        |
 |                                            |
 |                                            |  Pattern matched on pins!
 |                                            |  (same data transfer as simple)
 |                                            |
 |<-- [4B sample_count] [samples] [stamps] ---|
 |                                            |
```

### Blast Trigger

Blast mode uses maximum frequency (e.g., 400 MHz on turbo Pico 2). Key differences:
- `preSamples` must be 0
- `loopCount` must be 0
- `frequency` must equal `blastFrequency`
- No pre-trigger buffer

### Error Responses

If the capture cannot start, firmware responds with one of:

```
"CAPTURE_ERROR\n"    - PIO/DMA setup failed or invalid parameters
"ERR_BUSY\n"         - Streaming is currently active
```

If complex/fast triggers are not supported by the board:

```
"CAPTURE_ERROR\n"    - Board doesn't define SUPPORTS_COMPLEX_TRIGGER
```

---

## 6. Receiving Capture Data After Trigger Fires

### Binary Data Transfer Protocol

Once the trigger fires and capture completes, the firmware transfers data as raw binary (no framing, no escaping). The firmware disables stdio_usb and uses direct CDC transfers.

### Data Transfer Sequence

```
SW                                           FW
 |                                            |
 |                                            |  Capture complete!
 |                                            |  stdio_usb_deinit()
 |                                            |  sleep_ms(100) [USB: 100ms]
 |                                            |  sleep_ms(2000) [WiFi: 2000ms]
 |                                            |
 |<-- [4 bytes] sample_count (uint32 LE) -----|  Total number of samples
 |                                            |
 |    sleep_ms(100)                           |
 |                                            |
 |<-- [N bytes] raw sample data --------------|  sample_count * bytesPerSample
 |                                            |
 |<-- [1 byte] timestamp_count ---------------|  Number of timestamp entries
 |                                            |
 |<-- [M bytes] timestamps (optional) --------|  timestamp_count * 4 bytes (LE)
 |                                            |
 |                                            |  stdio_usb_init()  (re-enabled)
 |                                            |
```

### Bytes Per Sample by Capture Mode

| captureMode | Width  | Bytes/sample |
|-------------|--------|-------------|
| 0           | 8 ch   | 1           |
| 1           | 16 ch  | 2           |
| 2           | 24 ch  | 4           |

### Sample Count Header (4 bytes)

```
Example: 1100 total samples (100 pre + 1000 post)
Hex: 4C 04 00 00  (0x0000044C = 1100, little-endian)
```

### Circular Buffer Handling

The capture buffer is circular. The firmware computes `firstSample` as the index into the buffer where data starts. If the data wraps around the buffer boundary, two `cdc_transfer()` calls are made:

```
if (first + length > CAPTURE_BUFFER_SIZE):
    transfer(buffer + first, CAPTURE_BUFFER_SIZE - first)   // tail portion
    transfer(buffer, (first + length) - CAPTURE_BUFFER_SIZE) // head portion
else:
    transfer(buffer + first, length)                         // contiguous
```

The software receives all of this as a single contiguous byte stream via `readBytes()`.

### Timestamps (Burst Measurement)

If `measure = 1` and `loopCount > 0`, timestamps are transferred:

```
[1 byte] timestampIndex  (number of entries)
[timestampIndex * 4 bytes] uint32 LE timestamps
```

If `timestampIndex <= 1`, no timestamp data follows.

The software expects `loopCount + 2` timestamps when burst measurement is active.

### Hex Dump — Capture Data Example

8-channel capture, 100 pre + 1000 post = 1100 samples, no timestamps:

```
Direction: FW -> SW

4C 04 00 00           sample count = 1100 (LE)
[1100 bytes of sample data, 1 byte per sample]
00                    timestamp count = 0 (no timestamps)
```

### CDC Transfer Flow Control

The `cdc_transfer()` function implements blocking writes with backpressure:

```c
while(left > 0) {
    avail = tud_cdc_write_available();  // check USB TX buffer space
    if(avail > left) avail = left;
    if(avail) {
        transferred = tud_cdc_write(data + pos, avail);
        tud_task();
        tud_cdc_write_flush();
        pos += transferred;
        left -= transferred;
    } else {
        tud_task();
        tud_cdc_write_flush();
        if (!tud_cdc_connected()) break;  // bail on disconnect
    }
}
```

This means data is sent as fast as the USB CDC TX buffer allows. Each iteration calls `tud_task()` and `tud_cdc_write_flush()` to push data out. If USB disconnects mid-transfer, the function breaks out.

---

## 7. Starting a Streaming Session

### Command: `CMD_START_STREAM` (0x0A)

### STREAM_REQUEST Struct Layout (40 bytes, after command byte)

```
Offset  Size    Field           Description
------  ----    -----           -----------
 0      32      channels[32]    Channel numbers (zero-padded)
32      1       channelCount    Number of active channels (1-24)
33      1       (padding)       Alignment for chunkSamples
34      2       chunkSamples    Chunk size in samples (LE, 32-1024, multiple of 32)
36      4       frequency       Sampling frequency in Hz (LE)
```

### Sequence Diagram

```
SW                                           FW
 |                                            |
 |--- [0x55 0xAA] [0x0A] [40B stream_req]     |
 |    [0xAA 0x55] ------------------------------>  CMD_START_STREAM
 |                                            |
 |                                            |  FW validates parameters
 |                                            |  FW sets up PIO (blast capture program)
 |                                            |  FW configures DMA ring buffer
 |                                            |  FW disables stdio_usb
 |                                            |  FW launches Core 1 for compression
 |                                            |  FW enables PIO capture
 |                                            |
 |<-- "STREAM_STARTED\n" --------------------|  ASCII handshake
 |                                            |
 |<-- [8 bytes: info header] ----------------|  Binary info header
 |                                            |
 |         ... streaming data begins ...      |
 |                                            |
```

### Info Header (8 bytes, binary, LE)

```
Offset  Size    Field              Description
------  ----    -----              -----------
 0      2       chunkSamples       Actual chunk size (may differ from request, LE)
 2      1       numChannels        Number of active channels
 3      1       reserved           Always 0
 4      4       actualFrequency    Actual PIO sample rate after divider clamping (LE)
```

### Hex Dump — Stream Start Example

Starting a stream with 4 channels (0-3) at 1 MHz, 512 samples/chunk:

```
Direction: SW -> FW (before escaping)

Command:   0A
Payload (40 bytes):
  00 01 02 03 00 00 00 00     channels[0..7]
  00 00 00 00 00 00 00 00     channels[8..15]
  00 00 00 00 00 00 00 00     channels[16..23]
  00 00 00 00 00 00 00 00     channels[24..31]
  04                          channelCount = 4
  00                          padding
  00 02                       chunkSamples = 512 (0x0200, LE)
  40 42 0F 00                 frequency = 1000000 (LE)

Direction: FW -> SW

ASCII:  "STREAM_STARTED\n"

Binary (8 bytes):
  00 02                       chunkSamples = 512 (LE)
  04                          numChannels = 4
  00                          reserved
  40 42 0F 00                 actualFrequency = 1000000 (LE)
```

### Error Responses

```
"ERR_BUSY\n"      - Capture or streaming already active
"ERR_PARAMS\n"    - Invalid channel count (< 1 or > MAX_CHANNELS)
"STREAM_ERROR\n"  - PIO/DMA setup failed
```

---

## 8. Receiving Streaming Data Chunks

### Chunk Transfer Format

After the handshake, the firmware continuously sends compressed chunks. Each chunk is length-prefixed:

```
[2 bytes: compressed_size (uint16 LE)] [compressed_size bytes: compressed data]
[2 bytes: compressed_size (uint16 LE)] [compressed_size bytes: compressed data]
...
[2 bytes: 0x0000] -- EOF marker
"STREAM_DONE ...\n" or "STREAM_OVERFLOW ...\n" etc. -- termination status
```

### Sequence Diagram

```
SW                                           FW
 |                                            |
 |<-- [2B size] [compressed chunk #1] --------|  DMA->Core1 compress->Core0 send
 |<-- [2B size] [compressed chunk #2] --------|
 |<-- [2B size] [compressed chunk #3] --------|
 |         ...                                |
 |<-- [2B size] [compressed chunk #N] --------|
 |                                            |
 |  (stream stops: overflow/timeout/stop)     |
 |                                            |
 |<-- [flush remaining chunks] ---------------|
 |<-- [0x00 0x00] -- EOF marker --------------|
 |<-- "STREAM_DONE DMA=123 CMP=123 ..." -----|  Termination status line
 |                                            |
```

### Compressed Chunk Format

Each compressed chunk uses per-channel nibble-based compression:

```
[header: ceil(numChannels/4) bytes]  -- 2 bits per channel, LSB-first
[channel 0 data]                     -- depends on header mode
[channel 1 data]                     -- depends on header mode
...
[channel N-1 data]
```

Header mode codes (2 bits per channel):

| Code | Name          | Data Size                          |
|------|---------------|-----------------------------------|
| 0x00 | RAW           | chunkSamples/8 bytes (raw bitstream) |
| 0x01 | ALL_ZERO      | 0 bytes (all samples are 0)        |
| 0x02 | ALL_ONE       | 0 bytes (all samples are 1)        |
| 0x03 | NIBBLE_ENC    | Variable (nibble prefix codes)     |

### Nibble Prefix Codes

For NIBBLE_ENC channels, the data is a stream of 4-bit nibbles packed MSB-first:

| Nibble | Name   | Meaning                           |
|--------|--------|-----------------------------------|
| 0x0    | RAW1   | Read 1 data nibble (literal)      |
| 0x1    | RAW2   | Read 2 data nibbles               |
| 0x2    | RAW3   | Read 3 data nibbles               |
| 0x3    | RAW6   | Read 6 data nibbles               |
| 0x4    | RAW4   | Read 4 data nibbles               |
| 0x5    | RAW8   | Read 8 data nibbles               |
| 0x6    | ZERO2  | Emit 2 zero nibbles               |
| 0x7    | ZERO4  | Emit 4 zero nibbles               |
| 0x8    | ZERO8  | Emit 8 zero nibbles               |
| 0x9    | ZERO16 | Emit 16 zero nibbles              |
| 0xA    | ZERO32 | Emit 32 zero nibbles              |
| 0xB    | ONE2   | Emit 2 all-ones nibbles           |
| 0xC    | ONE4   | Emit 4 all-ones nibbles           |
| 0xD    | ONE8   | Emit 8 all-ones nibbles           |
| 0xE    | ONE16  | Emit 16 all-ones nibbles          |
| 0xF    | ONE32  | Emit 32 all-ones nibbles          |

### Pipeline Architecture

The streaming pipeline uses a producer-consumer pattern across both CPU cores with an 8-slot ring buffer:

```
 DMA (ISR)           Core 1              Core 0
 =========           ======              ======
 Captures data  -->  Compresses chunk -> Sends over USB/WiFi
 into ring slots     (bit transpose      (length-prefixed)
 (ping-pong DMA)      + nibble encode)

 dma_complete_count  compress_head       send_head
 (written by ISR)    (written by Core1)  (written by Core0)
```

Overflow occurs when: `dma_complete_count - send_head >= STREAM_SLOTS - 1` (i.e., 7)

### Maximum Compressed Chunk Size

Worst case (all channels RAW):
```
header_bytes = ceil(numChannels / 4)
raw_bytes_per_channel = chunkSamples / 8
max_output = header_bytes + numChannels * raw_bytes_per_channel
```

For 24 channels, 1024 samples: `6 + 24*128 = 3078 bytes`

The firmware allocates `STREAM_OUTPUT_SLOT_SIZE = 3080` bytes per output slot.

### Hex Dump — Chunk Example

4-channel stream, 512 samples/chunk, all channels idle (all zeros):

```
Direction: FW -> SW

01 00                         compressed size = 1 byte
00                            header: ch0=ALL_ZERO, ch1=ALL_ZERO,
                                      ch2=ALL_ZERO, ch3=ALL_ZERO
                              (4 channels * 2 bits = 8 bits = 1 byte)
                              bits: 01 01 01 01 = 0x55
```

Wait, let's recalculate. ALL_ZERO = 0x01 for each channel, LSB first:

```
Channel 0: bits[1:0] = 01  (ALL_ZERO)
Channel 1: bits[3:2] = 01  (ALL_ZERO)
Channel 2: bits[5:4] = 01  (ALL_ZERO)
Channel 3: bits[7:6] = 01  (ALL_ZERO)
Header byte = 0b01010101 = 0x55

Compressed size = 1 (just the header, no data needed)
Wire bytes: 01 00 55
            ^^ ^^  ^^
            size=1  header byte (needs escaping! 0x55 -> 0xF0 0xA5)
```

But note: streaming data is raw binary (no byte-stuffing). The 0x55/0xAA escaping only applies to the command frame (SW->FW). Streaming data from FW->SW is unescaped binary.

Corrected:
```
Direction: FW -> SW (raw binary, no escaping)

01 00        compressed size = 1 (uint16 LE)
55           header byte = 0x55 (all 4 channels ALL_ZERO)
```

---

## 9. Stopping a Streaming Session

### Command: `CMD_STOP_STREAM` (0x0B)

### Sequence Diagram — Normal Stop

```
SW                                           FW
 |                                            |
 |  (streaming is active)                     |
 |                                            |
 |--- [0x55 0xAA] [0x0B] [0xAA 0x55] ------->|  CMD_STOP_STREAM (5 bytes)
 |                                            |
 |                                            |  FW sets streaming = false
 |                                            |  RunStreamSendLoop() detects it
 |                                            |
 |<-- [remaining compressed chunks] ----------|  Flush any buffered chunks
 |<-- [0x00 0x00] -- EOF marker --------------|
 |<-- "STREAM_DONE DMA=N CMP=N ..." ---------|  Termination status
 |                                            |
 |                                            |  FW cleans up PIO/DMA/Core1
 |                                            |  FW re-enables stdio_usb
 |                                            |  FW returns to idle loop
 |                                            |
```

### Hex Dump — Stop Stream Command

```
Direction: SW -> FW
Bytes:     55 AA 0B AA 55
```

Note: The command byte 0x0B does not contain any special bytes, so no escaping is needed.

### Termination Status Line Format

```
STREAM_<REASON> DMA=<n> CMP=<n> SEND=<n> LOOP=<n> CONN=<0|1>/<0|1> CHUNKS=<n> FREQ=<n>
```

Reasons:
| Reason     | Code | Description |
|-----------|------|-------------|
| `DONE`     | 0    | Normal stop (StopStream called) |
| `OVERFLOW` | 1    | Ring buffer overflow (DMA outran send) |
| `DISCONN`  | 2    | USB disconnect detected |
| `TIMEOUT`  | 3    | No data produced within 3 seconds |

Example:
```
STREAM_DONE DMA=500 CMP=500 SEND=500 LOOP=12345 CONN=1/1 CHUNKS=512 FREQ=1000000\n
```

### Software-side Stop Procedure

The software:
1. Sends `CMD_STOP_STREAM` framed packet
2. Waits up to 5 seconds for the read loop to finish (checks `#streaming` flag every 50ms)
3. If the read loop hasn't finished after 5 seconds, forces cleanup by disconnecting and reconnecting the transport

### Sequence Diagram — Overflow Stop

```
SW                                           FW
 |                                            |
 |<-- [compressed chunks...] -----------------|
 |                                            |
 |                                            |  DMA overruns ring buffer!
 |                                            |  dma_complete - send_head >= 7
 |                                            |  FW sets streaming = false
 |                                            |
 |<-- [flush remaining] ----------------------|
 |<-- [0x00 0x00] -- EOF --------------------|
 |<-- "STREAM_OVERFLOW DMA=... ..." ----------|
 |                                            |
```

### Sequence Diagram — Timeout Stop

```
SW                                           FW
 |                                            |
 |                                            |  3 seconds pass with no new
 |                                            |  compressed data available
 |                                            |  FW sets streaming = false
 |                                            |
 |<-- [0x00 0x00] -- EOF --------------------|
 |<-- "STREAM_TIMEOUT DMA=... ..." ----------|
 |                                            |
```

---

## 10. WiFi Configuration and Connection

### Command: `CMD_NETWORK_CONFIG` (0x02)

Only available on WiFi-enabled builds (`USE_CYGW_WIFI`). On non-WiFi builds, responds with `"ERR_UNSUPPORTED\n"`.

### WIFI_SETTINGS_REQUEST Struct Layout (148 bytes, after command byte)

```
Offset  Size    Field           Description
------  ----    -----           -----------
 0      33      apName          WiFi AP SSID (null-terminated)
33      64      passwd          WiFi password (null-terminated)
97      16      ipAddress       Static IP address string (e.g., "192.168.1.100")
113     2       port            TCP server port (LE)
115     33      hostname        mDNS hostname (null-terminated)
```

Total payload = 1 (command) + 148 = 149 bytes. After escaping and framing: up to ~300 bytes.

### Sequence Diagram

```
SW                                           FW (Core 0)          FW (Core 1 / WiFi)
 |                                            |                        |
 |--- [0x55 0xAA] [0x02] [148B wifi_req]      |                        |
 |    [0xAA 0x55] ------------------------------>                       |
 |                                            |                        |
 |                                            |  Compute checksum      |
 |                                            |  Store to flash        |
 |                                            |  (multicore lockout)   |
 |                                            |  sleep_ms(500)         |
 |                                            |                        |
 |                                            |  Push CONFIG_RECEIVED  |
 |                                            |  to WiFi event queue   |
 |                                            |   ---- event --------->|
 |                                            |                        |
 |                                            |                        |  Kill TCP client
 |                                            |                        |  Stop TCP server
 |                                            |                        |  Disconnect from AP
 |                                            |                        |  Restart WiFi state
 |                                            |                        |  machine from
 |                                            |                        |  VALIDATE_SETTINGS
 |                                            |                        |
 |<-- "SETTINGS_SAVED\n" --------------------|                        |
 |                                            |                        |
 |                                            |                        |  Validate checksum
 |                                            |                        |  Connect to AP (10s)
 |                                            |                        |  Start TCP server
 |                                            |                        |  Wait for client
 |                                            |                        |
```

### Checksum Calculation

The checksum is computed by summing all bytes of the settings fields plus a magic constant:

```
checksum = sum(apName[0..32]) + sum(passwd[0..63]) + sum(ipAddress[0..15])
         + port + sum(hostname[0..32]) + 0x0F0F
```

This checksum is stored alongside the settings in flash. On boot, the firmware validates stored settings by recomputing the checksum. If it doesn't match (e.g., flash was never written), the WiFi state machine enters `WAITING_SETTINGS` and only USB communication is available.

### Flash Storage

Settings are stored at the end of flash memory:
- RP2040: offset `(2048 * 1024) - FLASH_SECTOR_SIZE` from XIP base
- RP2350: offset `(4096 * 1024) - FLASH_SECTOR_SIZE` from XIP base

Writing to flash requires a multicore lockout and interrupt disable (takes ~500ms+ including safety delays).

---

## 11. WiFi Event Notifications

### WiFi State Machine (Core 1)

```
VALIDATE_SETTINGS --> WAITING_SETTINGS (if checksum invalid)
                  \-> CONNECTING_AP --> STARTING_TCP_SERVER --> WAITING_TCP_CLIENT
                                                                     |
                                                               TCP_CLIENT_CONNECTED
```

### Inter-Core Communication

Two event queues connect Core 0 (main protocol) and Core 1 (WiFi):

```
Core 0 --> frontendToWifi --> Core 1
  Events: LED_ON, LED_OFF, CONFIG_RECEIVED, SEND_DATA, GET_POWER_STATUS

Core 1 --> wifiToFrontend --> Core 0
  Events: CYW_READY, CONNECTED, DISCONNECTED, DATA_RECEIVED, POWER_STATUS_DATA
```

Queue depth: 8 events. Event processing: up to 8 events per poll cycle.

### WiFi Connection Events

When a TCP client connects:
```
Core 1 pushes CONNECTED event --> Core 0
Core 0 sets usbDisabled = true  (USB input is ignored while WiFi is active)
```

When a TCP client disconnects or errors:
```
Core 1 pushes DISCONNECTED event --> Core 0
Core 0 sets usbDisabled = false
Core 0 purges pending USB data
```

### Data Received via WiFi

TCP data is broken into 128-byte chunks and pushed as `DATA_RECEIVED` events:

```
TCP data arrives (e.g., 200 bytes)
  --> DATA_RECEIVED event (128 bytes)
  --> DATA_RECEIVED event (72 bytes)
```

Each event is processed by `processData()` on Core 0, exactly as if it arrived via USB.

### WiFi Data Transfer (FW -> SW)

WiFi transfers use 32-byte chunks through the event queue:

```c
// wifi_transfer() breaks data into 32-byte pieces
while(pos < len) {
    evt.data[0..31] = data[pos..pos+31];
    evt.dataLength = filled;
    event_push(&frontendToWifi, &evt);
    // Core 1 receives SEND_DATA event and calls tcp_write()
}
```

This means large transfers (capture data) go through many event queue pushes on WiFi, which is significantly slower than USB CDC transfers.

### Power Status Command

### Command: `CMD_VOLTAGE_STATUS` (0x03)

Only available via WiFi connection. Returns battery voltage and USB power status.

```
SW                                           FW (Core 0)          FW (Core 1)
 |                                            |                        |
 |--- [0x55 0xAA] [0x03] [0xAA 0x55] ------->|                        |
 |                                            |                        |
 |                                            |  Push GET_POWER_STATUS |
 |                                            |  to WiFi queue         |
 |                                            |   ---- event --------->|
 |                                            |                        |
 |                                            |                        |  Read ADC (VSYS)
 |                                            |                        |  Read VBUS GPIO
 |                                            |                        |
 |                                            |  <--- POWER_STATUS_DATA|
 |                                            |                        |
 |<-- "4.85_1\n" ----------------------------|  voltage_VBUS
 |                                            |
```

Response format: `<voltage>_<vbus>` where:
- `<voltage>` = VSYS voltage as `%.2f` (e.g., `4.85`)
- `<vbus>` = `1` if USB power connected, `0` if not

If sent via USB (not WiFi), responds with `"ERR_UNSUPPORTED\n"`.

---

## 12. Error Scenarios and Recovery

### Error Response Summary

| Response               | Cause                                           |
|-----------------------|------------------------------------------------|
| `ERR_MSG_OVERFLOW\n`  | Receive buffer (160 bytes) overflowed          |
| `ERR_UNKNOWN_MSG\n`   | Unknown command ID or malformed message        |
| `ERR_BUSY\n`          | Capture or streaming already active            |
| `ERR_PARAMS\n`        | Invalid stream parameters                      |
| `ERR_UNSUPPORTED\n`   | Command not supported (WiFi on non-WiFi build) |
| `CAPTURE_ERROR\n`     | PIO/DMA setup failed                           |
| `STREAM_ERROR\n`      | Stream PIO/DMA setup failed                    |

### Frame Sync Recovery

The firmware self-synchronizes on the start condition:

```
if byte[0] != 0x55 -> reset bufferPos to 0
if byte[1] != 0xAA -> reset bufferPos to 0
```

This means garbage bytes are automatically discarded until a valid frame start is found.

### USB Reconnection Handling

When USB reconnects (CDC connected transitions from false to true), the firmware resets `bufferPos = 0` to prevent partial message corruption from the previous connection.

### Capture Cancel and Recovery

```
SW                                           FW
 |                                            |
 |  [capture is armed, waiting for trigger]   |
 |                                            |
 |--- 0xFF ---------------------------------->|  Cancel (raw byte, not framed)
 |                                            |
 |  [wait 2 seconds]                          |  FW calls StopCapture()
 |  [disconnect transport]                    |  FW returns to idle
 |  [reconnect transport]                     |
 |                                            |
 |  [new init handshake or operation]         |
 |                                            |
```

The 2-second wait is necessary because the firmware polls for cancel input in its capture wait loop which has 2-second periods (1s LED off + 1s LED on).

### Stream Overflow Recovery

If the DMA ring buffer overflows during streaming:

```
SW                                           FW
 |                                            |
 |<-- [compressed chunks] -------------------|
 |                                            |  Ring buffer overflow!
 |<-- [flush remaining] ---------------------|
 |<-- [0x00 0x00] EOF ----------------------|
 |<-- "STREAM_OVERFLOW ..." ----------------|
 |                                            |
 |  [SW read loop sees EOF, calls onEnd()]   |
 |  [SW may start a new stream at lower freq] |
 |                                            |
```

### Stream Timeout Recovery

If no data is produced within 3 seconds (diagnostic check):

```
SW                                           FW
 |                                            |
 |                                            |  3s timeout
 |<-- [0x00 0x00] EOF ----------------------|
 |<-- "STREAM_TIMEOUT ..." -----------------|
 |                                            |
```

### Software Timeout on Stream Stop

If the firmware doesn't respond to stop within 5 seconds, the software forces cleanup:

```
SW                                           FW
 |                                            |
 |--- CMD_STOP_STREAM ---------------------->|
 |                                            |
 |  [poll #streaming every 50ms for 5s]      |
 |  [timeout reached!]                        |
 |                                            |
 |  [disconnect transport]                    |
 |  [wait 100ms]                              |
 |  [reconnect transport]                     |
 |                                            |
```

---

## 13. Other Commands

### CMD_ENTER_BOOTLOADER (0x04)

Reboots the device into USB bootloader mode for firmware updates.

```
SW                                           FW
 |                                            |
 |--- [0x55 0xAA] [0x04] [0xAA 0x55] ------->|
 |                                            |
 |<-- "RESTARTING_BOOTLOADER\n" -------------|
 |                                            |  sleep_ms(1000)
 |                                            |  reset_usb_boot(0, 0)
 |                                            |  [device reboots into UF2 mode]
 |                                            |
```

### CMD_BLINK_LED_ON (0x05)

Starts LED blinking (device identification).

```
SW                                           FW
 |                                            |
 |--- [0x55 0xAA] [0x05] [0xAA 0x55] ------->|
 |<-- "BLINKON\n" ---------------------------|
 |                                            |  LED blinks at ~2.5 Hz
 |                                            |
```

### CMD_BLINK_LED_OFF (0x06)

Stops LED blinking.

```
SW                                           FW
 |                                            |
 |--- [0x55 0xAA] [0x06] [0xAA 0x55] ------->|
 |<-- "BLINKOFF\n" --------------------------|
 |                                            |  LED stays ON (solid)
 |                                            |
```

---

## 14. Timing Constraints Summary

### Connection and Initialization

| Event                              | Timing           |
|-----------------------------------|------------------|
| Firmware boot delay               | Variable (0-1.3s based on board ID hash) |
| Post-boot USB settle delay        | 1000 ms          |
| Software serial connect wait      | 200 ms (for boot messages) |
| Software drain pending data       | 100 ms timeout per drain attempt |
| Software skip non-version lines   | Up to 20 lines   |

### Capture Mode

| Event                              | Timing           |
|-----------------------------------|------------------|
| Trigger wait poll interval        | ~2 seconds (1s OFF + 1s ON LED cycle) |
| Pre-transfer delay (USB)         | 100 ms (`sleep_ms(100)` before data) |
| Pre-transfer delay (WiFi)        | 2000 ms (`sleep_ms(2000)` before data) |
| Post-length delay                | 100 ms (`sleep_ms(100)` between count and data) |
| Cancel detection latency         | 0-2 seconds (depends on poll phase) |
| Software cancel wait             | 2000 ms (before disconnect/reconnect) |

### Streaming Mode

| Event                              | Timing           |
|-----------------------------------|------------------|
| Chunk delivery rate               | frequency / chunkSamples Hz |
| Ring buffer depth                 | 8 slots          |
| Overflow threshold                | 7 slots behind   |
| Diagnostic timeout (no data)     | 3 seconds        |
| Software stop timeout            | 5 seconds (before forced reconnect) |
| Software stop poll interval      | 50 ms            |
| Forced reconnect delay           | 100 ms           |

### WiFi

| Event                              | Timing           |
|-----------------------------------|------------------|
| AP connection timeout             | 10,000 ms        |
| Flash write delay                 | ~500 ms (includes NOP loops and sleep) |
| WiFi send buffer wait             | Busy-loop with 1 ms sleep per iteration |
| Event queue processing            | Up to 8 events per poll cycle |

### USB CDC Transfer

| Parameter                          | Value            |
|-----------------------------------|------------------|
| Baud rate                         | 115200           |
| CDC TX buffer                     | System default (TinyUSB, typically 64 or 512 bytes) |
| Flow control                      | None (backpressure via `tud_cdc_write_available()`) |
| tud_task() + flush rate           | Every write iteration |

---

## Appendix A: Command ID Quick Reference

| ID   | Name                  | Direction | Payload           | Response Type     |
|------|-----------------------|-----------|-------------------|-------------------|
| 0x00 | DEVICE_INIT           | SW->FW    | None              | 5 text lines      |
| 0x01 | START_CAPTURE         | SW->FW    | 56B CAPTURE_REQUEST | Text + binary   |
| 0x02 | NETWORK_CONFIG        | SW->FW    | 148B WIFI_SETTINGS_REQUEST | Text    |
| 0x03 | VOLTAGE_STATUS        | SW->FW    | None              | Text (WiFi only)  |
| 0x04 | ENTER_BOOTLOADER      | SW->FW    | None              | Text then reboot  |
| 0x05 | BLINK_LED_ON          | SW->FW    | None              | Text              |
| 0x06 | BLINK_LED_OFF         | SW->FW    | None              | Text              |
| 0x0A | START_STREAM          | SW->FW    | 40B STREAM_REQUEST | Text + 8B binary + chunks |
| 0x0B | STOP_STREAM           | SW->FW    | None              | EOF + status text |
| 0xFF | STOP_CAPTURE          | SW->FW    | Raw byte (no frame) | None (implicit) |

## Appendix B: Response String Quick Reference

| Response                      | Command Context      | Meaning                    |
|------------------------------|---------------------|---------------------------|
| `LOGIC_ANALYZER_*_V6_5`     | DEVICE_INIT         | Device version identifier  |
| `FREQ:<n>`                   | DEVICE_INIT         | Max capture frequency (Hz) |
| `BLASTFREQ:<n>`              | DEVICE_INIT         | Max blast frequency (Hz)   |
| `BUFFER:<n>`                 | DEVICE_INIT         | Capture buffer size (bytes)|
| `CHANNELS:<n>`               | DEVICE_INIT         | Max channel count          |
| `CAPTURE_STARTED`            | START_CAPTURE       | Capture armed successfully |
| `CAPTURE_ERROR`              | START_CAPTURE       | Capture setup failed       |
| `STREAM_STARTED`             | START_STREAM        | Streaming started          |
| `STREAM_ERROR`               | START_STREAM        | Stream setup failed        |
| `STREAM_DONE ...`            | (end of stream)     | Normal stream termination  |
| `STREAM_OVERFLOW ...`        | (end of stream)     | Ring buffer overflow       |
| `STREAM_DISCONN ...`         | (end of stream)     | USB disconnect during stream|
| `STREAM_TIMEOUT ...`         | (end of stream)     | 3-second idle timeout      |
| `SETTINGS_SAVED`             | NETWORK_CONFIG      | WiFi settings stored       |
| `RESTARTING_BOOTLOADER`      | ENTER_BOOTLOADER    | About to reboot            |
| `BLINKON`                    | BLINK_LED_ON        | LED blinking started       |
| `BLINKOFF`                   | BLINK_LED_OFF       | LED blinking stopped       |
| `ERR_MSG_OVERFLOW`           | Any                 | Receive buffer overflow    |
| `ERR_UNKNOWN_MSG`            | Any                 | Unknown/malformed command  |
| `ERR_BUSY`                   | START_CAPTURE/STREAM| Device busy                |
| `ERR_PARAMS`                 | START_STREAM        | Invalid parameters         |
| `ERR_UNSUPPORTED`            | NETWORK_CONFIG etc. | Feature not available      |

## Appendix C: Full Handshake Hex Trace

Complete byte-level trace for connecting and identifying a Pico 2 device:

```
=== USB Serial Connection ===
[Open port: VID=0x1209 PID=0x3020 baud=115200 bufSize=1048576]
[Set RTS=true DTR=true]
[Wait 200ms]
[Drain pending data (100ms timeout)]

=== SW -> FW: Device Init ===
TX: 55 AA 00 AA 55

=== FW -> SW: Init Response ===
RX: 4C 4F 47 49 43 5F 41 4E 41 4C 59 5A 45 52 5F 50 49 43 4F 5F 32 5F 56 36 5F 35 0A
    "LOGIC_ANALYZER_PICO_2_V6_5\n"
RX: 46 52 45 51 3A 31 30 30 30 30 30 30 30 30 0A
    "FREQ:100000000\n"
RX: 42 4C 41 53 54 46 52 45 51 3A 32 30 30 30 30 30 30 30 30 0A
    "BLASTFREQ:200000000\n"
RX: 42 55 46 46 45 52 3A 33 39 33 32 31 36 0A
    "BUFFER:393216\n"
RX: 43 48 41 4E 4E 45 4C 53 3A 32 34 0A
    "CHANNELS:24\n"
```

## Appendix D: Full Capture Session Hex Trace

Capturing channels 0-3 at 1 MHz, edge trigger on channel 0 (rising), 100 pre-samples, 1000 post-samples, 8-channel mode:

```
=== SW -> FW: Start Capture ===
TX (before escaping): 55 AA 01
  00 00 00 00 00 00 00 01 02 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 04 00 40 42 0F 00 64 00 00 00
  E8 03 00 00 00 00 00 00
  AA 55

TX (after escaping — bytes 0xAA and 0x55 in payload replaced):
  55 AA 01
  00 00 00 00 00 00 00 01 02 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 04 00 40 42 0F 00 64 00 00 00
  E8 03 00 00 00 00 00 00
  AA 55
  (In this example, no payload bytes happen to be 0x55, 0xAA, or 0xF0)

=== FW -> SW: Capture Acknowledged ===
RX: 43 41 50 54 55 52 45 5F 53 54 41 52 54 45 44 0A
    "CAPTURE_STARTED\n"

=== [Waiting for trigger... firmware polls for cancel every ~2s] ===

=== FW -> SW: Trigger Fired, Data Transfer ===
(After 100ms delay)
RX: 4C 04 00 00               sample_count = 1100 (0x0000044C, LE)
(After 100ms delay)
RX: [1100 bytes of 8-bit sample data]
RX: 00                         timestamp_count = 0
```

## Appendix E: Full Stream Session Hex Trace

Streaming channels 0-1 at 500 kHz, 256 samples/chunk:

```
=== SW -> FW: Start Stream ===
TX (before escaping): 55 AA 0A
  00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 02 00 00 01 20 A1 07 00
  AA 55

=== FW -> SW: Stream Handshake ===
RX: 53 54 52 45 41 4D 5F 53 54 41 52 54 45 44 0A
    "STREAM_STARTED\n"

RX: 00 01 02 00 20 A1 07 00   info header
    chunkSamples = 256 (0x0100, LE)
    numChannels = 2
    reserved = 0
    actualFreq = 500000 (0x0007A120, LE)

=== FW -> SW: Compressed Chunks (continuous) ===
RX: 05 00                     compressed size = 5
    [5 bytes compressed data]

RX: 03 00                     compressed size = 3
    [3 bytes compressed data]

    ... (continues until stopped) ...

=== SW -> FW: Stop Stream ===
TX: 55 AA 0B AA 55

=== FW -> SW: Stream Termination ===
RX: [any remaining compressed chunks]
RX: 00 00                     EOF marker (compressed size = 0)
RX: "STREAM_DONE DMA=50 CMP=50 SEND=50 LOOP=1234 CONN=1/1 CHUNKS=256 FREQ=500000\n"
```

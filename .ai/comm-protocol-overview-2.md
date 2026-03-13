# LogicAnalyzer V2 Communication Protocol — Transport & WiFi Layer

This document covers the transport-specific protocol details: WiFi TCP connections, USB CDC serial configuration, the inter-core WiFi event system, large data transfers, byte ordering, version negotiation, and protocol differences between USB and WiFi modes.

For the general framing protocol, command IDs, and struct layouts, see `comm-protocol-overview.md` (if present).

---

## 1. Transport Modes Overview

The firmware supports two transport modes, selected at build time via `LogicAnalyzer_Build_Settings.cmake` (line 3) and compile definitions in `LogicAnalyzer_Board_Settings.h`:

| Build Target            | Board Name | Transport | Define              |
|-------------------------|------------|-----------|---------------------|
| `BOARD_PICO`            | `PICO`     | USB only  | `BUILD_PICO`        |
| `BOARD_PICO_2`          | `PICO_2`   | USB only  | `BUILD_PICO_2`      |
| `BOARD_PICO_W`          | `W`        | USB only  | `BUILD_PICO_W`      |
| `BOARD_PICO_W_WIFI`     | `WIFI`     | USB + WiFi| `BUILD_PICO_W_WIFI`, `USE_CYGW_WIFI` |
| `BOARD_PICO_2_W`        | `2_W`      | USB only  | `BUILD_PICO_2_W`    |
| `BOARD_PICO_2_W_WIFI`   | `2_WIFI`   | USB + WiFi| `BUILD_PICO_2_W_WIFI`, `USE_CYGW_WIFI` |

**Key architectural point:** WiFi builds include *both* USB and WiFi support. The firmware can receive commands on either transport simultaneously when no WiFi client is connected. When a WiFi client connects, USB input is disabled (`usbDisabled = true`, `LogicAnalyzer.c` line 571-572). When the WiFi client disconnects, USB is re-enabled (line 575-576).

---

## 2. USB CDC Serial Specifics

### 2.1 Hardware Layer

The Pico uses TinyUSB (`tusb.h`) to present a USB CDC ACM device. The firmware identifies with:

- **USB Vendor ID:** `0x1209` (`Software/Web/src/core/protocol/commands.js` line 35)
- **USB Product ID:** `0x3020` (`commands.js` line 36)

### 2.2 Baud Rate and Serial Configuration

- **Baud rate:** 115200 (defined in `commands.js` line 33 as `DEFAULT_BAUD_RATE`). Note: for USB CDC ACM, the baud rate is largely cosmetic since the actual data rate is governed by USB bulk transfers, but it must be set to open the port.
- **Flow control:** RTS/DTR are asserted by the host on connection (`serial.js` lines 70-73):
  ```js
  await this.#port.setSignals({
    requestToSend: true,
    dataTerminalReady: true,
  })
  ```
- **No hardware flow control** is used at the protocol level. The firmware writes data as fast as the USB endpoint allows.

### 2.3 Host Buffer Size

The Web Serial API defaults to a 255-byte receive buffer, which is catastrophically insufficient for capture data transfers. The web client overrides this to **1 MB** (1,048,576 bytes) — defined in `commands.js` line 34 as `DEFAULT_BUFFER_SIZE`, and passed to `port.open()` in `serial.js` line 66-68.

### 2.4 USB Data Transfer Mechanism

The firmware uses TinyUSB's CDC write API directly for bulk data transfer (capture results, streaming chunks). The `cdc_transfer()` function (`LogicAnalyzer.c` lines 177-207) implements a blocking write loop:

1. Checks `tud_cdc_write_available()` for space in the CDC TX FIFO
2. Writes up to the available amount via `tud_cdc_write()`
3. Calls `tud_task()` and `tud_cdc_write_flush()` to push data to the USB stack
4. If no space is available, polls `tud_task()` and checks `tud_cdc_connected()` to detect disconnection

**Critical detail:** Before sending capture/stream data, the firmware calls `stdio_usb_deinit()` (`LogicAnalyzer.c` line 728, `LogicAnalyzer_Stream.c` line 301) to disable the Pico SDK's background `tud_task()` calls. This prevents reentrancy in the TinyUSB stack. After the transfer, `stdio_usb_init()` is called to re-enable it (`LogicAnalyzer.c` line 816, `LogicAnalyzer_Stream.c` line 365).

### 2.5 USB Input Processing

Two input paths exist:

1. **`processUSBInput()`** (`LogicAnalyzer.c` lines 499-515) — uses `getchar_timeout_us(0)` via stdio, reads one byte at a time. Used during normal command processing.
2. **`processUSBInputDirect()`** (`LogicAnalyzer.c` lines 521-536) — uses `tud_cdc_available()` and `tud_cdc_read()` directly, bypassing stdio. Used during streaming when stdio_usb is disabled.

### 2.6 Host Connection Sequence

The web client's `SerialTransport.connect()` (`serial.js` lines 52-86):

1. Calls `navigator.serial.requestPort()` with USB VID/PID filter
2. Opens the port at 115200 baud with 1 MB buffer
3. Asserts RTS and DTR
4. Waits 200 ms for firmware boot messages to settle
5. Drains any pending bytes in the input buffer (matches C# `DiscardInBuffer()`)
6. Acquires reader and writer locks

---

## 3. WiFi Protocol Layer

### 3.1 Architecture: Dual-Core Design

WiFi builds use the RP2040/RP2350's dual-core architecture:

- **Core 0** — Runs the main protocol logic, command processing, capture management
- **Core 1** — Runs the WiFi stack (CYW43 driver, lwIP TCP/IP, TCP server)

The two cores communicate through an **event machine** system using Pico SDK's multicore-safe queues.

### 3.2 WiFi Initialization Sequence

At boot (`LogicAnalyzer.c` lines 691-695):

1. Core 0 initializes the WiFi-to-Frontend event machine with queue depth 8
2. Core 0 launches Core 1 via `multicore_launch_core1(runWiFiCore)`
3. Core 0 blocks, polling the event queue until it receives a `CYW_READY` event
4. Core 1 (`runWiFiCore()`, `LogicAnalyzer_WiFi.c` lines 295-312):
   - Initializes the Frontend-to-WiFi event machine (queue depth 8)
   - Sets up multicore lockout victim
   - Initializes CYW43 driver
   - Enables STA (station) mode
   - Pushes `CYW_READY` event to Core 0

### 3.3 WiFi State Machine

Core 1 runs a state machine (`processWifiMachine()`, `LogicAnalyzer_WiFi.c` lines 216-263) with these states (defined in `LogicAnalyzer_WiFi.h` lines 9-16):

```
VALIDATE_SETTINGS → WAITING_SETTINGS (if invalid checksum)
                   → CONNECTING_AP (if valid)
CONNECTING_AP     → STARTING_TCP_SERVER (on successful AP connection)
STARTING_TCP_SERVER → WAITING_TCP_CLIENT (on server bind success)
WAITING_TCP_CLIENT  → TCP_CLIENT_CONNECTED (on client accept)
```

### 3.4 WiFi Configuration and Network Settings

WiFi settings are stored in flash at the last sector:
- **Pico 2 builds:** offset `(4096 * 1024) - FLASH_SECTOR_SIZE` = top of 4 MB flash (`Shared_Buffers.h` line 10)
- **Pico 1 builds:** offset `(2048 * 1024) - FLASH_SECTOR_SIZE` = top of 2 MB flash (`Shared_Buffers.h` line 12)

The `WIFI_SETTINGS` struct (`LogicAnalyzer_Structs.h` lines 59-68):

| Field       | Type        | Size    | Description                    |
|-------------|-------------|---------|--------------------------------|
| `apName`    | `char[33]`  | 33 B    | WiFi SSID (null-terminated)    |
| `passwd`    | `char[64]`  | 64 B    | WiFi password                  |
| `ipAddress` | `char[16]`  | 16 B    | Static IP address string       |
| `port`      | `uint16_t`  | 2 B     | TCP listen port                |
| `hostname`  | `char[33]`  | 33 B    | mDNS/DHCP hostname             |
| `checksum`  | `uint16_t`  | 2 B     | Integrity checksum             |

**Total struct size:** 150 bytes

The `WIFI_SETTINGS_REQUEST` struct sent by the host (command 2) is the same but without the checksum field — 148 bytes (`LogicAnalyzer_Structs.h` lines 70-78).

**Checksum algorithm** (`LogicAnalyzer.c` lines 362-376, `LogicAnalyzer_WiFi.c` lines 227-244): Sum all bytes of `apName[0..32]`, `passwd[0..63]`, `ipAddress[0..15]`, `port`, and `hostname[0..32]`, then add `0x0f0f`. The result is stored as a `uint16_t` (implicitly truncated).

**Settings storage** (`storeSettings()`, `LogicAnalyzer.c` lines 108-150): Requires multicore lockout (Core 1 paused), interrupt disable, flash sector erase, then page program. NOP loops are inserted for flash timing stabilization.

### 3.5 Network Advertisement / Discovery

The firmware does **not** implement any active network discovery protocol (no mDNS, no UDP broadcast, no SSDP). The device is discoverable only by:

1. **Static IP address** — configured via the WiFi settings command
2. **Hostname** — set via `netif_set_hostname()` (`LogicAnalyzer_WiFi.c` line 199), which makes the device resolvable via DHCP hostname if the router supports it

The host must know the device's IP address and TCP port to connect.

### 3.6 TCP Server Configuration

The TCP server is implemented using lwIP's raw TCP API (`LogicAnalyzer_WiFi.c`):

- **IP version:** IPv4 only (`IPADDR_TYPE_V4`, line 175)
- **Backlog:** 1 connection (`tcp_listen_with_backlog(serverPcb, 1)`, line 181)
- **Only one client at a time.** If `clientPcb != NULL` when a connection arrives, `acceptConnection()` returns `ERR_VAL` (line 156)
- **Authentication:** WPA2 AES-PSK (`CYW43_AUTH_WPA2_AES_PSK`, line 191)
- **Connection timeout:** 10 seconds for AP association (`cyw43_arch_wifi_connect_timeout_ms`, line 191)

### 3.7 lwIP Configuration

Key settings from `lwipopts.h`:

| Setting              | Value     | Impact                             |
|----------------------|-----------|-------------------------------------|
| `NO_SYS`            | 1         | No RTOS — polling mode              |
| `MEM_ALIGNMENT`      | 4         | 4-byte aligned memory               |
| `MEM_SIZE`           | 4000      | 4 KB heap for lwIP                  |
| `TCP_MSS`           | 1460      | Standard Ethernet MSS               |
| `TCP_WND`           | 11680     | 8 * TCP_MSS = ~11.4 KB recv window  |
| `TCP_SND_BUF`       | 11680     | 8 * TCP_MSS = ~11.4 KB send buffer  |
| `MEMP_NUM_TCP_SEG`  | 32        | Max TCP segments in flight           |
| `PBUF_POOL_SIZE`    | 24        | Packet buffer pool                   |
| `LWIP_TCP_KEEPALIVE`| 1         | TCP keepalives enabled               |

**Polling mode:** The firmware uses `PICO_CYW43_ARCH_POLL` mode. The main WiFi core loop explicitly calls `cyw43_arch_poll()` (`LogicAnalyzer_WiFi.c` line 310) on each iteration when the state is past `CONNECTING_AP`.

### 3.8 TCP Data Send

The `sendData()` function (`LogicAnalyzer_WiFi.c` lines 91-107):

1. Waits for `tcp_sndbuf()` to report enough space, polling `cyw43_arch_poll()` + 1 ms sleep
2. Calls `tcp_write()` with `TCP_WRITE_FLAG_COPY`
3. On write failure, kills the client and posts a `DISCONNECTED` event

### 3.9 TCP Data Receive

`serverReceiveData()` (`LogicAnalyzer_WiFi.c` lines 118-152):

1. Handles client disconnect (null/empty pbuf) by posting `DISCONNECTED`
2. Splits received data into 128-byte chunks and posts each as a `DATA_RECEIVED` event
3. Each chunk is copied from the pbuf via `pbuf_copy_partial()` into the event's 128-byte data buffer
4. The pbuf is freed after all chunks are posted

---

## 4. Inter-Core Event System

### 4.1 Event Machine Architecture

The event machine (`Event_Machine.c/h`) wraps the Pico SDK's `queue_t` (multicore-safe FIFO):

- **Queue type:** Fixed-size entries, blocking push/pull
- **Two instances** (`Shared_Buffers.c` lines 9-10):
  - `wifiToFrontend` — WiFi core (Core 1) to Main core (Core 0)
  - `frontendToWifi` — Main core (Core 0) to WiFi core (Core 1)
- **Queue depth:** 8 entries each (initialized at `LogicAnalyzer.c` line 692 and `LogicAnalyzer_WiFi.c` line 297)
- **Processing:** `event_process_queue()` drains up to `max_events` per call

### 4.2 WiFi-to-Frontend Events

`EVENT_FROM_WIFI` struct (`LogicAnalyzer_Structs.h` lines 100-106):

| Field        | Type          | Size   |
|--------------|---------------|--------|
| `event`      | `WIFI_EVENT`  | 4 B    |
| `data`       | `char[128]`   | 128 B  |
| `dataLength` | `uint8_t`     | 1 B    |

Event types (`WIFI_EVENT` enum, `LogicAnalyzer_Structs.h` lines 80-88):

| Event               | Value | When Fired | Handler Action |
|---------------------|-------|------------|----------------|
| `CYW_READY`         | 0     | CYW43 driver initialized on Core 1 | Sets `cywReady = true`, unblocks boot |
| `CONNECTED`         | 1     | TCP client accepted | Sets `usbDisabled = true` |
| `DISCONNECTED`      | 2     | TCP client disconnected or error | Sets `usbDisabled = false`, purges USB data |
| `DATA_RECEIVED`     | 3     | TCP data received (up to 128 bytes per event) | Calls `processData()` with `fromWiFi=true` |
| `POWER_STATUS_DATA` | 4     | Response to GET_POWER_STATUS request | Formats and sends voltage/VBUS status string |

### 4.3 Frontend-to-WiFi Events

`EVENT_FROM_FRONTEND` struct (`LogicAnalyzer_Structs.h` lines 108-114):

| Field        | Type             | Size   |
|--------------|------------------|--------|
| `event`      | `FRONTEND_EVENT` | 4 B    |
| `data`       | `char[32]`       | 32 B   |
| `dataLength` | `uint8_t`        | 1 B    |

Event types (`FRONTEND_EVENT` enum, `LogicAnalyzer_Structs.h` lines 90-98):

| Event              | Value | Purpose |
|--------------------|-------|---------|
| `LED_ON`           | 0     | Turn on CYW43 LED (GPIO access requires WiFi core) |
| `LED_OFF`          | 1     | Turn off CYW43 LED |
| `CONFIG_RECEIVED`  | 2     | New WiFi settings saved — teardown and reconnect |
| `SEND_DATA`        | 3     | Send up to 32 bytes over TCP to the connected client |
| `GET_POWER_STATUS` | 4     | Read VSYS voltage and VBUS status via ADC |

### 4.4 WiFi Data Transfer Chunking

The `wifi_transfer()` function (`LogicAnalyzer.c` lines 213-233) splits large data buffers into 32-byte chunks for the event queue:

- Each chunk is pushed as a `SEND_DATA` event with up to 32 bytes
- This is necessary because `EVENT_FROM_FRONTEND.data` is only 32 bytes
- For a 128 KB capture buffer, this means ~4096 event pushes
- Each push is **blocking** (`queue_add_blocking`), so backpressure is automatically applied

By contrast, `sendData()` on the WiFi core side (`LogicAnalyzer_WiFi.c` lines 91-107) writes directly to the TCP socket, waiting for `tcp_sndbuf()` capacity.

---

## 5. Version Negotiation and Device Identification

### 5.1 Firmware Version String

The firmware version is compiled in via `CMakeLists.txt` line 98:
```
add_compile_definitions(FIRMWARE_VERSION="V6_5")
```

The identity response is constructed as a string concatenation (`LogicAnalyzer.c` line 287):
```c
sendResponse("LOGIC_ANALYZER_"BOARD_NAME"_"FIRMWARE_VERSION"\n", fromWiFi);
```

This produces strings like:
- `LOGIC_ANALYZER_PICO_V6_5`
- `LOGIC_ANALYZER_WIFI_V6_5`
- `LOGIC_ANALYZER_2_WIFI_V6_5`
- `LOGIC_ANALYZER_PICO_2_V6_5`

### 5.2 Init Handshake (Command 0x00)

The device identification command is a minimal framed packet: `[0x55 0xAA 0x00 0xAA 0x55]` (5 bytes total: header + command byte + footer).

The firmware responds with 5 newline-terminated text lines (`LogicAnalyzer.c` lines 286-299):

```
LOGIC_ANALYZER_<BOARD_NAME>_V<major>_<minor>\n
FREQ:<max_frequency>\n
BLASTFREQ:<max_blast_frequency>\n
BUFFER:<capture_buffer_size>\n
CHANNELS:<max_channels>\n
```

Example response for Pico 2 W WiFi:
```
LOGIC_ANALYZER_2_WIFI_V6_5
FREQ:100000000
BLASTFREQ:200000000
BUFFER:393216
CHANNELS:24
```

### 5.3 Version Validation

The web client validates the version string against minimum requirements (`parser.js` lines 1-28, `commands.js` lines 39-40):

- Regex: `/.*?V(\d+)_(\d+)$/`
- Minimum version: **V6.5** (major >= 6, minor >= 5 when major == 6)
- The parser skips up to 20 non-version lines before the expected response to handle boot noise (`parser.js` lines 58-65)

---

## 6. Endianness and Byte Ordering

### 6.1 General Rule

All multi-byte integer fields in the protocol are **little-endian**. This is natural for the ARM Cortex-M0+/M33 cores used in RP2040/RP2350, and the firmware does not perform any byte swapping.

### 6.2 Struct Alignment

The firmware casts message buffer pointers directly to C struct pointers (`LogicAnalyzer.c` line 310):
```c
req = (CAPTURE_REQUEST*)&messageBuffer[3];
```

This means the wire format must match the C compiler's struct layout including alignment padding. The web client accounts for this explicitly.

**CAPTURE_REQUEST struct** (56 bytes, `LogicAnalyzer_Structs.h` lines 9-42, with alignment mapped in `packets.js` lines 62-145):

| Offset | Size | Field            | Type       |
|--------|------|------------------|------------|
| 0      | 1    | triggerType      | uint8_t    |
| 1      | 1    | trigger          | uint8_t    |
| 2      | 1    | inverted/count   | uint8_t    |
| 3      | 1    | (padding)        | -          |
| 4      | 2    | triggerValue     | uint16_t LE|
| 6      | 32   | channels[32]     | uint8_t[]  |
| 38     | 1    | channelCount     | uint8_t    |
| 39     | 1    | (padding)        | -          |
| 40     | 4    | frequency        | uint32_t LE|
| 44     | 4    | preSamples       | uint32_t LE|
| 48     | 4    | postSamples      | uint32_t LE|
| 52     | 2    | loopCount        | uint16_t LE|
| 54     | 1    | measure          | uint8_t    |
| 55     | 1    | captureMode      | uint8_t    |

**STREAM_REQUEST struct** (40 bytes, `LogicAnalyzer_Structs.h` lines 44-55, mapped in `packets.js` lines 86-117):

| Offset | Size | Field         | Type       |
|--------|------|---------------|------------|
| 0      | 32   | channels[32]  | uint8_t[]  |
| 32     | 1    | channelCount  | uint8_t    |
| 33     | 1    | (padding)     | -          |
| 34     | 2    | chunkSamples  | uint16_t LE|
| 36     | 4    | frequency     | uint32_t LE|

**WIFI_SETTINGS_REQUEST struct** (148 bytes, `LogicAnalyzer_Structs.h` lines 70-78):

| Offset | Size | Field      | Type       |
|--------|------|------------|------------|
| 0      | 33   | apName     | char[33]   |
| 33     | 64   | passwd     | char[64]   |
| 97     | 16   | ipAddress  | char[16]   |
| 113    | 2    | port       | uint16_t LE|
| 115    | 33   | hostname   | char[33]   |

---

## 7. Large Data Transfers

### 7.1 Capture Data Transfer

After a capture completes (`LogicAnalyzer.c` lines 710-813), the firmware sends binary data directly over the active transport. The transfer sequence:

1. **Disable stdio_usb** (USB only) — prevents tud_task() reentrancy
2. **Wait for transport readiness:**
   - WiFi: `sleep_ms(2000)` — allows TCP send buffer to drain
   - USB: `sleep_ms(100)`
3. **Send sample count** — 4 bytes, `uint32_t` little-endian (number of samples, not bytes)
4. **Wait** — `sleep_ms(100)` additional settling
5. **Send sample data** — raw bytes from circular buffer:
   - 8-channel mode: 1 byte per sample
   - 16-channel mode: 2 bytes per sample
   - 24-channel mode: 4 bytes per sample
   - If the circular buffer wraps (`first + length > CAPTURE_BUFFER_SIZE`), two separate transfers are issued: tail then head
6. **Send timestamp length** — 1 byte (`stampsLength`)
7. **Send timestamps** (if `stampsLength > 1`) — `stampsLength * 4` bytes of `uint32_t` LE values

The web client reads this in `parseCaptureData()` (`parser.js` lines 133-175).

### 7.2 Streaming Data Transfer

Streaming uses a producer-consumer ring buffer architecture with on-device compression:

#### Ring Buffer Design (`LogicAnalyzer_Stream.h` lines 9-12)
- **Slots:** 8 (`STREAM_SLOTS`)
- **Max chunk size:** 1024 samples (`STREAM_MAX_CHUNK`)
- **Input slot size:** 4096 bytes (`STREAM_MAX_CHUNK * 4`, worst case 24-channel)
- **Output slot size:** 3080 bytes (max compressed for 24ch/1024 samples)

#### Pipeline
1. **DMA** (hardware) fills input slots via ping-pong chained DMA channels
2. **Core 1** compresses filled slots using `stream_compress_chunk_mapped()`
3. **Core 0** sends compressed data over USB/WiFi

Monotonically increasing counters track progress:
- `dma_complete_count` — incremented by DMA ISR
- `compress_head` — incremented by Core 1
- `send_head` — incremented by Core 0

#### Stream Wire Protocol

**Handshake:**
1. Host sends framed `CMD_START_STREAM` (0x0A) + `STREAM_REQUEST` struct
2. Firmware responds with text: `STREAM_STARTED\n` (15 bytes)
3. Firmware sends 8-byte info header (binary, `LogicAnalyzer_Stream.c` lines 316-324):

| Offset | Size | Field          | Format     |
|--------|------|----------------|------------|
| 0      | 2    | chunkSamples   | uint16_t LE|
| 2      | 1    | numChannels    | uint8_t    |
| 3      | 1    | (reserved)     | 0x00       |
| 4      | 4    | actualFrequency| uint32_t LE|

The `actualFrequency` may differ from the requested frequency due to PIO clock divider quantization.

**Data chunks** (repeating):
1. 2-byte chunk size — `uint16_t` LE (compressed byte count)
2. N bytes of compressed data

**EOF marker:**
- 2-byte zero: `0x00 0x00` — indicates end of stream

**Termination status line:**
- Text line with diagnostic counters, format (`LogicAnalyzer_Stream.c` lines 489-502):
  ```
  STREAM_<REASON> DMA=<n> CMP=<n> SEND=<n> LOOP=<n> CONN=<0|1>/<0|1> CHUNKS=<n> FREQ=<n>\n
  ```
  Where REASON is one of: `DONE`, `TIMEOUT`, `OVERFLOW`, `DISCONN`

**Stop command:** Host sends framed `CMD_STOP_STREAM` (0x0B). The firmware sets `streaming = false` and the send loop exits gracefully, flushing remaining chunks before sending EOF + status.

#### Compression Format

The compression algorithm is described in `stream_compress.h` and implemented in `stream_compress.c`. Each compressed chunk contains:

1. **Header:** `ceil(numChannels / 4)` bytes. Each channel gets 2 bits:
   - `0x00` (RAW) — raw transposed bitstream follows
   - `0x01` (ALL_ZERO) — all samples are 0, no data
   - `0x02` (ALL_ONE) — all samples are 1, no data
   - `0x03` (NIBBLE_ENC) — nibble-encoded compressed data follows

2. **Per-channel data** in header order:
   - RAW: `chunkSamples / 8` bytes of bit-transposed samples
   - NIBBLE_ENC: variable-length nibble stream using 16 prefix codes (run-length encoding of nibbles)

The nibble prefix codes (`stream_compress.h` lines 42-57, `decoder.js` lines 16-33):

| Code | Meaning   | Description                    |
|------|-----------|--------------------------------|
| 0x0  | RAW1      | 1 data nibble follows          |
| 0x1  | RAW2      | 2 data nibbles follow          |
| 0x2  | RAW3      | 3 data nibbles follow          |
| 0x3  | RAW6      | 6 data nibbles follow          |
| 0x4  | RAW4      | 4 data nibbles follow          |
| 0x5  | RAW8      | 8 data nibbles follow          |
| 0x6  | ZERO2     | 2 zero nibbles                 |
| 0x7  | ZERO4     | 4 zero nibbles                 |
| 0x8  | ZERO8     | 8 zero nibbles                 |
| 0x9  | ZERO16    | 16 zero nibbles                |
| 0xA  | ZERO32    | 32 zero nibbles                |
| 0xB  | ONE2      | 2 all-ones nibbles             |
| 0xC  | ONE4      | 4 all-ones nibbles             |
| 0xD  | ONE8      | 8 all-ones nibbles             |
| 0xE  | ONE16     | 16 all-ones nibbles            |
| 0xF  | ONE32     | 32 all-ones nibbles            |

Nibbles are packed MSB-first (high nibble first in each byte, matching `bw_put4()` in the encoder and `NibbleReader` in `decoder.js` lines 39-66).

---

## 8. Protocol Differences Between USB and WiFi Modes

### 8.1 Same Protocol, Different Transports

The application-layer protocol (framing, commands, responses) is **identical** between USB and WiFi. The `processData()` function (`LogicAnalyzer.c` line 240) accepts a `fromWiFi` boolean but processes the same byte stream regardless.

### 8.2 Key Differences

| Aspect | USB | WiFi |
|--------|-----|------|
| **Transport** | USB CDC ACM (TinyUSB) | TCP over lwIP |
| **Data path** | Direct CDC FIFO read/write | Event queue (32-byte chunks) |
| **String responses** | `printf()` via stdio | Event queue → `tcp_write()` |
| **Binary responses** | `cdc_transfer()` direct | `wifi_transfer()` → 32-byte event chunks → `sendData()` → `tcp_write()` |
| **Input reading** | `getchar_timeout_us()` or `tud_cdc_read()` | Event queue (128-byte chunks from `serverReceiveData()`) |
| **Capture pre-send delay** | 100 ms | 2000 ms (`LogicAnalyzer.c` line 737) |
| **Disconnect detection** | `tud_cdc_connected()` | `tcp_err()` callback + pbuf null check |
| **Concurrent use** | Disabled when WiFi client connected | Takes priority over USB |
| **WiFi-only commands** | `CMD_VOLTAGE_STATUS` (0x03) returns `ERR_UNSUPPORTED` | Returns VSYS voltage and VBUS status |
| **WiFi config command** | `CMD_NETWORK_CONFIG` (0x02) supported — saves and applies | Same |
| **Buffer sizes** | 1 MB host buffer (Web Serial) | ~11.4 KB TCP window |
| **Latency** | Low (USB bulk) | Higher (TCP stack + WiFi) |
| **Bandwidth** | ~12 Mbps (USB Full Speed) | Variable, limited by WiFi/TCP |

### 8.3 WiFi-Only Commands

**Command 0x03 — Power Status** (`LogicAnalyzer.c` lines 390-400):
- Only supported over WiFi (`fromWiFi` must be true)
- Posts `GET_POWER_STATUS` event to WiFi core
- WiFi core reads ADC (VSYS voltage via GPIO 29 / ADC3) and VBUS status (CYW43 GPIO 2)
- Response format: `<voltage>_<vbus>\n` where voltage is `%.2f` and vbus is `0` or `1`
- Example: `4.85_1\n`

**Command 0x02 — WiFi Settings** (`LogicAnalyzer.c` lines 349-388):
- Supported on both USB and WiFi, but primarily useful over USB to initially configure the device
- Saves settings to flash, then posts `CONFIG_RECEIVED` to WiFi core
- WiFi core tears down the current connection and restarts the state machine
- Response: `SETTINGS_SAVED\n`

### 8.4 Mutual Exclusion

When a WiFi client connects (`CONNECTED` event, `LogicAnalyzer.c` line 571):
- `usbDisabled = true` — `processInput()` skips USB reading
- USB data is effectively ignored

When a WiFi client disconnects (`DISCONNECTED` event, `LogicAnalyzer.c` line 575):
- `usbDisabled = false`
- `purgeUSBData()` is called to discard any stale USB bytes

---

## 9. Message Buffer and Framing Details

### 9.1 Receive Buffer

The firmware uses a 160-byte message buffer (`LogicAnalyzer.c` line 91):
```c
uint8_t messageBuffer[160];
```

This is sized to accommodate the largest possible command: WiFi settings request at 148 bytes payload + 2 bytes header + 2 bytes footer + escape overhead.

### 9.2 Framing Protocol

Detailed in the firmware source comments (`LogicAnalyzer.c` lines 478-493):

- **Start condition:** `0x55 0xAA`
- **End condition:** `0xAA 0x55`
- **Escape character:** `0xF0`
- **Escaping rule:** Bytes `0x55`, `0xAA`, and `0xF0` are escaped as `[0xF0, byte ^ 0xF0]`
  - `0x55` → `[0xF0, 0xA5]`
  - `0xAA` → `[0xF0, 0x5A]`
  - `0xF0` → `[0xF0, 0x00]`
- **Unescaping:** Done in-place in the message buffer (`LogicAnalyzer.c` lines 263-276) after the stop condition is detected
- **Buffer overflow:** If more than 160 bytes are received without a stop condition, the firmware responds with `ERR_MSG_OVERFLOW\n`
- **Malformed messages:** If the first byte is not `0x55` or the second is not `0xAA`, the buffer position is reset to 0

The web client implements the same escaping in `OutputPacket.serialize()` (`packets.js` lines 43-58), escaping `0xAA`, `0x55`, and `0xF0`.

### 9.3 Response Format Asymmetry

The protocol is asymmetric:
- **Host to device:** Binary framed packets (header + escaped payload + footer)
- **Device to host:** Newline-terminated ASCII strings for status/responses; raw binary for capture/stream data

The transition from text to binary happens implicitly:
- After `CAPTURE_STARTED\n`, the next bytes are raw binary capture data
- After `STREAM_STARTED\n`, the next bytes are the 8-byte binary info header followed by compressed chunks

### 9.4 Stop/Cancel Capture

Capture cancellation uses a special mechanism (`LogicAnalyzer.c` lines 637-650):
- Any incoming data (USB or WiFi) during capture is treated as a cancel signal
- The `processCancel()` function reads and discards the data (`skipProcessing = true`)
- The web client sends a raw `0xFF` byte (not framed) as `CMD_STOP_CAPTURE` (`commands.js` line 12, `analyzer.js` lines 355-369)
- After sending the cancel byte, the client waits 2 seconds, disconnects, and reconnects

---

## 10. Connection Lifecycle Summary

### 10.1 USB Connection Flow

```
Host                                  Firmware
  |                                      |
  |-- requestPort(VID:1209, PID:3020) -->|
  |-- port.open(115200, 1MB buffer) ---->|
  |-- setSignals(RTS=1, DTR=1) -------->|
  |-- wait 200ms ---------------------->|
  |-- drain pending bytes -------------->|
  |-- [0x55 0xAA 0x00 0xAA 0x55] ------>| (ID request)
  |<---- "LOGIC_ANALYZER_..._V6_5\n" ---|
  |<---- "FREQ:100000000\n" ------------|
  |<---- "BLASTFREQ:200000000\n" -------|
  |<---- "BUFFER:393216\n" -------------|
  |<---- "CHANNELS:24\n" --------------|
  |                                      |
  | (capture/stream commands...)         |
```

### 10.2 WiFi Connection Flow

```
Host (TCP Client)                    Firmware (TCP Server on Core 1)
  |                                      |
  |-- TCP connect to <IP>:<port> ------->| acceptConnection()
  |                                      | → posts CONNECTED event
  |                                      | → Core 0 sets usbDisabled=true
  |                                      |
  | (same command/response protocol      |
  |  as USB, but over TCP stream)        |
  |                                      |
  |-- TCP disconnect ------------------>| serverReceiveData() gets null pbuf
  |                                      | → posts DISCONNECTED event
  |                                      | → Core 0 sets usbDisabled=false
```

---

## 11. File Reference Index

| File | Description |
|------|-------------|
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c` | Main firmware: command processing, USB CDC transfer, WiFi event handling |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_WiFi.c` | WiFi core: TCP server, CYW43 driver, state machine |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_WiFi.h` | WiFi state machine enum |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h` | Protocol structs: CAPTURE_REQUEST, STREAM_REQUEST, WIFI_SETTINGS, event types |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c` | Streaming: ring buffer, DMA, Core 1 compression, send loop |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.h` | Stream constants and API |
| `Firmware/LogicAnalyzer_V2/Event_Machine.c/h` | Inter-core event queue wrapper |
| `Firmware/LogicAnalyzer_V2/Shared_Buffers.c/h` | Shared variables between cores (event machines, WiFi settings) |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Board_Settings.h` | Board-specific defines, buffer sizes, frequencies |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Build_Settings.cmake` | Build target selection |
| `Firmware/LogicAnalyzer_V2/lwipopts.h` | lwIP TCP/IP stack configuration |
| `Firmware/LogicAnalyzer_V2/stream_compress.h` | Compression API and format constants |
| `Software/Web/src/core/protocol/commands.js` | Command IDs, framing constants, USB defaults |
| `Software/Web/src/core/protocol/packets.js` | Packet serialization, struct builders |
| `Software/Web/src/core/protocol/parser.js` | Response parsing: version, capture data, stream handshake |
| `Software/Web/src/core/transport/serial.js` | Web Serial API transport implementation |
| `Software/Web/src/core/transport/types.js` | Transport interface definition |
| `Software/Web/src/core/driver/analyzer.js` | High-level driver: connect, capture, stream lifecycle |
| `Software/Web/src/core/compression/decoder.js` | Stream chunk decompression |

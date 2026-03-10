# LogicAnalyzer V2 Firmware Structure

## Overview

The LogicAnalyzer V2 firmware runs on RP2040/RP2350-based boards (Raspberry Pi Pico family). It implements a multi-channel logic analyzer supporting two operational modes: **capture mode** (trigger-based, high-frequency up to 100MHz/200MHz with turbo) and **streaming mode** (continuous real-time compressed streaming at 1-3MHz). Communication with the host software client is via USB (CDC serial) or WiFi (TCP, on W-variant boards).

Firmware version: **V6\_5** (set in `CMakeLists.txt` line 98).

---

## Source File Inventory

All source files reside in `Firmware/LogicAnalyzer_V2/`.

| File | Role |
|------|------|
| `LogicAnalyzer.c` | **Main entry point** (`main()`). Command protocol parser, USB/WiFi I/O, capture result transfer, main event loop. |
| `LogicAnalyzer_Capture.c` / `.h` | **Capture mode engine**. PIO program setup, DMA configuration, trigger handling, buffer post-processing. |
| `LogicAnalyzer_Stream.c` / `.h` | **Streaming mode engine**. PIO/DMA ring buffer setup, Core 1 compression dispatch, send loop on Core 0. |
| `stream_compress.c` / `.h` | **Stream compression algorithm**. Per-channel nibble-based compression with bit-transpose, CLZ run detection, and nibble encoding. Runs on Core 1. |
| `LogicAnalyzer_WiFi.c` / `.h` | **WiFi subsystem** (conditionally compiled). Runs on Core 1. TCP server, CYW43 driver, AP connection, event processing. |
| `Event_Machine.c` / `.h` | **Generic event queue** for inter-core communication. Used to pass events between Core 0 (frontend) and Core 1 (WiFi). |
| `Shared_Buffers.c` / `.h` | **Shared global state** for WiFi mode: `wifiSettings`, `wifiToFrontend`, and `frontendToWifi` event machines. |
| `LogicAnalyzer_Structs.h` | **Protocol data structures**: `CAPTURE_REQUEST`, `STREAM_REQUEST`, `WIFI_SETTINGS`, WiFi event enums and structs. |
| `LogicAnalyzer_Board_Settings.h` | **Board-variant configuration**: pin maps, buffer sizes, frequency limits, LED types, per-board `#define` blocks. |
| `LogicAnalyzer_W2812.c` / `.h` | **WS2812 RGB LED driver** (bit-banged, for the Zero board). |
| `LogicAnalyzer.pio` | **PIO assembly programs** for all capture modes (7 programs). |
| `lwipopts.h` | **lwIP configuration** for WiFi TCP stack. |
| `LogicAnalyzer_Build_Settings.cmake` | **User-facing build config**: selects `BOARD_TYPE` and `TURBO_MODE`. |
| `CMakeLists.txt` | **Build system**: board-conditional compilation, SDK integration, library linking. |
| `pico_sdk_import.cmake` | Standard Pico SDK import boilerplate. |
| `publish.ps1` | **Release build script** (PowerShell). Iterates all board/turbo combinations and produces `.uf2` files. |
| `stream_compress_*.c.ref` | Reference/prototype compression implementations (not compiled; kept for historical reference). |

---

## Build System

### `CMakeLists.txt` (lines 1-166)

- **SDK version**: Pico SDK 2.1.1, toolchain 14\_2\_Rel1
- **Language standards**: C11, C++17
- **Source collection**: `FILE(GLOB CSources *.c)` -- all `.c` files in the directory are compiled (line 80-81)
- **PIO header generation**: `pico_generate_pio_header()` compiles `LogicAnalyzer.pio` into `LogicAnalyzer.pio.h` (line 92-94)
- **USB device identity**: VID `0x1209`, PID `0x3020`, manufacturer "Dr. Gusman", product "LogicAnalyzer" (line 166)

### Board Selection (`LogicAnalyzer_Build_Settings.cmake`)

The user sets `BOARD_TYPE` to one of:
- `BOARD_PICO` -- original Pico (RP2040)
- `BOARD_PICO_2` -- Pico 2 (RP2350)
- `BOARD_PICO_W` -- Pico W without WiFi (CYW43 LED only)
- `BOARD_PICO_W_WIFI` -- Pico W with WiFi support
- `BOARD_PICO_2_W` -- Pico 2 W without WiFi
- `BOARD_PICO_2_W_WIFI` -- Pico 2 W with WiFi support
- `BOARD_ZERO` -- custom Zero board (WS2812 LED, different pin map)
- `BOARD_INTERCEPTOR` -- custom Interceptor board (no LED, 28 channels)

`TURBO_MODE` can be set to `1` for 400MHz overclock (not available on W variants).

### Compile-Time Defines per Board

`CMakeLists.txt` lines 103-143 set board-specific compile definitions:

| Board | Define | Extra |
|-------|--------|-------|
| Pico | `BUILD_PICO` | -- |
| Pico 2 | `BUILD_PICO_2`, `CORE_TYPE_2` | RP2350-specific code paths |
| Pico W | `BUILD_PICO_W` | CYW43 arch none |
| Pico W WiFi | `BUILD_PICO_W_WIFI` | CYW43 arch lwip\_poll |
| Pico 2 W | `BUILD_PICO_2_W`, `CORE_TYPE_2` | CYW43 arch none |
| Pico 2 W WiFi | `BUILD_PICO_2_W_WIFI`, `CORE_TYPE_2` | CYW43 arch lwip\_poll |
| Zero | `BUILD_ZERO` | -- |
| Interceptor | `BUILD_INTERCEPTOR` | -- |

### RAM-Only Builds

For `BOARD_PICO`, `BOARD_ZERO`, and `BOARD_PICO_2`, the binary type is set to `copy_to_ram` (line 87) in Release mode. This copies the entire program to RAM for execution, improving timing precision for high-frequency capture.

### Build Type Forcing

- W variants always force `Debug` build (lines 37, 45) due to flash requirements of the CYW43 driver
- Non-W variants default to `Release` for RAM-only builds (lines 62-67)

### Linked Libraries (lines 146-160)

```
pico_stdlib, hardware_dma, hardware_pio, hardware_clocks, hardware_flash,
hardware_adc, hardware_exception, hardware_vreg, pico_multicore,
pico_base_headers, cmsis_core, ${CYW_LIB}
```

Where `CYW_LIB` is either `pico_cyw43_arch_none` or `pico_cyw43_arch_lwip_poll` depending on board variant.

---

## Board Variants (`LogicAnalyzer_Board_Settings.h`)

Each board variant defines:

| Parameter | Pico/Pico 2 | W variants | Zero | Interceptor |
|-----------|-------------|------------|------|-------------|
| `INPUT_PIN_BASE` | 2 | 2 | 0 | 2 |
| `COMPLEX_TRIGGER_OUT_PIN` | 0 | 0 | 17 | 0 |
| `COMPLEX_TRIGGER_IN_PIN` | 1 | 1 | 18 | 1 |
| `MAX_CHANNELS` | 24 | 24 | 24 | 28 |
| `CAPTURE_BUFFER_SIZE` | 128KB (Pico), 384KB (Pico 2) | 128KB (W), 384KB (2W) | 128KB | 128KB |
| `MAX_FREQ` (normal) | 100MHz | 100MHz | 100MHz | 100MHz |
| `MAX_FREQ` (turbo) | 200MHz | N/A | 200MHz | 200MHz |
| `MAX_BLAST_FREQ` | 200MHz / 400MHz turbo | 200MHz | 200MHz / 400MHz | 200MHz / 400MHz |
| LED type | `GPIO_LED` (pin 25) | `CYGW_LED` | `WS2812_LED` (pin 16) | `NO_LED` |

All boards except Interceptor define `SUPPORTS_COMPLEX_TRIGGER`.

Pin maps are board-specific arrays mapping logical channel indices to physical GPIO numbers. The Pico-family boards use GPIOs 2-22, 26-28 for channels. The Zero uses GPIOs 0-15, 26-29, 22-25. The Interceptor uses GPIOs 6-29.

---

## Main Entry Point and Initialization (`LogicAnalyzer.c`)

### `main()` (line 654)

1. **Clock configuration** (lines 656-669):
   - Turbo mode: disables voltage limiter, sets 1.30V, overclocks to 400MHz
   - Normal mode: sets system clock to 200MHz

2. **SysTick enable** (line 672): `systick_hw->csr = 0x05` -- enables SysTick with CPU clock (used for burst timestamp measurement)

3. **Unique board ID delay** (lines 674-684): Reads the board's unique flash ID and derives a pseudorandom startup delay (0-1023ms range). This prevents USB enumeration collisions when multiple analyzers are connected.

4. **stdio initialization** (line 687): `stdio_init_all()` enables USB CDC serial

5. **Board-specific initialization** (lines 689-696):
   - Pico W / Pico 2 W (no WiFi): `cyw43_arch_init()` -- initializes CYW43 for LED control only
   - Pico W WiFi / Pico 2 W WiFi: initializes `wifiToFrontend` event machine, launches `runWiFiCore()` on Core 1, waits for `CYW_READY` event

6. **Post-init delay** (line 699): 1 second sleep for USB enumeration stability

7. **LED initialization** (lines 705-706): Board-specific `INIT_LED()` and `LED_ON()`

### Main Loop (lines 708-879)

The main loop has three states:

1. **Capturing** (`capturing == true`):
   - Polls `IsCapturing()` to check if PIO has finished
   - When finished: retrieves buffer via `GetBuffer()`, timestamps via `GetTimestamps()`, disables stdio\_usb, transfers data via `cdc_transfer()` or `wifi_transfer()`, re-enables stdio\_usb
   - While waiting: blinks LED every 1 second, checks for cancel requests via `processCancel()`, detects USB disconnect
   - For fast trigger captures: calls `check_fast_interrupt()` to poll PIO interrupt (workaround for W board PIO interrupt issues)

2. **Streaming** (`streaming_active == true`):
   - Calls `RunStreamSendLoop()` (blocking, runs until stream ends)
   - Calls `CleanupStream()` to release resources
   - Sets `streaming_active = false`

3. **Idle**:
   - Handles LED blinking if blink mode is active
   - Calls `processInput()` to read and parse incoming commands

---

## Command Protocol (`LogicAnalyzer.c`, lines 240-494)

Binary framing protocol with start marker `0x55 0xAA`, stop marker `0xAA 0x55`, and `0xF0` escape character. Messages are received into `messageBuffer[160]`.

### Commands

| ID | Name | Description |
|----|------|-------------|
| 0 | ID Request | Returns board name, firmware version, max frequencies, buffer size, channel count |
| 1 | Capture Request | Starts a capture with parameters from `CAPTURE_REQUEST` struct |
| 2 | WiFi Settings | Stores WiFi configuration to flash (WiFi builds only) |
| 3 | Power Status | Returns VSYS voltage and VBUS state (WiFi builds only) |
| 4 | Reboot Bootloader | Calls `reset_usb_boot()` for firmware update |
| 5 | Blink On | Starts LED blinking for device identification |
| 6 | Blink Off | Stops LED blinking |
| 10 | Start Stream | Begins continuous streaming with `STREAM_REQUEST` parameters |
| 11 | Stop Stream | Signals streaming to stop |

### Capture Trigger Types (command 1)

| Type | Name | Function |
|------|------|----------|
| 0 | Simple (edge) | `StartCaptureSimple()` -- single pin edge trigger |
| 1 | Complex (pattern) | `StartCaptureComplex()` -- multi-pin pattern trigger |
| 2 | Fast (pattern) | `StartCaptureFast()` -- high-speed pattern trigger via jump table |
| 3 | Blast | `StartCaptureBlast()` -- single-shot DMA capture at max frequency |

---

## Key Data Structures (`LogicAnalyzer_Structs.h`)

### `CAPTURE_REQUEST` (line 9)
Fields: `triggerType`, `trigger`, `inverted`/`count` (union), `triggerValue`, `channels[32]`, `channelCount`, `frequency`, `preSamples`, `postSamples`, `loopCount`, `measure`, `captureMode`.

### `STREAM_REQUEST` (line 45)
Fields: `channels[32]`, `channelCount`, `chunkSamples`, `frequency`.

### `CHANNEL_MODE` enum (`LogicAnalyzer_Capture.h`, line 9)
`MODE_8_CHANNEL`, `MODE_16_CHANNEL`, `MODE_24_CHANNEL` -- determines DMA transfer size (8/16/32 bits) and samples-per-buffer.

### WiFi Structures (conditional on `USE_CYGW_WIFI`)
- `WIFI_SETTINGS` (line 59): AP name, password, IP address, port, hostname, checksum
- `EVENT_FROM_WIFI` (line 100): event enum + 128-byte data payload
- `EVENT_FROM_FRONTEND` (line 108): event enum + 32-byte data payload
- `POWER_STATUS` (line 116): VSYS voltage (float), VBUS connected (bool)

---

## Global State

### `LogicAnalyzer.c`
- `messageBuffer[160]` (line 91): incoming command reception buffer
- `bufferPos` (line 93): current position in message buffer
- `capturing` (line 95): true when a capture is in progress
- `streaming_active` (line 97): true when streaming is in progress
- `usbDisabled` (line 39, WiFi only): true when a WiFi client is connected (USB input ignored)
- `cywReady` (line 40, WiFi only): set when CYW43 initialization completes on Core 1

### `LogicAnalyzer_Capture.c`
- `capturePIO`, `triggerPIO` (lines 20-21): PIO instance handles
- `sm_Capture`, `sm_Trigger` (lines 23, 26): state machine indices
- `dmaPingPong0`, `dmaPingPong1` (lines 30-31): DMA channel numbers
- `captureBuffer[CAPTURE_BUFFER_SIZE]` (line 67): main capture buffer (4-byte aligned)
- `captureFinished`, `captureProcessed` (lines 52-53): capture state flags
- `loopTimestamp[256]` (line 56): burst measurement timestamp array
- `pinMap[]` (line 64): GPIO pin mapping array from board settings

### `LogicAnalyzer_Stream.c`
- `stream_input[8][4096]` (line 28): DMA input ring buffer (8 slots)
- `stream_output[8][3080]` (line 29): compressed output ring buffer (8 slots)
- `dma_complete_count` (line 33): monotonic DMA completion counter (written by ISR)
- `compress_head` (line 34): monotonic compression counter (written by Core 1)
- `send_head` (line 35): monotonic send counter (written by Core 0)
- `streaming` (line 38): active streaming flag

### `Shared_Buffers.c` (WiFi only)
- `wifiSettings` (line 8): current WiFi configuration (volatile)
- `wifiToFrontend` (line 9): event queue from WiFi core to frontend core
- `frontendToWifi` (line 10): event queue from frontend core to WiFi core

---

## Threading / Core Usage

The RP2350 (and RP2040) is a dual-core processor. The firmware uses both cores:

### Core 0 (Main Core)
- Runs `main()` and the main event loop
- Handles USB CDC serial I/O
- Processes incoming commands
- Transfers captured data to host
- In streaming mode: runs `RunStreamSendLoop()` which sends compressed chunks

### Core 1 (Secondary Core)
Core 1 is used for one of two mutually exclusive purposes depending on mode:

**WiFi Mode** (on W-WiFi boards):
- Core 1 runs `runWiFiCore()` (`LogicAnalyzer_WiFi.c`, line 295)
- Launched at startup via `multicore_launch_core1(runWiFiCore)`
- Runs the CYW43 WiFi driver, TCP server, and processes `frontendToWifi` events
- Calls `multicore_lockout_victim_init()` to support flash writes from Core 0
- Event loop: processes frontend events, runs WiFi state machine, polls CYW43

**Streaming Mode**:
- Core 1 runs `stream_core1_entry()` (`LogicAnalyzer_Stream.c`, line 143)
- Launched via `multicore_launch_core1(stream_core1_entry)` after `multicore_reset_core1()`
- Runs the compression loop: reads DMA-completed input slots, compresses them, writes to output slots
- Sets bus priority for Core 1 SRAM access (`busctrl_hw->priority = (1u << 4)`)
- Terminated via `multicore_reset_core1()` when streaming ends

**Important**: When streaming starts on a WiFi board, Core 1 is reset (`multicore_reset_core1()`) which kills the WiFi core. Streaming and WiFi cannot run simultaneously.

### Inter-Core Communication
- **Event Machine** (`Event_Machine.c`): wraps Pico SDK `queue_t` with a handler function. Used for WiFi <-> frontend communication.
- **Volatile counters**: streaming mode uses `dma_complete_count`, `compress_head`, `send_head` with `__dmb()` memory barriers for lock-free producer-consumer coordination.
- **Multicore lockout**: used during flash writes (`multicore_lockout_start_timeout_us`) to safely pause Core 1.

---

## PIO Programs (`LogicAnalyzer.pio`)

The firmware uses 7 PIO programs for different capture scenarios. All programs use `in pins 32` to read 32 GPIO bits simultaneously.

### 1. `BLAST_CAPTURE` (line 2)
- Simplest capture: waits for trigger pin low (`jmp pin LOOP`), then continuously captures (`in pins 32` in wrap loop)
- Single instruction in steady state -- achieves maximum throughput (1 sample per PIO clock cycle)
- Clock divider: 1:1 with requested frequency (no 2x multiplier)
- Also reused by streaming mode (starting at offset+1 to skip trigger wait)

### 2. `POSITIVE_CAPTURE` (line 15)
- Edge-triggered capture for positive (rising) edge
- Pre-trigger: continuously captures in wrap loop until `jmp pin` detects trigger
- Post-trigger: captures `x` more samples, then loops `y` times
- Signals completion via `irq 0`
- Two instructions per sample in steady state (2x clock needed)

### 3. `NEGATIVE_CAPTURE` (line 52)
- Same as POSITIVE\_CAPTURE but for falling edge (inverted trigger logic)
- Pre-trigger loops while pin is high; transitions to post-capture when pin goes low

### 4. `POSITIVE_CAPTURE_MEASUREBURSTS` (line 89)
- Variant of POSITIVE\_CAPTURE that fires `irq 1` at each loop boundary
- IRQ 1 triggers NMI on the CPU to capture timestamp via SysTick counter
- Used when `measure` flag is set in capture request

### 5. `NEGATIVE_CAPTURE_MEASUREBURSTS` (line 129)
- Falling-edge variant of the burst measurement program

### 6. `COMPLEX_CAPTURE` (line 169)
- Pattern-triggered capture using a separate trigger state machine
- Waits for `irq 7` (from trigger SM) before entering pre-capture loop
- Uses `jmp pin` on `COMPLEX_TRIGGER_IN_PIN` (GPIO 1) which is physically wired to `COMPLEX_TRIGGER_OUT_PIN` (GPIO 0)

### 7. `FAST_CAPTURE` (line 195)
- Like COMPLEX\_CAPTURE but without the `wait irq 7` synchronization
- Used with the fast trigger which uses side-set pins instead of IRQ

### Dynamically Generated PIO Programs

#### `COMPLEX_TRIGGER` (in `LogicAnalyzer_Capture.c`, lines 82-107)
- Stored as a modifiable `uint16_t[]` array, not in `.pio` file
- Reads trigger value, sets trigger output pin low, releases capture via `irq 7`
- Loops reading pins, comparing against trigger pattern
- When match found, sets trigger output pin high
- Instruction at index 5 is patched at runtime to set the trigger pin count (`LogicAnalyzer_Capture.c` line 854)

#### `FAST_TRIGGER` (in `LogicAnalyzer_Capture.c`, lines 117-157)
- 32-instruction jump table dynamically generated by `create_fast_trigger_program()` (line 136)
- Each instruction is either `MOV PC, PINS SIDE 0` (no match) or `JMP self SIDE 1` (match)
- Achieves single-cycle trigger detection at full PIO speed
- Limited to 5-bit patterns (addresses 0-31)
- Uses side-set to signal trigger via `COMPLEX_TRIGGER_OUT_PIN`

### PIO Instance Assignment

| Capture Type | Capture PIO | Trigger PIO |
|-------------|-------------|-------------|
| Simple | `pio0` | N/A |
| Complex | `pio0` | `pio0` (same instance, different SM) |
| Fast | `pio1` | `pio0` |
| Blast | `pio0` | N/A |
| Stream | `pio0` | N/A |

The fast trigger uses PIO1 for capture because the fast trigger program occupies all 32 instruction slots of PIO0. The comment at `LogicAnalyzer_Capture.c` line 633 notes this is also because "the W uses PIO1 to transfer data" (CYW43 WiFi chip).

---

## DMA Usage Patterns

### Capture Mode -- Ping-Pong Circular Buffer (`LogicAnalyzer_Capture.c`)

**`configureCaptureDMAs()`** (line 466):
- Claims two DMA channels (`dmaPingPong0`, `dmaPingPong1`)
- Chained together: when channel 0 finishes, it triggers channel 1, and vice versa
- Both read from `capturePIO->rxf[sm_Capture]` (PIO RX FIFO, no read increment)
- Both write to `captureBuffer` with write increment
- Transfer count: `CAPTURE_BUFFER_SIZE` / bytes-per-sample
- Transfer size: `DMA_SIZE_8` (8ch), `DMA_SIZE_16` (16ch), or `DMA_SIZE_32` (24ch)
- Uses `DMA_IRQ_0` with `dma_handler()` ISR (line 225, `__not_in_flash_func`)
- ISR resets write address back to `captureBuffer` start -- creating a circular buffer
- IRQ priority: 0 (highest)

**`configureBlastDMA()`** (line 423):
- Single DMA channel (no ping-pong needed -- single-shot capture)
- Uses `blast_capture_completed()` as ISR -- fires when transfer is complete
- Sets DMA bus priority to maximum (`BUSCTRL_BUS_PRIORITY_DMA_W_BITS | BUSCTRL_BUS_PRIORITY_DMA_R_BITS`)

### Capture Mode -- Tail Finding (`find_capture_tail()`, line 164)
After capture completes, determines the last written sample position by checking which DMA channel is still busy and reading its `transfer_count` register.

### Streaming Mode -- Ring Buffer (`LogicAnalyzer_Stream.c`)

**`configure_stream_dma()`** (line 91):
- Claims two DMA channels (`stream_dma0`, `stream_dma1`)
- Chained together (same as capture mode)
- Transfer size matches capture mode
- Transfer count: `stream_chunk_samples` (32-1024 samples per slot)
- Uses `DMA_IRQ_1` (not IRQ 0, to avoid conflicts with capture) with shared handler
- ISR `stream_dma_handler()` (line 59, `__not_in_flash_func`):
  - Increments `dma_complete_count`
  - Sets write address to `stream_input[(dma_complete_count + 1) % STREAM_SLOTS]`
  - This cycles the write destination through 8 ring buffer slots

The ring buffer uses three monotonically increasing counters for lock-free coordination:
```
DMA ISR writes:  dma_complete_count  (slot filled by DMA)
Core 1 reads:    compress_head       (slot compressed)
Core 0 reads:    send_head           (slot sent to host)
```
Overflow detected when `dma_complete_count - send_head >= STREAM_SLOTS - 1`.

---

## Stream Compression (`stream_compress.c`)

The compression runs on Core 1 and implements a 4-stage pipeline:

### Stage 1: Bit Transpose
- Uses delta-swap 8x8 butterfly algorithm (~25 ALU ops per 8x8 block) from Hacker's Delight
- Three variants: `transpose_chunk_8ch()`, `transpose_chunk_16ch()`, `transpose_chunk_24ch()`
- Converts interleaved DMA data (samples as rows, channels as columns) into per-channel bitstreams stored in `s_transposed[24][16]` (uint32\_t words)

### Stage 2: Classification
- OR/AND reduction across all words per channel
- Determines: all-zero, all-one, or mixed

### Stage 3: Run Detection
- `count_run()` (line 241): uses `__builtin_ctz()` (compiles to RBIT+CLZ, 2 cycles on Cortex-M33) for O(1) per-word run length counting
- Counts consecutive 0x0 or 0xF nibbles

### Stage 4: Nibble Encoding
- `encode_channel()` (line 286): walks nibbles, emits run-length codes for 0/F runs and greedy raw group codes for mixed data
- 16 nibble prefix codes defined: RAW1-RAW8 for literal groups, ZERO2-ZERO32 and ONE2-ONE32 for run lengths
- Uses `bit_writer_t` accumulator for MSB-first nibble packing
- Early bail: if encoded output exceeds raw size, falls back to raw copy

### Output Format
Per chunk: `[header bytes][channel 0 data][channel 1 data]...`
Header: 2 bits per channel (ALL\_ZERO=1, ALL\_ONE=2, NIBBLE\_ENC=3, RAW=0).

### Bus Priority
`stream_compress_init()` (line 371) sets `busctrl_hw->priority = (1u << 4)` giving Core 1 (PROC1) high priority for SRAM access during compression.

---

## WiFi Subsystem (`LogicAnalyzer_WiFi.c`)

Conditionally compiled when `USE_CYGW_WIFI` is defined (WiFi board variants only).

### WiFi State Machine (`WIFI_STATE_MACHINE` enum, `LogicAnalyzer_WiFi.h` line 9)

States: `VALIDATE_SETTINGS` -> `WAITING_SETTINGS` or `CONNECTING_AP` -> `STARTING_TCP_SERVER` -> `WAITING_TCP_CLIENT` -> `TCP_CLIENT_CONNECTED`

### `runWiFiCore()` (line 295)
- Entry point for Core 1 in WiFi mode
- Initializes `frontendToWifi` event machine with `frontendEvent` handler
- Calls `multicore_lockout_victim_init()` to support flash writes
- Initializes CYW43 and enables STA mode
- Sends `CYW_READY` event to Core 0
- Main loop: processes frontend events, runs WiFi state machine, polls CYW43

### Settings Storage
- WiFi settings stored in last flash sector (offset `FLASH_SETTINGS_OFFSET`)
- RP2040: last sector of 2MB flash (`(2048 * 1024) - FLASH_SECTOR_SIZE`)
- RP2350: last sector of 4MB flash (`(4096 * 1024) - FLASH_SECTOR_SIZE`)
- Settings validated via checksum (sum of all bytes + `0x0f0f`)
- Flash writes use `multicore_lockout_start_timeout_us()` to safely pause Core 1

### TCP Server
- Listens on configured port with backlog of 1
- Single client connection at a time
- When WiFi client connects, USB input is disabled (`usbDisabled = true`)
- Data received via `serverReceiveData()` callback, chunked into 128-byte events pushed to `wifiToFrontend` queue

### Power Monitoring
- Reads VSYS voltage via ADC (GPIO 29, input 3) with 3x voltage divider factor
- Reads VBUS connected state via CYW43 GPIO 2
- Only available over WiFi connection

---

## Event Machine (`Event_Machine.c`)

Generic event queue system wrapping Pico SDK `queue_t`:

```c
typedef struct _EVENT_MACHINE {
    queue_t queue;
    EVENT_HANDLER handler;  // void(*)(void*)
} EVENT_MACHINE;
```

- `event_machine_init()`: creates queue with specified element size and depth
- `event_push()`: blocking enqueue
- `event_process_queue()`: dequeues and dispatches up to `max_events` events
- `event_clear()`: resets read/write pointers
- Thread-safe via `queue_t` (uses spin locks internally)

Two instances used in WiFi mode:
- `wifiToFrontend`: WiFi events (CYW\_READY, CONNECTED, DISCONNECTED, DATA\_RECEIVED, POWER\_STATUS\_DATA)
- `frontendToWifi`: Frontend events (LED\_ON, LED\_OFF, CONFIG\_RECEIVED, SEND\_DATA, GET\_POWER\_STATUS)

---

## LED Handling

LED control is abstracted via macros defined in `LogicAnalyzer.c` (lines 52-88):

| LED Type | `INIT_LED()` | `LED_ON()` | `LED_OFF()` |
|----------|-------------|-----------|------------|
| `GPIO_LED` | `gpio_init` + `gpio_set_dir` | `gpio_put(LED_IO, 1)` | `gpio_put(LED_IO, 0)` |
| `CYGW_LED` (no WiFi) | no-op | `cyw43_arch_gpio_put(LED, 1)` | `cyw43_arch_gpio_put(LED, 0)` |
| `CYGW_LED` (WiFi) | no-op | Sends `LED_ON` event to WiFi core | Sends `LED_OFF` event to WiFi core |
| `WS2812_LED` | `init_rgb()` | `send_rgb(0,32,0)` (green) | `send_rgb(0,0,32)` (blue) |
| `NO_LED` | no-op | no-op | no-op |

For WiFi-enabled CYW43 boards, LED control must go through Core 1 because the CYW43 driver is not thread-safe.

---

## Data Transfer

### USB Transfer (`cdc_transfer()`, `LogicAnalyzer.c` line 177)
- Uses TinyUSB CDC functions (`tud_cdc_write()`, `tud_cdc_write_flush()`)
- Loops until all data sent or USB disconnects
- Before large transfers (capture data), `stdio_usb_deinit()` is called to prevent `tud_task()` reentrancy; `stdio_usb_init()` is called after

### WiFi Transfer (`wifi_transfer()`, `LogicAnalyzer.c` line 213)
- Chunks data into 32-byte `SEND_DATA` events pushed to `frontendToWifi` queue
- WiFi core sends via `tcp_write()` with `TCP_WRITE_FLAG_COPY`

### Streaming Send Loop (`RunStreamSendLoop()`, `LogicAnalyzer_Stream.c` line 374)
- Runs on Core 0, blocking
- Sends 2-byte size prefix + compressed chunk data for each completed slot
- Checks for stop commands via `processUSBInputDirect()` (bypasses stdio since it's disabled)
- Overflow detection: exits if DMA overtakes send position
- Timeout: exits if no data produced in 3 seconds
- Sends EOF marker (`0x0000`) and diagnostic status string on exit

---

## Capture Buffer Post-Processing (`GetBuffer()`, `LogicAnalyzer_Capture.c` line 1217)

After capture completes and before data transfer, the captured data is reordered:
1. Calculates the start position in the circular buffer based on tail position and total sample count
2. For each sample, remaps the captured GPIO bits to the requested channel order
3. Handles blast mode trigger inversion (XORs trigger pin bit if positive edge was used)
4. Processing is done in-place in `captureBuffer`
5. Three code paths for 8/16/24 channel modes (operating on uint8\_t/uint16\_t/uint32\_t arrays respectively)

---

## Burst Timestamp Measurement

For looped captures with `measureBursts` enabled:

1. PIO programs with `_MEASUREBURSTS` suffix fire `irq 1` at each loop boundary (lines 120-121, 160-161 in `.pio`)
2. IRQ 1 is routed to CPU NMI via `syscfg_hw->proc0_nmi_mask` (RP2040) or `EPPB->NMI_MASK0` (RP2350, `LogicAnalyzer_Capture.c` lines 1166-1170)
3. NMI handler `loopEndHandler()` (line 901) reads SysTick counter value and stores it in `loopTimestamp[]`
4. SysTick runs with CPU clock, `sysTickRoll()` handler (line 896) increments `systickLoops` on overflow
5. Timestamp format: lower 24 bits = SysTick counter value, upper 8 bits = overflow count
6. Maximum 256 timestamps (255 loops + initial sync)

---

## Publish / Release Process (`publish.ps1`)

PowerShell script that:
1. Iterates all board types and turbo mode combinations
2. Skips turbo mode for Pico W variants
3. For each combination: updates `LogicAnalyzer_Build_Settings.cmake`, cleans build directory, runs CMake + Ninja
4. Renames output `.uf2` files with board name and turbo suffix
5. Compresses each `.uf2` into a `.zip` file

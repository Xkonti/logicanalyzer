# Logic Analyzer V2 Firmware Structure

Comprehensive reference for the firmware at `Firmware/LogicAnalyzer_V2/`.

---

## 1. Project Organization

| File | Role |
|------|------|
| `LogicAnalyzer.c` | Main entry point, command parser, main loop, USB/WiFi I/O, preview mode |
| `LogicAnalyzer_Capture.c` / `.h` | All capture logic: PIO setup, DMA configuration, trigger handling, buffer post-processing |
| `LogicAnalyzer_Stream.c` / `.h` | Streaming mode: PIO/DMA ring buffer, Core 1 launch, send loop |
| `stream_compress.c` / `.h` | Per-channel nibble-based compression engine (runs on Core 1) |
| `LogicAnalyzer.pio` | PIO assembly programs for all capture/trigger variants |
| `LogicAnalyzer_Board_Settings.h` | Per-board pin maps, buffer sizes, frequency limits, LED type |
| `LogicAnalyzer_Build_Settings.cmake` | User-editable build config: board type selection and turbo mode toggle |
| `LogicAnalyzer_Structs.h` | Shared data structures: `CAPTURE_REQUEST`, `PREVIEW_REQUEST`, `STREAM_REQUEST`, WiFi structs |
| `LogicAnalyzer_WiFi.c` / `.h` | CYW43 WiFi stack: TCP server, AP connection, state machine (runs on Core 1) |
| `Event_Machine.c` / `.h` | Generic inter-core event queue built on Pico SDK `queue_t` |
| `Shared_Buffers.c` / `.h` | Global WiFi settings and event machine instances shared between cores |
| `LogicAnalyzer_W2812.c` / `.h` | Bit-banged WS2812 (NeoPixel) LED driver for the Zero board |
| `CMakeLists.txt` | Build system: SDK init, board-specific compile defs, library linking |
| `pico_sdk_import.cmake` | Standard Pico SDK bootstrap |
| `lwipopts.h` | lwIP configuration for WiFi builds |
| `publish.ps1` | PowerShell script to batch-build all board variants |

Reference files (not compiled):

- `stream_compress_batched.c.ref`, `stream_compress_bitmagic.c.ref`, `stream_compress_hwaccel.c.ref`, `stream_compress_minimal.c.ref` -- four prototype compression implementations kept for reference. The production `stream_compress.c` cherry-picks the best techniques from each.

---

## 2. MCU Targets and Board Variants

The firmware targets the RP2040 (Cortex-M0+) and RP2350 (Cortex-M33) via the Pico SDK. Board selection is done in `LogicAnalyzer_Build_Settings.cmake` (line 3):

```cmake
set(BOARD_TYPE "BOARD_PICO_2_W_WIFI")
```

Supported `BOARD_TYPE` values and their characteristics:

| Board Type | MCU | `PICO_BOARD` | SRAM | `CAPTURE_BUFFER_SIZE` | LED Type | WiFi | Complex Trigger |
|---|---|---|---|---|---|---|---|
| `BOARD_PICO` | RP2040 | `pico` | 264KB | 128KB | GPIO (pin 25) | No | Yes |
| `BOARD_PICO_2` | RP2350 | `pico2` | 520KB | 384KB (128*3*1024) | GPIO (pin 25) | No | Yes |
| `BOARD_PICO_W` | RP2040 | `pico_w` | 264KB | 128KB | CYW43 | No (LED only) | Yes |
| `BOARD_PICO_W_WIFI` | RP2040 | `pico_w` | 264KB | 128KB | CYW43 | Yes | Yes |
| `BOARD_PICO_2_W` | RP2350 | `pico2_w` | 520KB | 384KB | CYW43 | No (LED only) | Yes |
| `BOARD_PICO_2_W_WIFI` | RP2350 | `pico2_w` | 520KB | 384KB | CYW43 | Yes | Yes |
| `BOARD_ZERO` | RP2040 | `pico` | 264KB | 128KB | WS2812 (pin 16) | No | Yes |
| `BOARD_INTERCEPTOR` | RP2040 | `pico` | 264KB | 128KB | None | No | Yes, 28 channels |

RP2350 boards define `CORE_TYPE_2`, which gates RP2350-specific code (e.g., `RP2350.h` includes, NMI mask register differences at `EPPB->NMI_MASK0` vs `syscfg_hw->proc0_nmi_mask`, larger flash settings offset).

---

## 3. Build System

### CMake Structure

`CMakeLists.txt` orchestrates the build:

1. **SDK version**: Pico SDK 2.1.1, toolchain 14_2_Rel1 (lines 18-19).
2. **Board selection**: Includes `LogicAnalyzer_Build_Settings.cmake`, which sets `BOARD_TYPE` and `TURBO_MODE`. CMake maps this to `PICO_BOARD` and compile definitions (lines 29-55).
3. **Source collection**: All `.c` files in the directory are compiled via `FILE(GLOB CSources *.c)` (line 80).
4. **PIO header generation**: `pico_generate_pio_header()` compiles `LogicAnalyzer.pio` into `LogicAnalyzer.pio.h` (lines 92-94).
5. **Firmware version**: Hardcoded as `V6_5` / program version `6.5` (lines 97-98).
6. **USB identity**: VID `0x1209`, PID `0x3020`, manufacturer "Dr. Gusman", product "LogicAnalyzer" (line 166).

### Key Build Settings

- **RAM-only execution**: For `BOARD_PICO`, `BOARD_ZERO`, and `BOARD_PICO_2`, `pico_set_binary_type(LogicAnalyzer copy_to_ram)` copies the entire binary to RAM for maximum timing precision (line 87).
- **Turbo mode**: 400 MHz overclock with `VREG_VOLTAGE_1_30`. Forbidden on Pico W variants. Doubles `MAX_FREQ` to 200 MHz and `MAX_BLAST_FREQ` to 400 MHz (CMakeLists.txt lines 57-60, LogicAnalyzer.c lines 826-833).
- **Release vs Debug**: Non-W boards default to Release; W boards force Debug (lines 62-67, 37, 44).
- **STDIO**: USB stdio enabled, UART disabled (lines 100-101).

### Linked Libraries

```
pico_stdlib, hardware_dma, hardware_pio, hardware_clocks, hardware_flash,
hardware_adc, hardware_exception, hardware_vreg, pico_multicore,
pico_base_headers, cmsis_core, ${CYW_LIB}
```

`CYW_LIB` is `pico_cyw43_arch_none` for W-without-WiFi, or `pico_cyw43_arch_lwip_poll` for WiFi builds.

### Publish Script

`publish.ps1` iterates all board types and turbo mode combinations, building each and producing `.uf2` files packaged into `.zip` archives.

---

## 4. Main Loop Architecture

### Initialization (`main()`, LogicAnalyzer.c line 824)

1. **Clock setup**: 200 MHz default, 400 MHz in turbo mode (with voltage regulator override).
2. **SysTick enable**: `systick_hw->csr = 0x05` -- enabled with CPU clock, no interrupt (used later for burst timing).
3. **Startup delay**: Derived from the board's unique ID to stagger USB enumeration when multiple devices are connected (lines 844-854).
4. **STDIO init**: `stdio_init_all()` initializes USB CDC stdio.
5. **CYW43 init** (W boards): For non-WiFi W builds, just `cyw43_arch_init()`. For WiFi builds, initializes the event machine and launches Core 1 with `runWiFiCore()`, then blocks until `CYW_READY` is received (lines 859-866).
6. **LED init**: Board-specific (GPIO, CYW43, WS2812, or no-op).

### Main Loop (`while(1)`, line 878)

The main loop is a simple state dispatcher with four mutually exclusive branches:

```
if (capturing)        -> poll IsCapturing(), transfer data when done, check for cancel
else if (streaming)   -> RunStreamSendLoop() (blocking), then CleanupStream()
else if (previewing)  -> runPreview() (blocking loop)
else                  -> idle: handle LED blink, call processInput()
```

**Idle state**: `processInput()` reads USB (and WiFi if enabled) data byte-by-byte, feeding it into the protocol parser.

**Capturing state** (lines 881-1021): Polls `IsCapturing()`. While waiting, the LED blinks every second and `processCancel()` is checked. On USB disconnect during capture, capture is stopped and state is reset. When capture finishes, `stdio_usb_deinit()` is called to prevent TinyUSB reentrancy, then sample data is transferred via `cdc_transfer()` or `wifi_transfer()`, followed by timestamps. `stdio_usb_init()` re-enables the background task afterward.

**Streaming state** (lines 1022-1031): Calls `RunStreamSendLoop()` which blocks until streaming ends, then `CleanupStream()` tears down PIO/DMA/Core 1.

**Preview state** (lines 1032-1035): Calls `runPreview()` which directly reads GPIOs and sends periodic binary packets.

---

## 5. Communication Protocol

### Framing (LogicAnalyzer.c, `processData()`, line 243)

Binary frame format:

- **Start**: `0x55 0xAA`
- **Stop**: `0xAA 0x55`
- **Escape**: `0xF0` followed by `(byte XOR 0xF0)`. Used for bytes `0x55`, `0xAA`, and `0xF0` within data.

The frame body starts with a **command byte** (byte index 2), followed by command-specific payload deserialized as a C struct.

### Commands

| Cmd | Name | Payload | Response |
|-----|------|---------|----------|
| 0 | ID request | None | `LOGIC_ANALYZER_<BOARD>_<VERSION>\n`, `FREQ:<n>\n`, `BLASTFREQ:<n>\n`, `BUFFER:<n>\n`, `CHANNELS:<n>\n` |
| 1 | Capture | `CAPTURE_REQUEST` struct | `CAPTURE_STARTED\n` or `CAPTURE_ERROR\n` |
| 2 | WiFi settings | `WIFI_SETTINGS_REQUEST` struct | `SETTINGS_SAVED\n` (WiFi only) |
| 3 | Power status | None | Voltage string via WiFi |
| 4 | Bootloader | None | `RESTARTING_BOOTLOADER\n`, then `reset_usb_boot()` |
| 5 | Blink on | None | `BLINKON\n` |
| 6 | Blink off | None | `BLINKOFF\n` |
| 7 | Start preview | `PREVIEW_REQUEST` struct | `PREVIEW_STARTED\n` |
| 8 | Stop preview | None | `PREVIEW_STOPPED\n` |
| 10 | Start stream | `STREAM_REQUEST` struct | `STREAM_STARTED\n` + 8-byte info header |
| 11 | Stop stream | None | (streaming ends, sends EOF + status) |

---

## 6. Dual-Core Usage

### Non-WiFi Builds

**Core 0**: Runs the main loop -- command parsing, capture state management, preview mode, and data transfer.

**Core 1**: Used only during streaming mode. `StartStream()` calls `multicore_reset_core1()` then `multicore_launch_core1(stream_core1_entry)` (LogicAnalyzer_Stream.c line 304). Core 1 runs the compression loop (`stream_core1_entry`, line 143), consuming DMA-completed slots, compressing them via `stream_compress_chunk_mapped()`, and incrementing `compress_head`. When streaming stops, `CleanupStream()` calls `multicore_reset_core1()` to halt Core 1.

### WiFi Builds (`USE_CYGW_WIFI`)

**Core 0**: Main loop (same as above).

**Core 1**: Runs `runWiFiCore()` (LogicAnalyzer_WiFi.c line 295) permanently. This function:

1. Initializes the `frontendToWifi` event machine.
2. Calls `multicore_lockout_victim_init()` so Core 0 can pause Core 1 for flash operations.
3. Initializes `cyw43_arch` and enables STA mode.
4. Sends `CYW_READY` event to Core 0.
5. Loops forever: processes frontend events, runs the WiFi state machine, and polls `cyw43_arch_poll()`.

**Inter-core communication** uses two `EVENT_MACHINE` instances (built on Pico SDK `queue_t`, which is multicore-safe):

- `frontendToWifi`: Core 0 -> Core 1. Events: `LED_ON`, `LED_OFF`, `CONFIG_RECEIVED`, `SEND_DATA`, `GET_POWER_STATUS`.
- `wifiToFrontend`: Core 1 -> Core 0. Events: `CYW_READY`, `CONNECTED`, `DISCONNECTED`, `DATA_RECEIVED`, `POWER_STATUS_DATA`.

**Conflict**: In WiFi builds, Core 1 is permanently occupied by the WiFi stack. Streaming mode needs Core 1 for compression. The current code calls `multicore_reset_core1()` before launching the compression entry point, which kills the WiFi core. This means streaming and WiFi cannot be used simultaneously in the current architecture.

---

## 7. PIO Programs

All PIO programs are defined in `LogicAnalyzer.pio`. Each captures 32 bits per `IN` instruction (reading all GPIO pins in parallel). The clock divider determines sample rate. All programs use **autopush** to push complete 32-bit words to the RX FIFO automatically.

### Capture Programs (loaded into PIO0 or PIO1)

| Program | Purpose | Instructions | Trigger | Speed |
|---------|---------|-------------|---------|-------|
| `BLAST_CAPTURE` | Maximum-speed single-shot capture | 2 (jmp + in) | Edge via `jmp pin` at offset 0, then continuous `in pins 32` | 1 instr/sample (1:1 clock) |
| `POSITIVE_CAPTURE` | Edge-triggered with pre/post and loop support | ~14 | Positive edge via `jmp pin` | 2 instr/sample (2:1 clock) |
| `NEGATIVE_CAPTURE` | Same but negative edge | ~14 | Negative edge (pin high = keep sampling) | 2 instr/sample |
| `POSITIVE_CAPTURE_MEASUREBURSTS` | Like POSITIVE but fires IRQ 1 at loop boundaries | ~16 | Positive edge | 2 instr/sample |
| `NEGATIVE_CAPTURE_MEASUREBURSTS` | Like NEGATIVE with burst measurement | ~16 | Negative edge | 2 instr/sample |
| `COMPLEX_CAPTURE` | Pattern-triggered capture | ~8 | External trigger pin (driven by COMPLEX_TRIGGER program) | 2 instr/sample |
| `FAST_CAPTURE` | Pattern-triggered capture without IRQ wait | ~8 | External trigger pin (driven by FAST_TRIGGER program) | 2 instr/sample |

### Trigger Programs (run on a separate state machine or PIO unit)

| Program | Purpose | Notes |
|---------|---------|-------|
| `COMPLEX_TRIGGER` | Multi-bit pattern match | Stored in volatile memory so instruction 5 can be patched at runtime to set the pin count (`out y, N`). Reads pins into OSR, shifts N bits into Y, compares with X. Sets output pin high when matched. Runs at max clock speed. Defined in `LogicAnalyzer_Capture.c` lines 82-106. |
| `FAST_TRIGGER` | 5-bit pattern match via jump table | All 32 instructions form a lookup table. Each is `MOV PC, PINS SIDE 0` except addresses matching the pattern, which are `JMP self SIDE 1`. The entire PIO instruction memory is consumed. Generated dynamically by `create_fast_trigger_program()` (line 136). |

### Streaming

Streaming reuses `BLAST_CAPTURE` but starts at offset+1 (skipping the trigger `jmp pin` instruction) for continuous free-running capture (`setup_stream_pio()`, LogicAnalyzer_Stream.c line 216).

---

## 8. DMA Usage Patterns

### Capture Mode: Ping-Pong Circular Buffer

Two DMA channels (`dmaPingPong0`, `dmaPingPong1`) are chained together to form a continuous circular write into `captureBuffer` (128KB or 384KB). Each channel transfers `CAPTURE_BUFFER_SIZE / bytes_per_sample` samples from the PIO RX FIFO into the buffer. When one channel completes, it fires `DMA_IRQ_0`, and the handler (`dma_handler()`, line 225) resets the write address back to the start of `captureBuffer`. The chained channel immediately starts writing, creating an unbroken circular capture.

**Transfer size** depends on channel mode:

- `MODE_8_CHANNEL`: `DMA_SIZE_8` (1 byte/sample)
- `MODE_16_CHANNEL`: `DMA_SIZE_16` (2 bytes/sample)
- `MODE_24_CHANNEL`: `DMA_SIZE_32` (4 bytes/sample)

The `dma_handler` is placed in RAM (`__not_in_flash_func`) for deterministic latency.

When the PIO program fires IRQ 0 (capture complete), a PIO interrupt handler (e.g., `simple_capture_completed()`) calls `find_capture_tail()` to read the DMA transfer counter and determine the exact sample position, then aborts both DMA channels.

### Blast Mode: Single-Shot DMA

Uses a single DMA channel (`dmaPingPong0` only) with no chaining. Transfers exactly the requested number of samples. On completion, `blast_capture_completed()` fires via `DMA_IRQ_0`. DMA is given full bus priority (`BUSCTRL_BUS_PRIORITY_DMA_W_BITS | BUSCTRL_BUS_PRIORITY_DMA_R_BITS`) during blast capture for maximum throughput.

### Streaming Mode: Ring Buffer

Two DMA channels are chained in a ring over `STREAM_SLOTS` (8) input slots, each `STREAM_INPUT_SLOT_SIZE` (4096) bytes. Uses `DMA_IRQ_1` (to avoid conflicts with capture's `DMA_IRQ_0`). The ISR (`stream_dma_handler()`, line 59) increments `dma_complete_count` and pre-configures the completed channel's write address to the slot two ahead (N+2), since the other channel is currently writing slot N+1.

The producer-consumer pipeline:

```
DMA ISR increments dma_complete_count
    -> Core 1 compresses slot when compress_head < dma_complete_count
       -> Core 0 sends slot when send_head < compress_head
```

Overflow is detected when `dma_complete_count - send_head >= STREAM_SLOTS - 1`.

---

## 9. GPIO Pin Mapping and Board Configurations

Pin mapping is defined in `LogicAnalyzer_Board_Settings.h` via the `PIN_MAP` macro, which initializes the `pinMap[]` array (declared in `LogicAnalyzer_Capture.c` line 64, extern'd in `.h` line 29).

### Standard Pico / Pico 2 / Pico W Variants

```c
#define INPUT_PIN_BASE 2
#define COMPLEX_TRIGGER_OUT_PIN 0
#define COMPLEX_TRIGGER_IN_PIN 1
#define PIN_MAP {2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,26,27,28,COMPLEX_TRIGGER_IN_PIN}
#define MAX_CHANNELS 24
```

- GPIO 0-1: Reserved for complex/fast trigger interconnect (output and input).
- GPIO 2-22: Channels 0-20 (21 channels, consecutive).
- GPIO 26-28: Channels 21-23 (ADC-capable pins repurposed as digital inputs).
- GPIO 23-25: Not used for capture (GPIO 25 = LED on Pico/Pico 2).
- The last entry in `PIN_MAP` is always `COMPLEX_TRIGGER_IN_PIN` so the trigger pin can be referenced as a channel.

### Zero Board

```c
#define INPUT_PIN_BASE 0
#define COMPLEX_TRIGGER_OUT_PIN 17
#define COMPLEX_TRIGGER_IN_PIN 18
#define LED_IO 16   // WS2812
#define PIN_MAP {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,26,27,28,29,22,23,24,25,COMPLEX_TRIGGER_IN_PIN}
```

Uses GPIO 0-15 as channels 0-15, with pins 26-29 and 22-25 filling channels 16-23. GPIO 16 drives the WS2812 LED. Trigger interconnect is on GPIO 17-18.

### Interceptor Board

```c
#define INPUT_PIN_BASE 2
#define PIN_MAP {6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,2,3,4,5,COMPLEX_TRIGGER_IN_PIN}
#define MAX_CHANNELS 28
```

The only board with 28 channels (all others have 24). No LED. Pin map starts at GPIO 6 and wraps around.

### How Pin Mapping Works in Practice

The PIO `in pins 32` instruction always reads 32 GPIO pins starting at `INPUT_PIN_BASE`. The captured 32-bit word contains raw GPIO state. After capture, `GetBuffer()` (LogicAnalyzer_Capture.c line 1217) post-processes the buffer to reorder bits: for each sample, it extracts the bit at position `(lastCapturePins[ch] - INPUT_PIN_BASE)` and places it at bit position `ch` in the output. This remaps arbitrary GPIO positions to sequential channel indices.

For streaming, the channel map is applied during compression on Core 1 via `stream_compress_chunk_mapped()`, which transposes only the selected DMA bit positions.

---

## 10. USB (TinyUSB CDC) and WiFi (CYW43) Communication Paths

### USB Communication

The firmware uses Pico SDK's `stdio_usb` (backed by TinyUSB CDC) for standard I/O. Input is read via `getchar_timeout_us(0)` in `processUSBInput()` (line 555). Output for string responses uses `printf()` via `sendResponse()`.

For bulk data transfer (capture buffers, preview packets, stream chunks), `cdc_transfer()` (line 180) writes directly to TinyUSB's CDC endpoint. It loops calling `tud_cdc_write()` / `tud_cdc_write_flush()` / `tud_task()` until all data is sent.

**STDIO reentrancy problem**: The `stdio_usb` background task periodically calls `tud_task()`. When the firmware also calls `tud_task()` inside `cdc_transfer()`, reentrancy can corrupt TinyUSB state. Solution: `stdio_usb_deinit()` is called before any `cdc_transfer()` sequence (capture transfer at line 898, preview at line 738, stream at line 301), and `stdio_usb_init()` is called afterward. During this window, USB input is read via `processUSBInputDirect()` (line 577) which calls `tud_cdc_read()` directly instead of going through stdio.

### WiFi Communication

Available only when `USE_CYGW_WIFI` is defined. The WiFi stack runs on Core 1 (`runWiFiCore()`). It manages:

1. **Settings validation**: WiFi credentials stored in the last sector of flash (offset `FLASH_SETTINGS_OFFSET`). Checksummed to detect uninitialized flash.
2. **AP connection**: `cyw43_arch_wifi_connect_timeout_ms()` with WPA2-AES-PSK.
3. **TCP server**: Listens on the configured port using lwIP in polling mode (`pico_cyw43_arch_lwip_poll`). Single client connection.
4. **Data path**: Received TCP data is split into 128-byte chunks and pushed as `DATA_RECEIVED` events to Core 0. Outgoing data is sent via `SEND_DATA` events from Core 0 to Core 1, which calls `tcp_write()`.

The WiFi state machine (`processWifiMachine()`, LogicAnalyzer_WiFi.c line 216) progresses through: `VALIDATE_SETTINGS` -> `CONNECTING_AP` -> `STARTING_TCP_SERVER` -> `WAITING_TCP_CLIENT` -> `TCP_CLIENT_CONNECTED`.

When a WiFi client connects, `usbDisabled` is set to `true` on Core 0, which stops USB input processing (but USB is not physically disabled). When the client disconnects, USB input resumes.

---

## 11. Operating Modes

### Capture Mode

Triggered by command 1. Four trigger types dispatched based on `req->triggerType`:

| Type | Function | Trigger Mechanism | PIO Programs Used | Notes |
|------|----------|-------------------|-------------------|-------|
| 0 (Simple) | `StartCaptureSimple()` | Single-pin edge | `POSITIVE_CAPTURE` or `NEGATIVE_CAPTURE` (optionally `_MEASUREBURSTS` variants) | Supports pre/post samples, loop count, burst measurement |
| 1 (Complex) | `StartCaptureComplex()` | Multi-bit pattern (up to 16 bits) | `COMPLEX_CAPTURE` + `COMPLEX_TRIGGER` (2 SMs on PIO0) | Trigger program dynamically patched for pin count |
| 2 (Fast) | `StartCaptureFast()` | Multi-bit pattern (up to 5 bits) | `FAST_CAPTURE` (PIO1) + `FAST_TRIGGER` (PIO0, all 32 instructions) | Jump-table trigger at max clock speed |
| 3 (Blast) | `StartCaptureBlast()` | Single-pin edge | `BLAST_CAPTURE` (1 instruction per sample) | Highest speed: up to 400 MHz in turbo mode, no pre-samples |

Complex and Fast triggers require `SUPPORTS_COMPLEX_TRIGGER` (defined for all boards). They use a hardware interconnect between GPIO 0 (trigger output) and GPIO 1 (capture JMP pin) to signal the trigger asynchronously between state machines.

Channel modes determine DMA transfer width:

- `MODE_8_CHANNEL`: channels 0-7, 1 byte/sample
- `MODE_16_CHANNEL`: channels 0-15, 2 bytes/sample
- `MODE_24_CHANNEL`: channels 0-23, 4 bytes/sample (32-bit DMA, only lower 24 bits meaningful)

The mode is set by the host via `req->captureMode`.

### Preview Mode

Triggered by command 7. A lightweight real-time monitoring mode that does NOT use PIO or DMA. Instead, `runPreview()` (LogicAnalyzer.c line 709) directly reads GPIO state via `gpio_get_all()` in a timed loop.

Each iteration:

1. Reads `samplesPerInterval` GPIO snapshots.
2. Packs requested channel bits into bytes (LSB-first).
3. Sends a binary packet: `[0xAB, 0xCD, samplesPerInterval, channelCount, ...packed data...]`.
4. Sleeps for `intervalUs` microseconds (minimum 1000 us).
5. Checks for incoming stop command (command 8).

Maximum 16 samples per interval, minimum interval 1000 us. This gives approximately 1000 Hz update rate at minimum interval.

### Streaming Mode

Triggered by command 10. A continuous real-time capture with compression, using both cores.

**Startup** (`StartStream()`, LogicAnalyzer_Stream.c line 225):

1. Determines `CHANNEL_MODE` from highest selected channel number.
2. Computes actual PIO frequency (clamped by clock divider range).
3. Validates and clamps chunk size to `[32, 1024]`, multiple of 32.
4. Sets up PIO using `BLAST_CAPTURE` at offset+1 (skipping trigger).
5. Configures DMA ring buffer (8 slots, chained ping-pong).
6. Disables `stdio_usb`, resets Core 1, launches compression entry point.
7. Enables PIO.
8. Sends `STREAM_STARTED\n` + 8-byte info header (chunk size, channel count, actual frequency).

**Data pipeline**:

- **DMA** (IRQ-driven): Fills 8-slot ring buffer with raw samples.
- **Core 1** (`stream_core1_entry`): Compresses each completed slot via `stream_compress_chunk_mapped()`. Sets bus priority for SRAM access. Increments `compress_head`.
- **Core 0** (`RunStreamSendLoop()`): Sends each compressed chunk as `[2-byte size][compressed data]`. Checks for stop command and USB disconnect. Detects overflow and timeout (3 seconds with no data).

**Compression** (`stream_compress.c`): Per-channel nibble-based encoding:

1. **Transpose**: 8x8 bit-matrix transpose (delta-swap butterfly, ~25 ALU ops per block) converts interleaved DMA samples into per-channel bitstreams.
2. **Classify**: OR/AND reduce determines if channel is all-zero, all-one, or mixed.
3. **Encode**: Mixed channels use nibble prefix codes with CLZ/CTZ-based run detection (O(1) per 32-bit word on Cortex-M33) and greedy raw group selection. Early bail if encoding exceeds raw size.

Output format per chunk: `[header: ceil(channels/4) bytes, 2 bits/channel]` followed by per-channel data (raw, encoded, or nothing for constant channels).

**Shutdown**: `StopStream()` sets `streaming = false`. `RunStreamSendLoop()` exits, flushes remaining chunks, sends `0x0000` EOF marker and a diagnostic status line. `CleanupStream()` stops Core 1, PIO, DMA, and re-enables `stdio_usb`.

---

## 12. Key Constants and Limits

| Constant | Pico | Pico 2 | Notes |
|----------|------|--------|-------|
| `MAX_FREQ` | 100 MHz (200 MHz turbo) | 100 MHz (200 MHz turbo) | Normal capture modes |
| `MAX_BLAST_FREQ` | 200 MHz (400 MHz turbo) | 200 MHz (400 MHz turbo) | Blast capture only |
| `CAPTURE_BUFFER_SIZE` | 128 KB | 384 KB | Shared circular buffer |
| `MAX_CHANNELS` | 24 (28 for Interceptor) | 24 | |
| `STREAM_SLOTS` | 8 | 8 | Ring buffer depth |
| `STREAM_MAX_CHUNK` | 1024 | 1024 | Samples per chunk |
| `STREAM_INPUT_SLOT_SIZE` | 4096 bytes | 4096 bytes | 1024 samples * 4 bytes (worst case) |
| System clock | 200 MHz (400 MHz turbo) | 200 MHz (400 MHz turbo) | |
| `FLASH_SETTINGS_OFFSET` | 2MB - 4KB | 4MB - 4KB | WiFi settings storage |

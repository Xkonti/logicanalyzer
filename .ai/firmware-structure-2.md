# LogicAnalyzer V2 Firmware — Runtime Architecture & Internals

This document provides a deep dive into the runtime behavior of the LogicAnalyzer V2 firmware located in `Firmware/`. It covers core assignment, interrupt handling, memory layout, state machines, communication abstraction, PIO programs, DMA configuration, error handling, and recovery mechanisms.

---

## 1. Dual-Core Runtime Architecture

The RP2040/RP2350 has two cores. The firmware assigns them different roles depending on the active operating mode.

### 1.1 Core 0 — Main Application Core

Core 0 runs the main event loop (`main()` in `LogicAnalyzer.c:654`). It is responsible for:

- **Idle mode**: Polling for USB and WiFi input, processing commands, blinking LEDs.
- **Capture mode**: Polling `IsCapturing()` to detect when PIO/DMA capture completes, then post-processing the buffer and transferring data to the host via `cdc_transfer()` or `wifi_transfer()`.
- **Streaming mode**: Running `RunStreamSendLoop()` (`LogicAnalyzer_Stream.c:374`), which sends compressed chunks produced by Core 1 over USB/WiFi, while also polling for stop commands.

### 1.2 Core 1 — Secondary Core

Core 1's role changes based on the firmware mode and build configuration:

- **WiFi builds (`USE_CYGW_WIFI`)**: Core 1 runs `runWiFiCore()` (`LogicAnalyzer_WiFi.c:295`) permanently. It initializes the CYW43 WiFi chip, manages the WiFi state machine, processes TCP connections, and handles LED control. It calls `multicore_lockout_victim_init()` (line 298) so Core 0 can temporarily lock it out during flash writes.

- **Streaming mode**: Core 1 is repurposed. `multicore_reset_core1()` kills whatever Core 1 was doing, then `multicore_launch_core1(stream_core1_entry)` (`LogicAnalyzer_Stream.c:304`) launches the compression loop. After streaming ends, `CleanupStream()` calls `multicore_reset_core1()` again (line 344).

- **Capture mode**: Core 1 is not explicitly used. If WiFi is enabled, the WiFi core continues running independently.

### 1.3 Core Coordination Mechanisms

| Mechanism | Usage | Location |
|-----------|-------|----------|
| `multicore_launch_core1()` | Launch WiFi core or compression core | `LogicAnalyzer.c:693`, `LogicAnalyzer_Stream.c:304` |
| `multicore_reset_core1()` | Kill Core 1 before re-launching for streaming | `LogicAnalyzer_Stream.c:303,344` |
| `multicore_lockout_start_timeout_us()` | Pause Core 1 during flash writes | `LogicAnalyzer.c:114` |
| `multicore_lockout_victim_init()` | Core 1 registers as lockout victim | `LogicAnalyzer_WiFi.c:298` |
| Event queues (`EVENT_MACHINE`) | Cross-core communication for WiFi builds | `Shared_Buffers.c:9-10` |
| Volatile counters (`dma_complete_count`, `compress_head`, `send_head`) | Lock-free producer-consumer for streaming | `LogicAnalyzer_Stream.c:33-35` |
| `__dmb()` (data memory barrier) | Ensures compressed output is visible to Core 0 | `LogicAnalyzer_Stream.c:162` |

---

## 2. Interrupt Handlers and Their Roles

### 2.1 DMA Interrupts

#### Capture Mode — `DMA_IRQ_0`

**Handler**: `dma_handler()` (`LogicAnalyzer_Capture.c:225`)

Marked `__not_in_flash_func` for speed. When either ping-pong DMA channel completes a full buffer transfer, this handler resets its write address back to the start of `captureBuffer`, creating a circular buffer. Used in simple, complex, and fast capture modes.

```
DMA0 completes -> IRQ0 -> dma_handler() -> reset DMA0 write addr to captureBuffer start
DMA1 completes -> IRQ0 -> dma_handler() -> reset DMA1 write addr to captureBuffer start
```

**Handler**: `blast_capture_completed()` (`LogicAnalyzer_Capture.c:344`)

For blast capture mode, a single DMA channel is used. When it completes, this ISR stops everything (disables DMA, removes PIO program, unclaims resources) and sets `captureFinished = true`.

#### Streaming Mode — `DMA_IRQ_1`

**Handler**: `stream_dma_handler()` (`LogicAnalyzer_Stream.c:59`)

Also `__not_in_flash_func`. Uses IRQ1 (not IRQ0) to avoid conflicts with capture mode handlers. Implements a ring buffer of `STREAM_SLOTS` (8) slots. When DMA channel N completes writing slot S, the handler increments `dma_complete_count` and points DMA channel N to slot S+2 (the slot after the one the other channel is currently writing).

### 2.2 PIO Interrupts

**PIO IRQ 0** — Capture completion signal. The PIO capture programs emit `irq 0` when post-trigger sampling is done. This triggers:
- `simple_capture_completed()` (`LogicAnalyzer_Capture.c:377`) — for simple edge captures
- `complex_capture_completed()` (`LogicAnalyzer_Capture.c:308`) — for complex pattern captures

These handlers disable GPIOs, find the DMA tail position, abort DMAs, clean up PIO state machines, and set `captureFinished = true`.

**PIO IRQ 1** — Burst timestamp capture. The `MEASUREBURSTS` PIO programs emit `irq 1` at each loop boundary. This is routed as a **Non-Maskable Interrupt (NMI)** via:
- RP2040: `syscfg_hw->proc0_nmi_mask = 1 << PIO0_IRQ_1` (`LogicAnalyzer_Capture.c:1169`)
- RP2350: `EPPB->NMI_MASK0 = 1 << PIO0_IRQ_1` (`LogicAnalyzer_Capture.c:1167`)

**NMI Handler**: `loopEndHandler()` (`LogicAnalyzer_Capture.c:901`) — Records `systick_hw->cvr | systickLoops << 24` into `loopTimestamp[]` array. The NMI route ensures zero-jitter timestamps even during DMA activity.

### 2.3 SysTick Interrupt

**Handler**: `sysTickRoll()` (`LogicAnalyzer_Capture.c:896`) — Increments `systickLoops` counter when the 24-bit SysTick counter wraps. This extends the timestamp range beyond the 24-bit SysTick limit. Configured with reload value `0x00FFFFFF` and CPU clock source (`LogicAnalyzer_Capture.c:1179-1181`).

### 2.4 Fast Trigger Polling (No Interrupt)

The fast trigger PIO program does not use an interrupt to signal completion. Instead, `check_fast_interrupt()` (`LogicAnalyzer_Capture.c:301-304`) polls `capturePIO->irq & 1` from the main loop. This workaround exists because "the W messes the PIO interrupts" (comment on line 300).

---

## 3. Memory Layout

### 3.1 Capture Buffer

```c
static uint8_t captureBuffer[CAPTURE_BUFFER_SIZE] __attribute__((aligned(4)));
```
(`LogicAnalyzer_Capture.c:67`)

Size varies by board:
| Board | `CAPTURE_BUFFER_SIZE` |
|-------|-----------------------|
| Pico, Pico W, Pico W WiFi, Zero | 128 KB (`128 * 1024`) |
| Pico 2, Pico 2 W, Pico 2 W WiFi | 384 KB (`128 * 3 * 1024`) |

This buffer is reused across all capture modes. The effective sample count depends on the channel mode:
- **8-channel**: 1 byte/sample, full buffer = `CAPTURE_BUFFER_SIZE` samples
- **16-channel**: 2 bytes/sample, half as many samples
- **24-channel**: 4 bytes/sample, quarter as many samples

In simple/complex/fast capture modes, the buffer is used as a **circular buffer** via DMA ping-pong chaining. In blast mode, it is a **linear buffer** filled by a single DMA transfer.

### 3.2 Streaming Buffers

```c
static uint8_t  stream_input[STREAM_SLOTS][STREAM_INPUT_SLOT_SIZE]  __attribute__((aligned(4)));
static uint8_t  stream_output[STREAM_SLOTS][STREAM_OUTPUT_SLOT_SIZE] __attribute__((aligned(4)));
static uint32_t stream_output_size[STREAM_SLOTS];
```
(`LogicAnalyzer_Stream.c:28-30`)

- `STREAM_SLOTS` = 8
- `STREAM_INPUT_SLOT_SIZE` = 4096 bytes (1024 samples * 4 bytes for 24ch worst case)
- `STREAM_OUTPUT_SLOT_SIZE` = 3080 bytes (max compressed output for 24ch/1024 samples)

Total streaming buffer footprint: 8 * (4096 + 3080) + 32 = ~57 KB in `.bss`.

### 3.3 Compression Transposition Buffer

```c
static uint32_t s_transposed[SC_MAX_CHANNELS][SC_MAX_CHUNK_WORDS] __attribute__((aligned(4)));
```
(`stream_compress.c:37-38`)

24 channels * 32 words * 4 bytes = 3,072 bytes. Stores the bit-transposed representation of one chunk during compression.

### 3.4 Timestamp Array

```c
static volatile uint32_t loopTimestamp[256];
```
(`LogicAnalyzer_Capture.c:56`)

1 KB array for burst measurement timestamps. Each entry stores a 24-bit SysTick counter value plus an 8-bit rollover counter in the upper byte.

### 3.5 Message Buffer

```c
uint8_t messageBuffer[160];
```
(`LogicAnalyzer.c:91`)

160 bytes for receiving framed protocol messages. Sized to accommodate the largest message (`WIFI_SETTINGS_REQUEST` = 148 bytes + framing overhead).

### 3.6 RAM-Only Execution

For Pico, Pico 2, and Zero boards, the entire firmware is compiled as `copy_to_ram` (`CMakeLists.txt:87-88`). This copies the entire program from flash to RAM at boot, eliminating flash access latency during capture. Critical interrupt handlers (`dma_handler`, `stream_dma_handler`, `sysTickRoll`, `loopEndHandler`) are additionally marked `__not_in_flash_func` as a safety measure for WiFi builds where RAM-only mode is not used.

### 3.7 Flash Layout (WiFi Builds)

WiFi settings are stored in the last sector of flash:
- RP2040: offset `(2048 * 1024) - FLASH_SECTOR_SIZE` (`Shared_Buffers.h:10`)
- RP2350: offset `(4096 * 1024) - FLASH_SECTOR_SIZE` (`Shared_Buffers.h:12`)

---

## 4. Firmware State Machine

### 4.1 Main Loop States (Core 0)

The main loop in `LogicAnalyzer.c:708-879` implicitly operates as a state machine driven by two boolean flags:

```
                    +-----------+
                    |   IDLE    |<--------------------------+
                    +-----+-----+                           |
                          |                                 |
              processInput() receives                       |
              capture or stream command                     |
                    |                   |                    |
            capturing=true      streaming_active=true       |
                    |                   |                    |
            +-------v-------+   +------v--------+          |
            |  CAPTURING    |   |   STREAMING   |          |
            |               |   |               |          |
            | Poll          |   | RunStreamSend |          |
            | IsCapturing() |   | Loop()        |          |
            | every ~2s     |   | (blocking)    |          |
            +-------+-------+   +------+--------+          |
                    |                   |                    |
            captureFinished     streaming stops              |
            or cancelled        (stop cmd/overflow/          |
                    |            disconnect/timeout)         |
                    |                   |                    |
            Transfer data       CleanupStream()             |
            via cdc/wifi        streaming_active=false       |
            capturing=false             |                    |
                    |                   |                    |
                    +-------------------+-------------------+
```

### 4.2 Capture Sub-States

Within the CAPTURING state, the firmware follows this flow:
1. **Waiting for trigger**: PIO program loops waiting for trigger condition. DMA continuously fills the circular buffer (pre-trigger data). The main loop blinks the LED and polls for cancel requests every ~2 seconds.
2. **Post-trigger capture**: PIO counts down post-trigger samples, then fires `irq 0`.
3. **Capture complete**: ISR sets `captureFinished = true`. Main loop detects this, post-processes the buffer (channel reordering), disables stdio_usb, and transfers data via `cdc_transfer()` or `wifi_transfer()`.

### 4.3 WiFi State Machine (Core 1)

Defined in `LogicAnalyzer_WiFi.h:10-17` and processed by `processWifiMachine()` (`LogicAnalyzer_WiFi.c:216`):

```
VALIDATE_SETTINGS --> WAITING_SETTINGS    (if checksum invalid)
         |
         v (checksum valid)
   CONNECTING_AP
         |
         v (connected)
STARTING_TCP_SERVER
         |
         v (server started)
WAITING_TCP_CLIENT
         |
         v (client connects via TCP accept callback)
TCP_CLIENT_CONNECTED
         |
         v (client disconnects or error)
WAITING_TCP_CLIENT
```

When new WiFi config arrives (`CONFIG_RECEIVED` event), the machine resets to `VALIDATE_SETTINGS` by calling `killClient()` -> `stopServer()` -> `disconnectAP()` (`LogicAnalyzer_WiFi.c:278-282`).

---

## 5. USB and WiFi Communication Abstraction

The firmware uses a compile-time abstraction layer via `#ifdef USE_CYGW_WIFI` blocks. There is no runtime vtable or function pointer abstraction.

### 5.1 Input Path

```
USB Input:
  getchar_timeout_us(0) -> processData(data, 1, false)
  [processUSBInput(), LogicAnalyzer.c:499]

  tud_cdc_read() -> processData(data, 1, false)
  [processUSBInputDirect(), LogicAnalyzer.c:521 — used during streaming when stdio is disabled]

WiFi Input:
  TCP recv callback -> EVENT_MACHINE queue -> wifiEvent() -> processData(data, len, true)
  [processWiFiInput(), LogicAnalyzer.c:598]
```

The `fromWiFi` boolean propagates through the entire command processing chain to determine the response path.

### 5.2 Output Path

**String responses**: `sendResponse()` (`LogicAnalyzer.c:157`) dispatches to `printf()` (USB) or pushes a `SEND_DATA` event to the WiFi queue.

**Binary data transfer**:
- USB: `cdc_transfer()` (`LogicAnalyzer.c:177`) — Direct TinyUSB CDC writes in a blocking loop. Calls `tud_task()` inline to keep USB alive. Breaks out if `tud_cdc_connected()` returns false.
- WiFi: `wifi_transfer()` (`LogicAnalyzer.c:213`) — Splits data into 32-byte chunks and pushes `SEND_DATA` events. Core 1's `frontendEvent()` handler calls `sendData()` which uses lwIP's `tcp_write()`.

### 5.3 stdio_usb Management

A critical detail: `stdio_usb_deinit()` is called before binary data transfer (capture results at `LogicAnalyzer.c:728`, streaming start at `LogicAnalyzer_Stream.c:301`). This disables the background `tud_task()` that stdio_usb runs, preventing reentrancy with manual `tud_task()` calls in `cdc_transfer()`. It is re-enabled with `stdio_usb_init()` afterward (`LogicAnalyzer.c:816`, `LogicAnalyzer_Stream.c:365`).

### 5.4 WiFi Connection State and USB Exclusivity

When a WiFi client connects, the `CONNECTED` event sets `usbDisabled = true` (`LogicAnalyzer.c:571`), which prevents USB input processing in `processInput()` (`LogicAnalyzer.c:628`). On disconnect, `usbDisabled = false` and pending USB data is purged (`LogicAnalyzer.c:575-576`).

---

## 6. PIO State Machines

The firmware uses up to 8 different PIO programs, loaded into PIO0 and optionally PIO1. All programs are defined in `LogicAnalyzer.pio`.

### 6.1 BLAST_CAPTURE (lines 1-12)

**Purpose**: Fastest possible capture. 1 instruction per sample after trigger.

```asm
LOOP:
    jmp pin LOOP        ; wait for trigger (instruction 0)
.wrap_target
    in pins 32          ; capture (instruction 1)
.wrap
```

- Used by: `StartCaptureBlast()`, `StartStream()` (streaming skips instruction 0)
- PIO: `pio0`
- Clock: 1:1 with requested frequency (no 2x multiplier)
- Autopush: 32-bit words, right-shift
- Trigger: Single pin via `jmp pin`

For streaming, the SM is initialized at `offset + 1` to skip the trigger wait entirely (`LogicAnalyzer_Stream.c:216`).

### 6.2 POSITIVE_CAPTURE / NEGATIVE_CAPTURE (lines 15-86)

**Purpose**: Edge-triggered capture with pre/post samples and loop support.

Structure:
1. Pull loop count and capture length from TX FIFO
2. Pre-capture loop: continuously sample, exit on trigger edge
3. Post-capture loop: count down X register, then check loop counter Y
4. When all loops done: `irq 0` to signal completion, then self-lock

- Used by: `StartCaptureSimple()`
- PIO: `pio0`
- Clock: 2x requested frequency (each sample = 2 PIO cycles: `in` + `jmp`)
- POSITIVE waits for pin HIGH to transition to post-capture
- NEGATIVE waits for pin LOW

### 6.3 POSITIVE/NEGATIVE_CAPTURE_MEASUREBURSTS (lines 89-166)

Same as above but with `irq 1` instructions at loop boundaries for timestamp capture via NMI. Also has an initial `irq wait 1` to synchronize the first timestamp.

### 6.4 COMPLEX_CAPTURE (lines 169-192)

**Purpose**: Pattern-triggered capture using inter-SM signaling.

```asm
    pull
    out x 32            ; read capture length
    wait irq 7          ; wait for trigger SM to be ready
.wrap_target
    in pins 32          ; read sample
    jmp pin POST_CAPTURE
.wrap
```

- Used by: `StartCaptureComplex()`
- PIO: `pio0` (both capture and trigger SMs on same PIO)
- The `wait irq 7` synchronizes with the trigger SM

### 6.5 FAST_CAPTURE (lines 195-216)

Similar to COMPLEX_CAPTURE but without the `wait irq 7` — the trigger is on a separate PIO (`pio1`), connected via physical GPIO wiring.

- Used by: `StartCaptureFast()`
- PIO: `pio1` (capture), `pio0` (trigger)

### 6.6 COMPLEX_TRIGGER (in-memory, LogicAnalyzer_Capture.c:82-96)

**Purpose**: Pattern match trigger using `mov osr, pins` + `out y, N` + `jmp x!=y`.

Stored as a C array (not in .pio file) because instruction 5 (`out y, N`) must be patched at runtime to set the trigger pin count (`LogicAnalyzer_Capture.c:854`). Runs at maximum clock speed regardless of capture frequency.

### 6.7 FAST_TRIGGER (in-memory, LogicAnalyzer_Capture.c:120-157)

**Purpose**: Ultra-fast pattern trigger using a 32-entry jump table.

All 32 instructions are dynamically generated by `create_fast_trigger_program()` (`LogicAnalyzer_Capture.c:136`). Each instruction is either:
- `MOV PC, PINS SIDE 0` (non-matching address) — reads pin state directly into program counter
- `JMP self SIDE 1` (matching address) — locks and sets trigger output high

This achieves single-cycle pattern detection at up to 200MHz, limited to 5-bit patterns. Occupies the entire instruction memory of one PIO block.

---

## 7. DMA Channels

### 7.1 Capture Mode — Ping-Pong Circular Buffer

**Allocation**: Two channels claimed dynamically via `dma_claim_unused_channel(true)` (`LogicAnalyzer_Capture.c:489-490`).

**Configuration** (`configureCaptureDMAs()`, line 466):
- Both channels read from `capturePIO->rxf[sm_Capture]` (PIO RX FIFO, no read increment)
- Both write to `captureBuffer` (with write increment)
- Transfer size: 8-bit (8ch), 16-bit (16ch), or 32-bit (24ch)
- Chained to each other: DMA0 chains to DMA1, DMA1 chains to DMA0
- Both trigger `DMA_IRQ_0`
- IRQ priority set to 0 (highest) (`LogicAnalyzer_Capture.c:517`)
- Transfer count: `CAPTURE_BUFFER_SIZE / bytes_per_sample`
- DMA0 triggered immediately; DMA1 configured but not triggered

When DMA0 finishes its full-buffer transfer, it chains to DMA1. The ISR resets DMA0's write address back to `captureBuffer`. This creates an infinite circular write.

### 7.2 Blast Mode — Single Linear DMA

**Allocation**: One channel (`LogicAnalyzer_Capture.c:441`).

**Configuration** (`configureBlastDMA()`, line 423):
- Single channel, no chaining
- Transfer count = requested sample count
- **Bus priority elevated**: `bus_ctrl_hw->priority = BUSCTRL_BUS_PRIORITY_DMA_W_BITS | BUSCTRL_BUS_PRIORITY_DMA_R_BITS` (`LogicAnalyzer_Capture.c:459`)
- Completion triggers `blast_capture_completed()` ISR which sets `captureFinished`

### 7.3 Streaming Mode — Ring Buffer DMA

**Allocation**: Two channels (`LogicAnalyzer_Stream.c:101-102`).

**Configuration** (`configure_stream_dma()`, line 91):
- Uses `DMA_IRQ_1` (not IRQ0) to avoid conflicts with capture mode (`LogicAnalyzer_Stream.c:125`)
- Shared handler registered via `irq_add_shared_handler()` with highest priority
- Transfer count: `stream_chunk_samples` (32-1024, user configurable)
- DMA0 writes to `stream_input[0]`, DMA1 writes to `stream_input[1]`
- Chained: DMA0 -> DMA1, DMA1 -> DMA0
- On completion, ISR advances `dma_complete_count` and sets the completed channel's write address to `stream_input[(dma_complete_count + 1) % STREAM_SLOTS]`

This creates a rotating ring of 8 input slots. The ISR only updates counters and write addresses; compression happens on Core 1.

### 7.4 DMA Cleanup

All modes follow a consistent cleanup pattern:
1. Clear enable bits: `hw_clear_bits(&dma_hw->ch[N].al1_ctrl, DMA_CH0_CTRL_TRIG_EN_BITS)`
2. Abort channels: `dma_channel_abort(N)`
3. Disable IRQ: `dma_channel_set_irq0_enabled(N, false)` (or IRQ1 for streaming)
4. Remove handler: `irq_remove_handler(DMA_IRQ_0, handler)`
5. Unclaim channels: `dma_channel_unclaim(N)`

See `abort_DMAs()` (`LogicAnalyzer_Capture.c:246`) and `CleanupStream()` (`LogicAnalyzer_Stream.c:341`).

---

## 8. Streaming Pipeline

The streaming mode implements a three-stage producer-consumer pipeline:

```
Stage 1 (DMA ISR):     PIO -> stream_input[slot]     (dma_complete_count++)
Stage 2 (Core 1):      stream_input[slot] -> compress -> stream_output[slot]  (compress_head++)
Stage 3 (Core 0):      stream_output[slot] -> USB/WiFi  (send_head++)
```

### 8.1 Compression Engine (`stream_compress.c`)

The compression runs entirely on Core 1 with elevated bus priority (`busctrl_hw->priority = (1u << 4)`, `stream_compress.c:377`).

**Algorithm (4 stages per chunk)**:

1. **Bit-transpose** (`transpose_chunk_Xch()`): Converts interleaved DMA samples (row = sample, column = channel) into per-channel bitstreams using an 8x8 delta-swap butterfly transpose (~25 ALU ops per 8x8 block). Three variants for 8/16/24 channel modes.

2. **Classify** (OR/AND reduce): For each channel, compute `or_all` and `and_all` across all transposed words. If `or_all == 0` the channel is all-zeros; if `and_all == 0xFFFFFFFF` it is all-ones. These are encoded as 2-bit header codes with zero data bytes.

3. **Run detection** (`count_run()`): Uses `__builtin_ctz()` (compiles to single-cycle RBIT+CLZ on Cortex-M33) to find run lengths of 0x0 or 0xF nibbles in O(1) per 32-bit word.

4. **Nibble encoding** (`encode_channel()`): Emits 4-bit prefix codes for runs (ZERO2..ZERO32, ONE2..ONE32) and raw groups (RAW1..RAW8). Uses a bit accumulator that packs nibbles into bytes. Early-bails if encoded size meets or exceeds raw size.

**Output format**: Per-chunk header (2 bits per channel, ceil(N/4) bytes) followed by per-channel data (raw, all-zero, all-one, or nibble-encoded).

### 8.2 Channel Mapping

The `stream_compress_chunk_mapped()` function (`stream_compress.c:451`) transposes all `capture_channels` (8/16/24) but only encodes the channels listed in `channel_map[]`. This allows the user to select a subset of channels while the PIO captures a full byte/word/dword.

---

## 9. Error Handling and Edge Cases

### 9.1 Protocol Errors

- **Buffer overflow**: If `bufferPos >= sizeof(messageBuffer)` (160 bytes), sends `ERR_MSG_OVERFLOW\n` (`LogicAnalyzer.c:253`)
- **Bad framing**: First byte not 0x55 or second byte not 0xAA resets `bufferPos` (`LogicAnalyzer.c:248-251`)
- **Unknown message**: Default case sends `ERR_UNKNOWN_MSG\n` (`LogicAnalyzer.c:467`)
- **Unsupported commands**: WiFi-only commands on non-WiFi builds return `ERR_UNSUPPORTED\n` (`LogicAnalyzer.c:405-409`)
- **Busy state**: Capture/stream commands while already active return `ERR_BUSY\n` (`LogicAnalyzer.c:304-308, 437-440`)
- **Bad parameters**: Invalid channel count, frequency, etc. return `CAPTURE_ERROR\n` or `ERR_PARAMS\n`

### 9.2 Capture Cancellation

During capture wait, the main loop calls `processCancel()` every ~2 seconds (`LogicAnalyzer.c:827`). Any incoming data (regardless of content) triggers `StopCapture()` (`LogicAnalyzer_Capture.c:524`), which:
1. Disables DMA channel enable bits (prevents buffer overrun during cleanup)
2. Saves and disables interrupts
3. Calls the appropriate `*_capture_completed()` handler to clean up PIO/DMA state
4. Restores interrupts

### 9.3 USB Disconnect Detection

- **During capture wait**: `tud_cdc_connected()` check at `LogicAnalyzer.c:835`. If disconnected, capture is stopped and `bufferPos` reset.
- **During data transfer**: `cdc_transfer()` breaks out of its send loop if `tud_cdc_connected()` returns false (`LogicAnalyzer.c:203`).
- **During streaming**: `RunStreamSendLoop()` checks `tud_cdc_connected()` and sets `exit_reason = STREAM_EXIT_DISCONN` (`LogicAnalyzer_Stream.c:432-437`).
- **On reconnection**: `processInput()` detects a new USB connection and resets `bufferPos` to prevent partial message corruption (`LogicAnalyzer.c:621-625`).

### 9.4 Streaming Overflow Detection

If `dma_complete_count - send_head >= STREAM_SLOTS - 1`, DMA is about to overwrite unprocessed slots. The stream is stopped with `STREAM_EXIT_OVERFLOW` (`LogicAnalyzer_Stream.c:441-446`).

### 9.5 Streaming Timeout

If no data is produced within 3 seconds (`time_us_64() - last_data_time > 3000000`), the stream exits with `STREAM_EXIT_TIMEOUT` and diagnostic counters (`LogicAnalyzer_Stream.c:449-453`).

### 9.6 Streaming Termination Protocol

On exit, `RunStreamSendLoop()`:
1. Flushes remaining compressed chunks (`LogicAnalyzer_Stream.c:457-477`)
2. Sends a 2-byte EOF marker `{0x00, 0x00}` (`LogicAnalyzer_Stream.c:480-486`)
3. Sends a diagnostic status string with exit reason and counters (`LogicAnalyzer_Stream.c:489-509`)

### 9.7 WiFi TCP Error Handling

- `serverError()` callback (`LogicAnalyzer_WiFi.c:109`): Kills client, sends `DISCONNECTED` event
- `serverReceiveData()` with null/empty pbuf (`LogicAnalyzer_WiFi.c:123-131`): Treats as disconnect
- `sendData()` write failure (`LogicAnalyzer_WiFi.c:99-106`): Kills client and sends `DISCONNECTED` event
- `acceptConnection()` rejects if a client is already connected (`LogicAnalyzer_WiFi.c:156`)

### 9.8 Flash Write Safety

`storeSettings()` (`LogicAnalyzer.c:109`) uses multiple safety measures:
1. `multicore_lockout_start_timeout_us()` with a huge timeout (10 years in microseconds) to pause Core 1
2. `save_and_disable_interrupts()` to prevent any interrupt during flash operations
3. NOP loops between erase and program operations for flash settling
4. `restore_interrupts()` followed by `multicore_lockout_end_timeout_us()` in a retry loop
5. 500ms post-write delay

### 9.9 WiFi Settings Validation

Settings use a simple additive checksum with a magic constant `0x0f0f` (`LogicAnalyzer_WiFi.c:228-248`, `LogicAnalyzer.c:362-376`). Invalid checksum keeps the WiFi state machine in `WAITING_SETTINGS` (no connection attempted).

---

## 10. Startup and Initialization

### 10.1 Clock Configuration

- **Turbo mode**: Voltage regulator limit disabled, VREG set to 1.30V, system clock set to 400 MHz (`LogicAnalyzer.c:658-663`)
- **Normal mode**: System clock set to 200 MHz (`LogicAnalyzer.c:667`)

### 10.2 Startup Delay

A unique per-device delay is computed from the board's unique ID (`LogicAnalyzer.c:674-684`). This prevents multiple devices on the same USB bus from initializing simultaneously.

### 10.3 SysTick Initialization

`systick_hw->csr = 0x05` enables SysTick with CPU clock source but without interrupt (`LogicAnalyzer.c:672`). The interrupt is only enabled later during burst measurement captures.

### 10.4 WiFi Core Launch (WiFi Builds)

```c
event_machine_init(&wifiToFrontend, wifiEvent, sizeof(EVENT_FROM_WIFI), 8);
multicore_launch_core1(runWiFiCore);
while(!cywReady)
    event_process_queue(&wifiToFrontend, &wifiEventBuffer, 1);
```
(`LogicAnalyzer.c:692-695`)

Core 0 blocks until Core 1 sends a `CYW_READY` event, ensuring the CYW43 chip is initialized before accepting commands.

---

## 11. Watchdog / Reset / Recovery

### 11.1 USB Bootloader Reset

Command 4 triggers `reset_usb_boot(0, 0)` (`LogicAnalyzer.c:417`), which reboots into the USB bootloader for firmware updates. A 1-second delay allows the response string to be transmitted first.

### 11.2 No Hardware Watchdog

The firmware does not use the RP2040/RP2350 hardware watchdog timer. There is no automatic recovery from hangs. The only reset mechanisms are:
- USB bootloader reset command (command 4)
- Physical power cycle
- Host-initiated capture cancellation (any data sent during capture wait)

### 11.3 LED Blink for Device Identification

Commands 5/6 enable/disable LED blinking (`LogicAnalyzer.c:422-433`) for physical device identification when multiple analyzers are connected.

---

## 12. Build Variants

The firmware supports 8 board configurations via `LogicAnalyzer_Build_Settings.cmake`:

| Board | Define | PIO Blocks | Complex Trigger | LED Type | WiFi | Buffer Size |
|-------|--------|------------|-----------------|----------|------|-------------|
| Pico | `BUILD_PICO` | 2 | Yes | GPIO 25 | No | 128 KB |
| Pico 2 | `BUILD_PICO_2` | 2 | Yes | GPIO 25 | No | 384 KB |
| Pico W | `BUILD_PICO_W` | 2 | Yes | CYW43 | No | 128 KB |
| Pico W WiFi | `BUILD_PICO_W_WIFI` | 2 | Yes | CYW43 via events | Yes | 128 KB |
| Pico 2 W | `BUILD_PICO_2_W` | 2 | Yes | CYW43 | No | 384 KB |
| Pico 2 W WiFi | `BUILD_PICO_2_W_WIFI` | 2 | Yes | CYW43 via events | Yes | 384 KB |
| Zero | `BUILD_ZERO` | 2 | Yes | WS2812 GPIO 16 | No | 128 KB |
| Interceptor | `BUILD_INTERCEPTOR` | 2 | Yes | None | No | 128 KB (28ch) |

Key build-time differences:
- `CORE_TYPE_2`: Defined for RP2350-based boards (Pico 2 variants). Affects NMI mask register and flash offset.
- `TURBO_MODE`: 400 MHz overclock, only available on non-W boards. Doubles max frequencies.
- WiFi builds: Force `Debug` build type (cannot use RAM-only execution due to CYW43 driver requirements).
- Non-WiFi non-W builds: Use `Release` + `copy_to_ram` for maximum timing precision.

---

## 13. Event Machine System

The `Event_Machine` (`Event_Machine.c/h`) provides a lightweight inter-core message passing system built on the Pico SDK's `queue_t` (which uses spin locks for thread safety).

Two event queues exist (declared in `Shared_Buffers.c:9-10`):
- `wifiToFrontend`: Core 1 (WiFi) -> Core 0 (main). Events: `CYW_READY`, `CONNECTED`, `DISCONNECTED`, `DATA_RECEIVED`, `POWER_STATUS_DATA`. Max event size: `sizeof(EVENT_FROM_WIFI)` = 133 bytes. Queue depth: 8.
- `frontendToWifi`: Core 0 (main) -> Core 1 (WiFi). Events: `LED_ON`, `LED_OFF`, `CONFIG_RECEIVED`, `SEND_DATA`, `GET_POWER_STATUS`. Max event size: `sizeof(EVENT_FROM_FRONTEND)` = 37 bytes. Queue depth: 8.

Core 0 processes the `wifiToFrontend` queue in `processInput()` via `event_process_queue()` which dequeues up to `max_events` items and calls the registered handler for each.

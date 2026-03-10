# Capture Mode - Detailed Technical Documentation

## Overview

Capture mode is the trigger-based high-frequency capture mode of the LogicAnalyzer V2 firmware. It captures digital signals on-hardware at frequencies up to 100MHz (or up to 200-400MHz in "blast" mode with turbo overclock), storing all samples into an on-chip buffer. Once capture is complete, the entire buffer is transferred to the host software.

The implementation lives primarily in:
- `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Capture.c` - all capture logic
- `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Capture.h` - public API
- `Firmware/LogicAnalyzer_V2/LogicAnalyzer.pio` - PIO assembly programs for sampling and triggering
- `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c` - command dispatch and data transfer to host
- `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h` - protocol structures
- `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Board_Settings.h` - per-board constants

---

## 1. Initiating a Capture

### 1.1 Host Command Protocol

The host sends a binary-framed message to the firmware via USB (serial/CDC) or WiFi. The frame format is:

| Bytes | Value | Purpose |
|-------|-------|---------|
| 2 | `0x55 0xAA` | Start condition |
| 1 | Command byte | `0x01` for capture request |
| N | Payload | `CAPTURE_REQUEST` struct |
| 2 | `0xAA 0x55` | Stop condition |

Bytes within the payload that would collide with framing bytes (`0x55`, `0xAA`, `0xF0`) are escaped using `0xF0` as the escape character: the escaped byte is XOR'd with `0xF0`. For example, `0xAA` is sent as `{0xF0, 0x5A}`.

**Reference:** `LogicAnalyzer.c` lines 240-494 (`processData` function).

### 1.2 The CAPTURE_REQUEST Structure

Defined in `LogicAnalyzer_Structs.h` lines 9-42:

```c
typedef struct _CAPTURE_REQUEST
{
    uint8_t triggerType;     // 0=edge, 1=pattern(complex), 2=pattern(fast), 3=blast
    uint8_t trigger;         // Trigger channel (or base channel for pattern trigger)
    union {
        uint8_t inverted;    // For edge trigger: invert trigger edge
        uint8_t count;       // For pattern trigger: number of trigger pins
    };
    uint16_t triggerValue;   // Pattern trigger value
    uint8_t channels[32];    // Channel indices to capture
    uint8_t channelCount;    // Number of channels
    uint32_t frequency;      // Sampling frequency in Hz
    uint32_t preSamples;     // Number of samples before trigger
    uint32_t postSamples;    // Number of samples after trigger
    uint16_t loopCount;      // Number of capture loops (re-triggers)
    uint8_t measure;         // Enable burst timestamp measurement
    uint8_t captureMode;     // 0=8ch, 1=16ch, 2=24ch
} CAPTURE_REQUEST;
```

### 1.3 Command Dispatch

When command byte `0x01` is received, the firmware dispatches to one of four capture start functions based on `triggerType` (`LogicAnalyzer.c` lines 302-347):

| triggerType | Function Called | Description |
|-------------|----------------|-------------|
| 0 | `StartCaptureSimple()` | Single-pin edge trigger |
| 1 | `StartCaptureComplex()` | Multi-pin pattern trigger (up to 16 pins) |
| 2 | `StartCaptureFast()` | Multi-pin fast pattern trigger (up to 5 pins) |
| 3 | `StartCaptureBlast()` | Maximum-speed single-pin edge trigger (no pre-trigger) |

On success, the firmware responds with the string `"CAPTURE_STARTED\n"`. On failure, it responds with `"CAPTURE_ERROR\n"`.

### 1.4 Channel Modes

Three channel modes control how data width maps to buffer usage (`LogicAnalyzer_Capture.h` lines 9-15):

```c
typedef enum {
    MODE_8_CHANNEL,   // 1 byte per sample, up to 8 channels
    MODE_16_CHANNEL,  // 2 bytes per sample, up to 16 channels
    MODE_24_CHANNEL   // 4 bytes per sample, up to 24 channels
} CHANNEL_MODE;
```

---

## 2. The Trigger System

### 2.1 Simple Edge Trigger (triggerType=0)

The simplest trigger mode. A single GPIO pin is monitored; capture transitions from pre-trigger to post-trigger when the pin's edge is detected.

**Trigger polarity:** The `invertTrigger` flag controls which edge is detected:
- `invertTrigger = false` (positive edge): Uses the `POSITIVE_CAPTURE` PIO program. The trigger pin's input override (`gpio_set_inover`) is NOT set, so `jmp pin` tests for HIGH.
- `invertTrigger = true` (negative edge): Uses the `NEGATIVE_CAPTURE` PIO program. The program structure itself handles the inverted logic.

**Pin mapping:** The trigger pin index from the host is mapped through `pinMap[]` to the actual GPIO number (`LogicAnalyzer_Capture.c` line 1084).

**Loop support:** The simple trigger supports a `loopCount` parameter, allowing the capture to re-trigger multiple times. The PIO program receives both the loop count and post-trigger length via `pio_sm_put_blocking()` (`LogicAnalyzer_Capture.c` lines 1198-1199):
```c
pio_sm_put_blocking(capturePIO, sm_Capture, loopCount);
pio_sm_put_blocking(capturePIO, sm_Capture, postLength - 1);
```

**Reference:** `StartCaptureSimple()` at `LogicAnalyzer_Capture.c` lines 1030-1209.

### 2.2 Complex Pattern Trigger (triggerType=1)

The complex trigger detects a multi-bit pattern (up to 16 pins) using a separate PIO state machine running on the same PIO unit (pio0). It uses two GPIO pins as an interconnect bridge between the trigger state machine and the capture state machine.

**How it works:**
1. GPIO `COMPLEX_TRIGGER_OUT_PIN` (pin 0) is configured as output from the trigger SM.
2. GPIO `COMPLEX_TRIGGER_IN_PIN` (pin 1) is configured as the `jmp pin` for the capture SM.
3. These two pins are physically connected on the board.
4. The trigger SM continuously reads the trigger pins, compares them to the target pattern, and sets pin 0 HIGH when the pattern matches.
5. The capture SM sees pin 1 go HIGH and transitions to post-trigger capture.

**Trigger PIO program** (defined in C code at `LogicAnalyzer_Capture.c` lines 82-100):
```
pull block           ; read trigger value into X
out x, 32
set pins, 0          ; set trigger output LOW
irq nowait 7         ; signal capture SM to start
mov osr, pins        ; read pin state
out y, N             ; extract N bits into Y (N is patched at runtime)
jmp x!=y, 4          ; loop if pattern not matched
set pins, 1          ; pattern matched - set trigger HIGH
jmp 8                ; lock (infinite loop)
```

The instruction at offset 5 (`out y, N`) is dynamically patched before loading to set the correct bit count: `COMPLEX_TRIGGER_program_instructions[5] = 0x6040 | triggerPinCount;` (`LogicAnalyzer_Capture.c` line 854).

**Synchronization:** The capture program (`COMPLEX_CAPTURE`) uses `wait irq 7` to wait until the trigger SM signals readiness via `irq nowait 7`. This ensures both state machines start in sync.

**Limitations documented in code comments** (`LogicAnalyzer_Capture.c` lines 726-746):
- Trigger runs at maximum system clock speed (no divider), but can only sample at ~66Msps due to the 3-instruction trigger loop.
- The trigger signal may glitch at lower capture speeds (trigger condition met for less than one capture cycle).
- Up to 25ns of trigger delay (3 instructions + 2 propagation cycles).
- No loop/re-trigger support (loopCount is forced to 0).

**Reference:** `StartCaptureComplex()` at `LogicAnalyzer_Capture.c` lines 723-892.

### 2.3 Fast Pattern Trigger (triggerType=2)

An evolution of the complex trigger that achieves higher speed by using a 32-instruction jump table occupying an entire PIO module.

**How it works:**
- The trigger program fills all 32 PIO instruction slots.
- Each instruction is `MOV PC, PINS SIDE 0` (reads pin values directly into the program counter), except for addresses matching the target pattern, which are `JMP self SIDE 1` (sets the trigger output HIGH and halts).
- This creates a hardware lookup table where the pin state directly becomes the program counter value.

**Program generation** (`LogicAnalyzer_Capture.c` lines 136-157):
```c
uint8_t create_fast_trigger_program(uint8_t pattern, uint8_t length)
{
    uint8_t mask = (1 << length) - 1;
    for(i = 0; i < 32; i++)
    {
        if((i & mask) == pattern)
            FAST_TRIGGER_program_instructions[i] = 0x1000 | i; // JMP i SIDE 1
        else
            FAST_TRIGGER_program_instructions[i] = 0xA0A0;     // MOV PC, PINS SIDE 0
    }
}
```

**Key differences from complex trigger:**
- Uses a separate PIO unit: capture on `pio1`, trigger on `pio0` (to avoid instruction memory conflicts since the trigger program needs all 32 slots).
- Pattern limited to 5 bits (due to 32-instruction PIO limit: 2^5 = 32).
- Trigger latency reduced to maximum 2 cycles (vs 5 for complex).
- Trigger runs at full system clock speed (1 instruction per cycle).
- The `FAST_CAPTURE` PIO program is used for the capture side (similar to `COMPLEX_CAPTURE` but without the `wait irq 7` synchronization since the trigger starts independently).

**Interrupt handling note:** The fast trigger uses polling instead of PIO interrupt for completion detection. The main loop calls `check_fast_interrupt()` which polls the PIO IRQ flag directly (`LogicAnalyzer_Capture.c` lines 301-304):
```c
void check_fast_interrupt()
{
    if(lastCaptureType == CAPTURE_TYPE_FAST && capturePIO->irq & 1)
        fast_capture_completed();
}
```
This workaround exists because "the W messes the PIO interrupts" (comment at line 300).

**Reference:** `StartCaptureFast()` at `LogicAnalyzer_Capture.c` lines 560-721.

### 2.4 Blast Trigger (triggerType=3)

The highest-speed capture mode that sacrifices pre-trigger samples for maximum throughput.

**Key characteristics:**
- No pre-trigger samples (preSamples is forced to 0).
- PIO clock divider is 1:1 with the capture frequency (not 2x like other modes), meaning the PIO program runs at the exact capture frequency.
- The PIO program is only 2 instructions: a `jmp pin` loop waiting for the trigger, then a tight `in pins 32` wrap loop.
- Single DMA channel (no ping-pong) since the buffer is not circular.
- DMA gets full bus priority: `bus_ctrl_hw->priority = BUSCTRL_BUS_PRIORITY_DMA_W_BITS | BUSCTRL_BUS_PRIORITY_DMA_R_BITS` (`LogicAnalyzer_Capture.c` line 459).
- Maximum frequency: up to 200MHz (normal) or 400MHz (turbo/overclocked).

**Trigger polarity for blast mode:** When `invertTrigger` is false (positive edge), the input override is set with `gpio_set_inover(triggerPin, 1)` to invert the signal at the GPIO level, so the `jmp pin` instruction (which jumps when HIGH) effectively waits for the original LOW state, then falls through when the pin goes HIGH (`LogicAnalyzer_Capture.c` lines 990-991).

**BLAST_CAPTURE PIO program** (`LogicAnalyzer.pio` lines 2-12):
```
LOOP:
    jmp pin LOOP            ; wait for trigger (loops while pin is HIGH/inverted)
.wrap_target
    in pins 32              ; capture sample
.wrap
```

**Reference:** `StartCaptureBlast()` at `LogicAnalyzer_Capture.c` lines 909-1028.

---

## 3. PIO Programs for Capture

All PIO programs read 32 bits from GPIO pins per `in` instruction, regardless of how many channels are actually being captured. The unused bits are discarded during post-processing. The programs are defined in `LogicAnalyzer.pio`.

### 3.1 POSITIVE_CAPTURE (lines 15-49)

Used for simple edge trigger detecting a rising edge.

```
    pull                    ; read loop count into Y
    out y 32
    pull                    ; read post-capture length into X (via OSR for re-use)
    mov x, osr

.wrap_target
    in pins 32              ; read sample (pre-trigger, circular)
    jmp pin POST_CAPTURE    ; if trigger pin HIGH, exit to post-capture
.wrap

POST_CAPTURE:
    in pins 32              ; read sample
    jmp x-- POST_CAPTURE    ; loop until post-samples exhausted

    jmp y-- LOOP            ; if more loops remain, go to re-trigger wait

    irq 0                   ; notify CPU that capture is complete

LOCK:
    jmp LOCK                ; halt

LOOP:
    mov x, osr              ; reload post-capture count from OSR
INNER_LOOP:
    jmp pin POST_CAPTURE    ; wait for trigger
    jmp INNER_LOOP
```

**Timing:** Each sample takes 2 PIO cycles (one `in` + one `jmp`). The clock divider is set to `sys_clk / (freq * 2)`, so the effective sample rate equals the requested frequency. At 200MHz sys_clk and 100MHz capture: divider = 1.0, meaning each instruction takes 1 cycle = 5ns, and each sample takes 2 cycles = 10ns = 100MHz.

**Pre-trigger behavior:** The `.wrap_target`/`.wrap` section creates a tight 2-instruction loop that continuously captures samples into the FIFO. The DMA writes these into the circular buffer, overwriting older data. This naturally creates the pre-trigger buffer. The pre-trigger data is whatever was in the circular buffer at the moment the trigger fires.

**Post-trigger behavior:** When `jmp pin` detects the trigger, execution falls through to `POST_CAPTURE`, which counts down X (post-trigger length) samples before completing.

**Loop re-trigger:** After post-capture completes, if Y > 0 (more loops), it reloads X from OSR and waits for the next trigger edge in `INNER_LOOP`.

### 3.2 NEGATIVE_CAPTURE (lines 52-86)

Used for simple edge trigger detecting a falling edge. Structure is similar but inverted:

```
    pull / out y 32         ; loop count
    pull / mov x, osr       ; post-capture length

PRE_CAPTURE:
    in pins 32              ; read sample
    jmp pin PRE_CAPTURE     ; loop WHILE pin is HIGH (pre-trigger)

POST_CAPTURE:
.wrap_target
    in pins 32              ; read sample
    jmp x-- POST_CAPTURE    ; count down post-samples

    jmp y-- LOOP            ; re-trigger if loops remain
    irq 0                   ; done
LOCK:
    jmp LOCK

LOOP:
    mov x, osr              ; reload post count
INNER_LOOP:
    jmp pin INNER_LOOP      ; wait while HIGH (trigger = falling edge)
.wrap
```

The key difference: `jmp pin` jumps while HIGH, so for a negative edge trigger, the pre-capture loop runs while the pin is HIGH and falls through when it goes LOW.

### 3.3 POSITIVE/NEGATIVE_CAPTURE_MEASUREBURSTS (lines 89-166)

Variants of the simple capture programs that additionally fire PIO IRQ 1 at loop boundaries to record timestamps. Used when `measureBursts` is enabled.

Added instructions:
- `irq wait 1` at program start to synchronize the first timestamp.
- `irq 1` after each loop completion (in the `LOOP` label) and at final completion.

These IRQ 1 signals are routed as NMI (Non-Maskable Interrupt) to the CPU, which records systick counter values in `loopTimestamp[]` (`LogicAnalyzer_Capture.c` lines 901-907).

### 3.4 COMPLEX_CAPTURE (lines 169-193)

Used with the complex pattern trigger:

```
    pull                    ; read post-capture length into X
    out x 32
    wait irq 7              ; wait for trigger SM to be ready

.wrap_target
    in pins 32              ; read sample (pre-trigger, circular)
    jmp pin POST_CAPTURE    ; if trigger pin HIGH (via interconnect), exit
.wrap

POST_CAPTURE:
    in pins 32
    jmp x-- POST_CAPTURE    ; count down post-samples
    irq 0                   ; done
LOCK:
    jmp LOCK
```

No loop support (no Y register usage). The `jmp pin` monitors `COMPLEX_TRIGGER_IN_PIN` (connected to the trigger SM's output).

### 3.5 FAST_CAPTURE (lines 195-216)

Used with the fast pattern trigger. Identical to `COMPLEX_CAPTURE` but without the `wait irq 7` synchronization:

```
    pull
    out x 32                ; read post-capture length

.wrap_target
    in pins 32              ; read sample (pre-trigger, circular)
    jmp pin POST_CAPTURE    ; if trigger pin HIGH, exit
.wrap

POST_CAPTURE:
    in pins 32
    jmp x-- POST_CAPTURE
    irq 0
LOCK:
    jmp LOCK
```

### 3.6 Autopush Configuration

All capture PIO programs use autopush to automatically transfer data from the ISR to the RX FIFO after 32 bits are shifted in:

```c
sm_config_set_in_shift(&smConfig, true/false, true, 0);  // autopush=true, threshold=0 (meaning 32 bits)
```

- Simple and blast captures shift right (`true` as first arg): `LogicAnalyzer_Capture.c` lines 1003, 1143.
- Complex and fast captures shift left (`false`): `LogicAnalyzer_Capture.c` lines 665, 831.

The `in pins 32` instruction reads all 32 GPIO pins (GPIO 0-31) into the ISR in a single cycle. The autopush then pushes the full 32-bit word into the RX FIFO, where DMA picks it up.

---

## 4. DMA Setup

### 4.1 Circular Buffer DMA (Ping-Pong)

For simple, complex, and fast captures, two DMA channels are configured in a ping-pong arrangement to create a circular buffer (`configureCaptureDMAs()`, `LogicAnalyzer_Capture.c` lines 466-522).

**Configuration of each channel:**
- **Read address:** PIO RX FIFO (`&capturePIO->rxf[sm_Capture]`), non-incrementing.
- **Write address:** `captureBuffer`, incrementing.
- **Transfer size:** Depends on channel mode: `DMA_SIZE_8` (8-ch), `DMA_SIZE_16` (16-ch), or `DMA_SIZE_32` (24-ch).
- **Transfer count:** `CAPTURE_BUFFER_SIZE` / element_size (the entire buffer).
- **DREQ:** PIO RX FIFO data request.
- **Chain:** Channel 0 chains to channel 1, and channel 1 chains to channel 0.
- **IRQ 0:** Both channels fire IRQ 0 on completion.

**The DMA IRQ handler** (`dma_handler()`, `LogicAnalyzer_Capture.c` lines 225-244):
```c
void __not_in_flash_func(dma_handler)()
{
    if(dma_channel_get_irq0_status(dmaPingPong0))
    {
        dma_channel_acknowledge_irq0(dmaPingPong0);
        dma_channel_set_write_addr(dmaPingPong0, captureBuffer, false);
    }
    else
    {
        dma_channel_acknowledge_irq0(dmaPingPong1);
        dma_channel_set_write_addr(dmaPingPong1, captureBuffer, false);
    }
}
```

When a channel finishes transferring the entire buffer, the IRQ handler resets its write address back to `captureBuffer` (without triggering it). The chained channel then starts automatically, writing from the beginning again. This creates a continuously overwriting circular buffer.

The handler is placed in RAM (`__not_in_flash_func`) for maximum speed.

**IRQ priority** is set to 0 (highest): `irq_set_priority(DMA_IRQ_0, 0)` (line 517).

### 4.2 Blast Mode DMA (Single Channel)

Blast mode uses a single DMA channel (`configureBlastDMA()`, `LogicAnalyzer_Capture.c` lines 423-463):

- Only one channel is claimed.
- Transfer count is exactly `length` (the requested number of samples).
- When the DMA transfer completes, `blast_capture_completed()` fires directly (the DMA completion IS the capture completion signal).
- DMA bus priority is elevated to maximum.
- No ping-pong, no circular buffer wrapping.

### 4.3 Transfer Size by Channel Mode

| Mode | DMA Transfer Size | Bytes per Sample | Max Samples (128KB buffer) | Max Samples (384KB buffer) |
|------|-------------------|------------------|---------------------------|---------------------------|
| MODE_8_CHANNEL | `DMA_SIZE_8` | 1 | 131,072 | 393,216 |
| MODE_16_CHANNEL | `DMA_SIZE_16` | 2 | 65,536 | 196,608 |
| MODE_24_CHANNEL | `DMA_SIZE_32` | 4 | 32,768 | 98,304 |

---

## 5. The Capture Buffer

### 5.1 Size and Allocation

The buffer is a statically allocated array, aligned to a 4-byte boundary (`LogicAnalyzer_Capture.c` line 67):

```c
static uint8_t captureBuffer[CAPTURE_BUFFER_SIZE] __attribute__((aligned(4)));
```

Buffer sizes vary by board (`LogicAnalyzer_Board_Settings.h`):

| Board | Buffer Size |
|-------|-------------|
| Pico, Pico W, Pico W WiFi, Zero, Interceptor | 128 KB (`128 * 1024`) |
| Pico 2, Pico 2 W, Pico 2 W WiFi | 384 KB (`128 * 3 * 1024`) |

### 5.2 Buffer Layout and Circular Operation

For non-blast captures, the buffer operates as a circular ring buffer:

1. **During pre-trigger phase:** DMA continuously writes samples to the buffer via ping-pong channels. Each channel writes `transferCount` samples (the full buffer), then chains to the other which also writes the full buffer to the same address. The IRQ handler resets the write pointer. Old data is continuously overwritten.

2. **At trigger moment:** The PIO program transitions from the pre-trigger loop to the post-trigger countdown. The DMA continues writing sequentially. The tail position at capture end is determined by `find_capture_tail()`.

3. **After capture:** The buffer contains a mix of pre-trigger and post-trigger data at arbitrary positions within the circular buffer. The firmware must calculate where the valid data starts.

### 5.3 Pre-Trigger and Post-Trigger Sample Management

**Pre-trigger samples** are "free" -- they are simply whatever samples exist in the circular buffer behind the trigger point. The host specifies `preSamples` to indicate how many of these older samples it wants.

**Post-trigger samples** are counted by the PIO program's X scratch register, which decrements from `postLength - 1` to 0.

**Total samples** stored: `preSamples + (postSamples * (loopCount + 1))`.

**Finding the tail position** (`find_capture_tail()`, `LogicAnalyzer_Capture.c` lines 164-206):

After the PIO fires IRQ 0, the completion handler immediately calls `find_capture_tail()`. This function:
1. Waits 5ms as a safety margin for any in-flight DMA transfer.
2. Checks which of the two ping-pong DMA channels is currently busy (has an active transfer).
3. Reads the remaining `transfer_count` from that channel's hardware registers.
4. Computes: `tail = (transferCount - transferPos) - 1`, where `transferCount` is the total transfers per channel and `transferPos` is the remaining count.

**Calculating the start position** (`GetBuffer()`, `LogicAnalyzer_Capture.c` lines 1217-1369):

```c
uint32_t totalSamples = lastPreSize + (lastPostSize * (lastLoopCount + 1));

if(lastTail < totalSamples - 1)
    lastStartPosition = (maxSize - totalSamples) + lastTail + 1;
else
    lastStartPosition = lastTail - totalSamples + 1;
```

This accounts for the circular wrapping: if the tail is before the total sample count, the start wraps around to the end of the buffer.

**Buffer clearing:** Before each capture starts, the entire buffer is zeroed with `memset(captureBuffer, 0, sizeof(captureBuffer))` to avoid sending stale data if the trigger fires before enough pre-trigger samples accumulate.

---

## 6. Capture Completion Detection

### 6.1 PIO IRQ 0

For simple, complex, and fast captures, the PIO program fires `irq 0` when all post-trigger samples (and all loops) are complete.

**Simple capture:** IRQ 0 is routed through `PIO0_IRQ_0` to `simple_capture_completed()` (`LogicAnalyzer_Capture.c` lines 1149-1152):
```c
pio_set_irq0_source_enabled(capturePIO, pis_interrupt0, true);
irq_set_exclusive_handler(PIO0_IRQ_0, simple_capture_completed);
irq_set_enabled(PIO0_IRQ_0, true);
```

**Complex capture:** Same mechanism, routed to `complex_capture_completed()` (line 839).

**Fast capture:** Uses polling instead of interrupt (due to Pico W compatibility issues). The main loop calls `check_fast_interrupt()` which checks `capturePIO->irq & 1` directly (lines 301-304).

### 6.2 DMA Completion (Blast Mode)

For blast mode, the DMA channel's own completion interrupt signals the end of capture. The `blast_capture_completed()` handler fires when all requested samples have been DMA'd (line 454).

### 6.3 Completion Handler Actions

All completion handlers follow the same pattern:
1. Disable GPIOs (`disable_gpios()`).
2. Find the DMA tail position (`find_capture_tail()`) -- except blast mode which sets `lastTail = lastPostSize`.
3. Abort and unclaim DMA channels (`abort_DMAs()`).
4. Clear PIO interrupts and remove handlers.
5. Stop and unclaim PIO state machines.
6. Remove PIO programs from instruction memory.
7. Set `captureFinished = true`.

### 6.4 Main Loop Polling

The main loop in `LogicAnalyzer.c` polls `IsCapturing()` (which returns `!captureFinished`) on each iteration (lines 711-850). While capturing, it blinks the LED every second and checks for cancel requests. When `IsCapturing()` returns false, it proceeds to transfer data.

### 6.5 Capture Cancellation

During capture, the firmware checks for any incoming USB/WiFi data. If data is received, it is treated as a cancel request (the data content is discarded): `processCancel()` returns true, and `StopCapture()` is called. `StopCapture()` manually invokes the appropriate completion handler to clean up resources (`LogicAnalyzer_Capture.c` lines 524-556). USB disconnection also triggers cancellation (lines 835-841).

---

## 7. Data Transfer to Host

### 7.1 Post-Processing (Channel Reordering)

Before transfer, `GetBuffer()` performs in-place channel reordering (`LogicAnalyzer_Capture.c` lines 1217-1369). The raw PIO data contains all 32 GPIO pin states, but the host only cares about the requested channels in a specific order.

For each sample, the function:
1. Reads the raw value from the buffer.
2. For each requested channel, extracts the bit corresponding to that channel's physical GPIO pin (offset by `INPUT_PIN_BASE`).
3. Places it at the channel's logical bit position (0, 1, 2, ...).
4. Writes the reordered value back.

**Blast mode inversion fix:** For blast captures with `invertTrigger = false`, the trigger pin's bit was inverted at the GPIO level (via `gpio_set_inover`). The post-processing XORs this bit back to restore the correct value (`LogicAnalyzer_Capture.c` lines 1258-1260, 1269-1270).

The reordering handles the circular buffer by tracking `currentPos` and wrapping at `maxSize`.

### 7.2 Transfer Protocol

After `GetBuffer()` returns, the main loop transfers data (`LogicAnalyzer.c` lines 716-813):

1. **Disable stdio_usb** (`stdio_usb_deinit()`) to prevent TinyUSB task reentrancy during bulk transfer (line 729).

2. **Send capture length** (4 bytes, little-endian `uint32_t`): the total number of samples.

3. **Send sample data**: The buffer may wrap around (circular buffer), so it may require two transfers:
   ```c
   if(first + length > CAPTURE_BUFFER_SIZE)
   {
       cdc_transfer(buffer + first, CAPTURE_BUFFER_SIZE - first);
       cdc_transfer(buffer, (first + length) - CAPTURE_BUFFER_SIZE);
   }
   else
       cdc_transfer(buffer + first, length);
   ```
   Note: `length` and `first` are converted from sample counts to byte offsets based on channel mode before transfer (lines 753-763).

4. **Send timestamp count** (1 byte): number of timestamps recorded.

5. **Send timestamps** (if count > 1): `count * 4` bytes of `uint32_t` timestamp values.

6. **Re-enable stdio_usb** (`stdio_usb_init()`).

### 7.3 USB Transfer Implementation

`cdc_transfer()` (`LogicAnalyzer.c` lines 177-207) uses TinyUSB's CDC class directly:
```c
void cdc_transfer(unsigned char* data, int len)
{
    int left = len;
    int pos = 0;
    while(left > 0)
    {
        int avail = (int) tud_cdc_write_available();
        if(avail > left) avail = left;
        if(avail)
        {
            int transferred = (int) tud_cdc_write(data + pos, avail);
            tud_task();
            tud_cdc_write_flush();
            pos += transferred;
            left -= transferred;
        }
        else
        {
            tud_task();
            tud_cdc_write_flush();
            if (!tud_cdc_connected()) break;
        }
    }
}
```

WiFi transfer (`wifi_transfer()`, lines 213-233) sends data in 32-byte chunks via the event machine queue to the WiFi core.

---

## 8. Data Format of Captured Samples

### 8.1 Raw PIO Output

Each PIO `in pins 32` instruction captures the state of GPIO pins 0-31 as a 32-bit word. The autopush pushes this to the RX FIFO. DMA writes it to the buffer at the configured transfer size:

| Channel Mode | DMA reads from FIFO | Bits used | Data type |
|-------------|---------------------|-----------|-----------|
| MODE_8_CHANNEL | Lower 8 bits | GPIO[PIN_BASE..PIN_BASE+7] | `uint8_t` |
| MODE_16_CHANNEL | Lower 16 bits | GPIO[PIN_BASE..PIN_BASE+15] | `uint16_t` |
| MODE_24_CHANNEL | Full 32 bits | GPIO[0..31] | `uint32_t` |

### 8.2 Post-Processed Output

After `GetBuffer()` reorders channels, each sample contains:
- Bit 0: Channel 0's state
- Bit 1: Channel 1's state
- ...
- Bit N-1: Channel (N-1)'s state

Higher bits (beyond the channel count) are zero.

### 8.3 Wire Format Sent to Host

1. `uint32_t` (4 bytes, little-endian): total sample count
2. Sample data: `sampleCount * bytesPerSample` bytes, where `bytesPerSample` is 1, 2, or 4 depending on channel mode. If the data wraps in the circular buffer, the two segments are sent sequentially to appear contiguous to the host.
3. `uint8_t` (1 byte): timestamp count
4. If timestamp count > 1: `timestampCount * 4` bytes of `uint32_t` timestamps

---

## 9. Burst Measurement (Timestamps)

When `measureBursts` is enabled (only for simple trigger with `loopCount > 0`), the firmware records timestamps at each loop boundary.

### 9.1 Mechanism

The PIO programs `POSITIVE_CAPTURE_MEASUREBURSTS` and `NEGATIVE_CAPTURE_MEASUREBURSTS` fire `irq 1` at:
- Program start (`irq wait 1` -- also waits for CPU acknowledgment)
- Each loop boundary (after post-capture completes, before re-arming)
- Final completion

IRQ 1 is routed as an NMI (Non-Maskable Interrupt) to ensure minimum latency. The NMI handler `loopEndHandler()` (`LogicAnalyzer_Capture.c` lines 901-907) records the ARM SysTick counter:

```c
void __not_in_flash_func(loopEndHandler)()
{
    loopTimestamp[timestampIndex++] = systick_hw->cvr | systickLoops << 24;
    capturePIO->irq = (1u << 1);  // clear PIO IRQ 1
}
```

The timestamp format packs the 24-bit SysTick current value register with an 8-bit overflow counter in the upper byte.

### 9.2 SysTick Configuration

SysTick is configured as a free-running 24-bit downcounter at CPU clock speed (`LogicAnalyzer_Capture.c` lines 1178-1181):
```c
systick_hw->rvr = 0x00FFFFFF;   // reload value: max
systick_hw->cvr = 0x00FFFFFF;   // current value: max
systick_hw->csr = 0x7;          // enable, interrupt, CPU clock source
```

A separate `sysTickRoll()` handler (line 896-898) increments `systickLoops` on each SysTick rollover, extending the timer range.

### 9.3 Limits

Maximum 254 loops when burst measurement is active (`loopCount > 253` returns false, line 1056-1057), because `timestampIndex` is a `uint8_t` and the array `loopTimestamp` has 256 entries.

---

## 10. Pin Mapping

The `pinMap[]` array maps logical channel indices to physical GPIO numbers. It is defined per board in `LogicAnalyzer_Board_Settings.h`.

Example for Pico/Pico 2 (line 72):
```c
#define PIN_MAP {2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,26,27,28,COMPLEX_TRIGGER_IN_PIN}
```

- Channels 0-19 map to GPIO 2-21 (contiguous).
- Channels 20-23 map to GPIO 22, 26, 27, 28 (skipping GPIO 23-25 which are used for other purposes).
- The last entry is the complex trigger input pin (GPIO 1), accessible as an extra trigger-only channel.

The `INPUT_PIN_BASE` constant (GPIO 2 for Pico) is the starting GPIO for the PIO `in pins` instruction. The PIO reads a contiguous range starting from this pin.

---

## 11. Clock Configuration

### 11.1 System Clock

The system clock is configured in `main()` (`LogicAnalyzer.c` lines 656-669):
- **Turbo mode:** 400MHz (with voltage set to 1.30V)
- **Normal mode:** 200MHz

### 11.2 PIO Clock Dividers

| Capture Type | Clock Divider Formula | Effective Sample Rate |
|-------------|----------------------|----------------------|
| Simple | `sys_clk / (freq * 2)` | `freq` (2 cycles per sample) |
| Complex | `sys_clk / (freq * 2)` | `freq` (2 cycles per sample) |
| Fast | `sys_clk / (freq * 2)` | `freq` (2 cycles per sample) |
| Blast | `sys_clk / freq` | `freq` (1 cycle per sample in wrap loop) |

The 2x multiplier for non-blast modes accounts for the 2-instruction sample loop (`in` + `jmp`).

### 11.3 Maximum Frequencies

Defined per board in `LogicAnalyzer_Board_Settings.h`:

| Board | Normal Max | Blast Max |
|-------|-----------|-----------|
| Pico/Zero/Interceptor (turbo) | 200 MHz | 400 MHz |
| Pico/Zero/Interceptor (normal) | 100 MHz | 200 MHz |
| Pico 2 (turbo) | 200 MHz | 400 MHz |
| Pico 2 (normal) | 100 MHz | 200 MHz |
| Pico W / Pico 2 W (all) | 100 MHz | 200 MHz |

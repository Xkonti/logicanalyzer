# Capture Mode - Detailed Technical Reference

This document provides a comprehensive technical breakdown of how "capture" mode works in the LogicAnalyzer V2, covering PIO assembly programs, trigger mechanisms, DMA configuration, clock dividers, channel modes, burst/turbo mode, and the software-side capture flow for both the Web client and the legacy C# client.

---

## Table of Contents

1. [Overview](#overview)
2. [PIO Assembly Programs](#pio-assembly-programs)
   - [BLAST_CAPTURE](#blast_capture)
   - [POSITIVE_CAPTURE](#positive_capture)
   - [NEGATIVE_CAPTURE](#negative_capture)
   - [POSITIVE_CAPTURE_MEASUREBURSTS](#positive_capture_measurebursts)
   - [NEGATIVE_CAPTURE_MEASUREBURSTS](#negative_capture_measurebursts)
   - [COMPLEX_CAPTURE](#complex_capture)
   - [FAST_CAPTURE](#fast_capture)
   - [COMPLEX_TRIGGER (runtime-generated)](#complex_trigger)
   - [FAST_TRIGGER (runtime-generated jump table)](#fast_trigger)
3. [Trigger Modes](#trigger-modes)
   - [Edge Trigger (Simple)](#edge-trigger-simple)
   - [Complex Trigger](#complex-trigger)
   - [Fast Trigger](#fast-trigger)
   - [Blast Capture (no pre-trigger)](#blast-capture-no-pre-trigger)
4. [Turbo/Burst Mode](#turboburst-mode)
5. [Channel Count and Capture Modes](#channel-count-and-capture-modes)
6. [GPIO Pin Mapping](#gpio-pin-mapping)
7. [Clock Divider and Frequency Configuration](#clock-divider-and-frequency-configuration)
8. [DMA Configuration](#dma-configuration)
   - [Ping-Pong DMA (Normal Capture)](#ping-pong-dma-normal-capture)
   - [Single DMA (Blast Capture)](#single-dma-blast-capture)
9. [Capture Completion and Buffer Processing](#capture-completion-and-buffer-processing)
10. [Software Side: Web Client](#software-side-web-client)
    - [Protocol and Packet Framing](#protocol-and-packet-framing)
    - [Capture Request Construction](#capture-request-construction)
    - [Capture Data Reception and Parsing](#capture-data-reception-and-parsing)
    - [Sample Extraction](#sample-extraction)
    - [Burst Timestamp Processing](#burst-timestamp-processing)
11. [Software Side: Legacy C# Client](#software-side-legacy-c-client)
12. [Limitations and Edge Cases](#limitations-and-edge-cases)

---

## Overview

Capture mode is a trigger-based, high-frequency capture mechanism. The device waits for a trigger condition, then captures a fixed number of samples into an on-board RAM buffer at frequencies up to 100MHz (normal) or 200-400MHz (blast/turbo). Once capture is complete, the full buffer is transferred to the host software for display.

The capture pipeline consists of:
1. **PIO state machines** on the RP2040/RP2350 that read GPIO pins and push data into FIFOs
2. **DMA channels** that drain FIFOs into a circular RAM buffer
3. **IRQ handlers** that detect capture completion
4. **Post-processing** on-device that reorders pin data into logical channel order
5. **Transfer** of the buffer over USB (CDC) or WiFi to the host application

---

## PIO Assembly Programs

All PIO programs are defined in:
**`Firmware/LogicAnalyzer.pio`**

### BLAST_CAPTURE
**Lines 2-12.** The simplest capture program. Runs at a 1:1 clock divider (one PIO cycle = one sample), achieving the highest possible frequency.

```
LOOP:
    jmp pin LOOP          ; Wait for trigger: loop while JMP pin is LOW (or HIGH if inverted)
.wrap_target
    in pins 32            ; Capture all 32 GPIO pins into the ISR
.wrap
```

**Instruction-by-instruction:**
- `jmp pin LOOP` (line 6): The `jmp pin` instruction checks the state of the designated JMP pin. If the pin is HIGH, it jumps to `LOOP` (keeps waiting). When the pin goes LOW, execution falls through to the capture loop. (The trigger polarity is handled by the GPIO input override -- `gpio_set_inover` -- which inverts the signal at the hardware level for positive-edge triggers.)
- `in pins 32` (line 10): Reads the state of 32 consecutive GPIO pins starting from the configured `in_base` pin and shifts them into the Input Shift Register (ISR). With autopush enabled, this automatically pushes the ISR contents into the RX FIFO when full.
- `.wrap_target` / `.wrap`: The PIO automatically loops back from the wrap point to the wrap target with zero overhead. This makes the capture loop a single instruction (`in pins 32`), achieving one sample per PIO clock cycle.

**Key difference from other programs:** No pre-trigger buffer, no post-trigger counting, no loop support. The DMA is configured for a fixed transfer count; when the DMA finishes, the capture is complete. The PIO runs indefinitely -- it is the DMA completion IRQ that ends the capture.

### POSITIVE_CAPTURE
**Lines 15-49.** Used for edge-triggered capture when waiting for a **rising edge** (trigger pin going HIGH). Supports pre-trigger circular buffering and post-trigger sample counting, plus multi-burst looping.

```
    pull                        ; Read loop count from TX FIFO
    out y 32                    ; Store loop count in Y register
    pull
    mov x, osr                  ; Store capture length in X (via OSR so it can be restored)

.wrap_target
    in pins 32                  ; Read sample (pre-trigger circular buffer)
    jmp pin POST_CAPTURE        ; If JMP pin is HIGH -> trigger fired, exit pre-trigger loop
.wrap

POST_CAPTURE:
    in pins 32                  ; Read sample (post-trigger)
    jmp x-- POST_CAPTURE        ; Decrement X; if X > 0, continue capturing post-trigger samples

    jmp y-- LOOP               ; Decrement Y (loop count); if Y > 0, go to next burst

    irq 0                      ; All bursts done -- notify CPU via IRQ 0

LOCK:
    jmp LOCK                   ; Infinite loop (halt program)

LOOP:
    mov x, osr                 ; Restore capture length from OSR for next burst

INNER_LOOP:
    jmp pin POST_CAPTURE       ; Wait for trigger again
    jmp INNER_LOOP
```

**Instruction-by-instruction:**
- `pull` / `out y 32` (lines 17-18): Read a 32-bit value from the TX FIFO and store it in the Y scratch register. This is the loop count (number of additional bursts after the first).
- `pull` / `mov x, osr` (lines 19-20): Read the post-trigger sample count into the OSR, then copy it to X. Using `mov` instead of `out` preserves the value in OSR so it can be restored for each burst iteration via `mov x, osr`.
- **Pre-trigger loop** (lines 22-27, wrapped): `in pins 32` captures a sample; `jmp pin POST_CAPTURE` checks the trigger pin. If the pin is HIGH (trigger condition met), execution jumps to POST_CAPTURE. Otherwise, the wrap causes the program to loop back to `in pins 32`. This continuously fills the DMA buffer in a circular fashion until the trigger fires.
- **Post-trigger loop** (lines 29-32): `in pins 32` captures a sample, then `jmp x-- POST_CAPTURE` decrements X and loops while X > 0. This captures exactly `postLength` samples after the trigger.
- **Burst loop** (line 34): `jmp y-- LOOP` decrements Y. If Y > 0, jumps to `LOOP` which restores X from OSR and enters `INNER_LOOP` to wait for the next trigger. If Y == 0, falls through to `irq 0`.
- `irq 0` (line 36): Signals the CPU that capture is complete. The IRQ handler (`simple_capture_completed`) then cleans up PIO/DMA resources.
- `LOCK` (lines 38-40): Infinite self-jump that halts the state machine after completion. The CPU will disable the SM.

### NEGATIVE_CAPTURE
**Lines 52-86.** Used for edge-triggered capture when waiting for a **falling edge** (trigger pin going LOW).

```
    pull / out y 32             ; Read loop count
    pull / mov x, osr           ; Read capture length

PRE_CAPTURE:
    in pins 32                  ; Read sample (pre-trigger)
    jmp pin PRE_CAPTURE         ; If JMP pin HIGH -> trigger NOT met, keep pre-capturing

POST_CAPTURE:
.wrap_target
    in pins 32                  ; Read sample (post-trigger)
    jmp x-- POST_CAPTURE        ; Count down post-trigger samples

    jmp y-- LOOP               ; Next burst or finish

    irq 0                      ; Done

LOCK:
    jmp LOCK

LOOP:
    mov x, osr                 ; Restore capture length

INNER_LOOP:
    jmp pin INNER_LOOP         ; While pin HIGH, keep waiting (trigger = pin going LOW)
.wrap
```

**Key difference from POSITIVE_CAPTURE:** The pre-trigger phase uses `jmp pin PRE_CAPTURE` which loops *while the pin is HIGH*. When the pin goes LOW, execution falls through to POST_CAPTURE. The wrap boundaries are also different -- the wrap covers the post-trigger and re-trigger wait, not the pre-trigger phase.

### POSITIVE_CAPTURE_MEASUREBURSTS
**Lines 89-127.** Identical to POSITIVE_CAPTURE but adds `irq 1` instructions to trigger NMI interrupts on the CPU for burst timing measurement.

Additional instructions compared to POSITIVE_CAPTURE:
- `irq wait 1` (line 95): After reading initial parameters, raises IRQ 1 and waits for it to be acknowledged. This synchronizes the first timestamp.
- `irq 1` (line 111): After all bursts complete (before `irq 0`), raises IRQ 1 to capture the final timestamp.
- `irq 1` (line 120): At the start of each new burst loop iteration, raises IRQ 1 to capture the inter-burst timestamp.

The NMI handler (`loopEndHandler` at `LogicAnalyzer_Capture.c` line 901) reads the SysTick counter value and stores it in the `loopTimestamp[]` array.

### NEGATIVE_CAPTURE_MEASUREBURSTS
**Lines 129-166.** Same as NEGATIVE_CAPTURE with the same `irq 1` additions for burst measurement, mirroring POSITIVE_CAPTURE_MEASUREBURSTS.

### COMPLEX_CAPTURE
**Lines 169-193.** Used with the complex trigger system. This program does not implement its own trigger detection -- instead, it relies on a separate trigger state machine that drives a GPIO pin.

```
    pull
    out x 32                   ; Read post-trigger capture length

    wait irq 7                 ; Wait for trigger program to signal readiness

.wrap_target
    in pins 32                 ; Read sample (pre-trigger circular buffer)
    jmp pin POST_CAPTURE       ; Check trigger pin (driven by COMPLEX_TRIGGER SM)
.wrap

POST_CAPTURE:
    in pins 32                 ; Read sample
    jmp x-- POST_CAPTURE       ; Count down post-trigger samples

    irq 0                      ; Done

LOCK:
    jmp LOCK
```

**Key details:**
- `wait irq 7` (line 174): Blocks until IRQ 7 is raised. The COMPLEX_TRIGGER state machine raises IRQ 7 after it has initialized, ensuring proper synchronization.
- The `jmp pin` monitors `COMPLEX_TRIGGER_IN_PIN` (GPIO 1), which is physically wired to `COMPLEX_TRIGGER_OUT_PIN` (GPIO 0). The trigger SM drives GPIO 0 HIGH when the pattern matches.
- No loop/burst support -- complex trigger always does a single capture.

### FAST_CAPTURE
**Lines 195-216.** Nearly identical to COMPLEX_CAPTURE but without the `wait irq 7` synchronization.

```
    pull
    out x 32                   ; Read post-trigger capture length

.wrap_target
    in pins 32                 ; Read sample
    jmp pin POST_CAPTURE       ; Check trigger pin
.wrap

POST_CAPTURE:
    in pins 32                 ; Read sample
    jmp x-- POST_CAPTURE       ; Count down

    irq 0                      ; Done

LOCK:
    jmp LOCK
```

The lack of `wait irq 7` means the capture starts immediately. The fast trigger program does not need explicit synchronization because it uses a different mechanism (jump table with side-set pins) that activates instantly.

### COMPLEX_TRIGGER
**Lines 218-240 (commented out as reference).** The actual program is stored in volatile memory (`COMPLEX_TRIGGER_program_instructions` array at `LogicAnalyzer_Capture.c` lines 82-94) because the `out y, N` instruction's bit count must be modified at runtime to match the trigger pin count.

```
    pull                       ; Read trigger value from TX FIFO
    out x 32                   ; Store trigger value in X

    set pins 0                 ; Set trigger output pin LOW (not triggered)

    irq 7                      ; Signal to COMPLEX_CAPTURE that trigger is ready

TRIGGER_LOOP:
    mov osr, pins              ; Read all pin states into OSR
    out y, N                   ; Shift N bits from OSR into Y (N = trigger pin count)
    jmp x!=y TRIGGER_LOOP      ; If Y != X (pattern doesn't match), keep checking

    set pins 1                 ; Pattern matched! Set trigger output pin HIGH

LOCK:
    jmp LOCK                   ; Halt
```

**Runtime modification** (`LogicAnalyzer_Capture.c` line 854):
```c
COMPLEX_TRIGGER_program_instructions[5] = 0x6040 | triggerPinCount;
```
This patches the `out y, N` instruction to shift the correct number of bits (matching the trigger pattern width).

**How it works:** The trigger SM continuously reads the GPIO pins into the OSR, shifts out the trigger-relevant bits into Y, and compares Y against the expected pattern in X. When they match, it sets the output pin HIGH, which is physically wired to the capture SM's JMP pin.

**Limitations:**
- Maximum trigger speed: ~66MHz (3 instructions per check at 200MHz clock)
- Trigger delay: 5 cycles (3 instructions + 2 propagation cycles = 25ns at 200MHz), compensated in software via `COMPLEX_TRIGGER_DELAY`
- Can glitch at low capture speeds: the trigger condition might be met for less time than one capture cycle

### FAST_TRIGGER
**Lines 117-157 of `LogicAnalyzer_Capture.c`.** A dynamically generated 32-instruction jump table that occupies an entire PIO instruction memory. This is the fastest trigger mechanism.

The `create_fast_trigger_program` function (line 136) builds the program:

```c
uint8_t create_fast_trigger_program(uint8_t pattern, uint8_t length) {
    uint8_t mask = (1 << length) - 1;
    for (i = 0; i < 32; i++) {
        if ((i & mask) == pattern)
            FAST_TRIGGER_program_instructions[i] = 0x1000 | i;  // JMP i SIDE 1
        else
            FAST_TRIGGER_program_instructions[i] = 0xA0A0;      // MOV PC, PINS SIDE 0
    }
}
```

**How it works:**
- The `in_base` pins are mapped to the trigger pins. The PIO reads these pins directly as the program counter via `MOV PC, PINS`.
- Each PIO clock cycle, the state machine jumps to the address that corresponds to the current pin state.
- At addresses matching the trigger pattern: `JMP self SIDE 1` -- the side-set pin (COMPLEX_TRIGGER_OUT_PIN) goes HIGH and the SM enters an infinite loop. The capture SM sees the HIGH JMP pin and exits its pre-trigger loop.
- At all other addresses: `MOV PC, PINS SIDE 0` -- the side-set pin stays LOW and the SM jumps to whatever address the pins currently represent, effectively polling at full speed.

**Performance characteristics:**
- Maximum trigger speed: 100MHz (1 instruction per check at system clock, though limited to match capture max)
- Trigger delay: 3 cycles (1 instruction + 2 propagation cycles = 15ns at 200MHz), compensated via `FAST_TRIGGER_DELAY`
- Maximum pattern width: 5 bits (since the PIO instruction memory is 32 entries = 2^5)
- Occupies an entire PIO unit (all 32 instruction slots), so uses PIO0 for trigger and PIO1 for capture

---

## Trigger Modes

### Edge Trigger (Simple)

**Firmware entry point:** `StartCaptureSimple()` (`LogicAnalyzer_Capture.c` line 1030)

Uses POSITIVE_CAPTURE or NEGATIVE_CAPTURE programs (or their MEASUREBURSTS variants when burst timing is enabled).

**Trigger mechanism:** The `jmp pin` instruction directly monitors a single GPIO pin. The trigger pin is one of the mapped capture pins (or the external trigger pin at index `MAX_CHANNELS` in the pin map).

**Polarity handling:** For positive-edge triggering (waiting for pin to go HIGH), the firmware uses NEGATIVE_CAPTURE (which loops while pin is HIGH during pre-capture, then starts post-capture when it goes LOW... but wait, this seems inverted). Looking at the code more carefully:

At `LogicAnalyzer_Capture.c` line 1100:
```c
if(invertTrigger)
    captureOffset = pio_add_program(capturePIO, &NEGATIVE_CAPTURE_program);
else
    captureOffset = pio_add_program(capturePIO, &POSITIVE_CAPTURE_program);
```

The naming convention: POSITIVE_CAPTURE waits for the `jmp pin` to be HIGH (positive), meaning it triggers on a rising edge. The `invertTrigger` flag selects the opposite program. The `simple_capture_completed` handler (line 412) removes the correct program based on `lastTriggerInverted`.

**GPIO input override:** For blast mode specifically, `gpio_set_inover(triggerPin, 1)` (line 991) inverts the trigger pin input when `invertTrigger` is false. This is because BLAST_CAPTURE loops while pin is HIGH, so to trigger on a rising edge, the input must be inverted.

**Burst/loop support:** The Y register holds the loop count. After each post-trigger capture completes, Y is decremented. If Y > 0, the program re-enters the trigger wait loop for the next burst.

**Parameters pushed to PIO TX FIFO** (`LogicAnalyzer_Capture.c` lines 1198-1199):
```c
pio_sm_put_blocking(capturePIO, sm_Capture, loopCount);
pio_sm_put_blocking(capturePIO, sm_Capture, postLength - 1);
```
The post-trigger length is decremented by 1 because `jmp x--` tests *then* decrements (it captures `postLength` samples total including the initial `in pins 32` before the loop check).

### Complex Trigger

**Firmware entry point:** `StartCaptureComplex()` (`LogicAnalyzer_Capture.c` line 723)

Uses COMPLEX_CAPTURE for sampling and COMPLEX_TRIGGER for pattern detection. Both run on PIO0 as separate state machines.

**Two-SM architecture:**
1. **Trigger SM** runs at maximum clock speed (clkdiv = 1) and continuously compares GPIO pin states against a target pattern
2. **Capture SM** runs at the requested sample rate and monitors `COMPLEX_TRIGGER_IN_PIN` (GPIO 1) via `jmp pin`
3. GPIO 0 (output from trigger SM) is physically wired to GPIO 1 (input to capture SM)

**Pattern matching:** The trigger SM reads pins into OSR, shifts out `triggerPinCount` bits into Y, and compares against X (the target value). The pin count in the `out y, N` instruction is patched at runtime.

**Limitations:**
- Maximum trigger check rate: ~66MHz (3 instructions per iteration)
- Trigger delay: 5 PIO cycles
- Cannot do burst/loop captures
- Trigger pattern up to 16 bits wide
- Trigger pins must be in the first 16 channels (base + count <= 16)

### Fast Trigger

**Firmware entry point:** `StartCaptureFast()` (`LogicAnalyzer_Capture.c` line 560)

Uses FAST_CAPTURE for sampling (on PIO1) and the runtime-generated FAST_TRIGGER jump table (on PIO0).

**Key differences from complex trigger:**
- Uses separate PIO units (PIO0 for trigger, PIO1 for capture) because the trigger program needs all 32 instruction slots
- Trigger check is 1 instruction per cycle (vs 3 for complex)
- Maximum pattern width: 5 bits (vs 16 for complex)
- Trigger delay: 3 cycles (vs 5 for complex)
- The FAST_CAPTURE program does not use `wait irq 7` synchronization

**Side-set pin mechanism:** The fast trigger uses `SIDE 1` / `SIDE 0` encoding in the instructions. Side-set pins are changed simultaneously with instruction execution, so the trigger output pin transitions at the exact same cycle as the pattern match, reducing latency.

### Blast Capture (No Pre-trigger)

**Firmware entry point:** `StartCaptureBlast()` (`LogicAnalyzer_Capture.c` line 909)

Uses BLAST_CAPTURE program. This is the highest-speed capture mode.

**Key characteristics:**
- No pre-trigger buffer (preSamples must be 0)
- No burst/loop support (loopCount must be 0)
- Frequency must exactly equal `blastFrequency` (200MHz normal, 400MHz turbo)
- Clock divider is 1:1 (not 2:1 like other modes)
- Uses a single DMA channel (not ping-pong)
- DMA gets full bus priority (`bus_ctrl_hw->priority = BUSCTRL_BUS_PRIORITY_DMA_W_BITS | BUSCTRL_BUS_PRIORITY_DMA_R_BITS`)
- Capture completes when DMA transfer count reaches zero (DMA IRQ, not PIO IRQ)

**Why it is faster:** In normal capture modes, the PIO runs at 2x the sample frequency because each sample requires 2 instructions (`in pins` + `jmp pin`). BLAST_CAPTURE's capture loop is a single `in pins 32` instruction in the wrap, so 1 PIO cycle = 1 sample. Combined with the 1:1 clock divider, this achieves the system clock frequency as the sample rate.

---

## Turbo/Burst Mode

**Configuration:** `LogicAnalyzer_Board_Settings.h` lines 74-80, 95-101

When `TURBO_MODE` is defined at build time:
- System clock is overclocked to 400MHz (from the default 200MHz) via `set_sys_clock_khz(400000, true)` (`LogicAnalyzer.c` line 663)
- Voltage regulator is set to 1.30V (`vreg_set_voltage(VREG_VOLTAGE_1_30)`, line 659)
- `MAX_FREQ` doubles from 100MHz to 200MHz
- `MAX_BLAST_FREQ` doubles from 200MHz to 400MHz

**Burst mode** (loopCount > 0) is different from turbo mode. In burst mode, the capture repeats multiple times (up to 65534 loops), each time waiting for the trigger condition to be met again. This is implemented in the PIO program's Y register loop. With `measureBursts` enabled, the inter-burst timing is measured using the SysTick timer and NMI interrupts.

**Burst timestamp mechanism:**
1. The `POSITIVE_CAPTURE_MEASUREBURSTS` / `NEGATIVE_CAPTURE_MEASUREBURSTS` programs raise `irq 1` at specific points
2. IRQ 1 is routed through the NMI mechanism (`LogicAnalyzer_Capture.c` lines 1157-1172) for lowest latency
3. The NMI handler `loopEndHandler` (line 901) reads `systick_hw->cvr` (current value register) and combines it with a rollover counter: `loopTimestamp[timestampIndex++] = systick_hw->cvr | systickLoops << 24`
4. A SysTick rollover handler `sysTickRoll` (line 896) increments `systickLoops` when the 24-bit counter wraps
5. SysTick is configured with max reload value (0x00FFFFFF) at CPU clock frequency

**Limitations for burst measurement:**
- Maximum 254 loops when measuring (`loopCount > 253` returns false, line 1056)
- Post-trigger samples must be >= 100 when measuring (validated in software)
- Timestamp array size is 256 entries (`loopTimestamp[256]`, line 56)

---

## Channel Count and Capture Modes

**Defined in:** `LogicAnalyzer_Capture.h` lines 9-15

Three capture modes control the data width:

| Mode | Enum | Bytes/Sample | Max Samples (128KB buffer) | Max Samples (384KB buffer, Pico 2) |
|------|------|-------------|---------------------------|-----------------------------------|
| 8-channel | `MODE_8_CHANNEL` | 1 | 131,072 | 393,216 |
| 16-channel | `MODE_16_CHANNEL` | 2 | 65,536 | 196,608 |
| 24-channel | `MODE_24_CHANNEL` | 4 | 32,768 | 98,304 |

**Mode selection:** Determined by the highest channel number in the capture request. If all channels are 0-7, 8-channel mode is used. If any channel is 8-15, 16-channel mode. If any channel is 16-23, 24-channel mode. (`AnalyzerDriver.getCaptureMode()` in `Software/Web/src/core/driver/analyzer.js` line 114)

**DMA transfer size** matches the mode:
- 8-channel: `DMA_SIZE_8` (byte transfers)
- 16-channel: `DMA_SIZE_16` (halfword transfers)
- 24-channel: `DMA_SIZE_32` (word transfers)

**PIO always captures 32 bits** via `in pins 32`. The DMA transfer size determines how many of those bits are stored. With `DMA_SIZE_8`, only the lowest 8 bits of each 32-bit FIFO entry are transferred. This is why the PIO `in_base` pin must be set correctly and channels must map to the appropriate bit positions.

**Autopush configuration** (`LogicAnalyzer_Capture.c` line 1143):
```c
sm_config_set_in_shift(&smConfig, true, true, 0);
```
- First `true`: shift right (LSB first) for simple/blast captures
- Second `true`: autopush enabled
- `0`: push threshold of 0 means push every 32 bits

Note: For complex and fast captures, the shift direction is left (`false`):
```c
sm_config_set_in_shift(&smConfig, false, true, 0);  // line 665, 831
```

---

## GPIO Pin Mapping

**Defined in:** `LogicAnalyzer_Board_Settings.h` via `PIN_MAP` macro

For the Pico / Pico 2 boards (line 72):
```c
#define PIN_MAP {2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,26,27,28,COMPLEX_TRIGGER_IN_PIN}
```

- `INPUT_PIN_BASE = 2` -- the PIO reads consecutive pins starting from GPIO 2
- Channels 0-20 map to GPIO 2-22 (contiguous)
- Channels 21-23 map to GPIO 26-28 (skip GPIO 23-25 which are used for other purposes)
- Channel 24 (index `MAX_CHANNELS`) maps to `COMPLEX_TRIGGER_IN_PIN` (GPIO 1) -- this is the external trigger input
- GPIO 0 = `COMPLEX_TRIGGER_OUT_PIN` (output from trigger SM)
- GPIO 1 = `COMPLEX_TRIGGER_IN_PIN` (input to capture SM, physically wired to GPIO 0)

For the Zero board (line 174):
```c
#define PIN_MAP {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,26,27,28,29,22,23,24,25,COMPLEX_TRIGGER_IN_PIN}
```

**Pin remapping in GetBuffer():** After capture completes, the firmware reorders the bits in each sample. The PIO captures raw GPIO states where bit N corresponds to GPIO (INPUT_PIN_BASE + N). The `GetBuffer()` function (`LogicAnalyzer_Capture.c` lines 1217-1369) iterates through each sample and remaps bits from their GPIO position to their logical channel position:

```c
for (int pin = 0; pin < lastCapturePinCount; pin++) {
    lastPin = lastCapturePins[pin] - INPUT_PIN_BASE;
    newValue |= (((oldValue & (1 << lastPin))) >> lastPin) << pin;
}
```

This means that after processing, bit 0 of each sample corresponds to the first requested channel, bit 1 to the second, and so on, regardless of which GPIO pins they map to.

**Blast mode trigger pin inversion:** For blast captures with positive trigger (non-inverted), the trigger pin's bit in the captured data is inverted during post-processing (`LogicAnalyzer_Capture.c` lines 1258-1270):
```c
if (lastCaptureType == CAPTURE_TYPE_BLAST && !lastTriggerInverted)
    oldValue ^= blastMask;
```
This compensates for the `gpio_set_inover(triggerPin, 1)` that was applied to make the BLAST_CAPTURE trigger logic work.

---

## Clock Divider and Frequency Configuration

**Normal capture modes (simple, complex, fast):**
The PIO clock divider is set to produce a clock **2x** the requested sample frequency:

```c
float clockDiv = (float)clock_get_hz(clk_sys) / (float)(freq * 2);
```
(`LogicAnalyzer_Capture.c` line 1088)

This is because each sample in the pre-trigger loop requires 2 PIO instructions (`in pins 32` + `jmp pin`), so the PIO must run at twice the sample rate.

**Blast capture mode:**
The clock divider is 1:1 with the requested frequency:

```c
float clockDiv = (float)clock_get_hz(clk_sys) / (float)(freq);
```
(`LogicAnalyzer_Capture.c` line 965)

This works because the capture loop is a single instruction (`in pins 32` in the wrap).

**Frequency limits:**

| Board | System Clock | MAX_FREQ (normal) | MAX_BLAST_FREQ | MIN_FREQ |
|-------|-------------|-------------------|----------------|----------|
| Pico/Pico 2 (normal) | 200MHz | 100MHz | 200MHz | ~6.1kHz |
| Pico/Pico 2 (turbo) | 400MHz | 200MHz | 400MHz | ~12.2kHz |
| Pico W / Pico 2W | 200MHz | 100MHz | 200MHz | ~6.1kHz |

**Minimum frequency** is calculated as: `(MaxFrequency * 2) / 65535`

This comes from the PIO clock divider being a 16-bit integer + 8-bit fractional value. The maximum divider is 65535, and since normal mode runs at 2x frequency, the minimum achievable frequency is `(sysclk / 65535) / 2 = sysclk / 131070`. For 200MHz sysclk: ~1526Hz. However, the software reports `(MaxFrequency * 2) / 65535` which at 100MHz gives ~3052Hz.

**Complex/Fast trigger clock:** The trigger state machine always runs at maximum speed (clkdiv = 1), regardless of the capture sample rate (`LogicAnalyzer_Capture.c` line 697 for fast, line 864 for complex).

---

## DMA Configuration

### Ping-Pong DMA (Normal Capture)

**Function:** `configureCaptureDMAs()` (`LogicAnalyzer_Capture.c` lines 466-522)

Two DMA channels are configured in a chained ping-pong arrangement:

```
Channel 0 → writes to captureBuffer → when done, triggers Channel 1
Channel 1 → writes to captureBuffer → when done, triggers Channel 0
```

Both channels:
- Read from PIO RX FIFO (non-incrementing read address)
- Write to `captureBuffer` (incrementing write address)
- Transfer size matches capture mode (8/16/32 bit)
- Transfer count = `CAPTURE_BUFFER_SIZE / bytesPerSample`
- Chain to each other (`channel_config_set_chain_to`)
- Both trigger DMA IRQ 0 on completion

The DMA IRQ handler (`dma_handler`, line 225) resets the write address back to `captureBuffer` when a channel completes, creating a circular buffer:

```c
void dma_handler() {
    if (dma_channel_get_irq0_status(dmaPingPong0)) {
        dma_channel_acknowledge_irq0(dmaPingPong0);
        dma_channel_set_write_addr(dmaPingPong0, captureBuffer, false);
    } else {
        dma_channel_acknowledge_irq0(dmaPingPong1);
        dma_channel_set_write_addr(dmaPingPong1, captureBuffer, false);
    }
}
```

This means the DMA continuously overwrites the same buffer. When the PIO capture finishes (via `irq 0`), the DMA is stopped and the buffer contains the most recent data in a circular arrangement.

**Finding the tail:** `find_capture_tail()` (line 164) determines which DMA channel is currently active and reads its `transfer_count` register to find the last written position:

```c
uint32_t transfer = (transferCount - transferPos) - 1;
```

### Single DMA (Blast Capture)

**Function:** `configureBlastDMA()` (`LogicAnalyzer_Capture.c` lines 423-463)

Uses only one DMA channel with a fixed transfer count equal to the requested sample length. No chaining, no circular buffer.

```c
dma_channel_configure(dmaPingPong0, &dmaConfig, captureBuffer,
    &capturePIO->rxf[sm_Capture], length, true);
```

DMA bus priority is set to maximum:
```c
bus_ctrl_hw->priority = BUSCTRL_BUS_PRIORITY_DMA_W_BITS | BUSCTRL_BUS_PRIORITY_DMA_R_BITS;
```

When the DMA transfer completes, it fires IRQ 0 which calls `blast_capture_completed()` (line 344).

---

## Capture Completion and Buffer Processing

When capture completes, the relevant completion handler is called:
- `simple_capture_completed()` (line 377) -- for edge trigger
- `complex_capture_completed()` (line 308) -- for complex trigger
- `fast_capture_completed()` (line 270) -- for fast trigger
- `blast_capture_completed()` (line 344) -- for blast mode

Each handler:
1. Disables GPIO overrides
2. Finds the buffer tail position via `find_capture_tail()`
3. Aborts DMA channels
4. Clears PIO interrupts and removes handlers
5. Stops and unclaims PIO state machines
6. Removes PIO programs from instruction memory
7. Sets `captureFinished = true`

The main loop in `LogicAnalyzer.c` (line 714) polls `IsCapturing()`. When capture is done:

1. Calls `GetBuffer()` which:
   - Computes total sample count: `lastPreSize + (lastPostSize * (lastLoopCount + 1))`
   - Calculates start position from the tail position
   - Remaps GPIO bits to logical channel order (in-place)
   - Returns pointer to buffer, sample count, start position, and capture mode

2. Calls `GetTimestamps()` which returns the timestamp array and its length

3. Transfers data via USB CDC or WiFi:
   - Sends 4-byte sample count (UInt32 LE)
   - Sends raw sample data (handles circular buffer wrap-around)
   - Sends 1-byte timestamp length
   - If timestamps present, sends `timestampLength * 4` bytes of UInt32 LE timestamps

**Circular buffer handling** during transfer (`LogicAnalyzer.c` lines 800-806):
```c
if (first + length > CAPTURE_BUFFER_SIZE) {
    cdc_transfer(buffer + first, CAPTURE_BUFFER_SIZE - first);  // End of buffer
    cdc_transfer(buffer, (first + length) - CAPTURE_BUFFER_SIZE); // Wrap to start
} else {
    cdc_transfer(buffer + first, length);
}
```

---

## Software Side: Web Client

### Protocol and Packet Framing

**File:** `Software/Web/src/core/protocol/packets.js`

The communication protocol uses binary frames with byte-stuffing:

| Component | Bytes | Value |
|-----------|-------|-------|
| Header | 2 | `0x55 0xAA` |
| Payload | variable | Escaped data |
| Footer | 2 | `0xAA 0x55` |

**Escaping:** Bytes `0xAA`, `0x55`, and `0xF0` within the payload are escaped as `[0xF0, byte ^ 0xF0]`. For example, `0xAA` becomes `[0xF0, 0x5A]`.

**Commands** (`Software/Web/src/core/protocol/commands.js`):
- `0x00` = Device init (ID request)
- `0x01` = Start capture
- `0xFF` = Stop capture (sent as raw byte, NOT framed)

### Capture Request Construction

**File:** `Software/Web/src/core/protocol/packets.js` lines 119-145

The `buildCaptureRequest()` function constructs a 56-byte struct matching the C `CAPTURE_REQUEST`:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | triggerType (0=Edge, 1=Complex, 2=Fast, 3=Blast) |
| 1 | 1 | triggerChannel |
| 2 | 1 | invertedOrCount |
| 3 | 1 | padding (alignment) |
| 4 | 2 | triggerValue (LE) |
| 6 | 32 | channels[32] (zero-padded) |
| 38 | 1 | channelCount |
| 39 | 1 | padding (alignment) |
| 40 | 4 | frequency (LE) |
| 44 | 4 | preSamples (LE) |
| 48 | 4 | postSamples (LE) |
| 52 | 2 | loopCount (LE) |
| 54 | 1 | measure |
| 55 | 1 | captureMode |

**Trigger delay compensation** (for Complex and Fast triggers):
The `composeRequest()` method in `analyzer.js` (lines 263-282) adjusts pre/post sample counts to compensate for trigger detection delay:

```javascript
const samplePeriod = 1e9 / session.frequency
const delay = session.triggerType === TRIGGER_FAST ? FAST_TRIGGER_DELAY : COMPLEX_TRIGGER_DELAY
const delayPeriod = (1.0 / this.#maxFrequency) * 1e9 * delay
const offset = Math.round(delayPeriod / samplePeriod + 0.3)

// Shift the pre/post boundary to account for trigger delay
preSamples: session.preTriggerSamples + offset,
postSamples: session.postTriggerSamples - offset,
```

This ensures that the trigger point appears at the correct position in the captured data despite the hardware delay in pattern detection.

### Capture Data Reception and Parsing

**File:** `Software/Web/src/core/protocol/parser.js` lines 133-175

The `parseCaptureData()` function reads the binary capture data:

1. **Read sample count** (4 bytes, UInt32 LE)
2. **Read raw samples** (`sampleCount * bytesPerSample` bytes):
   - 8-channel mode: 1 byte per sample -> `getUint8()`
   - 16-channel mode: 2 bytes per sample -> `getUint16(i*2, true)`
   - 24-channel mode: 4 bytes per sample -> `getUint32(i*4, true)`
3. **Read timestamp flag** (1 byte): if > 0 and bursts enabled, timestamps follow
4. **Read timestamps** (`(loopCount + 2) * 4` bytes of UInt32 LE)

Each raw sample is stored in a Uint32Array regardless of the source width.

### Sample Extraction

**File:** `Software/Web/src/core/driver/samples.js` lines 15-22

The `extractSamples()` function extracts per-channel binary data from packed multi-channel samples:

```javascript
export function extractSamples(rawSamples, channelIndex) {
  const mask = 1 << channelIndex
  const result = new Uint8Array(rawSamples.length)
  for (let i = 0; i < rawSamples.length; i++) {
    result[i] = (rawSamples[i] & mask) !== 0 ? 1 : 0
  }
  return result
}
```

Note: `channelIndex` here is the **position** of the channel in the capture request (0-based), not the GPIO number. The firmware already remapped GPIO positions to sequential channel positions in `GetBuffer()`.

### Burst Timestamp Processing

**File:** `Software/Web/src/core/driver/samples.js` lines 36-98

The `processBurstTimestamps()` function converts raw SysTick timestamps into inter-burst timing information:

1. **Invert lower 24 bits** (SysTick counts down): `ts[i] = (raw & 0xff000000) | (0x00ffffff - (raw & 0x00ffffff))`
2. **Handle rollover and jitter**: If the gap between consecutive timestamps is less than the expected burst duration, all subsequent timestamps are shifted forward to correct for jitter
3. **Calculate delays**: For each pair of consecutive timestamps (starting from index 2), compute the inter-burst gap in nanoseconds: `(top - ts[i-1] - ticksPerBurst) * tickLength`
4. **Build BurstInfo array**: Each entry contains start/end sample indices and the gap duration in both samples and nanoseconds

---

## Software Side: Legacy C# Client

**File:** `Software/LogicAnalyzer/SharedDriver/LogicAnalyzerDriver.cs`

The C# client follows the same flow but uses .NET serialization:

### Request Composition (lines 682-731)
Uses `Marshal.StructureToPtr` to serialize the `CaptureRequest` struct, identical field layout to the JS version.

### Capture Reading (lines 442-670)

The `ReadCapture` method runs in a background `Task`:

1. Reads UInt32 sample count via `BinaryReader.ReadUInt32()`
2. For serial connections, pre-reads the entire expected byte count into a `MemoryStream` to avoid timeout issues during slow serial reads (lines 472-491)
3. Reads samples according to capture mode using `ReadByte()`, `ReadUInt16()`, or `ReadUInt32()`
4. Reads timestamp flag and timestamp data
5. Processes timestamps with the same jitter correction algorithm
6. Extracts per-channel samples via `ExtractSamples` (line 672): `samples.Select(s => (s & mask) != 0 ? (byte)1 : (byte)0).ToArray()`

### Validation (lines 734-799)
The `ValidateSettings` method mirrors the Web client's `validateSettings`:
- Edge trigger: validates channel range, trigger channel (allowing `ChannelCount` as external trigger), sample limits, frequency bounds, burst constraints
- Blast trigger: preSamples must be 0, frequency must exactly equal BlastFrequency, loopCount must be 0
- Complex/Fast trigger: validates trigger bit count (max 16 for complex, max 5 for fast), trigger channel base must be 0-15

### Key Differences from Web Client
- C# uses `BinaryReader` for deserialization vs manual `DataView` parsing in JS
- C# reads serial data in bulk into a `MemoryStream` before parsing (to handle serial port buffering)
- C# fires `CaptureCompleted` event or calls an action delegate; Web client uses a callback
- C# uses `UInt64` for timestamps; JS uses `Uint32Array` (sufficient since raw values are 32-bit)

---

## Limitations and Edge Cases

1. **Buffer size constrains total samples:** The capture buffer is fixed at compile time (128KB for Pico, 384KB for Pico 2). Total samples = `preSamples + postSamples * (loopCount + 1)` must fit within `CAPTURE_BUFFER_SIZE / bytesPerSample`.

2. **Pre-trigger samples are limited to 10% of total buffer:** `maxPreSamples = totalSamples / 10` (enforced in software, not hardware).

3. **Complex/Fast trigger only works on first 16 channels:** Trigger pins must satisfy `triggerPinBase + triggerPinCount <= 16` (complex) or `<= 5` (fast). This is because the trigger mechanism reads from a contiguous block of GPIO pins starting at `INPUT_PIN_BASE`.

4. **Blast mode has no pre-trigger buffer:** It is a simple "trigger then capture" mechanism with no circular buffering. Pre-trigger samples must be 0.

5. **Blast mode frequency is fixed:** Must exactly equal `blastFrequency` (the maximum). No clock division is possible while maintaining single-instruction capture.

6. **Complex trigger can glitch at low sample rates:** The trigger SM runs at full speed while the capture SM runs at the requested rate. A trigger condition lasting less than one capture cycle may be missed by the capture SM's `jmp pin` instruction.

7. **Fast trigger occupies full PIO:** The 32-instruction jump table requires an entire PIO module. On boards that use PIO1 for WiFi (Pico W), the capture must use the remaining PIO, which may conflict.

8. **WiFi has a 2-second delay before data transfer:** (`LogicAnalyzer.c` line 736: `sleep_ms(2000)`) to allow the WiFi connection to stabilize.

9. **Trigger pin can be beyond the capture channels:** The trigger channel can be set to `MAX_CHANNELS` (typically 24), which maps to the external trigger pin (`COMPLEX_TRIGGER_IN_PIN`). This allows triggering on a signal that is not being captured.

10. **Capture data is transferred with stdio disabled:** Before sending capture data, `stdio_usb_deinit()` is called (line 728) to prevent TinyUSB's background task from interfering with the bulk data transfer. It is re-enabled after transfer with `stdio_usb_init()` (line 816).

11. **Stop capture sends raw 0xFF:** The stop command is NOT framed in an OutputPacket. It is sent as a single raw byte (`CMD_STOP_CAPTURE = 0xFF`), and the firmware checks for any incoming data during capture wait and interprets any data as a cancel signal (line 827: `processCancel()` returns true on any input).

12. **Circular buffer wrap-around during transfer:** The firmware handles the case where the capture data wraps around the end of the buffer by sending two separate chunks (end-of-buffer, then beginning-of-buffer).

13. **Minimum post-trigger samples for burst measurement:** When `measureBursts` is true, `postTriggerSamples` must be >= 100 to ensure meaningful timing measurements.

14. **USB disconnect detection during capture:** If the USB CDC connection is lost while waiting for a trigger, the firmware automatically stops the capture (`LogicAnalyzer.c` lines 835-840).

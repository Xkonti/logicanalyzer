# Streaming Mode: Detailed Technical Documentation

This document describes the real-time streaming capture mode of the LogicAnalyzer V2 firmware, which continuously captures and streams logic analyzer data at sample rates of 1-3 MHz to the host over USB or WiFi.

## Overview

Streaming mode provides continuous, real-time data capture as opposed to the trigger-based "capture mode" that stores everything on-device first. The key architectural challenge is maintaining continuous data flow from GPIO pins through PIO, DMA, compression, and transport without dropping samples or overflowing buffers.

The system uses a **three-stage pipeline** spread across both CPU cores:

1. **PIO + DMA (hardware):** Continuously samples GPIO pins and writes interleaved sample data into a ring buffer via two chained DMA channels.
2. **Core 1 (compression):** Reads completed DMA slots, bit-transposes the data, and compresses each channel using a nibble-based encoding scheme.
3. **Core 0 (transport):** Sends compressed chunks over USB CDC or WiFi, while also polling for stop commands.

---

## 1. Initiating a Stream

### 1.1 Host Command

The host sends a binary-framed command with command byte `10` (decimal) to start streaming. The binary frame protocol uses `0x55 0xAA` as start delimiter and `0xAA 0x55` as end delimiter, with `0xF0` as an escape character.

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c`, lines 435-458

The command payload is deserialized as a `STREAM_REQUEST` struct:

```c
// File: Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h, lines 44-55
typedef struct _STREAM_REQUEST
{
    uint8_t channels[32];     // Channels to capture
    uint8_t channelCount;     // Number of channels (1-24)
    uint16_t chunkSamples;    // Chunk size in samples (32-1024, must be multiple of 32)
    uint32_t frequency;       // Sampling frequency in Hz
} STREAM_REQUEST;
```

The main loop validates the request and calls `StartStream()`:

```c
// File: Firmware/LogicAnalyzer_V2/LogicAnalyzer.c, lines 435-458
case 10: // Start stream
{
    if(capturing || streaming_active)
    {
        sendResponse("ERR_BUSY\n", fromWiFi);
        break;
    }
    STREAM_REQUEST* streamReq = (STREAM_REQUEST*)&messageBuffer[3];
    if(!StartStream(streamReq, fromWiFi))
    {
        sendResponse("STREAM_ERROR\n", fromWiFi);
        break;
    }
    streaming_active = true;
    break;
}
```

### 1.2 StartStream() Initialization

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 225-333

`StartStream()` performs the following steps in order:

1. **Validate parameters:** Channel count must be 1-24, frequency must be >= 1. Each channel index must be < `MAX_CHANNELS` (typically 24).

2. **Determine capture mode:** Based on the highest channel index requested:
   - Channels 0-7: `MODE_8_CHANNEL` (1 byte per sample, DMA_SIZE_8)
   - Channels 8-15: `MODE_16_CHANNEL` (2 bytes per sample, DMA_SIZE_16)
   - Channels 16-23: `MODE_24_CHANNEL` (4 bytes per sample, DMA_SIZE_32)

   This determines how many bits the PIO shifts in per sample and the DMA transfer size. (Lines 233-258)

3. **Build channel map:** The `stream_channel_map[]` array maps selected channel indices to their bit positions in the DMA data. This allows the host to request a sparse subset of channels (e.g., channels 0, 3, 7) while the PIO always captures a full 8/16/24-bit word. (Lines 234-240)

4. **Compute actual frequency:** The PIO clock divider is `clk_sys / requested_freq`, clamped to max 65535. The actual achievable frequency is then `clk_sys / clockDiv`. With `clk_sys` at 200 MHz (or 400 MHz in turbo mode), the minimum frequency is ~3052 Hz (200MHz/65535). (Lines 263-267)

5. **Validate and set chunk size:** The client-provided `chunkSamples` is clamped to [32, 1024] and rounded down to a multiple of 32. (Lines 270-277)

6. **Reset pipeline counters:** `dma_complete_count`, `compress_head`, and `send_head` are all set to 0. The `streaming` flag is set to `true`. (Lines 280-284)

7. **Setup PIO** via `setup_stream_pio()`. (Line 289)

8. **Setup DMA ring buffer** via `configure_stream_dma()`. (Line 296)

9. **Disable stdio_usb:** `stdio_usb_deinit()` is called to prevent `tud_task()` reentrancy and stdio mutex deadlocks when Core 1 is reset. (Line 301)

10. **Launch Core 1:** `multicore_reset_core1()` followed by `multicore_launch_core1(stream_core1_entry)` starts the compression loop on the second core. (Lines 303-304)

11. **Enable PIO:** `pio_sm_set_enabled()` starts the state machine; capture begins immediately. (Line 307)

12. **Send handshake:** A text response `"STREAM_STARTED\n"` is sent, followed by an 8-byte binary info header:
    - Bytes 0-1: `stream_chunk_samples` (little-endian uint16)
    - Byte 2: `stream_num_channels`
    - Byte 3: reserved (0)
    - Bytes 4-7: `stream_actual_freq` (little-endian uint32)

    (Lines 309-331)

---

## 2. PIO Program for Streaming

### 2.1 Reusing BLAST_CAPTURE

Streaming reuses the `BLAST_CAPTURE` PIO program, which is the simplest capture program in the firmware.

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer.pio`, lines 2-12

```
.program BLAST_CAPTURE

LOOP:
    jmp pin LOOP                ;wait for trigger

.wrap_target
    in pins 32                  ;capture
.wrap
```

The program has two parts:
- **Offset 0:** `jmp pin LOOP` -- a trigger-wait instruction used in capture mode.
- **Offset 1 (`.wrap_target`):** `in pins 32` -- reads all 32 GPIO pins into the ISR, with autopush enabled to push a full 32-bit word to the RX FIFO every cycle.

The `.wrap` directive causes the program to loop back to offset 1 indefinitely, reading one sample per PIO clock cycle.

### 2.2 Bypassing the Trigger

For streaming, the trigger instruction is irrelevant. The PIO state machine's program counter is initialized to `stream_pio_offset + 1`, skipping the `jmp pin LOOP` instruction entirely and starting continuous capture immediately.

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 207-216

```c
/*
 * BLAST_CAPTURE program layout:
 *   offset 0: jmp pin LOOP    (trigger wait -- we skip this)
 *   offset 1: in pins 32      (.wrap_target -- continuous capture)
 *   .wrap back to offset 1
 *
 * By initializing the PC to offset+1, we bypass the trigger instruction
 * entirely and start continuous capture immediately.
 */
pio_sm_init(stream_pio, stream_sm, stream_pio_offset + 1, &smConfig);
```

### 2.3 PIO Configuration Details

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 178-218

- Uses `pio0`.
- Input pins start at `INPUT_PIN_BASE` (typically GPIO 2).
- All `MAX_CHANNELS` pins are configured as PIO inputs with `pio_sm_set_consecutive_pindirs()` and `pio_gpio_init()`.
- Clock divider: `clk_sys / frequency`, clamped to 65535 max.
- ISR shift: right-shift, autopush enabled, push threshold 0 (meaning push every 32 bits).
- `sm_config_set_in_shift(&smConfig, true, true, 0)` -- shifts right, autopush on, threshold=0 (32 bits).

The PIO always captures a full 32-bit word of GPIO state. Only the relevant bits (lower 8, 16, or 24) contain meaningful channel data. The DMA transfer size determines how many of those bytes are actually written to memory per sample.

---

## 3. DMA Setup: Double-Buffered Ring with Chaining

### 3.1 Ring Buffer Layout

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.h`, lines 8-12

```c
#define STREAM_SLOTS            8
#define STREAM_MAX_CHUNK        1024
#define STREAM_INPUT_SLOT_SIZE  (STREAM_MAX_CHUNK * 4)   /* 4096 bytes (24ch worst case) */
#define STREAM_OUTPUT_SLOT_SIZE 3080                      /* max compressed for 24ch/1024 */
```

The ring buffer consists of 8 slots, each capable of holding up to 1024 samples at 4 bytes/sample (24-channel mode). The actual number of bytes written per slot depends on the capture mode and chunk size.

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 28-30

```c
static uint8_t  stream_input[STREAM_SLOTS][STREAM_INPUT_SLOT_SIZE]  __attribute__((aligned(4)));
static uint8_t  stream_output[STREAM_SLOTS][STREAM_OUTPUT_SLOT_SIZE] __attribute__((aligned(4)));
static uint32_t stream_output_size[STREAM_SLOTS];
```

- `stream_input[][]`: DMA writes raw samples here (8 slots x 4096 bytes = 32 KB).
- `stream_output[][]`: Core 1 writes compressed data here (8 slots x 3080 bytes = ~24 KB).
- `stream_output_size[]`: Size of compressed output for each slot.

### 3.2 Two Chained DMA Channels

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 91-137

Two DMA channels (`stream_dma0` and `stream_dma1`) are configured with mutual chaining:

- `dma0` chains to `dma1`, `dma1` chains to `dma0`.
- When `dma0` finishes transferring `stream_chunk_samples` words, `dma1` automatically starts.
- When `dma1` finishes, `dma0` automatically starts again.

Each channel is configured as:
- **Read address:** PIO RX FIFO (`&stream_pio->rxf[stream_sm]`), non-incrementing.
- **Write address:** A slot in `stream_input[][]`, incrementing.
- **Transfer size:** Matches the capture mode (8-bit, 16-bit, or 32-bit).
- **Transfer count:** `stream_chunk_samples` (the number of samples per chunk).
- **DREQ:** PIO RX FIFO data request, so DMA paces itself to the PIO output rate.
- **IRQ:** Both channels trigger `DMA_IRQ_1` on completion.

Initial configuration (lines 130-136):
- `dma1` is configured with write address `stream_input[1]` but NOT triggered.
- `dma0` is configured with write address `stream_input[0]` and IS triggered (starts immediately).

### 3.3 DMA Interrupt Handler: Rotating Write Addresses

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 59-85

The DMA ISR (`stream_dma_handler`) is marked `__not_in_flash_func` to run from SRAM for deterministic latency.

When a DMA channel completes:
1. Acknowledge the IRQ.
2. Increment `dma_complete_count` (monotonically increasing counter).
3. Compute the next slot: `(dma_complete_count + 1) % STREAM_SLOTS`.
4. Set the completed DMA channel's write address to that next slot (without triggering it).

The logic ensures that when DMA channel X completes slot N, the other channel is already writing slot N+1 (via chaining). Channel X is set to write to slot N+2, so it is ready when the other channel completes and chains back.

This creates a continuous ring of DMA writes across all 8 slots, with no CPU intervention needed to keep the pipeline flowing -- only the write address rotation happens in the ISR.

```c
void __not_in_flash_func(stream_dma_handler)(void)
{
    if (dma_channel_get_irq1_status(stream_dma0))
    {
        dma_channel_acknowledge_irq1(stream_dma0);
        dma_complete_count++;
        uint32_t next = (dma_complete_count + 1) % STREAM_SLOTS;
        dma_channel_set_write_addr(stream_dma0, stream_input[next], false);
    }

    if (dma_channel_get_irq1_status(stream_dma1))
    {
        dma_channel_acknowledge_irq1(stream_dma1);
        dma_complete_count++;
        uint32_t next = (dma_complete_count + 1) % STREAM_SLOTS;
        dma_channel_set_write_addr(stream_dma1, stream_input[next], false);
    }
}
```

---

## 4. Core 1: Compression Pipeline

### 4.1 Compression Loop

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 143-172

Core 1 runs a tight loop that processes completed DMA slots:

```c
static void stream_core1_entry(void)
{
    stream_compress_init();   // set bus priority for Core 1

    while (streaming)
    {
        if (compress_head < dma_complete_count)
        {
            uint32_t slot = compress_head % STREAM_SLOTS;
            stream_output_size[slot] = stream_compress_chunk_mapped(
                stream_input[slot],
                stream_channel_map,
                stream_num_channels,
                stream_capture_channels,
                stream_chunk_samples,
                stream_output[slot]
            );
            __dmb();   // ensure output data is visible to Core 0
            compress_head++;
        }
        else
        {
            tight_loop_contents();
        }
    }

    stream_compress_deinit();
}
```

Key aspects:
- `compress_head` tracks how many slots Core 1 has processed. It only advances when `compress_head < dma_complete_count` (a new DMA slot is ready).
- The `__dmb()` (data memory barrier) after writing compressed data ensures Core 0 sees the output before `compress_head` is incremented.
- `stream_compress_chunk_mapped()` is used instead of `stream_compress_chunk()` to support sparse channel selection via the channel map.

### 4.2 Bus Priority Optimization

**File:** `Firmware/LogicAnalyzer_V2/stream_compress.c`, lines 371-382

Core 1 sets itself to high bus priority during compression:

```c
void stream_compress_init(void) {
    busctrl_hw->priority = (1u << 4);  // PROC1 gets SRAM priority
}
```

This gives Core 1 priority over DMA when they contend for the same SRAM bank, which is important since Core 1 reads from `stream_input[]` (written by DMA) and writes to `stream_output[]`.

### 4.3 Compression Algorithm

**File:** `Firmware/LogicAnalyzer_V2/stream_compress.c`

The compression is a multi-stage pipeline optimized for Cortex-M33:

#### Stage 1: Bit Transpose (lines 140-215)

Raw DMA data is interleaved: each sample contains all channels packed into 1/2/4 bytes. The transpose converts this to per-channel bitstreams -- each channel's samples are packed as consecutive bits in `uint32_t` words.

The transpose uses a delta-swap 8x8 butterfly algorithm (~25 ALU instructions per 8x8 block), operating on groups of 8 samples at a time. Three variants handle 8-channel, 16-channel, and 24-channel modes:

- `transpose_chunk_8ch()`: 1 transpose per group (lines 140-152)
- `transpose_chunk_16ch()`: 2 transposes per group (low/high byte) (lines 154-179)
- `transpose_chunk_24ch()`: 3 transposes per group (bytes 0, 1, 2 of 4-byte word) (lines 181-215)

#### Stage 2: Classification (lines 418-428 in `stream_compress_chunk`, lines 483-487 in `stream_compress_chunk_mapped`)

For each channel, OR-reduce and AND-reduce across all transposed words:
- If `or_all == 0`: channel is all-zero (`SC_HDR_ALL_ZERO`, 2-bit header code `0x01`)
- If `and_all == 0xFFFFFFFF`: channel is all-one (`SC_HDR_ALL_ONE`, header code `0x02`)
- Otherwise: attempt nibble encoding, fall back to raw.

#### Stage 3: Run Detection (lines 241-271)

Uses CLZ/CTZ (Count Leading/Trailing Zeros) hardware instructions for O(1) per-word run length detection. The `count_run()` function XORs with a fill pattern (0x00000000 or 0xFFFFFFFF) to normalize both zero-runs and one-runs, then uses `__builtin_ctz()` (which compiles to RBIT+CLZ, 2 cycles on M33) to find the first mismatch.

#### Stage 4: Nibble Encoding (lines 286-365)

Each channel's transposed bitstream is encoded using 4-bit prefix codes. The encoder walks the nibble stream and emits:

**Run-length codes** for runs of 0x0 or 0xF nibbles:
| Code | Nibble | Run Length |
|------|--------|------------|
| `SC_NPC_ZERO2` (0x6) | - | 2 zero nibbles |
| `SC_NPC_ZERO4` (0x7) | - | 4 zero nibbles |
| `SC_NPC_ZERO8` (0x8) | - | 8 zero nibbles |
| `SC_NPC_ZERO16` (0x9) | - | 16 zero nibbles |
| `SC_NPC_ZERO32` (0xA) | - | 32 zero nibbles |
| `SC_NPC_ONE2` (0xB) | - | 2 one nibbles |
| `SC_NPC_ONE4` (0xC) | - | 4 one nibbles |
| `SC_NPC_ONE8` (0xD) | - | 8 one nibbles |
| `SC_NPC_ONE16` (0xE) | - | 16 one nibbles |
| `SC_NPC_ONE32` (0xF) | - | 32 one nibbles |

**Raw group codes** for non-compressible regions:
| Code | Nibble | Raw Nibbles |
|------|--------|-------------|
| `SC_NPC_RAW1` (0x0) | - | 1 raw nibble follows |
| `SC_NPC_RAW2` (0x1) | - | 2 raw nibbles follow |
| `SC_NPC_RAW3` (0x2) | - | 3 raw nibbles follow |
| `SC_NPC_RAW6` (0x3) | - | 6 raw nibbles follow |
| `SC_NPC_RAW4` (0x4) | - | 4 raw nibbles follow |
| `SC_NPC_RAW8` (0x5) | - | 8 raw nibbles follow |

Runs are emitted largest-first (greedy). For non-run regions, a lookahead of up to 8 nibbles finds the boundary where a compressible run starts, then emits the largest raw group code that fits.

The encoder bails early if the compressed output meets or exceeds the raw size, falling back to `SC_HDR_RAW` mode (uncompressed per-channel bitstream).

#### Output Format

Each compressed chunk has:
1. **Header:** `ceil(num_channels / 4)` bytes, 2 bits per channel (LSB-first), encoding the mode for each channel (`SC_HDR_RAW`, `SC_HDR_ALL_ZERO`, `SC_HDR_ALL_ONE`, `SC_HDR_NIBBLE_ENC`).
2. **Channel data:** Concatenated per-channel data in channel order. All-zero and all-one channels contribute no data. Raw channels contribute `chunk_samples / 8` bytes. Nibble-encoded channels contribute variable-length encoded data.

---

## 5. Core 0: Transport Loop

### 5.1 RunStreamSendLoop()

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 374-510

After `StartStream()` returns, the main loop in `LogicAnalyzer.c` (lines 852-861) calls `RunStreamSendLoop()`, which blocks until streaming ends:

```c
// File: Firmware/LogicAnalyzer_V2/LogicAnalyzer.c, lines 852-861
else if(streaming_active)
{
    RunStreamSendLoop(usbDisabled);  // or false if no WiFi
    CleanupStream();
    streaming_active = false;
}
```

The send loop runs on Core 0 and performs three tasks each iteration:

#### 5.1.1 Sending Compressed Chunks (lines 386-406)

When `send_head < compress_head`, a compressed chunk is ready:
1. Read the compressed size from `stream_output_size[slot]`.
2. Send a 2-byte little-endian size prefix.
3. Send the compressed chunk data.
4. Increment `send_head`.

Each chunk is framed as: `[2-byte size][compressed data]`.

#### 5.1.2 Keeping USB/WiFi Alive (lines 408-438)

- `tud_task()` is called every iteration to service the USB stack.
- The loop checks for incoming stop commands using `processUSBInputDirect()` (USB) or `processWiFiInput()` (WiFi). These functions read one byte at a time from the transport and feed it through the command parser. If a command byte `11` (stop stream) is received, `StopStream()` is called, setting `streaming = false`.
- USB disconnect is detected via `tud_cdc_connected()`.

#### 5.1.3 Safety Checks (lines 440-453)

- **Overflow detection (line 441):** If `dma_complete_count - send_head >= STREAM_SLOTS - 1`, the DMA is about to overwrite slots that haven't been sent yet. The stream is aborted with `STREAM_EXIT_OVERFLOW`.
- **Timeout detection (line 449):** If no data has been produced for 3 seconds (`time_us_64() - last_data_time > 3000000`), the stream is aborted with `STREAM_EXIT_TIMEOUT`.

### 5.2 Stream Termination Protocol (lines 456-510)

When the send loop exits:

1. **Flush remaining chunks:** Any compressed chunks that Core 1 finished but haven't been sent yet are flushed.

2. **Send EOF marker:** A 2-byte `0x0000` size prefix signals end-of-stream to the host.

3. **Send termination status:** A human-readable diagnostic string is sent:
   ```
   STREAM_DONE DMA=<n> CMP=<n> SEND=<n> LOOP=<n> CONN=<0|1>/<0|1> CHUNKS=<n> FREQ=<n>
   ```
   Or `STREAM_TIMEOUT`, `STREAM_OVERFLOW`, or `STREAM_DISCONN` depending on the exit reason.

---

## 6. Data Flow Summary

```
GPIO Pins
    |
    v
PIO State Machine (BLAST_CAPTURE @ offset+1)
    |  "in pins 32" every clock cycle
    |  autopush to RX FIFO every 32 bits
    v
PIO RX FIFO
    |
    v
DMA Channel 0/1 (chained, IRQ-driven write address rotation)
    |  DREQ-paced from PIO FIFO
    |  writes stream_chunk_samples transfers per slot
    v
stream_input[slot]  (ring buffer, 8 slots)
    |
    |  [Core 1]
    v
Bit Transpose (8x8 delta-swap butterfly)
    |
    v
Per-Channel Classification (OR/AND reduce)
    |
    v
Nibble Encoding (CLZ-based run detection + greedy raw groups)
    |
    v
stream_output[slot] (ring buffer, 8 slots)
    |
    |  [Core 0]
    v
Transport (USB CDC via cdc_transfer / WiFi via wifi_transfer)
    |  framed as [2-byte size][compressed data] per chunk
    |  EOF = [0x0000]
    v
Host Application
```

---

## 7. Producer-Consumer Synchronization

Three monotonically-increasing counters coordinate the pipeline:

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 32-35

| Counter | Writer | Reader | Meaning |
|---------|--------|--------|---------|
| `dma_complete_count` | DMA ISR | Core 1 | Number of DMA slots completed |
| `compress_head` | Core 1 | Core 0 | Number of slots compressed |
| `send_head` | Core 0 | Core 0 (overflow check) | Number of slots sent to host |

Invariant: `send_head <= compress_head <= dma_complete_count`

The slot index for any counter is `counter % STREAM_SLOTS`. Since counters are monotonically increasing and the ring has 8 slots, as long as no stage falls more than 7 slots behind the DMA, there is no data corruption.

The `__dmb()` on line 162 ensures that Core 0 sees the compressed data written by Core 1 before the `compress_head` increment becomes visible.

---

## 8. Stopping a Stream

### 8.1 Normal Stop (host command)

The host sends command byte `11`:

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c`, lines 461-462

```c
case 11: // Stop stream
    StopStream();
    break;
```

`StopStream()` simply sets `streaming = false`:

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 336-339

```c
void StopStream(void)
{
    streaming = false;
}
```

This causes:
1. Core 1's compression loop to exit (`while (streaming)` on line 147).
2. Core 0's send loop to exit (`while (streaming)` on line 381).

### 8.2 Abnormal Stop Conditions

- **Overflow** (line 441): `dma_complete_count - send_head >= STREAM_SLOTS - 1`. The compression or transport is too slow to keep up with the DMA.
- **USB disconnect** (line 432): `tud_cdc_connected()` returns false.
- **Timeout** (line 449): No data produced in 3 seconds.

### 8.3 Cleanup

**File:** `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c`, lines 341-366

`CleanupStream()` is called after `RunStreamSendLoop()` returns:

1. **Stop Core 1:** `multicore_reset_core1()`.
2. **Stop PIO:** `pio_sm_set_enabled(stream_pio, stream_sm, false)`.
3. **Abort and release DMAs:** Disable both channels, abort transfers, disable IRQs, remove handler, unclaim channels.
4. **Release PIO resources:** Unclaim state machine, remove program from instruction memory.
5. **Re-enable stdio_usb:** `stdio_usb_init()` restores the normal USB stdio background task.

---

## 9. Sample Rate Limitations

### 9.1 PIO Clock Divider

The PIO state machine executes one `in pins 32` instruction per clock cycle. The clock divider determines the sample rate:

```
sample_rate = clk_sys / clock_divider
```

With `clk_sys` = 200 MHz (standard) or 400 MHz (turbo mode):
- **Minimum divider:** 1.0 (theoretical max: 200 MHz or 400 MHz, but streaming cannot sustain this)
- **Maximum divider:** 65535 (minimum rate: ~3052 Hz at 200 MHz)

### 9.2 Practical Streaming Rate Limits

The practical maximum streaming rate is determined by the bottleneck in the pipeline:

1. **Compression throughput on Core 1:** The bit-transpose and nibble encoding must complete before the next DMA slot fills. At 200 MHz CPU with 1024-sample chunks, Core 1 has `1024 / sample_rate` seconds to compress each chunk.

2. **USB CDC throughput:** USB Full Speed is 12 Mbps (theoretical). CDC bulk transfers achieve roughly 1 MB/s in practice. For 24 channels at the raw rate, each sample is 4 bytes, so 1 MHz sampling produces 4 MB/s raw -- compression must achieve at least 4:1 to avoid USB bottleneck.

3. **Ring buffer depth:** With 8 slots, the pipeline can absorb bursts where compression or transport temporarily falls behind. But if the average throughput of transport is less than the average DMA production rate, overflow is inevitable.

The 1-3 MHz range mentioned in the project description reflects these practical limits. The exact maximum depends on:
- Number of channels (fewer channels = less data per sample, easier to compress)
- Signal characteristics (static signals compress well; noisy signals compress poorly)
- Transport (USB is generally faster than WiFi for bulk data)

### 9.3 Chunk Size Selection

**File:** `Firmware/LogicAnalyzer_V2/stream_compress.c`, lines 555-572

The firmware provides a helper to select chunk size based on sample rate, targeting 5 updates per second for the real-time display:

```c
#define STREAM_TARGET_FPS 5

static const struct { uint32_t min_rate; uint32_t chunk_size; } sc_chunk_table[] = {
    { 5120, SC_CHUNK_1024 },
    { 2560, SC_CHUNK_512  },
    { 1280, SC_CHUNK_256  },
    {  640, SC_CHUNK_128  },
    {  320, SC_CHUNK_64   },
    {    0, SC_CHUNK_32   },
};
```

Larger chunks are more efficient for compression (better run-length opportunities) and reduce per-chunk overhead, but introduce more display latency. The table picks the largest chunk where `sample_rate / chunk_size >= 5` (at least 5 chunks per second).

However, the actual chunk size used is determined by the host's `STREAM_REQUEST.chunkSamples` field -- the firmware validates and clamps it but uses the client-provided value (lines 270-277).

---

## 10. Wire Protocol Summary

### 10.1 Start Handshake

```
Host  -> Device:  [0x55 0xAA] [0x0A] [STREAM_REQUEST payload] [0xAA 0x55]
Device -> Host:   "STREAM_STARTED\n"
Device -> Host:   [8-byte info header]
```

Info header (8 bytes, little-endian):
| Offset | Size | Field |
|--------|------|-------|
| 0 | 2 | chunk_samples |
| 2 | 1 | num_channels |
| 3 | 1 | reserved (0) |
| 4 | 4 | actual_freq |

### 10.2 Data Stream

Repeating sequence of compressed chunks:
```
[2-byte LE size] [compressed chunk data]
[2-byte LE size] [compressed chunk data]
...
```

### 10.3 End of Stream

```
[0x00 0x00]   (EOF marker -- zero-length chunk)
"STREAM_<reason> DMA=<n> CMP=<n> SEND=<n> LOOP=<n> CONN=<0|1>/<0|1> CHUNKS=<n> FREQ=<n>\n"
```

### 10.4 Stop Command

```
Host -> Device:  [0x55 0xAA] [0x0B] [0xAA 0x55]
```

Command byte `0x0B` = 11 decimal = stop stream.

---

## 11. Key Files Reference

| File | Purpose |
|------|---------|
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c` | Streaming state machine, DMA setup, PIO setup, send loop |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.h` | Stream API declarations, ring buffer constants |
| `Firmware/LogicAnalyzer_V2/stream_compress.c` | Compression algorithm (transpose, classify, encode) |
| `Firmware/LogicAnalyzer_V2/stream_compress.h` | Compression API, nibble prefix code definitions, header encoding constants |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer.pio` | PIO programs including BLAST_CAPTURE |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h` | STREAM_REQUEST struct definition |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer.c` | Main loop, command parsing (cmd 10/11), transport functions |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Board_Settings.h` | Board-specific pin maps, frequencies, buffer sizes |
| `Firmware/LogicAnalyzer_V2/LogicAnalyzer_Capture.h` | CHANNEL_MODE enum, pinMap declaration |

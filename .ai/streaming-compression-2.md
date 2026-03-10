# Streaming Compression Algorithm: Mathematical & Architectural Analysis

This document provides a deep technical analysis of the streaming compression algorithm used in the LogicAnalyzer V2 firmware and its JavaScript decompression counterpart. It focuses on the mathematical properties, performance characteristics, memory layout, and pipeline integration aspects of the compression scheme.

## Table of Contents

1. [Algorithm Overview](#algorithm-overview)
2. [Mathematical Analysis of the Nibble Coding Scheme](#mathematical-analysis-of-the-nibble-coding-scheme)
3. [Compression Ratio Analysis](#compression-ratio-analysis)
4. [DMA/Streaming Pipeline Integration](#dmastreaming-pipeline-integration)
5. [Memory Requirements](#memory-requirements)
6. [Performance Characteristics](#performance-characteristics)
7. [JavaScript Decompression: Step by Step](#javascript-decompression-step-by-step)
8. [Chunk Framing and Delimiting](#chunk-framing-and-delimiting)
9. [Implementation Tricks and Optimizations](#implementation-tricks-and-optimizations)
10. [Comparison with Alternative Approaches](#comparison-with-alternative-approaches)
11. [Rejected Prototype Implementations](#rejected-prototype-implementations)

---

## Algorithm Overview

The compression operates in four stages on a per-chunk basis:

1. **Bit-Transpose**: Convert interleaved DMA samples (where each sample contains one bit per channel) into per-channel bitstreams (where each channel has all its samples packed consecutively).
2. **Classification**: For each channel, determine if all samples are 0, all are 1, or mixed.
3. **Run Detection**: For mixed channels, scan the transposed bitstream as 4-bit nibbles and detect runs of `0x0` or `0xF`.
4. **Encoding**: Emit prefix-coded nibbles using a 16-symbol code that compresses runs while passing through mixed data with minimal overhead.

**Source files:**
- Firmware (production): `/home/xkonti/repos/logicanalyzer/Firmware/LogicAnalyzer_V2/stream_compress.c` (lines 1-573)
- Firmware header: `/home/xkonti/repos/logicanalyzer/Firmware/LogicAnalyzer_V2/stream_compress.h` (lines 1-151)
- JS decoder: `/home/xkonti/repos/logicanalyzer/Software/Web/src/core/compression/decoder.js` (lines 1-181)
- Streaming pipeline: `/home/xkonti/repos/logicanalyzer/Firmware/LogicAnalyzer_V2/LogicAnalyzer_Stream.c` (lines 1-516)

---

## Mathematical Analysis of the Nibble Coding Scheme

### The Code Table

The algorithm uses a fixed 16-symbol prefix code where each symbol is exactly 4 bits (one nibble). The 16 code points are:

| Code | Symbol | Type | Nibbles Consumed | Output Nibbles | Overhead Ratio |
|------|--------|------|----------------:|---------------:|---------------:|
| 0x0 | RAW1 | raw | 1 data nibble | 2 (1 prefix + 1 data) | 2.00x |
| 0x1 | RAW2 | raw | 2 data nibbles | 3 (1 prefix + 2 data) | 1.50x |
| 0x2 | RAW3 | raw | 3 data nibbles | 4 (1 prefix + 3 data) | 1.33x |
| 0x3 | RAW6 | raw | 6 data nibbles | 7 (1 prefix + 6 data) | 1.17x |
| 0x4 | RAW4 | raw | 4 data nibbles | 5 (1 prefix + 4 data) | 1.25x |
| 0x5 | RAW8 | raw | 8 data nibbles | 9 (1 prefix + 8 data) | 1.125x |
| 0x6 | ZERO2 | run | 2 zero nibbles | 1 (prefix only) | 0.50x |
| 0x7 | ZERO4 | run | 4 zero nibbles | 1 | 0.25x |
| 0x8 | ZERO8 | run | 8 zero nibbles | 1 | 0.125x |
| 0x9 | ZERO16 | run | 16 zero nibbles | 1 | 0.0625x |
| 0xA | ZERO32 | run | 32 zero nibbles | 1 | 0.03125x |
| 0xB | ONE2 | run | 2 one nibbles | 1 | 0.50x |
| 0xC | ONE4 | run | 4 one nibbles | 1 | 0.25x |
| 0xD | ONE8 | run | 8 one nibbles | 1 | 0.125x |
| 0xE | ONE16 | run | 16 one nibbles | 1 | 0.0625x |
| 0xF | ONE32 | run | 32 one nibbles | 1 | 0.03125x |

### Key design properties

**Uniform code length**: Every prefix code is exactly 4 bits. This is not a Huffman code or variable-length code -- it is a uniform-length prefix code. This has several important consequences:

1. **No bit-level alignment ambiguity**: The decoder always reads nibbles in pairs (forming bytes), so nibble boundaries are trivially recoverable.
2. **O(1) decode per symbol**: No tree traversal or multi-step matching is needed. A single table lookup (indexed by the 4-bit value) determines both the symbol type and count.
3. **Predictable worst-case**: Because every prefix code is the same length, the worst-case expansion is bounded and calculable.

**Asymmetric raw group sizes**: The available raw group sizes are {1, 2, 3, 4, 6, 8}, not {1, 2, 3, 4, 5, 6, 7, 8}. Sizes 5 and 7 are missing because the 16 code points are exhausted. The choice of 6 over 5 and 7 minimizes worst-case expansion for contiguous raw regions. For a raw run of length N, the greedy decomposition into {8, 6, 4, 3, 2, 1} groups produces:

| Raw length | Greedy decomposition | Output nibbles | Overhead |
|-----------:|---------------------|---------------:|---------:|
| 1 | RAW1 | 2 | 2.00x |
| 2 | RAW2 | 3 | 1.50x |
| 3 | RAW3 | 4 | 1.33x |
| 4 | RAW4 | 5 | 1.25x |
| 5 | RAW4 + RAW1 | 7 | 1.40x |
| 6 | RAW6 | 7 | 1.17x |
| 7 | RAW6 + RAW1 | 9 | 1.29x |
| 8 | RAW8 | 9 | 1.125x |

The worst amortized overhead for a contiguous raw region is for length 5 (1.40x), but the encoder limits lookahead to 8 nibbles max, so a long raw region is chunked into RAW8 groups at 1.125x overhead.

**Run-length power-of-two sizing**: Run codes encode 2, 4, 8, 16, or 32 nibbles. This means any run of length R >= 2 can be decomposed into at most log2(R) run codes via binary decomposition. For example, a run of 63 zero nibbles:
- 63 = 32 + 16 + 8 + 4 + 2 + 1
- Emits: ZERO32 + ZERO16 + ZERO8 + ZERO4 + ZERO2 + RAW1(0x0) = 7 output nibbles
- Compression: 63 input nibbles -> 7 output nibbles = 9:1 ratio

---

## Compression Ratio Analysis

### Best Case: Constant Channel

When a channel is entirely 0 or entirely 1 across all chunk samples, the header classification catches it as `ALL_ZERO` or `ALL_ONE` (2-bit header code). **Zero bytes** of channel data are emitted.

For a chunk of S samples with N channels, all constant:
- **Input size**: `S * bytes_per_sample` (DMA buffer)
- **Compressed output**: `ceil(N/4)` bytes (header only)
- **Compression ratio**: For 8ch/512 samples: 512 bytes -> 2 bytes = **256:1**
- **Compression ratio**: For 24ch/512 samples: 2048 bytes -> 6 bytes = **341:1**

### Best Case: Nibble-Encoded (Half-Constant)

A channel where the first half of samples is 0 and the second half is 1 (e.g., a single transition). For S=512 samples (128 nibbles per channel):

- First 64 nibbles are 0x0: encoded as ZERO32 + ZERO32 = 2 output nibbles
- Next 64 nibbles are 0xF: encoded as ONE32 + ONE32 = 2 output nibbles
- Total: 4 output nibbles = 2 bytes per channel
- Raw would be 64 bytes per channel
- **Channel compression**: 64 bytes -> 2 bytes = **32:1**

### Worst Case: Nibble-Encoded

When nibble encoding beats raw, the worst case is data with no runs at all (every nibble is "mixed" -- not 0x0 or 0xF). The encoder falls back to RAW mode in this case because nibble encoding would expand the data.

The encoder performs an **early bail**: at `stream_compress.c` line 354, if the output byte position `bw.pos` meets or exceeds `raw_bytes` at any point during encoding, it returns 0 (signaling fallback to raw). At line 361, after encoding completes, it also checks `bw.pos >= raw_bytes` and returns 0 if encoding did not strictly save space.

This means nibble-encoded mode is only used when it produces strictly fewer bytes than raw. **There is no expansion case** -- the algorithm always falls back to raw when encoding would not help.

### Worst Case: Overall

When all channels are "noisy" (no constant channels, no compressible runs), every channel falls back to raw mode. The output is:

```
Output = header_bytes + N * raw_bytes_per_channel
       = ceil(N/4) + N * (S/8)
```

Compared to input size `S * bytes_per_sample`:
- 8ch, 512 samples: input = 512 bytes, output = 2 + 8*64 = 514 bytes
- The header adds `ceil(N/4)` bytes of overhead
- **Worst-case expansion**: `ceil(N/4)` bytes over raw (0.4% for 8ch, 0.3% for 24ch)

This is extremely small overhead because the transposed data (without the header) is exactly the same size as the original data -- just rearranged. The header cost is the only overhead.

### Typical Case: Logic Analyzer Signals

Real logic analyzer signals have high temporal locality (signals change infrequently relative to the sample rate). At 1 MHz sampling a 100 kHz I2C bus:

- SCL spends ~50% at each level, changing every ~5 us = 5 samples. Each group of 5 same-level nibbles (rounding to nibble boundaries): ~1 ZERO/ONE4 + 1 RAW1 per 5 nibbles ≈ 3 output nibbles per 5 input nibbles = 0.6x
- SDA has longer stretches of constant data (8-bit transfers) with occasional transitions
- Inactive channels: ALL_ZERO, 0 bytes
- Expected compression: 3:1 to 10:1 for typical mixed signals

---

## DMA/Streaming Pipeline Integration

### Architecture: Ring Buffer with Producer-Consumer

The streaming pipeline uses a **three-stage producer-consumer ring buffer** with separate indices for each stage:

```
PIO --> DMA (ISR, any core) --> Compression (Core 1) --> USB Send (Core 0)
         |                         |                        |
   dma_complete_count        compress_head              send_head
```

Defined at `LogicAnalyzer_Stream.c` lines 33-35:
```c
static volatile uint32_t dma_complete_count;   /* written by DMA ISR */
static volatile uint32_t compress_head;        /* written by Core 1 */
static volatile uint32_t send_head;            /* written by Core 0 */
```

The ring buffer has `STREAM_SLOTS = 8` slots (`LogicAnalyzer_Stream.h` line 9).

### Separate Buffers: Input and Output

Compression is **NOT** done in-place. There are two separate ring buffer arrays (`LogicAnalyzer_Stream.c` lines 28-30):

```c
static uint8_t stream_input[STREAM_SLOTS][STREAM_INPUT_SLOT_SIZE];   // DMA writes here
static uint8_t stream_output[STREAM_SLOTS][STREAM_OUTPUT_SLOT_SIZE]; // Compressed output here
static uint32_t stream_output_size[STREAM_SLOTS];                    // Compressed size per slot
```

- `STREAM_INPUT_SLOT_SIZE = STREAM_MAX_CHUNK * 4 = 4096` bytes (worst case: 1024 samples * 4 bytes/sample for 24ch)
- `STREAM_OUTPUT_SLOT_SIZE = 3080` bytes (max compressed output for 24ch/1024 samples)

### DMA Configuration

Two DMA channels are chained in a ping-pong configuration (`LogicAnalyzer_Stream.c` lines 91-137). Each DMA transfer captures exactly `stream_chunk_samples` worth of samples. When a DMA channel completes, the ISR:

1. Increments `dma_complete_count`
2. Sets the completed channel's write address to the slot two ahead (`(dma_complete_count + 1) % STREAM_SLOTS`), so it is ready for its next trigger

This means DMA always writes to input slots, and the completed input slot remains stable for Core 1 to read until the ring wraps around.

### Core 1 Compression Loop

Core 1 runs a tight polling loop (`LogicAnalyzer_Stream.c` lines 143-172):

```c
static void stream_core1_entry(void) {
    stream_compress_init();
    while (streaming) {
        if (compress_head < dma_complete_count) {
            uint32_t slot = compress_head % STREAM_SLOTS;
            stream_output_size[slot] = stream_compress_chunk_mapped(
                stream_input[slot], ...channel_map..., stream_output[slot]);
            __dmb();
            compress_head++;
        } else {
            tight_loop_contents();
        }
    }
    stream_compress_deinit();
}
```

Key points:
- `stream_compress_chunk_mapped()` reads from `stream_input[slot]` and writes to `stream_output[slot]` -- **different buffers**, no in-place operation
- A data memory barrier (`__dmb()`) at line 162 ensures the compressed output is visible to Core 0 before `compress_head` is incremented
- The static transposed buffer `s_transposed` at `stream_compress.c` line 37 is an intermediate workspace, not shared with DMA

### Core 0 Send Loop

Core 0 runs the USB send loop (`LogicAnalyzer_Stream.c` lines 374-454). It checks `send_head < compress_head` and sends compressed chunks over USB/WiFi.

### Overflow Detection

At `LogicAnalyzer_Stream.c` line 441:
```c
if (dma_complete_count - send_head >= STREAM_SLOTS - 1)
```

If the DMA producer is about to lap the USB sender (only 1 free slot remaining), the stream is aborted with an overflow status.

---

## Memory Requirements

### Firmware Side (RP2350 SRAM, 520 KB total)

#### Static Buffers

| Buffer | Size | Location | Purpose |
|--------|-----:|----------|---------|
| `stream_input[8][4096]` | 32,768 B | `.bss` | DMA ring buffer (input) |
| `stream_output[8][3080]` | 24,640 B | `.bss` | Compressed ring buffer (output) |
| `stream_output_size[8]` | 32 B | `.bss` | Per-slot compressed sizes |
| `s_transposed[24][32]` | 3,072 B | `.bss` | Transpose workspace (Core 1) |
| **Total static** | **~60,512 B** | | **~11.6% of 520 KB SRAM** |

Note: `s_transposed` is sized for `SC_MAX_CHANNELS=24` and `SC_MAX_CHUNK_WORDS=32` (1024/32), giving `24 * 32 * 4 = 3,072 bytes` (`stream_compress.c` lines 37-38).

#### Stack Buffers (Core 1)

| Buffer | Size | Purpose |
|--------|-----:|---------|
| `header[8]` | 8 B | Per-chunk header assembly |
| `enc_buf[SC_MAX_CHUNK/8 + 8]` | 136 B | Encoding scratch per channel |
| `tr[8]` | 8 B | Transpose kernel output |
| **Total stack** | **~152 B** | Fits easily in Core 1's stack |

#### Comparison with Reference Implementations

The production code (`stream_compress.c`) uses significantly less memory than the reference implementations:

- **batched** (`stream_compress_batched.c.ref`): Required `transposed_buf[12,288]` + `output_buf[12,384]` + `chunk_headers` for batch-processing entire 4KB DMA buffers. Total: ~25 KB extra static buffers.
- **hwaccel** (`stream_compress_hwaccel.c.ref`): Required `output_buf[OUTPUT_BUFFER_SIZE]` where `OUTPUT_BUFFER_SIZE = 8 + 24 * 68 = 1,640 bytes` static.
- **minimal** (`stream_compress_minimal.c.ref`): Used `channel_data[24][32] = 768 bytes` on stack (per chunk).
- **Production**: Uses a shared static `s_transposed[24][32] = 3,072 bytes` (slightly larger due to `SC_MAX_CHUNK_WORDS=32` supporting up to 1024 samples).

---

## Performance Characteristics

### Can Compression Keep Up with Max Sample Rates?

The streaming mode supports sample rates up to ~3 MHz (limited by USB bandwidth, not compression speed). Let's analyze the compression budget at the maximum rate.

#### Timing Budget

At 3 MHz with 8 channels, 512-sample chunks:
- One chunk = 512 / 3,000,000 = **170.7 us** per chunk
- At 200 MHz (Core 1 clock), that's **34,133 CPU cycles** per chunk

#### Transpose Cost

The 8x8 delta-swap transpose kernel (`stream_compress.c` lines 90-125) executes ~25 ALU instructions per 8x8 block.

For 8ch, 512 samples: `512/8 = 64` groups of 8 samples, each needing 1 transpose8x8 call + 8 byte scatters:
- 64 * (25 ALU + 8 stores + 8 loads) ≈ 64 * 41 ≈ **2,624 cycles**

For 24ch, 512 samples: 64 groups * 3 transpose8x8 calls (one per byte lane) + 24 byte scatters:
- 64 * (3*25 + 24*2) ≈ 64 * 123 ≈ **7,872 cycles**

#### Classification Cost

OR/AND reduce of chunk_words (16 for 512 samples): ~32 instructions per channel.
- 8ch: 8 * 32 = **256 cycles**
- 24ch: 24 * 32 = **768 cycles**

#### Encoding Cost (Per Channel, Mixed Data)

The nibble encoder (`stream_compress.c` lines 286-365) processes chunk_nibbles (128 for 512 samples). The critical path depends on data patterns:

- **All-run data**: Each CLZ/CTZ run detection is O(1) per word. For 128 nibbles in a single run: 1 run detection + 1 emit = ~20 cycles.
- **All-mixed data**: The lookahead scans up to 8 nibbles per iteration. For 128 nibbles: ~16 iterations of RAW8, each doing 1 prefix emit + 8 data emits + 8 get_nibble calls ≈ 16 * 30 = **480 cycles**. Then early bail returns 0 (falls back to raw), so this is the fast path for noisy data.
- **Typical data**: Mix of short runs and raw groups, ~200-400 cycles per channel.

Total encode, 24ch worst case: 24 * 480 = **11,520 cycles**

#### Total Budget

| Stage | 8ch, 512 | 24ch, 512 |
|-------|--------:|----------:|
| Transpose | 2,624 | 7,872 |
| Classify | 256 | 768 |
| Encode | 3,840 | 11,520 |
| memcpy + header | 500 | 1,500 |
| **Total** | **~7,220** | **~21,660** |
| **Budget** | 34,133 | 34,133* |
| **Utilization** | 21% | 63% |

*Note: At 24ch, each sample is 4 bytes, so 512 samples = 2048 bytes input. At 3 MHz, the USB throughput limit is the real bottleneck, not the compression.

**Conclusion**: Compression can comfortably keep up with the maximum streaming sample rates. Even at 24 channels, Core 1 uses only ~63% of its cycle budget per chunk.

### Bus Priority Optimization

The firmware gives Core 1 high SRAM bus priority during compression (`stream_compress.c` lines 371-382):

```c
void stream_compress_init(void) {
    busctrl_hw->priority = (1u << 4); // PROC1 high priority
}
```

This ensures that when Core 1 and DMA contend for the same SRAM bank, Core 1 wins. Since DMA is filling the *next* slot while Core 1 reads the *current* slot, bank contention is rare but this setting provides a free safety margin.

---

## JavaScript Decompression: Step by Step

The decoder lives in `decoder.js` (lines 1-181). Here is the complete decompression algorithm:

### Step 1: Parse the Header

```
Input:  compressed byte array
Output: per-channel mode codes (2 bits each)
```

The header occupies `ceil(numChannels / 4)` bytes. Each byte contains 4 channel mode codes packed LSB-first:
- Bits [1:0] = channel 0 mode
- Bits [3:2] = channel 1 mode
- Bits [5:4] = channel 2 mode
- Bits [7:6] = channel 3 mode

(`decoder.js` lines 82-85)

### Step 2: Decode Each Channel

For each channel, based on its header mode:

#### Mode 0x01 (ALL_ZERO):
Allocate `rawBytes` zero-filled bytes. No data consumed from stream. (`decoder.js` lines 92-93)

#### Mode 0x02 (ALL_ONE):
Allocate `rawBytes` bytes, fill with 0xFF. No data consumed. (`decoder.js` lines 96-100)

#### Mode 0x00 (RAW):
Copy `rawBytes` bytes directly from the compressed stream. (`decoder.js` lines 103-105)

#### Mode 0x03 (NIBBLE_ENC):

This is the most complex path (`decoder.js` lines 108-139):

1. **Initialize**: Create a `NibbleReader` at the current data position. Allocate a nibble output array of size `chunkSamples / 4`.

2. **Decode loop**: While output position < chunkNibbles:
   a. Read one nibble -- this is the prefix code.
   b. Look up `NIBBLE_CODES[prefix]` to get `{type, count}`.
   c. If `type === 'raw'`: read `count` more nibbles from the stream, append to output.
   d. If `type === 'zero'`: append `count` zero nibbles (0x0) to output.
   e. If `type === 'one'`: append `count` one nibbles (0xF) to output.

3. **Repack nibbles**: The nibble array must be repacked into bytes matching the transposed byte format. Each pair of consecutive nibbles forms one byte in **little-endian nibble order**:
   ```
   byte[j] = (nibble[2*j + 1] << 4) | nibble[2*j]
   ```
   This reverses the firmware's nibble extraction which reads nibbles from the uint32_t words in little-endian order. (`decoder.js` lines 133-136)

4. **Track bytes consumed**: The `NibbleReader.bytesConsumed` property advances the data position for the next channel.

### Step 3: Reverse Transpose (Optional)

If the caller needs interleaved samples (for display), `reverseTranspose()` (`decoder.js` lines 155-180) converts per-channel bitstreams back to per-sample values:

```
For each sample s (0..chunkSamples-1):
  For each channel ch (0..numChannels-1):
    bit = (channels[ch][s >> 3] >> (s & 7)) & 1
    sampleValue |= bit << ch
```

In practice, the stream store (`stream.js` line 64-70) directly unpacks each channel's bitstream into a per-sample `Uint8Array` of 0/1 values for rendering, avoiding the full reverse transpose.

### NibbleReader Implementation

The `NibbleReader` class (`decoder.js` lines 39-66) reads nibbles MSB-first from packed bytes, matching the encoder's `bw_put4()` packing order:

- The **high nibble** (bits 7-4) of each byte is read first.
- The **low nibble** (bits 3-0) is read second.
- An internal boolean `#high` tracks which nibble to read next.

This matches the encoder's bit accumulator which shifts nibbles left into the accumulator and flushes the MSB first.

---

## Chunk Framing and Delimiting

### Wire Protocol

Each compressed chunk is framed with a **2-byte little-endian length prefix** sent before the chunk data (`LogicAnalyzer_Stream.c` lines 389-403):

```
[size_lo][size_hi][compressed_data...][size_lo][size_hi][compressed_data...]...[0x00][0x00]
```

- The length prefix gives the total compressed chunk size (header + all channel data).
- A length of 0x0000 serves as the **EOF marker**, indicating no more chunks will follow.
- After EOF, a text status line follows (e.g., `STREAM_DONE DMA=... CMP=... SEND=...`).

### Handshake

Before streaming data begins, the firmware sends (`LogicAnalyzer_Stream.c` lines 309-331):
1. Text response: `STREAM_STARTED\n`
2. 8-byte binary info header:
   - Bytes [0:1]: `chunkSamples` (LE16) -- actual chunk size
   - Byte [2]: `numChannels` -- number of selected channels
   - Byte [3]: reserved (0)
   - Bytes [4:7]: `actualFrequency` (LE32) -- actual PIO frequency after clock divider clamping

The JavaScript driver reads this header at `analyzer.js` lines 438-443 and uses the values to configure the decompression loop.

### Self-Delimiting Chunks

Within each compressed chunk, the data is **self-delimiting by construction**. The decoder knows `numChannels` and `chunkSamples` from the handshake. For each channel:
- ALL_ZERO/ALL_ONE: 0 bytes
- RAW: exactly `chunkSamples/8` bytes
- NIBBLE_ENC: the nibble reader tracks exactly how many bytes it consumed

However, the 2-byte length prefix provides a redundant framing layer that allows the decoder to skip a chunk or detect corruption.

---

## Implementation Tricks and Optimizations

### 1. Delta-Swap Butterfly Transpose

The 8x8 bit matrix transpose (`stream_compress.c` lines 90-125) uses three rounds of delta-swap from Hacker's Delight (2nd ed, section 7-3). The key insight is that a delta-swap:

```c
t = ((x >> shift) ^ x) & mask;
x ^= t; x ^= (t << shift);
```

...swaps bit pairs at distance `shift` within a word. Three rounds with distances 7, 14, and 28 complete the full 8x8 transpose in ~25 ALU instructions. This is faster than a LUT-based approach because:
- The M33 has a tiny D-cache; a 256-entry LUT would cause cache thrashing
- The delta-swap runs entirely in registers -- zero data memory accesses
- The butterfly structure has perfect instruction-level parallelism

### 2. CLZ/CTZ Word-Level Run Detection

The production code's `count_run()` function (`stream_compress.c` lines 241-271) uses a single XOR + CTZ to detect run lengths in O(1) per 32-bit word:

```c
uint32_t w = (s_transposed[ch][word_idx] ^ fill) >> (nib_in_word * 4);
if (w == 0) { count += 8 - nib_in_word; }
else { return __builtin_ctz(w) / 4; }
```

The XOR with `fill` (0x00000000 or 0xFFFFFFFF) normalizes zero-runs and one-runs into the same zero-detection problem. The `__builtin_ctz()` compiles to `RBIT` + `CLZ` (2 cycles total on Cortex-M33), giving the exact number of trailing zero bits. Dividing by 4 yields complete matching nibbles.

This replaces the nibble-by-nibble scanning in the `minimal` reference implementation, which used a while loop to count matching nibbles.

### 3. Greedy Code Selection with Lookahead Boundary

The encoder does not use optimal prefix assignment. Instead, it uses a greedy largest-first strategy (`stream_compress.c` lines 338-345):

```c
if      (raw_count >= 8) { prefix = SC_NPC_RAW8; emit = 8; }
else if (raw_count >= 6) { prefix = SC_NPC_RAW6; emit = 6; }
...
```

The raw group boundary is determined by a lookahead that stops when it detects the start of a compressible run (two consecutive identical 0x0 or 0xF nibbles), as seen at lines 328-336. This prevents the raw group from "eating into" a run that would compress better.

The comment in `stream_compress_minimal.c.ref` (lines 379-384) notes this is ~1-2% worse compression than optimal grouping but saves significant branching logic.

### 4. Early Bail on Encoding Futility

At `stream_compress.c` line 354:
```c
if (bw.pos >= raw_bytes)
    return 0;
```

This check runs inside the main encoding loop. If at any point the encoded output has already reached or exceeded the raw size, encoding is abandoned immediately. This saves significant CPU time for noisy/random channels where compression is futile.

### 5. Inline Nibble Extraction via UBFX

The `get_nibble()` function (`stream_compress.c` lines 225-227):
```c
return (s_transposed[ch][nib_idx >> 3] >> ((nib_idx & 7) * 4)) & 0xF;
```

On Cortex-M33, the compiler emits a single `UBFX` (Unsigned Bit Field Extract) instruction, which is single-cycle. This eliminates the need for the pre-unpacked nibble array used in the `minimal` reference (which cost ~160 instructions to set up per channel).

### 6. Channel Map for Selective Compression

The `stream_compress_chunk_mapped()` function (`stream_compress.c` lines 451-512) transposes ALL capture channels (8, 16, or 24) but only encodes the selected channels. This avoids the complexity of masking during transpose while still allowing the user to stream an arbitrary subset of channels.

---

## Comparison with Alternative Approaches

### vs. LZ4/LZO (Byte-Level Dictionary Compression)

| Property | Nibble RLE | LZ4 |
|----------|-----------|-----|
| Working memory | 3 KB (transposed) | 8-16 KB (hash table) |
| Code size | ~2 KB | ~4-8 KB |
| Compression for logic data | Excellent (exploits bit-level patterns) | Moderate (byte-oriented, misses bit-level runs) |
| Decode complexity | O(n), table lookup | O(n), copy loops |
| Worst-case expansion | 0.3-0.4% | ~0.4% |
| Suitability for 1-bit signals | Optimal (per-channel) | Poor (8x wider than needed) |

LZ4 would require byte-level pattern matching, which is poorly suited to logic analyzer data where signals are single-bit. The transpose step converts the problem from "24 interleaved bits" to "24 independent bit streams", which is the key insight that makes the nibble RLE approach so effective.

### vs. Raw Streaming (No Compression)

Without compression, USB bandwidth is the bottleneck. USB Full-Speed CDC-ACM achieves ~800 KB/s effective throughput. At 8 channels:
- Raw: 800 KB/s / 1 byte/sample = 800 kHz max sample rate
- With compression (typical 4:1): 800 KB/s * 4 = ~3.2 MHz effective sample rate

The `STREAM_RATE_LIMITS` table in `stream.js` (lines 11-36) shows the empirical limits, which align with this analysis.

### vs. Huffman Coding

Huffman coding would assign variable-length codes to the 16 possible nibble values. For typical logic data with heavy 0x0/0xF bias, this could achieve slightly better compression. However:
- Variable-length codes require bit-level alignment tracking in the decoder
- The decode table is larger and more complex
- On-device Huffman tree construction requires a statistics pass
- The fixed nibble code already captures the dominant compression opportunity (runs)

### vs. Delta + RLE on Raw Samples

Delta encoding (XOR successive samples) followed by RLE would:
- Work on interleaved samples directly (no transpose needed)
- Miss the per-channel structure (a change on one channel forces the entire delta word to be non-zero)
- Require wider symbols (8/16/32-bit) for the RLE values

The transpose-then-per-channel-RLE approach is strictly superior for logic analyzer data because it decomposes the multi-channel problem into independent single-bit problems.

### vs. COBS (Consistent Overhead Byte Stuffing)

COBS is a framing protocol, not a compression algorithm. However, it is sometimes paired with compression for serial streams. The 2-byte length prefix used here is simpler and adds less overhead than COBS (which adds ~0.5% overhead for framing alone).

---

## Rejected Prototype Implementations

The production code was cherry-picked from four prototype implementations, each preserved as `.ref` files in the firmware directory:

### 1. `stream_compress_minimal.c.ref`
- Used stack-allocated `channel_data[24][32]` (768 bytes on stack)
- Pre-unpacked nibbles into a flat array (`nibbles[64]` per channel)
- Nibble-by-nibble run counting with a while loop
- **Selected**: Delta-swap transpose kernel, bit accumulator output writer

### 2. `stream_compress_hwaccel.c.ref`
- Used RP2350 hardware interpolators (INTERP0/INTERP1) for bit extraction and nibble extraction
- CLZ/CTZ for O(1) run detection
- Separate `count_zero_nibbles()` and `count_ones_nibbles()` functions
- `raw_pending[]` buffer with memmove for deferred raw nibble emission
- **Selected**: CLZ/CTZ word-level run detection, bus priority configuration

### 3. `stream_compress_bitmagic.c.ref`
- 256-entry LUT for nibble classification
- SWAR (SIMD Within A Register) techniques for parallel bit manipulation
- Branchless selection via arithmetic masks
- Greedy raw group code selection from the same {1,2,3,4,6,8} set
- **Selected**: Greedy raw group code selection strategy

### 4. `stream_compress_batched.c.ref`
- Three-phase batch processing (transpose all -> classify all -> encode all)
- Processed entire 4KB DMA buffer as one batch
- Pre-computed nibble cost estimation in classify phase
- Separate static buffers for transposed data and output
- **Not selected** for production, but its multi-phase architecture influenced the overall pipeline design

The production code (`stream_compress.c`) combines the best elements:
- Delta-swap transpose from `minimal` (simple, fast, no LUTs)
- CLZ/CTZ run detection from `hwaccel` (O(1) per word, uses Cortex-M33 hardware)
- Bit accumulator from `minimal` (compact, branch-predictor-friendly)
- Greedy raw grouping from `bitmagic` (near-optimal with minimal branching)
- Bus priority from `hwaccel` (free performance when bank-contention occurs)
- Variable chunk sizes (32-1024) added in production, not present in any prototype

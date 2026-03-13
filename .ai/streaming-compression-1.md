# Streaming Compression Algorithm

## Overview

The LogicAnalyzer V2 uses a custom per-channel nibble-based compression algorithm optimized for real-time streaming on the RP2350 (Cortex-M33 @ 200MHz). Compression runs on Core 1 while Core 0 handles USB/WiFi transmission, enabling continuous streaming at 1-3 MHz sample rates over bandwidth-constrained USB CDC or WebSocket links.

## Why Compression Is Needed

Streaming mode continuously sends samples from the device to the software client. Without compression, the raw data rate quickly exceeds USB CDC bulk transfer capacity:

| Channels | Sample Rate | Raw Data Rate | Feasible? |
|----------|------------|---------------|-----------|
| 8        | 1 MHz      | 1 MB/s        | Marginal  |
| 16       | 1 MHz      | 2 MB/s        | Exceeds USB CDC |
| 24       | 1 MHz      | 4 MB/s        | Far exceeds USB CDC |

USB CDC bulk transfers typically sustain ~1-2 MB/s. The recommended streaming rate limits in the web client (`Software/Web/src/stores/stream.js`, lines 11-36) show the practical ceiling: 910 kHz for 8 channels, 454 kHz for 16 channels, 303 kHz for 24 channels. These limits already assume compression is active.

Logic analyzer signals are inherently compressible: channels are often idle (constant 0 or 1), and transitions between states are sparse relative to the sample rate. The algorithm exploits this by encoding per-channel bitstreams with run-length codes for constant regions and raw data for transition-heavy regions.

## Architecture: Four-Stage Pipeline

The compression is a cherry-pick of techniques from four prototype implementations (preserved as `.ref` files). The data flows through four stages:

```
PIO capture -> DMA ping-pong buffers -> [Core 1] bit-transpose -> classify -> run-detect -> encode -> [Core 0] USB/WiFi
```

Source: `Firmware/stream_compress.c`, lines 1-18.

### Stage 1: Bit Transpose (Delta-Swap 8x8 Butterfly)

**Problem:** DMA delivers interleaved samples where each sample contains one bit per channel packed into 1, 2, or 4 bytes (for 8, 16, or 24 channels respectively). Compression needs per-channel bitstreams instead.

**Solution:** An 8x8 bit matrix transpose using the delta-swap butterfly from *Hacker's Delight* (2nd ed, section 7-3). Three rounds of XOR-shift-mask operations transpose an 8x8 bit block in ~25 ALU instructions with zero memory lookups.

The `transpose8x8()` function (`stream_compress.c`, lines 90-125) takes 8 input bytes (rows = samples, columns = channels) and produces 8 output bytes (rows = channels, columns = samples). Each output byte contains 8 consecutive sample bits for one channel.

Three variant functions handle different capture widths:

- **`transpose_chunk_8ch()`** (lines 140-152): 1 byte/sample, single 8x8 transpose per group of 8 samples.
- **`transpose_chunk_16ch()`** (lines 154-179): 2 bytes/sample, two 8x8 transposes per group (low byte for channels 0-7, high byte for channels 8-15), with stride=2 to skip alternating bytes.
- **`transpose_chunk_24ch()`** (lines 181-215): 4 bytes/sample (padded to 32-bit DMA width), three 8x8 transposes per group with stride=4.

The transposed data lands in a static buffer `s_transposed[24][32]` (24 channels x 32 uint32_t words = 1024 bits per channel max), which is 1,536 bytes in `.bss` (`stream_compress.c`, lines 37-38).

### Stage 2: Channel Classification (OR/AND Reduce)

Before encoding, each channel's transposed words are classified with a fast OR/AND reduce across all words (`stream_compress.c`, lines 419-423):

```c
uint32_t or_all = 0, and_all = 0xFFFFFFFF;
for (uint32_t i = 0; i < chunk_words; i++) {
    or_all  |= s_transposed[ch][i];
    and_all &= s_transposed[ch][i];
}
```

This yields three possible outcomes in ~25 instructions per channel:

| Condition | Meaning | Header Code | Data Size |
|-----------|---------|-------------|-----------|
| `or_all == 0` | All samples are 0 | `ALL_ZERO` (0x01) | 0 bytes |
| `and_all == 0xFFFFFFFF` | All samples are 1 | `ALL_ONE` (0x02) | 0 bytes |
| Otherwise | Mixed data | Try nibble encoding | Variable |

For idle channels (very common in practice), classification alone eliminates all data for that channel.

### Stage 3: Run Detection (CLZ/CTZ Word-Level)

For channels with mixed data, the `count_run()` function (`stream_compress.c`, lines 241-271) counts consecutive matching nibbles using hardware CLZ/CTZ instructions.

The key insight: XOR the transposed word with a fill pattern (0x00000000 for zero runs, 0xFFFFFFFF for one runs). Matching nibbles become 0x0, and `__builtin_ctz()` (which compiles to RBIT+CLZ on Cortex-M33, 2 cycles total) instantly finds the first non-matching nibble position. A full-zero word means 8 matching nibbles detected in O(1) time.

```c
uint32_t w = s_transposed[ch][word_idx] ^ fill;
if (w == 0) {
    count += 8;    // entire word matches
} else {
    count += (uint32_t)__builtin_ctz(w) / 4;  // first mismatch position
}
```

### Stage 4: Nibble Encoding

The encoder (`encode_channel()`, lines 286-365) walks the transposed bitstream as a sequence of 4-bit nibbles and emits prefix-coded nibble pairs. Each nibble (4 bits of transposed data) represents 4 consecutive samples for one channel.

#### Nibble Prefix Codes (4 bits each)

Defined in `stream_compress.h`, lines 42-57:

| Code | Name | Meaning |
|------|------|---------|
| 0x0 | RAW1 | 1 raw data nibble follows |
| 0x1 | RAW2 | 2 raw data nibbles follow |
| 0x2 | RAW3 | 3 raw data nibbles follow |
| 0x3 | RAW6 | 6 raw data nibbles follow |
| 0x4 | RAW4 | 4 raw data nibbles follow |
| 0x5 | RAW8 | 8 raw data nibbles follow |
| 0x6 | ZERO2 | 2 zero nibbles (8 zero samples) |
| 0x7 | ZERO4 | 4 zero nibbles (16 zero samples) |
| 0x8 | ZERO8 | 8 zero nibbles (32 zero samples) |
| 0x9 | ZERO16 | 16 zero nibbles (64 zero samples) |
| 0xA | ZERO32 | 32 zero nibbles (128 zero samples) |
| 0xB | ONE2 | 2 one nibbles (8 one-filled samples) |
| 0xC | ONE4 | 4 one nibbles |
| 0xD | ONE8 | 8 one nibbles |
| 0xE | ONE16 | 16 one nibbles |
| 0xF | ONE32 | 32 one nibbles |

Note the non-sequential ordering of RAW codes (RAW6 at 0x3, RAW4 at 0x4) -- this is intentional from the bitmagic prototype's greedy code selection.

#### Encoding Strategy

The encoder uses a greedy approach (`stream_compress.c`, lines 294-351):

1. **Run detection path** (nibble is 0x0 or 0xF): Use `count_run()` to measure the run length, then emit the largest-fitting run codes first (ZERO32/ONE32, then 16, 8, 4, 2). A leftover single 0x0 or 0xF nibble is emitted as RAW1 + data.

2. **Raw data path** (nibble is anything else): Lookahead up to 8 nibbles to find where the next compressible run (>= 2 identical 0x0 or 0xF nibbles) begins. Everything before that boundary is emitted as the largest-fitting raw group (RAW8, RAW6, RAW4, RAW3, RAW2, RAW1).

3. **Early bail** (line 354): If the encoded output already meets or exceeds the raw byte count at any point during encoding, the function returns 0, and the channel falls back to `RAW` mode (header code 0x00) with uncompressed transposed data. This ensures compression never makes things worse.

#### Bit Accumulator Output

Encoded nibbles are packed MSB-first into bytes using a bit accumulator (`stream_compress.c`, lines 49-77). The `bw_put4()` function shifts each nibble into a 32-bit register and flushes a byte when 8 bits accumulate. The conditional flush alternates predictably for near-100% branch prediction accuracy on the M33.

## Output Format

### Chunk Structure

Each compressed chunk has this layout:

```
[header: ceil(numChannels/4) bytes]
[channel 0 data]
[channel 1 data]
...
[channel N-1 data]
```

**Header:** 2 bits per channel, packed LSB-first into bytes. Channel 0 occupies bits [1:0] of byte 0, channel 1 occupies bits [3:2], channel 4 occupies bits [1:0] of byte 1, etc. (`stream_compress.c`, lines 406-444).

Each 2-bit field is one of:
- `0x00` = RAW (raw transposed bytes follow)
- `0x01` = ALL_ZERO (no data)
- `0x02` = ALL_ONE (no data)
- `0x03` = NIBBLE_ENC (nibble-encoded stream follows)

**Channel data:** Depends on the header mode:
- ALL_ZERO / ALL_ONE: zero bytes (the entire channel is constant).
- RAW: `chunkSamples / 8` bytes of uncompressed transposed bitstream.
- NIBBLE_ENC: variable-length nibble-encoded stream, always strictly smaller than raw.

### Packetization for Transmission

Compressed chunks are transmitted with a simple length-prefixed framing protocol (`Firmware/LogicAnalyzer_Stream.c`, lines 386-403):

```
[2 bytes: compressed size, little-endian uint16]
[N bytes: compressed chunk data]
```

This repeats for each chunk. The stream ends with a 2-byte EOF marker (`0x0000`), followed by a text status line (`STREAM_DONE`, `STREAM_OVERFLOW`, etc.) with diagnostic counters (lines 479-509).

Before the chunk stream begins, the firmware sends:
1. Text handshake: `"STREAM_STARTED\n"` (line 313)
2. 8-byte info header: `[chunkSamples LE16][numChannels u8][reserved u8][actualFreq LE32]` (lines 316-331)

## Channel Mapping

The firmware supports selecting a subset of channels via `stream_compress_chunk_mapped()` (`stream_compress.c`, lines 451-512). The full PIO capture width (8, 16, or 24 channels) is always transposed, but only the channels listed in `channel_map[]` are classified and encoded. This means capturing channels 0, 5, and 23 uses 24-channel DMA width but only compresses and transmits 3 channels, with the header sized for 3 channels.

The capture width is determined by the highest channel index (`LogicAnalyzer_Stream.c`, lines 233-258):
- Channels 0-7: 8-bit DMA (1 byte/sample)
- Channels 0-15: 16-bit DMA (2 bytes/sample)
- Channels 0-23: 32-bit DMA (4 bytes/sample)

## Chunk Size Selection

The chunk size (number of samples per compression unit) is configurable. The firmware accepts a client-requested chunk size, validated to the range [32, 1024] and rounded down to a multiple of 32 (`LogicAnalyzer_Stream.c`, lines 270-277).

The `stream_compress_select_chunk_size()` function (`stream_compress.c`, lines 555-572) provides a recommended chunk size targeting >= 5 updates/second for real-time display:

| Min Sample Rate | Chunk Size |
|-----------------|------------|
| 5120 Hz         | 1024       |
| 2560 Hz         | 512        |
| 1280 Hz         | 256        |
| 640 Hz          | 128        |
| 320 Hz          | 64         |
| 0 Hz            | 32         |

Larger chunks compress better (longer runs to exploit) but increase latency.

## Ring Buffer and Dual-Core Pipeline

The firmware uses a producer-consumer ring buffer with `STREAM_SLOTS = 8` slots (`LogicAnalyzer_Stream.h`, lines 9-12):

- **Slot sizes:** Input = 4096 bytes (worst case: 1024 samples x 4 bytes for 24ch), Output = 3080 bytes (max compressed for 24ch/1024 samples).
- **DMA ISR** (Core 0): Fills input slots via ping-pong DMA, increments `dma_complete_count`.
- **Core 1** (`stream_core1_entry()`, lines 143-172): Polls `dma_complete_count`, compresses each completed slot into the corresponding output slot, increments `compress_head`.
- **Core 0 send loop** (`RunStreamSendLoop()`, lines 374-510): Polls `compress_head`, transmits completed output slots via USB/WiFi, increments `send_head`.

Bus priority is set to favor Core 1 for SRAM access during compression (`stream_compress_init()`, line 377), providing free performance when Core 1 and DMA contend for the same SRAM bank.

Overflow is detected when DMA is about to overwrite unprocessed slots: `dma_complete_count - send_head >= STREAM_SLOTS - 1` (line 441).

## Software-Side Decompression

The JavaScript decoder (`Software/Web/src/core/compression/decoder.js`) mirrors the firmware encoder:

### `decompressChunk(data, numChannels, chunkSamples)` (lines 77-144)

1. **Parse header:** Reads 2-bit mode codes for each channel from the header bytes (LSB-first, same packing as firmware).

2. **Decode per channel:**
   - `HDR_ALL_ZERO`: Allocate zero-filled `Uint8Array`.
   - `HDR_ALL_ONE`: Allocate `0xFF`-filled `Uint8Array`.
   - `HDR_RAW`: Slice raw bytes directly from the compressed data.
   - `HDR_NIBBLE_ENC`: Use `NibbleReader` to walk prefix codes and emit nibbles:
     - `raw` type: read N data nibbles from the stream.
     - `zero`/`one` type: emit N fill nibbles (0x0 or 0xF).
     - Repack nibbles into bytes with little-endian nibble ordering: `byte[j] = (nibble[2j+1] << 4) | nibble[2j]` (line 135).

3. **Returns:** Array of per-channel transposed bitstreams plus `bytesConsumed` for framing.

### `NibbleReader` (lines 39-66)

Reads nibbles MSB-first from a packed byte stream, matching the encoder's `bw_put4()` packing order. Tracks byte consumption for framing.

### `reverseTranspose(channels, numChannels, chunkSamples)` (lines 155-180)

Converts per-channel bitstreams back to interleaved sample bytes by iterating all samples and gathering each channel's bit at that sample position. This is the inverse of the firmware's 8x8 transpose.

### Integration with Driver

The `analyzer.js` driver (`Software/Web/src/core/driver/analyzer.js`, lines 464-477) reads compressed chunks in a loop:
1. Read 2-byte size prefix.
2. If size is 0, the stream has ended (EOF marker).
3. Read `compressedSize` bytes of compressed data.
4. Call `decompressChunk()` to decode.
5. Pass decoded per-channel bitstreams to the `onChunk` callback.

The stream store (`Software/Web/src/stores/stream.js`, lines 64-70) then unpacks each channel's bitstream from packed bits into per-sample 0/1 values for display.

## Compression Ratio Expectations

### Best Case: Idle Channels

A channel that is entirely 0 or entirely 1 within a chunk costs **0 bytes** of payload (just 2 header bits). For 8 idle channels with 512 samples, the compressed output is just 2 header bytes versus 512 raw bytes = **256:1** compression.

### Typical Case: Sparse Activity

Logic signals typically have long idle periods with occasional transitions. A channel with a single transition in a 512-sample chunk might compress as: ZERO32 (128 zeros) + ZERO16 (64 zeros) + ... + RAW2 (the transition region) + ONE32 + ONE16 + ... This yields roughly 5-8 nibbles of overhead (3-4 bytes) versus 64 raw bytes = **~16:1** compression.

### Worst Case: Random Data

Every nibble is non-zero and non-0xF, so the encoder emits RAW8 prefix + 8 data nibbles for each group of 8. That is 9 nibbles per 8 data nibbles = **12.5% overhead**. However, the early bail mechanism (`stream_compress.c`, lines 354, 361) detects when encoded output would equal or exceed raw size and falls back to `HDR_RAW` mode -- so worst case is exactly raw size plus 2 header bits per channel. In practice, the worst case adds only `ceil(numChannels/4)` header bytes of overhead.

### Worst-Case Output Size

The `stream_compress_max_output_size()` function (`stream_compress.c`, lines 544-548) computes the maximum possible output:

```
max_output = ceil(numChannels / 4) + numChannels * (chunkSamples / 8)
```

This is the header plus all channels raw (no compression). The output slot is sized at 3080 bytes to accommodate the worst case for 24 channels with 1024 samples: `ceil(24/4) + 24 * (1024/8) = 6 + 3072 = 3078`.

## Edge Cases

### Highly Repetitive Data (ALL_ZERO / ALL_ONE)

Entire channels are encoded with just 2 header bits and zero payload. This is the most common case for unused channels.

### Highly Random Data (e.g., COUNTER Pattern)

Every channel falls back to `HDR_RAW` mode. The early bail in `encode_channel()` triggers quickly (after the first few nibbles show no compression benefit), minimizing wasted CPU cycles. The output is header + raw transposed bytes -- functionally identical to uncompressed but with the data already bit-transposed.

### Single Leftover Nibble

When a run of 0x0 or 0xF nibbles has an odd count, the last single nibble is emitted as RAW1 + data nibble (2 nibbles = 1 byte). This is handled explicitly at lines 313-317 of `stream_compress.c`.

### Non-Multiple-of-8 Channel Counts

Channel counts like 5 or 13 work correctly. The transpose functions process up to the actual channel count within their byte groups, and the header is sized as `ceil(numChannels/4)` bytes. Unused bits in the last header byte are zero (RAW mode) but there is no corresponding channel data to read.

### Partial Runs at Chunk Boundaries

Runs cannot span chunk boundaries. Each chunk is compressed independently, so a long run of zeros that spans two chunks is encoded as two separate runs. This is a deliberate trade-off: independent chunks enable parallel processing and simplify the decompressor state machine.

## Key Source Files

| File | Purpose |
|------|---------|
| `Firmware/stream_compress.h` | Public API, constants, nibble prefix code definitions |
| `Firmware/stream_compress.c` | Compression implementation (transpose, classify, encode) |
| `Firmware/LogicAnalyzer_Stream.c` | Streaming pipeline (DMA, Core 1 loop, USB send loop, framing) |
| `Firmware/LogicAnalyzer_Stream.h` | Ring buffer sizing constants |
| `Software/Web/src/core/compression/decoder.js` | JavaScript decompressor |
| `Software/Web/src/core/compression/decoder.test.js` | Decompressor unit tests |
| `Software/Web/src/core/compression/test-patterns.js` | Test pattern generators (JS equivalents of firmware patterns) |
| `Software/Web/src/core/driver/analyzer.js` | Driver integration (read loop, chunk framing) |
| `Software/Web/src/stores/stream.js` | Stream state management, bitstream unpacking |
| `Firmware/stream_compress_minimal.c.ref` | Prototype: delta-swap transpose + bit accumulator |
| `Firmware/stream_compress_hwaccel.c.ref` | Prototype: CLZ/CTZ run detection + bus priority |
| `Firmware/stream_compress_bitmagic.c.ref` | Prototype: greedy raw group code selection |
| `Firmware/stream_compress_batched.c.ref` | Prototype: batched processing |

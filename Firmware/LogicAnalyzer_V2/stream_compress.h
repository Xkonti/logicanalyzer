/*
 * stream_compress.h — Unified stream compression for RP2350 logic analyzer
 *
 * Per-channel nibble-based compression for DMA-captured logic analyzer data.
 * Designed for real-time streaming on Core 1 (Cortex-M33 @ 200MHz).
 *
 * Best-of-4 hybrid algorithm:
 *   - Delta-swap 8x8 butterfly transpose (from minimal)
 *   - CLZ/CTZ word-level run detection (from hwaccel)
 *   - Bit-accumulator output writer (from minimal)
 *   - Greedy raw group code selection (from bitmagic)
 *
 * Supports variable chunk sizes (128, 256, 512 samples) selected at runtime.
 */

#ifndef __STREAM_COMPRESS_H__
#define __STREAM_COMPRESS_H__

#include <stdint.h>
#include <stdbool.h>

/* Supported chunk sizes (samples per chunk) */
#define SC_CHUNK_128    128
#define SC_CHUNK_256    256
#define SC_CHUNK_512    512

/* Maximum values for static buffer sizing */
#define SC_MAX_CHANNELS     24
#define SC_MAX_CHUNK        512
#define SC_MAX_CHUNK_WORDS  (SC_MAX_CHUNK / 32)   /* 16 */

/* Header encoding (2 bits per channel, LSB-first packing) */
#define SC_HDR_RAW          0x00
#define SC_HDR_ALL_ZERO     0x01
#define SC_HDR_ALL_ONE      0x02
#define SC_HDR_NIBBLE_ENC   0x03

/* Nibble prefix codes (4-bit values) */
#define SC_NPC_RAW1     0x0
#define SC_NPC_RAW2     0x1
#define SC_NPC_RAW3     0x2
#define SC_NPC_RAW6     0x3
#define SC_NPC_RAW4     0x4
#define SC_NPC_RAW8     0x5
#define SC_NPC_ZERO2    0x6
#define SC_NPC_ZERO4    0x7
#define SC_NPC_ZERO8    0x8
#define SC_NPC_ZERO16   0x9
#define SC_NPC_ZERO32   0xA
#define SC_NPC_ONE2     0xB
#define SC_NPC_ONE4     0xC
#define SC_NPC_ONE8     0xD
#define SC_NPC_ONE16    0xE
#define SC_NPC_ONE32    0xF

/*
 * Initialize compression engine. Call from Core 1 before streaming.
 * Sets bus priority for Core 1.
 */
void stream_compress_init(void);

/*
 * Restore bus priority. Call when streaming ends.
 */
void stream_compress_deinit(void);

/*
 * Compress one chunk of interleaved DMA samples.
 *
 * Parameters:
 *   samples       - interleaved DMA samples (chunk_samples * bytes_per_sample)
 *   num_channels  - active channel count (1..24)
 *   chunk_samples - samples per chunk (128, 256, or 512; must be multiple of 8)
 *   out           - output buffer (>= stream_compress_max_output_size() bytes)
 *
 * Returns: bytes written to out.
 *
 * Output format (LSB-first header):
 *   [header: ceil(num_channels/4) bytes, 2 bits per channel]
 *   [channel 0 data: raw / encoded / nothing]
 *   [channel 1 data: ...]
 *   ...
 */
uint32_t stream_compress_chunk(const uint8_t *samples,
                                uint32_t num_channels,
                                uint32_t chunk_samples,
                                uint8_t *out);

/*
 * Compress all chunks in a DMA buffer.
 *
 * Parameters:
 *   dma_buf       - completed DMA ping-pong buffer
 *   dma_buf_size  - buffer size in bytes
 *   num_channels  - active channel count (1..24)
 *   chunk_samples - samples per chunk (128, 256, or 512)
 *   out           - output buffer for compressed stream
 *   out_capacity  - output buffer size in bytes
 *
 * Returns: total bytes written, or 0 on output overflow.
 */
uint32_t stream_compress_buffer(const uint8_t *dma_buf,
                                 uint32_t dma_buf_size,
                                 uint32_t num_channels,
                                 uint32_t chunk_samples,
                                 uint8_t *out,
                                 uint32_t out_capacity);

/*
 * Maximum possible output size for one chunk (header + all channels raw).
 */
uint32_t stream_compress_max_output_size(uint32_t num_channels,
                                          uint32_t chunk_samples);

/*
 * Select chunk size based on sample rate.
 *   < 25K sps  -> 128 samples (responsive preview)
 *   25K-200K   -> 256 samples (sweet spot)
 *   > 200K     -> 512 samples (fewer chunks/sec)
 */
uint32_t stream_compress_select_chunk_size(uint32_t sample_rate);

#endif /* __STREAM_COMPRESS_H__ */

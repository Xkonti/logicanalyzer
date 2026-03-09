/*
 * stream_compress.c — Unified stream compression for RP2350 logic analyzer
 *
 * Runs on Core 1 (Cortex-M33 @ 200MHz). Every cycle matters.
 *
 * Data flow:
 *   PIO -> DMA ping-pong buffers -> bit-transpose -> per-channel encode -> USB
 *
 * Cherry-picked from 4 prototype implementations:
 *   Stage 1 (transpose):  delta-swap 8x8 butterfly from minimal — ~25 ALU ops
 *                          per 8x8 block, pure registers, no LUTs/hardware deps
 *   Stage 2 (classify):   OR/AND reduce — common across all 4 prototypes
 *   Stage 3 (run detect): CLZ/CTZ word-level from hwaccel — O(1) per 32-bit
 *                          word via single-cycle RBIT+CLZ on Cortex-M33
 *   Stage 4 (encode):     bit accumulator from minimal + greedy code selection
 *                          from bitmagic, with inline nibble extraction
 *   Bus priority:         from hwaccel — Core 1 gets SRAM priority
 */

#include "stream_compress.h"
#include "pico/stdlib.h"
#include "hardware/structs/busctrl.h"
#include <string.h>

/* ======================================================================== */
/* Static transposed buffer                                                  */
/* ======================================================================== */

/*
 * Per-channel bitstream after transpose. Each channel's samples stored as
 * consecutive uint32_t words. Sized for maximum: 512 samples × 24 channels.
 * 24 × 16 × 4 = 1,536 bytes in .bss.
 *
 * On little-endian ARM, byte access via (uint8_t*)s_transposed[ch] gives
 * correct sample bit ordering for both word-level and byte-level operations.
 */
static uint32_t s_transposed[SC_MAX_CHANNELS][SC_MAX_CHUNK_WORDS]
    __attribute__((aligned(4)));

/* ======================================================================== */
/* Bit Accumulator (from minimal)                                            */
/* ======================================================================== */

/*
 * Packs output nibbles MSB-first into a byte stream. The shift+OR is
 * single-cycle on M33; the conditional flush alternates perfectly for
 * ~100% branch prediction accuracy.
 */
typedef struct {
    uint8_t *buf;
    uint32_t accum;     /* bit accumulator */
    uint32_t bits;      /* valid bits in accum, 0..7 */
    uint32_t pos;       /* byte write position */
} bit_writer_t;

static inline void bw_init(bit_writer_t *bw, uint8_t *out) {
    bw->buf = out;
    bw->accum = 0;
    bw->bits = 0;
    bw->pos = 0;
}

static inline void bw_put4(bit_writer_t *bw, uint32_t nibble) {
    bw->accum = (bw->accum << 4) | (nibble & 0xF);
    bw->bits += 4;
    if (bw->bits >= 8) {
        bw->bits -= 8;
        bw->buf[bw->pos++] = (uint8_t)(bw->accum >> bw->bits);
    }
}

static inline void bw_flush(bit_writer_t *bw) {
    if (bw->bits > 0) {
        bw->buf[bw->pos++] = (uint8_t)(bw->accum << (8 - bw->bits));
        bw->bits = 0;
    }
}

/* ======================================================================== */
/* 8x8 Bit Matrix Transpose (from minimal — delta-swap butterfly)            */
/* ======================================================================== */

/*
 * Transposes an 8x8 bit matrix using three rounds of delta-swap from
 * Hacker's Delight (2nd ed, section 7-3). ~25 ALU instructions total.
 *
 * Input:  src[i*stride] for i=0..7 (rows = samples, columns = channels)
 * Output: out[ch] = 8-bit column vector (bit k = sample k for this channel)
 */
static inline void transpose8x8(const uint8_t *src, uint32_t stride,
                                  uint8_t out[8]) {
    uint32_t lo = ((uint32_t)src[3 * stride] << 24) |
                  ((uint32_t)src[2 * stride] << 16) |
                  ((uint32_t)src[1 * stride] <<  8) |
                  ((uint32_t)src[0 * stride]);

    uint32_t hi = ((uint32_t)src[7 * stride] << 24) |
                  ((uint32_t)src[6 * stride] << 16) |
                  ((uint32_t)src[5 * stride] <<  8) |
                  ((uint32_t)src[4 * stride]);

    uint32_t t;

    /* Round 1: distance=7, mask=0x00AA00AA — swap 2x2 bit blocks */
    t = ((lo >> 7) ^ lo) & 0x00AA00AA;
    lo ^= t; lo ^= (t << 7);
    t = ((hi >> 7) ^ hi) & 0x00AA00AA;
    hi ^= t; hi ^= (t << 7);

    /* Round 2: distance=14, mask=0x0000CCCC — swap 4x4 blocks */
    t = ((lo >> 14) ^ lo) & 0x0000CCCC;
    lo ^= t; lo ^= (t << 14);
    t = ((hi >> 14) ^ hi) & 0x0000CCCC;
    hi ^= t; hi ^= (t << 14);

    /* Round 3: distance=28 — cross-word swap completing the 8x8 */
    t = (((hi << 4) | (lo >> 28)) ^ lo) & 0xF0F0F0F0;
    lo ^= t;
    hi ^= (t >> 4);

    out[0] = (uint8_t)(lo);        out[1] = (uint8_t)(lo >>  8);
    out[2] = (uint8_t)(lo >> 16);  out[3] = (uint8_t)(lo >> 24);
    out[4] = (uint8_t)(hi);        out[5] = (uint8_t)(hi >>  8);
    out[6] = (uint8_t)(hi >> 16);  out[7] = (uint8_t)(hi >> 24);
}

/* ======================================================================== */
/* Chunk Transpose — variable size (128/256/512 samples)                     */
/* ======================================================================== */

/*
 * Transpose interleaved DMA samples into per-channel bitstreams stored
 * in s_transposed[][]. Each variant processes num_groups = chunk_samples/8
 * invocations of the 8x8 kernel, scattering one byte per channel per group.
 *
 * On little-endian ARM, the byte scatter into the uint32_t array naturally
 * produces correct word-level layout for the CLZ-based encoder.
 */

static void transpose_chunk_8ch(const uint8_t *samples,
                                 uint32_t num_channels,
                                 uint32_t num_groups) {
    uint8_t *base = (uint8_t *)s_transposed;
    const uint32_t ch_stride = SC_MAX_CHUNK_WORDS * 4;

    for (uint32_t g = 0; g < num_groups; g++) {
        uint8_t tr[8];
        transpose8x8(&samples[g * 8], 1, tr);
        for (uint32_t ch = 0; ch < num_channels; ch++)
            base[ch * ch_stride + g] = tr[ch];
    }
}

static void transpose_chunk_16ch(const uint8_t *samples,
                                  uint32_t num_channels,
                                  uint32_t num_groups) {
    uint8_t *base = (uint8_t *)s_transposed;
    const uint32_t ch_stride = SC_MAX_CHUNK_WORDS * 4;

    for (uint32_t g = 0; g < num_groups; g++) {
        const uint8_t *src = &samples[g * 16]; /* 8 samples × 2 bytes */
        uint8_t tr[8];

        /* Low byte: channels 0-7 */
        transpose8x8(src, 2, tr);
        uint32_t lo = (num_channels < 8) ? num_channels : 8;
        for (uint32_t ch = 0; ch < lo; ch++)
            base[ch * ch_stride + g] = tr[ch];

        /* High byte: channels 8-15 */
        if (num_channels > 8) {
            transpose8x8(src + 1, 2, tr);
            uint32_t hi = num_channels - 8;
            if (hi > 8) hi = 8;
            for (uint32_t ch = 0; ch < hi; ch++)
                base[(ch + 8) * ch_stride + g] = tr[ch];
        }
    }
}

static void transpose_chunk_24ch(const uint8_t *samples,
                                  uint32_t num_channels,
                                  uint32_t num_groups) {
    uint8_t *base = (uint8_t *)s_transposed;
    const uint32_t ch_stride = SC_MAX_CHUNK_WORDS * 4;

    for (uint32_t g = 0; g < num_groups; g++) {
        const uint8_t *src = &samples[g * 32]; /* 8 samples × 4 bytes */
        uint8_t tr[8];

        /* Byte 0: channels 0-7 */
        transpose8x8(src, 4, tr);
        uint32_t n = (num_channels < 8) ? num_channels : 8;
        for (uint32_t ch = 0; ch < n; ch++)
            base[ch * ch_stride + g] = tr[ch];

        /* Byte 1: channels 8-15 */
        if (num_channels > 8) {
            transpose8x8(src + 1, 4, tr);
            n = num_channels - 8;
            if (n > 8) n = 8;
            for (uint32_t ch = 0; ch < n; ch++)
                base[(ch + 8) * ch_stride + g] = tr[ch];
        }

        /* Byte 2: channels 16-23 */
        if (num_channels > 16) {
            transpose8x8(src + 2, 4, tr);
            n = num_channels - 16;
            if (n > 8) n = 8;
            for (uint32_t ch = 0; ch < n; ch++)
                base[(ch + 16) * ch_stride + g] = tr[ch];
        }
    }
}

/* ======================================================================== */
/* Inline nibble extraction                                                  */
/* ======================================================================== */

/*
 * Extract nibble at position nib_idx from a channel's transposed words.
 * Compiles to a single UBFX (Unsigned Bit Field Extract) on Cortex-M33.
 */
static inline uint32_t get_nibble(uint32_t ch, uint32_t nib_idx) {
    return (s_transposed[ch][nib_idx >> 3] >> ((nib_idx & 7) * 4)) & 0xF;
}

/* ======================================================================== */
/* CLZ-based run detection (from hwaccel)                                    */
/* ======================================================================== */

/*
 * Count consecutive nibbles matching 'fill' starting at nib_pos.
 *   fill = 0x00000000 for zero runs, 0xFFFFFFFF for ones runs.
 *
 * XOR with fill normalizes both cases: matching nibbles become 0x0.
 * Then CTZ (RBIT+CLZ, 2 cycles on M33) finds the first mismatch in O(1)
 * per word. A full zero word = 8 matching nibbles instantly.
 */
static uint32_t count_run(uint32_t ch, uint32_t nib_pos,
                           uint32_t chunk_words, uint32_t fill) {
    uint32_t count = 0;
    uint32_t word_idx = nib_pos >> 3;
    uint32_t nib_in_word = nib_pos & 7;

    /* First (possibly partial) word */
    if (word_idx < chunk_words) {
        uint32_t w = (s_transposed[ch][word_idx] ^ fill) >> (nib_in_word * 4);
        if (w == 0) {
            count += 8 - nib_in_word;
            word_idx++;
        } else {
            return (uint32_t)__builtin_ctz(w) / 4;
        }
    }

    /* Subsequent full words */
    while (word_idx < chunk_words) {
        uint32_t w = s_transposed[ch][word_idx] ^ fill;
        if (w == 0) {
            count += 8;
            word_idx++;
        } else {
            count += (uint32_t)__builtin_ctz(w) / 4;
            return count;
        }
    }

    return count;
}

/* ======================================================================== */
/* Nibble encoder — one channel                                              */
/* ======================================================================== */

/*
 * Encodes one channel's transposed bitstream using nibble prefix codes.
 * Returns bytes written, or 0 if encoding doesn't beat raw (early bail).
 *
 * Walks transposed words directly via inline nibble extraction (no
 * pre-unpacked array). For 0x0/0xF nibbles, uses CLZ-based run counting
 * and emits largest-first run codes. For mixed nibbles, lookahead scans
 * up to 8 nibbles and emits greedy raw group codes.
 */
static uint32_t encode_channel(uint32_t ch, uint32_t chunk_nibbles,
                                uint32_t chunk_words, uint32_t raw_bytes,
                                uint8_t *out) {
    bit_writer_t bw;
    bw_init(&bw, out);

    uint32_t pos = 0;

    while (pos < chunk_nibbles) {
        uint32_t nib = get_nibble(ch, pos);

        if (nib == 0x0 || nib == 0xF) {
            /* CLZ-based run detection */
            uint32_t fill = (nib == 0x0) ? 0x00000000 : 0xFFFFFFFF;
            uint32_t run = count_run(ch, pos, chunk_words, fill);
            uint32_t base_code = (nib == 0x0) ? SC_NPC_ZERO2 : SC_NPC_ONE2;

            /* Emit largest-first run codes (32, 16, 8, 4, 2) */
            while (run >= 2) {
                if      (run >= 32) { bw_put4(&bw, base_code + 4); pos += 32; run -= 32; }
                else if (run >= 16) { bw_put4(&bw, base_code + 3); pos += 16; run -= 16; }
                else if (run >= 8)  { bw_put4(&bw, base_code + 2); pos += 8;  run -= 8;  }
                else if (run >= 4)  { bw_put4(&bw, base_code + 1); pos += 4;  run -= 4;  }
                else                { bw_put4(&bw, base_code);      pos += 2;  run -= 2;  }
            }

            /* Single leftover 0x0/0xF: emit as RAW1 */
            if (run == 1) {
                bw_put4(&bw, SC_NPC_RAW1);
                bw_put4(&bw, nib);
                pos++;
            }
        } else {
            /*
             * Non-run region. Lookahead up to 8 nibbles for the boundary
             * where a compressible run (≥2 identical 0x0 or 0xF) starts.
             * Everything before that goes as a raw group.
             */
            uint32_t remaining = chunk_nibbles - pos;
            uint32_t max_look = (remaining < 8) ? remaining : 8;
            uint32_t raw_count = 1;

            while (raw_count < max_look) {
                uint32_t next = get_nibble(ch, pos + raw_count);
                if ((next == 0x0 || next == 0xF) &&
                    (pos + raw_count + 1 < chunk_nibbles) &&
                    get_nibble(ch, pos + raw_count + 1) == next) {
                    break;
                }
                raw_count++;
            }

            /* Greedy largest-first raw group (8, 6, 4, 3, 2, 1) */
            uint32_t emit, prefix;
            if      (raw_count >= 8) { prefix = SC_NPC_RAW8; emit = 8; }
            else if (raw_count >= 6) { prefix = SC_NPC_RAW6; emit = 6; }
            else if (raw_count >= 4) { prefix = SC_NPC_RAW4; emit = 4; }
            else if (raw_count >= 3) { prefix = SC_NPC_RAW3; emit = 3; }
            else if (raw_count >= 2) { prefix = SC_NPC_RAW2; emit = 2; }
            else                     { prefix = SC_NPC_RAW1; emit = 1; }

            bw_put4(&bw, prefix);
            for (uint32_t i = 0; i < emit; i++)
                bw_put4(&bw, get_nibble(ch, pos + i));
            pos += emit;
        }

        /* Early bail: output already meets or exceeds raw size */
        if (bw.pos >= raw_bytes)
            return 0;
    }

    bw_flush(&bw);

    /* Must strictly improve on raw to justify decode cost */
    if (bw.pos >= raw_bytes)
        return 0;

    return bw.pos;
}

/* ======================================================================== */
/* Bus priority control (from hwaccel)                                       */
/* ======================================================================== */

void stream_compress_init(void) {
    /*
     * Give Core 1 (PROC1) high priority for SRAM access during compression.
     * BUSCTRL_BUS_PRIORITY bit 4 = PROC1 priority. Free performance gain
     * when Core 1 and DMA contend for the same SRAM bank.
     */
    busctrl_hw->priority = (1u << 4);
}

void stream_compress_deinit(void) {
    busctrl_hw->priority = 0;
}

/* ======================================================================== */
/* Public API                                                                */
/* ======================================================================== */

uint32_t stream_compress_chunk(const uint8_t *samples,
                                uint32_t num_channels,
                                uint32_t chunk_samples,
                                uint8_t *out) {
    const uint32_t chunk_words = chunk_samples / 32;
    const uint32_t chunk_nibbles = chunk_samples / 4;
    const uint32_t raw_bytes = chunk_samples / 8;
    const uint32_t num_groups = chunk_samples / 8;

    /* --- Stage 1: Bit-transpose --- */
    if (num_channels <= 8)
        transpose_chunk_8ch(samples, num_channels, num_groups);
    else if (num_channels <= 16)
        transpose_chunk_16ch(samples, num_channels, num_groups);
    else
        transpose_chunk_24ch(samples, num_channels, num_groups);

    /* --- Stage 2-4: Classify + encode each channel, assemble output --- */
    const uint32_t header_bytes = (num_channels + 3) >> 2;
    uint32_t data_pos = header_bytes;
    uint8_t header[8] = {0};

    /* Encoding scratch buffer: raw_bytes + headroom for worst-case RAW8 overshoot before bail */
    uint8_t enc_buf[SC_MAX_CHUNK / 8 + 8];

    for (uint32_t ch = 0; ch < num_channels; ch++) {
        uint32_t hdr_byte = ch >> 2;
        uint32_t hdr_shift = (ch & 3) * 2;
        uint32_t mode;

        /* Classification: OR/AND reduce across all words (~25 instructions) */
        uint32_t or_all = 0, and_all = 0xFFFFFFFF;
        for (uint32_t i = 0; i < chunk_words; i++) {
            or_all  |= s_transposed[ch][i];
            and_all &= s_transposed[ch][i];
        }

        if (or_all == 0) {
            mode = SC_HDR_ALL_ZERO;
        } else if (and_all == 0xFFFFFFFF) {
            mode = SC_HDR_ALL_ONE;
        } else {
            uint32_t enc_size = encode_channel(ch, chunk_nibbles, chunk_words,
                                                raw_bytes, enc_buf);
            if (enc_size > 0) {
                mode = SC_HDR_NIBBLE_ENC;
                memcpy(&out[data_pos], enc_buf, enc_size);
                data_pos += enc_size;
            } else {
                mode = SC_HDR_RAW;
                memcpy(&out[data_pos], s_transposed[ch], raw_bytes);
                data_pos += raw_bytes;
            }
        }

        /* Pack header LSB-first: channel 0 in bits [1:0], channel 1 in [3:2] */
        header[hdr_byte] |= (uint8_t)(mode << hdr_shift);
    }

    memcpy(out, header, header_bytes);
    return data_pos;
}

uint32_t stream_compress_buffer(const uint8_t *dma_buf,
                                 uint32_t dma_buf_size,
                                 uint32_t num_channels,
                                 uint32_t chunk_samples,
                                 uint8_t *out,
                                 uint32_t out_capacity) {
    uint32_t bytes_per_sample;
    if      (num_channels <= 8)  bytes_per_sample = 1;
    else if (num_channels <= 16) bytes_per_sample = 2;
    else                         bytes_per_sample = 4;

    const uint32_t chunk_input_bytes = chunk_samples * bytes_per_sample;
    const uint32_t num_chunks = dma_buf_size / chunk_input_bytes;
    const uint32_t worst_per_chunk = stream_compress_max_output_size(
                                        num_channels, chunk_samples);
    uint32_t total_out = 0;

    for (uint32_t i = 0; i < num_chunks; i++) {
        if (total_out + worst_per_chunk > out_capacity)
            return 0;

        uint32_t chunk_out = stream_compress_chunk(
            &dma_buf[i * chunk_input_bytes], num_channels,
            chunk_samples, &out[total_out]);
        total_out += chunk_out;
    }

    return total_out;
}

uint32_t stream_compress_max_output_size(uint32_t num_channels,
                                          uint32_t chunk_samples) {
    uint32_t raw_bytes = chunk_samples / 8;
    return ((num_channels + 3) >> 2) + num_channels * raw_bytes;
}

uint32_t stream_compress_select_chunk_size(uint32_t sample_rate) {
    if (sample_rate > 200000) return SC_CHUNK_512;
    if (sample_rate >= 25000) return SC_CHUNK_256;
    return SC_CHUNK_128;
}

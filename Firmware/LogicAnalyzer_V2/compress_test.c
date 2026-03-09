/*
 * compress_test.c — Compression benchmark for RP2350 logic analyzer
 *
 * Generates realistic I2C traffic on ALL channels (cycling SCL/SDA pairs),
 * sampled at 250 kHz for a 100 kHz I2C bus. Runs 100 iterations of 512-sample
 * chunks per channel count and reports averaged timing/size.
 *
 * 24 tests total (one per channel count 1-24).
 */

#include "LogicAnalyzer_Board_Settings.h"
#include "stream_compress.h"
#include "pico/stdlib.h"
#include "tusb.h"
#include <string.h>

/* Functions from LogicAnalyzer.c (external linkage, no shared header) */
extern void sendResponse(const char* response, bool toWiFi);
extern void cdc_transfer(unsigned char* data, int len);
#ifdef USE_CYGW_WIFI
extern void wifi_transfer(unsigned char* data, int len);
#endif

/* Pattern IDs (kept for unit test compatibility) */
#define PAT_ALL_ZERO    0
#define PAT_ALL_ONE     1
#define PAT_HALF_TOGGLE 2
#define PAT_CLOCK       3
#define PAT_COUNTER     4
#define PAT_SPI_BUS     5
#define PAT_I2C         6
#define PAT_COUNT       7

/* Benchmark config */
#define BENCH_CHUNK     512
#define BENCH_ITERS     100

/* I2C timing: 100 kHz bus sampled at 250 kHz (4 µs per sample) */
#define I2C_SAMPLE_US   4
#define I2C_BIT_US      10     /* 100 kHz → 10 µs per bit */
#define I2C_TX_BITS     28     /* 4 idle + 1 start + 8 addr + 1 ACK + 8 data + 1 ACK + 1 stop + 4 idle */
#define I2C_TX_US       (I2C_TX_BITS * I2C_BIT_US)  /* 280 µs per transaction */

/* Static buffers — avoid stack overflow on Cortex-M33 */
static uint8_t s_pattern_buf[BENCH_CHUNK * 4]; /* max: 512 samples × 4 bytes/sample */
static uint8_t s_output_buf[1560];             /* >= max_output_size(24, 512) */

static void transfer_data(unsigned char* data, int len, bool toWiFi) {
    #ifdef USE_CYGW_WIFI
    if (toWiFi) {
        wifi_transfer(data, len);
    } else
    #endif
    {
        cdc_transfer(data, len);
    }
}

static uint32_t bytes_per_sample(uint32_t num_channels) {
    if (num_channels <= 8) return 1;
    if (num_channels <= 16) return 2;
    return 4;
}

/*
 * Generate I2C traffic on ALL channels, cycling SCL/SDA pairs.
 * ch0=SCL0, ch1=SDA0, ch2=SCL1, ch3=SDA1, ...
 *
 * Each pair is an independent I2C bus with different data and a phase offset
 * (pair * 37 µs) for channel diversity.
 *
 * chunk_offset: sample offset for continuity across chunks (0, 512, 1024, ...)
 */
static void generate_i2c_continuous(uint8_t* buf, uint32_t num_channels,
                                     uint32_t chunk_samples, uint32_t chunk_offset) {
    uint32_t bps = bytes_per_sample(num_channels);
    memset(buf, 0, chunk_samples * bps);

    uint32_t num_pairs = (num_channels + 1) / 2;

    for (uint32_t s = 0; s < chunk_samples; s++) {
        uint32_t global_s = chunk_offset + s;
        uint32_t base_time_us = global_s * I2C_SAMPLE_US;

        for (uint32_t pair = 0; pair < num_pairs; pair++) {
            /* Phase offset per pair for channel diversity */
            uint32_t time_us = base_time_us + pair * 37;

            uint32_t tx_time = time_us % I2C_TX_US;
            uint32_t tx_num  = time_us / I2C_TX_US;
            uint32_t bit_idx  = tx_time / I2C_BIT_US;   /* 0-27 */
            uint32_t phase_us = tx_time % I2C_BIT_US;   /* 0-9 */

            /* Vary data per pair */
            uint32_t pair_tx = tx_num + pair * 97;
            uint8_t addr7   = (uint8_t)((pair_tx * 0x1B + 0x50) & 0x7F);
            uint8_t addr_rw = (uint8_t)((addr7 << 1) | (pair_tx & 1));
            uint8_t data_byte = (uint8_t)((pair_tx * 0x37 + 0xA5) & 0xFF);

            uint8_t scl, sda;

            if (bit_idx < 4 || bit_idx >= 24) {
                /* Idle: both high */
                scl = 1; sda = 1;
            } else if (bit_idx == 4) {
                /* Start: SDA falls while SCL high, then SCL falls */
                scl = (phase_us < 5) ? 1 : 0;
                sda = 0;
            } else if (bit_idx == 23) {
                /* Stop: SCL rises, then SDA rises */
                scl = (phase_us >= 5) ? 1 : 0;
                sda = (phase_us >= 7) ? 1 : 0;
            } else {
                /* Data/ACK bits (bit_idx 5-22) */
                uint32_t dbit = bit_idx - 5; /* 0-17 */
                scl = (phase_us >= 5) ? 1 : 0;

                if (dbit < 8) {
                    sda = (addr_rw >> (7 - dbit)) & 1;
                } else if (dbit == 8) {
                    sda = 0; /* Address ACK */
                } else if (dbit < 17) {
                    sda = (data_byte >> (7 - (dbit - 9))) & 1;
                } else {
                    sda = 0; /* Data ACK */
                }
            }

            /* Even channel = SCL, odd channel = SDA */
            uint32_t scl_ch = pair * 2;
            uint32_t sda_ch = pair * 2 + 1;

            if (scl_ch < num_channels) {
                buf[s * bps + (scl_ch >> 3)] |= (scl << (scl_ch & 7));
            }
            if (sda_ch < num_channels) {
                buf[s * bps + (sda_ch >> 3)] |= (sda << (sda_ch & 7));
            }
        }
    }
}

/* Legacy pattern generator (kept for JS unit test parity) */
static void generate_pattern(uint8_t id, uint8_t* buf,
                              uint32_t num_channels, uint32_t chunk_samples,
                              uint32_t chunk_offset) {
    uint32_t bps = bytes_per_sample(num_channels);
    uint32_t buf_size = chunk_samples * bps;

    switch (id) {
        case PAT_ALL_ZERO:
            memset(buf, 0, buf_size);
            break;

        case PAT_ALL_ONE:
            for (uint32_t s = 0; s < chunk_samples; s++) {
                uint32_t off = s * bps;
                buf[off] = 0xFF;
                if (bps >= 2) buf[off + 1] = 0xFF;
                if (bps >= 4) {
                    buf[off + 2] = 0xFF;
                    buf[off + 3] = 0x00;
                }
            }
            break;

        case PAT_HALF_TOGGLE:
            memset(buf, 0, buf_size);
            for (uint32_t s = chunk_samples / 2; s < chunk_samples; s++) {
                uint32_t off = s * bps;
                buf[off] = 0xFF;
                if (bps >= 2) buf[off + 1] = 0xFF;
                if (bps >= 4) {
                    buf[off + 2] = 0xFF;
                    buf[off + 3] = 0x00;
                }
            }
            break;

        case PAT_CLOCK:
            for (uint32_t s = 0; s < chunk_samples; s++) {
                uint32_t off = s * bps;
                if (s & 1) {
                    buf[off] = 0xFF;
                    if (bps >= 2) buf[off + 1] = 0xFF;
                    if (bps >= 4) {
                        buf[off + 2] = 0xFF;
                        buf[off + 3] = 0x00;
                    }
                } else {
                    memset(&buf[off], 0, bps);
                }
            }
            break;

        case PAT_COUNTER:
            for (uint32_t s = 0; s < chunk_samples; s++) {
                uint32_t off = s * bps;
                buf[off] = (s * 7 + 3) & 0xFF;
                if (bps >= 2) buf[off + 1] = (s * 13 + 5) & 0xFF;
                if (bps >= 4) {
                    buf[off + 2] = (s * 17 + 11) & 0xFF;
                    buf[off + 3] = 0x00;
                }
            }
            break;

        case PAT_SPI_BUS:
            memset(buf, 0, buf_size);
            {
                uint32_t pos = 0;
                uint32_t byte_idx = 0;
                while (pos < chunk_samples) {
                    uint8_t mosi_byte = (uint8_t)((byte_idx * 0xA5 + 0x3C) & 0xFF);
                    uint8_t miso_byte = (uint8_t)((byte_idx * 0x5A + 0xC3) & 0xFF);
                    for (uint32_t i = 0; i < 4 && pos < chunk_samples; i++, pos++)
                        buf[pos * bps] = 0x01;
                    for (int bit = 7; bit >= 0 && pos < chunk_samples; bit--) {
                        uint8_t mosi_bit = (mosi_byte >> bit) & 1;
                        uint8_t miso_bit = (miso_byte >> bit) & 1;
                        uint8_t data_val = (uint8_t)((mosi_bit << 2) | (miso_bit << 3));
                        if (pos < chunk_samples)
                            buf[pos++ * bps] = data_val;
                        if (pos < chunk_samples)
                            buf[pos++ * bps] = data_val | 0x02;
                    }
                    for (uint32_t i = 0; i < 4 && pos < chunk_samples; i++, pos++)
                        buf[pos * bps] = 0x01;
                    byte_idx++;
                }
            }
            break;

        case PAT_I2C:
            generate_i2c_continuous(buf, num_channels, chunk_samples, chunk_offset);
            return; /* Skip channel mask — bits are set explicitly per channel */
    }

    /* Mask off bits above num_channels (handles non-multiple-of-8 counts) */
    uint8_t ch_mask[4] = {0, 0, 0, 0};
    for (uint32_t c = 0; c < num_channels; c++)
        ch_mask[c >> 3] |= (1u << (c & 7));
    for (uint32_t s = 0; s < chunk_samples; s++) {
        uint32_t off = s * bps;
        for (uint32_t b = 0; b < bps; b++)
            buf[off + b] &= ch_mask[b];
    }
}

void run_compression_test(bool fromWiFi) {
    sendResponse("COMPRESS_TEST\n", fromWiFi);

    uint16_t test_count = 24; /* one per channel count */
    transfer_data((unsigned char*)&test_count, 2, fromWiFi);

    for (uint32_t ch = 1; ch <= 24; ch++) {
        uint32_t total_compress_us = 0;
        uint32_t total_compressed_size = 0;
        uint32_t last_sz = 0;

        for (uint32_t iter = 0; iter < BENCH_ITERS; iter++) {
            generate_i2c_continuous(s_pattern_buf, ch, BENCH_CHUNK, iter * BENCH_CHUNK);

            uint32_t t0 = time_us_32();
            last_sz = stream_compress_chunk(s_pattern_buf, ch, BENCH_CHUNK, s_output_buf);
            uint32_t elapsed = time_us_32() - t0;

            total_compress_us += elapsed;
            total_compressed_size += last_sz;

            /* Keep USB alive during long runs */
            if ((iter & 0xF) == 0) tud_task();
        }

        uint32_t avg_compress_us = total_compress_us / BENCH_ITERS;
        uint16_t avg_compressed_size = (uint16_t)(total_compressed_size / BENCH_ITERS);
        uint32_t bps = bytes_per_sample(ch);
        uint16_t raw_size = (uint16_t)(BENCH_CHUNK * bps);

        /* 16-byte result header (little-endian) */
        uint8_t header[16];
        header[0] = PAT_I2C;
        header[1] = (uint8_t)ch;
        header[2] = (uint8_t)(BENCH_CHUNK & 0xFF);
        header[3] = (uint8_t)(BENCH_CHUNK >> 8);
        header[4] = (uint8_t)(last_sz & 0xFF);         /* actual payload size */
        header[5] = (uint8_t)(last_sz >> 8);
        header[6] = (uint8_t)(raw_size & 0xFF);
        header[7] = (uint8_t)(raw_size >> 8);
        header[8]  = (uint8_t)(avg_compress_us);
        header[9]  = (uint8_t)(avg_compress_us >> 8);
        header[10] = (uint8_t)(avg_compress_us >> 16);
        header[11] = (uint8_t)(avg_compress_us >> 24);
        header[12] = (uint8_t)(avg_compressed_size & 0xFF);
        header[13] = (uint8_t)(avg_compressed_size >> 8);
        header[14] = (uint8_t)(BENCH_ITERS & 0xFF);
        header[15] = (uint8_t)(BENCH_ITERS >> 8);

        transfer_data(header, 16, fromWiFi);
        transfer_data(s_output_buf, (int)last_sz, fromWiFi);

        tud_task();
    }

    sendResponse("COMPRESS_TEST_DONE\n", fromWiFi);
}

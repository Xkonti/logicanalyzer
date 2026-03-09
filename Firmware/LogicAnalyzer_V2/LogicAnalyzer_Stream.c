#include "LogicAnalyzer_Stream.h"
#include "stream_compress.h"
#include "hardware/dma.h"
#include "hardware/pio.h"
#include "hardware/clocks.h"
#include "hardware/irq.h"
#include "hardware/sync.h"
#include "hardware/structs/bus_ctrl.h"
#include "pico/multicore.h"
#include "LogicAnalyzer.pio.h"
#include "tusb.h"
#include <string.h>

/* External functions from LogicAnalyzer.c */
extern void cdc_transfer(unsigned char* data, int len);
extern void sendResponse(const char* response, bool toWiFi);
extern bool processUSBInput(bool skipProcessing);

/* ---- Ring buffer ---- */
static uint8_t  stream_input[STREAM_SLOTS][STREAM_INPUT_SLOT_SIZE]  __attribute__((aligned(4)));
static uint8_t  stream_output[STREAM_SLOTS][STREAM_OUTPUT_SLOT_SIZE] __attribute__((aligned(4)));
static uint32_t stream_output_size[STREAM_SLOTS];

/* ---- Producer-consumer counters (monotonically increasing) ---- */
static volatile uint32_t dma_complete_count;   /* written by DMA ISR */
static volatile uint32_t compress_head;        /* written by Core 1 */
static volatile uint32_t send_head;            /* written by Core 0 */

/* ---- Streaming state ---- */
static volatile bool streaming;
static volatile bool overflow;

/* ---- Capture parameters (set at stream start, read by Core 1) ---- */
static uint32_t stream_num_channels;     /* number of selected channels */
static uint32_t stream_capture_channels; /* total channels in capture mode (8/16/24) */
static uint8_t  stream_channel_map[24];  /* maps selected index → DMA bit position */
static uint32_t stream_chunk_samples;
static uint32_t stream_actual_freq;  /* actual PIO sample rate after clock divider clamping */

/* ---- DMA / PIO handles ---- */
static uint32_t stream_dma0;
static uint32_t stream_dma1;
static PIO      stream_pio;
static uint     stream_sm;
static uint     stream_pio_offset;

/* ------------------------------------------------------------------ */
/*  DMA interrupt handler — cycles write addresses through ring buffer */
/* ------------------------------------------------------------------ */

void __not_in_flash_func(stream_dma_handler)(void)
{
    /*
     * Slot assignment: when DMAx completes writing slot N, the chained
     * DMA channel is already writing slot N+1.  We set DMAx's write
     * address to slot N+2 so it's ready for the next chain trigger.
     *
     * dma_complete_count is the total number of completed slots.
     * After incrementing, (dma_complete_count + 1) % STREAM_SLOTS is
     * the slot AFTER the one the other DMA channel is currently writing.
     */
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

/* ------------------------------------------------------------------ */
/*  DMA configuration                                                  */
/* ------------------------------------------------------------------ */

static void configure_stream_dma(CHANNEL_MODE mode)
{
    enum dma_channel_transfer_size xfer_size;
    switch (mode)
    {
        case MODE_8_CHANNEL:  xfer_size = DMA_SIZE_8;  break;
        case MODE_16_CHANNEL: xfer_size = DMA_SIZE_16; break;
        case MODE_24_CHANNEL: xfer_size = DMA_SIZE_32; break;
    }

    stream_dma0 = dma_claim_unused_channel(true);
    stream_dma1 = dma_claim_unused_channel(true);

    /* DMA0 config */
    dma_channel_config c0 = dma_channel_get_default_config(stream_dma0);
    channel_config_set_read_increment(&c0, false);
    channel_config_set_write_increment(&c0, true);
    channel_config_set_transfer_data_size(&c0, xfer_size);
    channel_config_set_dreq(&c0, pio_get_dreq(stream_pio, stream_sm, false));
    channel_config_set_chain_to(&c0, stream_dma1);
    channel_config_set_enable(&c0, true);
    dma_channel_set_irq1_enabled(stream_dma0, true);

    /* DMA1 config */
    dma_channel_config c1 = dma_channel_get_default_config(stream_dma1);
    channel_config_set_read_increment(&c1, false);
    channel_config_set_write_increment(&c1, true);
    channel_config_set_transfer_data_size(&c1, xfer_size);
    channel_config_set_dreq(&c1, pio_get_dreq(stream_pio, stream_sm, false));
    channel_config_set_chain_to(&c1, stream_dma0);
    channel_config_set_enable(&c1, true);
    dma_channel_set_irq1_enabled(stream_dma1, true);

    /* Set ISR — use DMA_IRQ_1 with shared handler to avoid conflicts */
    irq_add_shared_handler(DMA_IRQ_1, stream_dma_handler, PICO_SHARED_IRQ_HANDLER_HIGHEST_ORDER_PRIORITY);
    irq_set_enabled(DMA_IRQ_1, true);

    /* DMA1 configured but not triggered; DMA0 configured and triggered.
     * DMA0 writes to slot[0], DMA1 writes to slot[1]. */
    dma_channel_configure(stream_dma1, &c1,
        stream_input[1], &stream_pio->rxf[stream_sm],
        stream_chunk_samples, false);

    dma_channel_configure(stream_dma0, &c0,
        stream_input[0], &stream_pio->rxf[stream_sm],
        stream_chunk_samples, true);
}

/* ------------------------------------------------------------------ */
/*  Core 1 — compression loop                                         */
/* ------------------------------------------------------------------ */

static void stream_core1_entry(void)
{
    stream_compress_init();   /* set bus priority for Core 1 */

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

            __dmb();   /* ensure output data is visible to Core 0 */
            compress_head++;
        }
        else
        {
            tight_loop_contents();
        }
    }

    stream_compress_deinit();
}

/* ------------------------------------------------------------------ */
/*  PIO setup — reuses BLAST_CAPTURE program                           */
/* ------------------------------------------------------------------ */

static bool setup_stream_pio(uint32_t frequency)
{
    stream_pio = pio0;
    pio_clear_instruction_memory(stream_pio);

    stream_sm = pio_claim_unused_sm(stream_pio, true);
    pio_sm_clear_fifos(stream_pio, stream_sm);
    pio_sm_restart(stream_pio, stream_sm);

    stream_pio_offset = pio_add_program(stream_pio, &BLAST_CAPTURE_program);

    /* Configure all capture pins as inputs */
    for (int i = 0; i < MAX_CHANNELS; i++)
        pio_sm_set_consecutive_pindirs(stream_pio, stream_sm, pinMap[i], 1, false);
    for (uint8_t i = 0; i < MAX_CHANNELS; i++)
        pio_gpio_init(stream_pio, pinMap[i]);

    /* stream_actual_freq is already computed by StartStream before calling us */
    float clockDiv = (float)clock_get_hz(clk_sys) / (float)frequency;
    if (clockDiv > 65535.0f) clockDiv = 65535.0f;

    pio_sm_config smConfig = BLAST_CAPTURE_program_get_default_config(stream_pio_offset);
    sm_config_set_in_pins(&smConfig, INPUT_PIN_BASE);
    sm_config_set_clkdiv(&smConfig, clockDiv);
    sm_config_set_in_shift(&smConfig, true, true, 0);  /* autopush per dword */
    sm_config_set_jmp_pin(&smConfig, pinMap[0]);        /* unused but required */

    pio_sm_set_enabled(stream_pio, stream_sm, false);

    /*
     * BLAST_CAPTURE program layout:
     *   offset 0: jmp pin LOOP    (trigger wait — we skip this)
     *   offset 1: in pins 32      (.wrap_target — continuous capture)
     *   .wrap back to offset 1
     *
     * By initializing the PC to offset+1, we bypass the trigger instruction
     * entirely and start continuous capture immediately.
     */
    pio_sm_init(stream_pio, stream_sm, stream_pio_offset + 1, &smConfig);

    return true;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

bool StartStream(const STREAM_REQUEST *req, bool fromWiFi)
{
    if (req->channelCount < 1 || req->channelCount > MAX_CHANNELS)
        return false;
    if (req->frequency < 1)
        return false;

    /* Find highest channel number to determine capture mode */
    uint8_t maxCh = 0;
    for (int i = 0; i < req->channelCount; i++)
    {
        if (req->channels[i] >= MAX_CHANNELS)
            return false;
        if (req->channels[i] > maxCh)
            maxCh = req->channels[i];
        stream_channel_map[i] = req->channels[i];
    }

    CHANNEL_MODE mode;
    if (maxCh < 8)
    {
        mode = MODE_8_CHANNEL;
        stream_capture_channels = 8;
    }
    else if (maxCh < 16)
    {
        mode = MODE_16_CHANNEL;
        stream_capture_channels = 16;
    }
    else
    {
        mode = MODE_24_CHANNEL;
        stream_capture_channels = 24;
    }

    stream_num_channels = req->channelCount;

    /* Compute actual PIO frequency (clock divider is clamped to 16-bit max in setup_stream_pio) */
    {
        float clockDiv = (float)clock_get_hz(clk_sys) / (float)req->frequency;
        if (clockDiv > 65535.0f) clockDiv = 65535.0f;
        stream_actual_freq = (uint32_t)((float)clock_get_hz(clk_sys) / clockDiv);
    }

    /* Use client-provided chunk size, validated to [32, STREAM_MAX_CHUNK] and multiple of 32 */
    {
        uint32_t chunk = req->chunkSamples;
        if (chunk < 32) chunk = 32;
        if (chunk > STREAM_MAX_CHUNK) chunk = STREAM_MAX_CHUNK;
        chunk &= ~31u;  /* round down to multiple of 32 */
        if (chunk == 0) chunk = 32;
        stream_chunk_samples = chunk;
    }

    /* Reset counters */
    dma_complete_count = 0;
    compress_head      = 0;
    send_head          = 0;
    overflow           = false;
    streaming          = true;

    memset(stream_output_size, 0, sizeof(stream_output_size));

    /* Setup PIO */
    if (!setup_stream_pio(req->frequency))
    {
        streaming = false;
        return false;
    }

    /* Setup DMA ring buffer */
    configure_stream_dma(mode);

    /* Reset Core 1 before launch (required on Pico 2W — CYW43 may touch Core 1 during init).
     * WARNING: Do NOT call printf/stdio_flush between multicore_reset_core1 and
     * multicore_launch_core1 — on WiFi builds, Core 1 may hold the stdio mutex
     * when killed, causing a deadlock. */
    multicore_reset_core1();
    multicore_launch_core1(stream_core1_entry);

    /* Enable PIO — capture begins */
    pio_sm_set_enabled(stream_pio, stream_sm, true);

    /* Send handshake AFTER all setup succeeds: text response + 8-byte info header.
     * Use cdc_transfer directly for USB — printf/stdio_flush would deadlock because
     * multicore_reset_core1() may have killed Core 1 while it held the stdio mutex. */
    if (fromWiFi)
        sendResponse("STREAM_STARTED\n", true);
    else
        cdc_transfer((unsigned char *)"STREAM_STARTED\n", 15);
    tud_task();

    uint8_t info[8];
    info[0] = stream_chunk_samples & 0xFF;
    info[1] = (stream_chunk_samples >> 8) & 0xFF;
    info[2] = (uint8_t)stream_num_channels;
    info[3] = 0; /* reserved */
    info[4] = stream_actual_freq & 0xFF;
    info[5] = (stream_actual_freq >> 8) & 0xFF;
    info[6] = (stream_actual_freq >> 16) & 0xFF;
    info[7] = (stream_actual_freq >> 24) & 0xFF;
    cdc_transfer(info, 8);

    return true;
}

void StopStream(void)
{
    streaming = false;
}

void CleanupStream(void)
{
    /* Stop Core 1 */
    multicore_reset_core1();

    /* Stop PIO */
    pio_sm_set_enabled(stream_pio, stream_sm, false);

    /* Abort DMAs */
    hw_clear_bits(&dma_hw->ch[stream_dma0].al1_ctrl, DMA_CH0_CTRL_TRIG_EN_BITS);
    hw_clear_bits(&dma_hw->ch[stream_dma1].al1_ctrl, DMA_CH0_CTRL_TRIG_EN_BITS);
    dma_channel_abort(stream_dma0);
    dma_channel_abort(stream_dma1);
    dma_channel_set_irq1_enabled(stream_dma0, false);
    dma_channel_set_irq1_enabled(stream_dma1, false);
    irq_remove_handler(DMA_IRQ_1, stream_dma_handler);
    dma_channel_unclaim(stream_dma0);
    dma_channel_unclaim(stream_dma1);

    /* Cleanup PIO */
    pio_sm_unclaim(stream_pio, stream_sm);
    pio_remove_program(stream_pio, &BLAST_CAPTURE_program, stream_pio_offset);
}

void RunStreamSendLoop(bool fromWiFi)
{
    while (streaming)
    {
        /* Send compressed chunks that Core 1 has finished */
        if (send_head < compress_head)
        {
            uint32_t slot = send_head % STREAM_SLOTS;
            uint16_t size = (uint16_t)stream_output_size[slot];
            uint8_t size_bytes[2] = { size & 0xFF, (size >> 8) & 0xFF };

            cdc_transfer(size_bytes, 2);
            cdc_transfer(stream_output[slot], size);
            send_head++;
        }

        /* Keep USB alive */
        tud_task();

        /* Check for incoming stop command */
        while (processUSBInput(false))
        {
            if (!streaming)
                break;
        }

        /* Overflow detection: DMA is about to overwrite unprocessed slots */
        if (dma_complete_count - send_head >= STREAM_SLOTS - 1)
        {
            overflow = true;
            streaming = false;
        }
    }

    /* Flush any remaining compressed chunks */
    while (send_head < compress_head)
    {
        uint32_t slot = send_head % STREAM_SLOTS;
        uint16_t size = (uint16_t)stream_output_size[slot];
        uint8_t size_bytes[2] = { size & 0xFF, (size >> 8) & 0xFF };

        cdc_transfer(size_bytes, 2);
        cdc_transfer(stream_output[slot], size);
        send_head++;
        tud_task();
    }

    /* Send EOF marker */
    uint8_t eof[2] = { 0x00, 0x00 };
    cdc_transfer(eof, 2);

    /* Send termination status — use cdc_transfer for USB to avoid stdio mutex deadlock
     * (mutex may still be locked from multicore_reset_core1 in StartStream). */
    if (fromWiFi)
    {
        sendResponse(overflow ? "STREAM_OVERFLOW\n" : "STREAM_DONE\n", true);
    }
    else
    {
        if (overflow)
            cdc_transfer((unsigned char *)"STREAM_OVERFLOW\n", 16);
        else
            cdc_transfer((unsigned char *)"STREAM_DONE\n", 12);
    }
}

bool IsStreamActive(void)
{
    return streaming;
}

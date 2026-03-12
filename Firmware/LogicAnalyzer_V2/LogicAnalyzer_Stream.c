#include "LogicAnalyzer_Stream.h"
#include "LogicAnalyzer_Board_Settings.h"
#include "stream_compress.h"
#include "hardware/dma.h"
#include "hardware/pio.h"
#include "hardware/clocks.h"
#include "hardware/irq.h"
#include "hardware/sync.h"
#include "hardware/structs/bus_ctrl.h"
#include "hardware/timer.h"
#include "pico/multicore.h"
#include "pico/stdio_usb.h"
#include "LogicAnalyzer.pio.h"
#include "tusb.h"
#include <string.h>
#include <stdio.h>

/* External functions from LogicAnalyzer.c */
extern void sendResponse(const char* response, bool toWiFi);

#ifdef USE_CYGW_WIFI
extern void wifi_transfer(unsigned char* data, int len);
/* usb_bulk_transfer_blocking is for Core 0 → Core 1 handoff (capture data, handshake).
 * During streaming, Core 1 uses usb_cdc_write_bulk directly (it owns TinyUSB). */
extern void usb_bulk_transfer_blocking(unsigned char* data, int len);
/* Direct Core 1 USB write — defined in LogicAnalyzer_WiFi.c */
extern void usb_cdc_write_bulk_ext(const uint8_t* data, uint32_t len);
#endif


/* ---- Ring buffers ---- */
static uint8_t  stream_input[STREAM_SLOTS][STREAM_INPUT_SLOT_SIZE]  __attribute__((aligned(4)));
static uint8_t  stream_output[STREAM_SLOTS][STREAM_OUTPUT_SLOT_SIZE] __attribute__((aligned(4)));
static uint32_t stream_output_size[STREAM_SLOTS];

/* ---- Local copy buffers (prevent reading partially-overwritten data) ---- */
static uint8_t  compress_local_input[STREAM_INPUT_SLOT_SIZE]  __attribute__((aligned(4)));

#ifdef USE_CYGW_WIFI
static uint8_t  transmit_local_buf[STREAM_OUTPUT_SLOT_SIZE]   __attribute__((aligned(4)));
#endif

/* ---- Producer-consumer counters (monotonically increasing) ---- */
static volatile uint32_t dma_complete_count;        /* written by DMA ISR (Core 0) */
static volatile uint32_t compress_complete_count;   /* written by Core 0 compression */
static volatile uint32_t transmit_count;            /* written by Core 1 transmission */

/* ---- Streaming state ---- */
static volatile bool streaming;
static volatile bool overflow;
static volatile bool compress_done;          /* Core 0 sets when compression loop exits */
volatile bool stream_transmit_active;        /* Core 0 sets true at start, Core 1 clears when done */
static bool stream_from_wifi;                /* set once at StartStream, read by Core 1 */

/* ---- Capture parameters (set at stream start) ---- */
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
    uint32_t clockDivInt = clock_get_hz(clk_sys) / frequency;
    if (clockDivInt > 65535) clockDivInt = 65535;
    if (clockDivInt == 0) clockDivInt = 1;

    pio_sm_config smConfig = BLAST_CAPTURE_program_get_default_config(stream_pio_offset);
    sm_config_set_in_pins(&smConfig, INPUT_PIN_BASE);
    sm_config_set_clkdiv(&smConfig, (float)clockDivInt);
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

    /* Compute actual PIO frequency — integer-only to avoid FPU hard fault */
    {
        uint32_t sys_clk = clock_get_hz(clk_sys);
        uint32_t clockDiv = sys_clk / req->frequency;
        if (clockDiv > 65535) clockDiv = 65535;
        if (clockDiv == 0) clockDiv = 1;
        stream_actual_freq = sys_clk / clockDiv;
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

    /* Reset counters and flags */
    dma_complete_count      = 0;
    compress_complete_count = 0;
    transmit_count          = 0;
    overflow                = false;
    compress_done           = false;
    streaming               = true;
    stream_from_wifi        = fromWiFi;

    memset(stream_output_size, 0, sizeof(stream_output_size));

    /* Setup PIO */
    if (!setup_stream_pio(req->frequency))
    {
        streaming = false;
        return false;
    }

    /* Setup DMA ring buffer */
    configure_stream_dma(mode);

    /* Send handshake + info header */
    sendResponse("STREAM_STARTED\n", fromWiFi);

    uint8_t info[8];
    info[0] = stream_chunk_samples & 0xFF;
    info[1] = (stream_chunk_samples >> 8) & 0xFF;
    info[2] = (uint8_t)stream_num_channels;
    info[3] = 0; /* reserved */
    info[4] = stream_actual_freq & 0xFF;
    info[5] = (stream_actual_freq >> 8) & 0xFF;
    info[6] = (stream_actual_freq >> 16) & 0xFF;
    info[7] = (stream_actual_freq >> 24) & 0xFF;

    #ifdef USE_CYGW_WIFI
    if (fromWiFi)
        wifi_transfer(info, 8);
    else
        usb_bulk_transfer_blocking(info, 8);
    #else
    {
        for (int i = 0; i < 8; i++)
            putchar_raw(info[i]);
        stdio_flush();
        sleep_ms(10);
    }
    #endif

    /* Signal Core 1 to start transmission */
    __dmb();
    stream_transmit_active = true;

    /* Enable PIO — sampling begins */
    pio_sm_set_enabled(stream_pio, stream_sm, true);

    return true;
}

void StopStream(void)
{
    streaming = false;
}

/* ------------------------------------------------------------------ */
/*  Core 0 — Compression loop                                         */
/* ------------------------------------------------------------------ */

void RunCompressionLoop(void)
{
    extern void processInput(void);

    stream_compress_init();   /* set bus priority for Core 0 during compression */

    uint32_t compress_read_count = 0;

    while (streaming)
    {
        /* Busy-poll until input ready, processing commands while waiting */
        if (compress_read_count >= dma_complete_count)
        {
            processInput();  /* check for stop command */
            tight_loop_contents();
            continue;
        }

        /* Overflow detection: DMA is about to overwrite uncompressed slots.
         * 2 slots are unsafe (chained DMA currently writing + next). */
        uint32_t pending = dma_complete_count - compress_read_count;
        if (pending >= STREAM_SLOTS - 2)
        {
            /* Skip ahead — can't compress slots that are being overwritten */
            compress_read_count = dma_complete_count - 1;
        }

        /* Copy input slot to local buffer (prevent partial overwrite during compression) */
        uint32_t input_slot = compress_read_count % STREAM_SLOTS;
        memcpy(compress_local_input, stream_input[input_slot], STREAM_INPUT_SLOT_SIZE);

        /* Compress into the output ring */
        uint32_t output_slot = compress_complete_count % STREAM_SLOTS;

        stream_output_size[output_slot] = stream_compress_chunk_mapped(
            compress_local_input,
            stream_channel_map,
            stream_num_channels,
            stream_capture_channels,
            stream_chunk_samples,
            stream_output[output_slot]
        );

        /* Make compressed data visible to Core 1 before incrementing counter */
        __dmb();
        compress_complete_count++;
        compress_read_count++;

        /* Check if compressed ring is full (Core 1 can't keep up) */
        if (compress_complete_count - transmit_count >= STREAM_SLOTS - 1)
        {
            overflow = true;
            streaming = false;
        }
    }

    stream_compress_deinit();

    /* Signal Core 1 that no more compressed data will be produced */
    __dmb();
    compress_done = true;
}

/* ------------------------------------------------------------------ */
/*  Core 1 — Non-blocking transmission                                 */
/* ------------------------------------------------------------------ */

#ifdef USE_CYGW_WIFI

/* Helper: send size + data via the appropriate transport.
 * Called on Core 1 — uses direct USB write (not the bulk transfer handoff). */
static void stream_send_chunk(const uint8_t* data, uint32_t size)
{
    uint16_t sz = (uint16_t)size;
    uint8_t size_bytes[2] = { sz & 0xFF, (sz >> 8) & 0xFF };

    if (stream_from_wifi)
    {
        wifi_transfer(size_bytes, 2);
        wifi_transfer((unsigned char*)data, sz);
    }
    else
    {
        usb_cdc_write_bulk_ext(size_bytes, 2);
        usb_cdc_write_bulk_ext(data, sz);
    }
}

static void stream_send_eof(void)
{
    uint8_t eof[2] = { 0x00, 0x00 };
    if (stream_from_wifi)
        wifi_transfer(eof, 2);
    else
        usb_cdc_write_bulk_ext(eof, 2);
}

void stream_process_transmit(void)
{
    /* Process available compressed chunks, but limit per call to avoid
     * starving tud_task() and other Core 1 responsibilities */
    uint32_t chunks_sent = 0;
    while (transmit_count < compress_complete_count && chunks_sent < 4)
    {
        __dmb();  /* acquire barrier — ensure we see Core 0's compressed data */

        uint32_t slot = transmit_count % STREAM_SLOTS;

        /* Copy to local buffer to prevent reading partially-overwritten data */
        uint32_t size = stream_output_size[slot];
        memcpy(transmit_local_buf, stream_output[slot], size);

        stream_send_chunk(transmit_local_buf, size);
        transmit_count++;
        chunks_sent++;
    }

    /* Check if compression is done and all data has been transmitted */
    if (compress_done && transmit_count >= compress_complete_count)
    {
        __dmb();

        /* Send EOF marker */
        stream_send_eof();

        /* Send termination status */
        if (overflow)
            sendResponse("STREAM_OVERFLOW\n", stream_from_wifi);
        else
            sendResponse("STREAM_DONE\n", stream_from_wifi);

        /* Signal Core 0 that transmission is complete */
        stream_transmit_active = false;
    }
}

#endif /* USE_CYGW_WIFI */

void CleanupStream(void)
{
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

bool IsStreamActive(void)
{
    return streaming;
}

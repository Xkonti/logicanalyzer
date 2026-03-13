#include "LogicAnalyzer_Board_Settings.h"
#include "Event_Machine.h"
#include "Shared_Buffers.h"
#include "LogicAnalyzer_WiFi.h"
#include "LogicAnalyzer_Structs.h"
#include "LogicAnalyzer_Stream.h"
#include "ws_protocol.h"
#include <stdio.h>
#include <string.h>
#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"
#include "pico/multicore.h"
#include "hardware/adc.h"
#include "hardware/gpio.h"
#include "hardware/flash.h"
#include "hardware/sync.h"
#include "lwip/pbuf.h"
#include "lwip/tcp.h"
#include "tusb.h"

EVENT_FROM_FRONTEND frontendEventBuffer;
EVENT_TO_USB usbSendEventBuffer;
WIFI_STATE_MACHINE currentState = VALIDATE_SETTINGS;
ip_addr_t address;
struct tcp_pcb* serverPcb;
struct tcp_pcb* clientPcb;

bool apConnected = false;
bool boot = false;
static bool usb_was_connected = false;

/* ---- WebSocket state ---- */
static char ws_handshake_buf[512];
static uint16_t ws_handshake_pos = 0;
static WS_FRAME_PARSER ws_parser;

#define LED_ON() cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 1)
#define LED_OFF() cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 0)

void getPowerStatus()
{
    EVENT_FROM_WIFI evtPower;
    evtPower.event = POWER_STATUS_DATA;
    evtPower.dataLength = sizeof(POWER_STATUS);
    POWER_STATUS* status = (POWER_STATUS*)&evtPower.data;
    
    adc_init();

    uint32_t oldInt = save_and_disable_interrupts();
    uint32_t old_pad = pads_bank0_hw->io[29];
    uint32_t old_ctrl = io_bank0_hw->io[29].ctrl;

    adc_gpio_init(29);
    adc_select_input(3);

    sleep_ms(100);

    const float conversion_factor = 3.3f / (1 << 12);
    status->vsysVoltage = adc_read() * conversion_factor * 3;

    gpio_init(29);

    pads_bank0_hw->io[29] = old_pad;
    io_bank0_hw->io[29].ctrl = old_ctrl;
    restore_interrupts(oldInt);

    status->vbusConnected = cyw43_arch_gpio_get(2);
    
    event_push(&wifiToFrontend, &evtPower);

}

void readSettings()
{
    wifiSettings = *((volatile WIFI_SETTINGS*)(FLASH_SETTINGS_ADDRESS));
}

void stopServer()
{
    if(serverPcb == NULL)
        return;

    tcp_close(serverPcb);
    serverPcb = NULL;
}

void killClient()
{
    if(clientPcb != NULL)
    {
        tcp_recv(clientPcb, NULL);
        tcp_err(clientPcb, NULL);
        tcp_close(clientPcb);
        clientPcb = NULL;
    }
    ws_handshake_pos = 0;
    currentState = WAITING_TCP_CLIENT;
}

void sendData(uint8_t* data, uint8_t len)
{
    if (!clientPcb) return;

    uint8_t header[4];
    uint8_t hlen = ws_build_frame_header(header, WS_OP_BINARY, len);

    while (clientPcb && tcp_sndbuf(clientPcb) < hlen + len)
    {
        cyw43_arch_poll();
        sleep_ms(1);
    }

    if (tcp_write(clientPcb, header, hlen, TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE) ||
        tcp_write(clientPcb, data, len, TCP_WRITE_FLAG_COPY))
    {
        killClient();
        EVENT_FROM_WIFI evt;
        evt.event = DISCONNECTED;
        event_push(&wifiToFrontend, &evt);
    }
}

void serverError(void *arg, err_t err)
{
    killClient();

    EVENT_FROM_WIFI evt;
    evt.event = DISCONNECTED;
    event_push(&wifiToFrontend, &evt);
}

err_t serverReceiveData(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err)
{
    EVENT_FROM_WIFI evt;

    /* Client disconnected */
    if (!p || p->tot_len == 0)
    {
        if (p)
            pbuf_free(p);

        killClient();
        evt.event = DISCONNECTED;
        event_push(&wifiToFrontend, &evt);
        return ERR_ABRT;
    }

    /* ---- WebSocket handshake accumulation ---- */
    if (currentState == WS_HANDSHAKE_PENDING)
    {
        uint16_t copy_len = p->tot_len;
        if (ws_handshake_pos + copy_len >= sizeof(ws_handshake_buf) - 1)
        {
            /* Request too large — abort */
            killClient();
            pbuf_free(p);
            return ERR_ABRT;
        }

        pbuf_copy_partial(p, ws_handshake_buf + ws_handshake_pos, copy_len, 0);
        ws_handshake_pos += copy_len;
        ws_handshake_buf[ws_handshake_pos] = '\0';

        tcp_recved(clientPcb, copy_len);
        pbuf_free(p);

        /* Check for complete HTTP request */
        if (strstr(ws_handshake_buf, "\r\n\r\n"))
        {
            char response[256];
            uint16_t resp_len = ws_build_handshake_response(
                ws_handshake_buf, response, sizeof(response));

            if (resp_len == 0)
            {
                killClient();
                return ERR_ABRT;
            }

            tcp_write(clientPcb, response, resp_len, TCP_WRITE_FLAG_COPY);
            tcp_output(clientPcb);
            tcp_nagle_disable(clientPcb);

            currentState = TCP_CLIENT_CONNECTED;

            evt.event = CONNECTED;
            event_push(&wifiToFrontend, &evt);
        }

        return ERR_OK;
    }

    /* ---- WebSocket frame parsing ---- */
    if (currentState == TCP_CLIENT_CONNECTED)
    {
        uint16_t offset = 0;
        uint16_t remaining = p->tot_len;
        uint8_t temp[128];

        while (remaining > 0)
        {
            uint16_t chunk = remaining > sizeof(temp) ? sizeof(temp) : remaining;
            pbuf_copy_partial(p, temp, chunk, offset);

            uint16_t pos = 0;
            while (pos < chunk)
            {
                bool frame_ready = false;
                pos += ws_parser_feed(&ws_parser, temp + pos, chunk - pos, &frame_ready);

                if (frame_ready)
                {
                    uint8_t opcode = ws_parser.opcode;

                    if (opcode == 0x08)  /* Close */
                    {
                        uint8_t close_frame[2];
                        ws_build_frame_header(close_frame, WS_OP_CLOSE, 0);
                        tcp_write(clientPcb, close_frame, 2, TCP_WRITE_FLAG_COPY);
                        tcp_output(clientPcb);
                        killClient();
                        evt.event = DISCONNECTED;
                        event_push(&wifiToFrontend, &evt);
                        pbuf_free(p);
                        return ERR_ABRT;
                    }
                    else if (opcode == 0x09)  /* Ping → Pong */
                    {
                        uint8_t pong_header[4];
                        uint8_t hlen = ws_build_frame_header(
                            pong_header, WS_OP_PONG, ws_parser.payload_len);
                        tcp_write(clientPcb, pong_header, hlen, TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE);
                        if (ws_parser.payload_len > 0)
                            tcp_write(clientPcb, ws_parser.payload,
                                      ws_parser.payload_len, TCP_WRITE_FLAG_COPY);
                        tcp_output(clientPcb);
                    }
                    else if (opcode == 0x01 || opcode == 0x02)  /* Text or Binary data */
                    {
                        /* Push unmasked payload as DATA_RECEIVED events */
                        uint16_t pay_left = ws_parser.payload_len;
                        uint16_t pay_pos = 0;
                        while (pay_left)
                        {
                            uint8_t copy = pay_left > 128 ? 128 : pay_left;
                            evt.event = DATA_RECEIVED;
                            evt.dataLength = copy;
                            memcpy(evt.data, ws_parser.payload + pay_pos, copy);
                            event_push(&wifiToFrontend, &evt);
                            pay_pos += copy;
                            pay_left -= copy;
                        }
                    }
                    /* else: ignore unknown opcodes (including continuation 0x00) */

                    ws_parser_init(&ws_parser);
                }
            }

            offset += chunk;
            remaining -= chunk;
        }

        tcp_recved(clientPcb, p->tot_len);
        pbuf_free(p);
        return ERR_OK;
    }

    /* Unexpected data in wrong state — discard */
    pbuf_free(p);
    return ERR_OK;
}

err_t acceptConnection(void *arg, struct tcp_pcb *client_pcb, err_t err)
{
    if (err != ERR_OK || client_pcb == NULL || clientPcb != NULL || currentState != WAITING_TCP_CLIENT)
        return ERR_VAL;

    clientPcb = client_pcb;

    tcp_recv(clientPcb, serverReceiveData);
    tcp_err(clientPcb, serverError);

    /* Begin WebSocket handshake. CONNECTED event is deferred until
     * the upgrade handshake completes successfully. */
    currentState = WS_HANDSHAKE_PENDING;
    ws_handshake_pos = 0;
    ws_parser_init(&ws_parser);

    return ERR_OK;
}

bool tryStartServer()
{
    serverPcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    err_t err = tcp_bind(serverPcb, &address, wifiSettings.port);

    if (err) 
        return false;

    serverPcb = tcp_listen_with_backlog(serverPcb, 1);

    if(!serverPcb)
        return false;

    tcp_accept(serverPcb, acceptConnection);
}

bool tryConnectAP()
{
    /* Try connecting in 2s chunks (5 × 2s = 10s total budget).
     * Between attempts, pump the USB stack and check if a USB
     * host opened the serial port — if so, abort early so the
     * main loop can switch to WIFI_DISABLED without a long stall. */
    for (int attempt = 0; attempt < 5; attempt++)
    {
        tud_task();
        if (tud_cdc_connected())
            return false;

        if (!cyw43_arch_wifi_connect_timeout_ms(
                (const char*)wifiSettings.apName,
                (const char*)wifiSettings.passwd,
                CYW43_AUTH_WPA2_AES_PSK, 2000))
        {
            ipaddr_aton((const char*)wifiSettings.ipAddress, &address);
            netif_set_ipaddr(netif_list, &address);

            if(wifiSettings.hostname[0] != '\0')
                netif_set_hostname(netif_list, (const char*)wifiSettings.hostname);

            apConnected = true;
            return true;
        }
    }

    return false;
}

void disconnectAP()
{
    if(!apConnected)
        return;
        
    cyw43_wifi_leave(&cyw43_state, 0);
    apConnected = false;

}

void processWifiMachine()
{
    if (currentState == WIFI_DISABLED)
        return;

    switch (currentState)
    {
        case VALIDATE_SETTINGS:
            {
                if(!boot)
                    readSettings();

                boot = true;

                uint16_t checksum = 0;

                for(int buc = 0; buc < 33; buc++)
                    checksum += wifiSettings.apName[buc];

                for(int buc = 0; buc < 64; buc++)
                    checksum += wifiSettings.passwd[buc];

                for(int buc = 0; buc < 16; buc++)
                    checksum += wifiSettings.ipAddress[buc];

                checksum += wifiSettings.port;

                for(int buc = 0; buc < 33; buc++)
                    checksum += wifiSettings.hostname[buc];

                checksum += 0x0f0f;

                if(wifiSettings.checksum == checksum)
                    currentState = CONNECTING_AP;
                else
                    currentState = WAITING_SETTINGS;
            }
            break;

        case CONNECTING_AP:
            if(tryConnectAP())
                currentState = STARTING_TCP_SERVER;
            break;
        case STARTING_TCP_SERVER:
            if(tryStartServer())
                currentState = WAITING_TCP_CLIENT;
            break;
        default:
            break;
    }
}

/* ---- Direct WiFi send from Core 1 (bypasses event queue) ---- */

void wifi_send_direct(const uint8_t* data, uint16_t len)
{
    if (!clientPcb) return;

    uint8_t header[4];
    uint8_t hlen = ws_build_frame_header(header, WS_OP_BINARY, len);

    while (clientPcb && tcp_sndbuf(clientPcb) < (uint16_t)(hlen + len))
    {
        cyw43_arch_poll();
        sleep_ms(1);
    }
    if (!clientPcb) return;

    tcp_write(clientPcb, header, hlen, TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE);
    tcp_write(clientPcb, data, len, TCP_WRITE_FLAG_COPY);
    tcp_output(clientPcb);
}

void wifi_send_direct_2(const uint8_t* d1, uint16_t l1,
                        const uint8_t* d2, uint16_t l2)
{
    if (!clientPcb) return;

    uint16_t total = l1 + l2;
    uint8_t header[4];
    uint8_t hlen = ws_build_frame_header(header, WS_OP_BINARY, total);

    while (clientPcb && tcp_sndbuf(clientPcb) < (uint16_t)(hlen + total))
    {
        cyw43_arch_poll();
        sleep_ms(1);
    }
    if (!clientPcb) return;

    tcp_write(clientPcb, header, hlen, TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE);
    tcp_write(clientPcb, d1, l1, TCP_WRITE_FLAG_COPY | TCP_WRITE_FLAG_MORE);
    tcp_write(clientPcb, d2, l2, TCP_WRITE_FLAG_COPY);
    tcp_output(clientPcb);
}

void frontendEvent(void* event)
{
    EVENT_FROM_FRONTEND* evt = (EVENT_FROM_FRONTEND*)event;
    switch(evt->event)
    {
        case LED_ON:
            LED_ON();
            break;

        case LED_OFF:
            LED_OFF();
            break;
        case CONFIG_RECEIVED:

            killClient();
            stopServer();
            disconnectAP();
            currentState = usb_was_connected ? WIFI_DISABLED : VALIDATE_SETTINGS;
            break;

        case SEND_DATA:
            sendData(evt->data, evt->dataLength);
            break;
        
        case GET_POWER_STATUS:
            getPowerStatus();
            break;
    }
}

/* ------------------------------------------------------------------ */
/*  USB I/O functions — all run on Core 1                              */
/* ------------------------------------------------------------------ */

/* Read available USB data and push to Core 0 via usbToFrontend queue */
static void usb_process_input(void)
{
    /* Check connection state changes */
    bool connected = tud_cdc_connected();
    if (connected && !usb_was_connected)
    {
        EVENT_FROM_USB evt;
        evt.event = USB_CONNECTED;
        evt.dataLength = 0;
        event_push(&usbToFrontend, &evt);

        /* Disable WiFi — USB takes priority */
        if (currentState == TCP_CLIENT_CONNECTED ||
            currentState == WS_HANDSHAKE_PENDING)
        {
            EVENT_FROM_WIFI wifiEvt;
            wifiEvt.event = DISCONNECTED;
            event_push(&wifiToFrontend, &wifiEvt);
        }
        killClient();
        stopServer();
        disconnectAP();
        currentState = WIFI_DISABLED;
    }
    else if (!connected && usb_was_connected)
    {
        EVENT_FROM_USB evt;
        evt.event = USB_DISCONNECTED;
        evt.dataLength = 0;
        event_push(&usbToFrontend, &evt);

        /* Re-enable WiFi */
        currentState = VALIDATE_SETTINGS;
    }
    usb_was_connected = connected;

    /* Read available bytes and push to Core 0 */
    if (!tud_cdc_available())
        return;

    EVENT_FROM_USB evt;
    evt.event = USB_DATA_RECEIVED;
    evt.dataLength = (uint8_t)tud_cdc_read(evt.data, sizeof(evt.data));
    if (evt.dataLength > 0)
        event_push(&usbToFrontend, &evt);
}

/* Process queued USB send events from Core 0 */
static void usbSendEvent(void* event)
{
    EVENT_TO_USB* evt = (EVENT_TO_USB*)event;
    if (evt->event == USB_SEND_DATA)
    {
        uint32_t left = evt->dataLength;
        uint32_t pos = 0;
        while (left > 0)
        {
            uint32_t avail = tud_cdc_write_available();
            if (avail > left) avail = left;
            if (avail)
            {
                uint32_t written = tud_cdc_write(evt->data + pos, avail);
                pos += written;
                left -= written;
            }
            tud_task();
            tud_cdc_write_flush();
            if (!tud_cdc_connected())
                break;
        }
    }
}

/* Efficient bulk write for large data transfers.
 * Used internally for capture data, and externally by stream_process_transmit. */
void usb_cdc_write_bulk_ext(const uint8_t* data, uint32_t len)
{
    uint32_t left = len;
    uint32_t pos = 0;
    while (left > 0)
    {
        uint32_t avail = tud_cdc_write_available();
        if (avail > left) avail = left;
        if (avail)
        {
            uint32_t written = tud_cdc_write(data + pos, avail);
            pos += written;
            left -= written;
        }
        tud_task();
        tud_cdc_write_flush();
        if (!tud_cdc_connected())
            break;
    }
}

/* Send pending bulk transfer (capture data) */
static void usb_send_bulk_transfer(void)
{
    usb_cdc_write_bulk_ext(usb_bulk.data, usb_bulk.length);
    __dmb();
    usb_bulk.pending = false;  /* prevent re-entry before Core 0 wakes */
    __dmb();
    usb_bulk.complete = true;
}

void runWiFiCore()
{
    /* WiFi event queue init */
    event_machine_init(&frontendToWifi, frontendEvent, sizeof(EVENT_FROM_FRONTEND), 8);

    /* USB send event queue init */
    event_machine_init(&frontendToUsb, usbSendEvent, sizeof(EVENT_TO_USB), 8);

    multicore_lockout_victim_init();
    cyw43_arch_init();
    cyw43_arch_enable_sta_mode();

    EVENT_FROM_WIFI evtRdy;
    evtRdy.event = CYW_READY;
    event_push(&wifiToFrontend, &evtRdy);

    while(true)
    {
        /* USB hardware processing — always */
        tud_task();

        /* USB input: read bytes, push to Core 0 */
        usb_process_input();

        /* USB output: send queued responses */
        event_process_queue(&frontendToUsb, &usbSendEventBuffer, 8);

        /* USB bulk: send capture data if pending */
        if (usb_bulk.pending)
            usb_send_bulk_transfer();

        /* Streaming transmission (when active) */
        if (stream_transmit_active)
            stream_process_transmit();

        /* WiFi processing */
        event_process_queue(&frontendToWifi, &frontendEventBuffer, 8);
        processWifiMachine();
        if(currentState > CONNECTING_AP)
            cyw43_arch_poll();
    }
}
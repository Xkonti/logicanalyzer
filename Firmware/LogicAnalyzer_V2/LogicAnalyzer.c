#include "LogicAnalyzer_Board_Settings.h"

#include <stdio.h>
#include <string.h>
#include "pico/stdlib.h"
#include "hardware/dma.h"
#include "hardware/pio.h"
#include "hardware/clocks.h"
#include "hardware/flash.h"
#include "hardware/vreg.h"
#include "pico/multicore.h"
#include "LogicAnalyzer.pio.h"
#include "LogicAnalyzer_Structs.h"
#include "LogicAnalyzer_Capture.h"
#include "hardware/structs/syscfg.h"
#include "hardware/structs/systick.h"
#include "tusb.h"
#include "pico/unique_id.h"
#include "pico/bootrom.h"
#include "LogicAnalyzer_Stream.h"
#include "hardware/sync.h"

#ifdef WS2812_LED
    #include "LogicAnalyzer_W2812.h"
#endif


#include "pico/cyw43_arch.h"
#include "Event_Machine.h"
#include "Shared_Buffers.h"
#include "LogicAnalyzer_WiFi.h"

bool cywReady = false;
bool skipWiFiData = false;
bool skipUsbData = false;
bool hadUsbData = false;
bool hadWiFiData = false;
bool dataFromWiFi = false;
EVENT_FROM_WIFI wifiEventBuffer;
WIFI_SETTINGS_REQUEST* wReq;

#define MULTICORE_LOCKOUT_TIMEOUT (uint64_t)10 * 365 * 24 * 60 * 60 * 1000 * 1000

#if defined (GPIO_LED)
    #define INIT_LED() {\
                            gpio_init(LED_IO); \
                            gpio_set_dir(LED_IO, GPIO_OUT); \
                        }
    #define LED_ON() gpio_put(LED_IO, 1)
    #define LED_OFF() gpio_put(LED_IO, 0)
#elif defined (CYGW_LED)

    #define INIT_LED() { }

    #define LED_ON() {\
    EVENT_FROM_FRONTEND lonEvt;\
    lonEvt.event = LED_ON;\
    event_push(&frontendToWifi, &lonEvt);\
    }

    #define LED_OFF() {\
    EVENT_FROM_FRONTEND loffEvt;\
    loffEvt.event = LED_OFF;\
    event_push(&frontendToWifi, &loffEvt);\
    }

#elif defined (WS2812_LED)
    #define INIT_LED() init_rgb()
    #define LED_ON() send_rgb(0,32,0)
    #define LED_OFF() send_rgb(0,0,32)
#elif defined (NO_LED)
    #define INIT_LED() { }
    #define LED_ON() { }
    #define LED_OFF() { }
#endif

//Buffer used to store received data (160 bytes to fit WIFI_SETTINGS_REQUEST = 148 + framing)
uint8_t messageBuffer[160];
//Position in the buffer
uint16_t bufferPos = 0;
//Capture status
bool capturing = false;
//Streaming status
bool streaming_active = false;

bool blink = false;
uint32_t blinkCount = 0;

//Capture request pointer
CAPTURE_REQUEST* req;

/// @brief Stores a new WiFi configuration in the flash of the device
/// @param settings Settings to store
void storeSettings(WIFI_SETTINGS* settings)
{
    uint8_t buffer[FLASH_PAGE_SIZE];
    memcpy(buffer, settings, sizeof(WIFI_SETTINGS));
    //multicore_lockout_start_blocking ();
    multicore_lockout_start_timeout_us(MULTICORE_LOCKOUT_TIMEOUT);

    uint32_t intStatus = save_and_disable_interrupts();

    flash_range_erase(FLASH_SETTINGS_OFFSET, FLASH_SECTOR_SIZE);

    for(int buc = 0; buc < 1000; buc++)
    {
        asm("nop");
        asm("nop");
        asm("nop");
        asm("nop");
        asm("nop");
    }

    flash_range_program(FLASH_SETTINGS_OFFSET, buffer, FLASH_PAGE_SIZE);

    for(int buc = 0; buc < 1000; buc++)
    {
        asm("nop");
        asm("nop");
        asm("nop");
        asm("nop");
        asm("nop");
    }

    restore_interrupts(intStatus);

    bool unlocked = false;

    do {
        unlocked = multicore_lockout_end_timeout_us(MULTICORE_LOCKOUT_TIMEOUT);
    } while(!unlocked);

    sleep_ms(500);

}

/// @brief Sends a response message to the host application in string mode
/// @param response The message to be sent (null terminated)
/// @param toWiFi If true the message is sent to a WiFi endpoint, else to the USB connection through STDIO
void sendResponse(const char* response, bool toWiFi)
{
    if(toWiFi)
    {
        EVENT_FROM_FRONTEND evt;
        evt.event = SEND_DATA;
        evt.dataLength = strlen(response);
        memset(evt.data, 0, 32);
        memcpy(evt.data, response, evt.dataLength);
        event_push(&frontendToWifi, &evt);
    }
    else
    {
        EVENT_TO_USB evt;
        evt.event = USB_SEND_DATA;
        uint8_t len = strlen(response);
        if (len > sizeof(evt.data))
            len = sizeof(evt.data);
        evt.dataLength = len;
        memcpy(evt.data, response, len);
        event_push(&frontendToUsb, &evt);
    }
}

/// @brief Transfer a buffer of data through USB via Core 1 bulk transfer mechanism.
/// Core 0 sets up the descriptor, Core 1 sends the data. Blocks until complete.
/// @param data Buffer of data to transfer
/// @param len Length of the buffer
void usb_bulk_transfer_blocking(unsigned char* data, int len)
{
    usb_bulk.data = data;
    usb_bulk.length = len;
    usb_bulk.complete = false;
    __dmb();
    usb_bulk.pending = true;

    /* Wait for Core 1 to complete the transfer */
    while (!usb_bulk.complete)
        tight_loop_contents();
    __dmb();  /* ensure Core 1's writes are visible before we set up next transfer */
}

/// @brief Transfer a buffer of data through WiFi
/// @param data Buffer of data to transfer
/// @param len Length of the buffer
void wifi_transfer(unsigned char* data, int len)
{
    EVENT_FROM_FRONTEND evt;
    evt.event = SEND_DATA;

    int pos = 0;
    int filledData;
    while(pos < len)
    {
        filledData = 0;
        while(pos < len && filledData < 32)
        {
            evt.data[filledData] = data[pos];
            pos++;
            filledData++;
        }

        evt.dataLength = filledData;
        event_push(&frontendToWifi, &evt);
    }
}

/// @brief Processes data received from the host application
/// @param data The received data
/// @param length Length of the data
/// @param fromWiFi If true the message comes from a WiFi connection
void processData(uint8_t* data, uint length, bool fromWiFi)
{
    for(uint pos = 0; pos < length; pos++)
    {
        //Store char in buffer and increment position
        messageBuffer[bufferPos++] = data[pos];
        
        //If we have stored the first byte and it is not 0x55 restart reception
        if(bufferPos == 1 && messageBuffer[0] != 0x55)
            bufferPos = 0;
        else if(bufferPos == 2 && messageBuffer[1] != 0xAA) //If we have stored the second byte and it is not 0xAA restart reception
            bufferPos = 0;
        else if(bufferPos >= sizeof(messageBuffer)) //Have we overflowed the buffer? then inform to the host and restart reception
        {
            sendResponse("ERR_MSG_OVERFLOW\n", fromWiFi);
            bufferPos = 0;
        }
        else if(bufferPos > 2) //Try to parse the data
        {
            if(messageBuffer[bufferPos - 2] == 0xAA && messageBuffer[bufferPos - 1] == 0x55) //Do we have the stop condition?
            {

                //Yes, unescape the buffer,
                int dest = 0;

                for(int src = 0; src < bufferPos; src++)
                {
                    if(messageBuffer[src] == 0xF0)
                    {
                        messageBuffer[dest] = messageBuffer[src + 1] ^ 0xF0;
                        src++;
                    }
                    else
                        messageBuffer[dest] = messageBuffer[src];

                    dest++;
                }

                switch(messageBuffer[2]) //Check the command we received
                {

                    case 0: //ID request

                        if(bufferPos != 5) //Malformed message?
                            sendResponse("ERR_UNKNOWN_MSG\n", fromWiFi);
                        else
                        {
                            sendResponse("LOGIC_ANALYZER_"BOARD_NAME"_"FIRMWARE_VERSION"\n", fromWiFi);

                            char msg[64];
                            
                            sprintf(msg, "FREQ:%d\n", MAX_FREQ);
                            sendResponse(msg, fromWiFi);
                            sprintf(msg, "BLASTFREQ:%d\n", MAX_BLAST_FREQ);
                            sendResponse(msg, fromWiFi);
                            sprintf(msg, "BUFFER:%d\n", CAPTURE_BUFFER_SIZE);
                            sendResponse(msg, fromWiFi);
                            sprintf(msg, "CHANNELS:%d\n", MAX_CHANNELS);
                            sendResponse(msg, fromWiFi);
                        }
                        break;

                    case 1: //Capture request

                        if(streaming_active)
                        {
                            sendResponse("ERR_BUSY\n", fromWiFi);
                            break;
                        }

                        req = (CAPTURE_REQUEST*)&messageBuffer[3]; //Get the request pointer

                        bool started = false;

                        #ifdef SUPPORTS_COMPLEX_TRIGGER

                            if(req->triggerType == 1) //Start complex trigger capture
                                started = StartCaptureComplex(req->frequency, req->preSamples, req->postSamples, (uint8_t*)&req->channels, req->channelCount, req->trigger, req->count, req->triggerValue, req->captureMode);
                            else if(req->triggerType == 2) //start fast trigger capture
                                started = StartCaptureFast(req->frequency, req->preSamples, req->postSamples, (uint8_t*)&req->channels, req->channelCount, req->trigger, req->count, req->triggerValue, req->captureMode);
                            else if(req->triggerType == 3)
                                started = StartCaptureBlast(req->frequency, req->postSamples, (uint8_t*)&req->channels, req->channelCount, req->trigger, req->inverted, req->captureMode);
                            else //Start simple trigger capture
                                started = StartCaptureSimple(req->frequency, req->preSamples, req->postSamples, req->loopCount, req->measure, (uint8_t*)&req->channels, req->channelCount, req->trigger, req->inverted, req->captureMode);
                        
                        #else

                            if(req->triggerType == 1 || req->triggerType == 2)
                            {
                                sendResponse("CAPTURE_ERROR\n", fromWiFi);
                                break;
                            }
                            else if(req->triggerType == 3)
                                started = StartCaptureBlast(req->frequency, req->postSamples, (uint8_t*)&req->channels, req->channelCount, req->trigger, req->inverted, req->captureMode);
                            else //Start simple trigger capture
                                started = StartCaptureSimple(req->frequency, req->preSamples, req->postSamples, req->loopCount, req->measure, (uint8_t*)&req->channels, req->channelCount, req->trigger, req->inverted, req->captureMode);
                        
                        #endif

                        if(started) //If started successfully inform to the host
                        {
                            sendResponse("CAPTURE_STARTED\n", fromWiFi);
                            capturing = true;
                        }
                        else
                            sendResponse("CAPTURE_ERROR\n", fromWiFi); //Else notify the error

                        break;
                    
                    case 2: //Update WiFi settings

                        wReq = (WIFI_SETTINGS_REQUEST*)&messageBuffer[3];
                        WIFI_SETTINGS settings;
                        settings.checksum = 0;
                        memcpy(settings.apName, wReq->apName, 33);
                        memcpy(settings.passwd, wReq->passwd, 64);
                        memcpy(settings.ipAddress, wReq->ipAddress, 16);
                        settings.port = wReq->port;
                        memcpy(settings.hostname, wReq->hostname, 33);

                        for(int buc = 0; buc < 33; buc++)
                            settings.checksum += settings.apName[buc];

                        for(int buc = 0; buc < 64; buc++)
                            settings.checksum += settings.passwd[buc];

                        for(int buc = 0; buc < 16; buc++)
                            settings.checksum += settings.ipAddress[buc];

                        settings.checksum += settings.port;

                        for(int buc = 0; buc < 33; buc++)
                            settings.checksum += settings.hostname[buc];

                        settings.checksum += 0x0f0f;

                        storeSettings(&settings);

                        wifiSettings = settings;

                        EVENT_FROM_FRONTEND evt;
                        evt.event = CONFIG_RECEIVED;
                        event_push(&frontendToWifi, &evt);

                        sendResponse("SETTINGS_SAVED\n", fromWiFi);

                        break;

                    case 3: //Read power status

                        if(!fromWiFi)
                            sendResponse("ERR_UNSUPPORTED\n", fromWiFi);
                        else
                        {
                            EVENT_FROM_FRONTEND powerEvent;
                            powerEvent.event = GET_POWER_STATUS;
                            event_push(&frontendToWifi, &powerEvent);
                        }

                        break;

                    case 4:

                        sendResponse("RESTARTING_BOOTLOADER\n", fromWiFi);
                        sleep_ms(1000);
                        reset_usb_boot(0, 0);
                        break;

                    case 5:

                        blink = true;
                        blinkCount = 0;
                        sendResponse("BLINKON\n", fromWiFi);
                        break;

                    case 6:

                        blink = false;
                        blinkCount = 0;
                        sendResponse("BLINKOFF\n", fromWiFi);
                        LED_ON();
                        break;

                    case 10: //Start stream
                    {
                        if(capturing || streaming_active)
                        {
                            sendResponse("ERR_BUSY\n", fromWiFi);
                            break;
                        }

                        STREAM_REQUEST* streamReq = (STREAM_REQUEST*)&messageBuffer[3];

                        if(streamReq->channelCount < 1 || streamReq->channelCount > MAX_CHANNELS)
                        {
                            sendResponse("ERR_PARAMS\n", fromWiFi);
                            break;
                        }

                        if(!StartStream(streamReq, fromWiFi))
                        {
                            sendResponse("STREAM_ERROR\n", fromWiFi);
                            break;
                        }

                        streaming_active = true;
                        break;
                    }

                    case 11: //Stop stream
                        StopStream();
                        break;

                    default:

                        sendResponse("ERR_UNKNOWN_MSG\n", fromWiFi); //Unknown message
                        break;

                }

                bufferPos = 0; //Reset buffer position
            }
        }

    }

    //PROTOCOL EXPLAINED:
    //
    //The protocol is very basic, it receives binary frames and sends strings terminated by a carriage return.
    //
    //Each binary frame has a start and an end condition, being these two secuences of two bytes:
    // start condition: 0x55 0xAA
    // stop condition: 0xAA 0x55
    //
    //This kind of framing can cause problems if the packets contain the frame condition bytes, there needs to be implemented
    //a scape character to avoid this.The char 0xF0 is used as escape character. Escaping is done by XOR'ing the scape character 
    //with the scaped char. For example, if we need to send 0xAA we would send { 0xF0, 0x5A }, which is 0xAA XOR 0xF0 = 0x5A. 
    //In case of sending the scape char we would send { 0xF0, 0x00 }.
    //
    //Inside each frame we have a command byte and additional data. Based on the command a binary struct will be deserialized
    //from the buffer. Right now the protocol has only two commands: ID request and capture request. ID request does not
    //have any data, but the capture request has a CAPTURE_REQUEST struct as data.
}

/// @brief Send a string response with the power status
/// @param status Status received from the WiFi core
void sendPowerStatus(POWER_STATUS* status)
{
    char buffer[32];
    memset(buffer, 0, 32);
    int len = sprintf(buffer, "%.2f", status->vsysVoltage);
    buffer[len++] = '_';
    buffer[len++] = status->vbusConnected ? '1' : '0';
    buffer[len] = '\n';
    sendResponse(buffer, true);
}

/// @brief Callback for the WiFi event queue
/// @param event Received event
void wifiEvent(void* event)
{
    EVENT_FROM_WIFI* wEvent = (EVENT_FROM_WIFI*)event;

    switch(wEvent->event)
    {
        case CYW_READY:
            cywReady = true;
            break;
        case CONNECTED:
            dataFromWiFi = true;
            break;
        case DISCONNECTED:
            dataFromWiFi = false;
            break;
        case DATA_RECEIVED:
            if(skipWiFiData)
                hadWiFiData = true;
            else
                processData(wEvent->data, wEvent->dataLength, true);
            break;
        case POWER_STATUS_DATA:
            {
                POWER_STATUS status;
                memcpy(&status, wEvent->data, sizeof(POWER_STATUS));
                sendPowerStatus(&status);
            }
            break;
    }
}

/// @brief Receives and processes input from the host application (when connected through WiFi)
/// @param skipProcessing If true the received data is not processed (used for cleanup)
/// @return True if anything is received, false if not
bool processWiFiInput(bool skipProcessing)
{
    if(skipProcessing)
    {
        skipWiFiData = true;
    }

    event_process_queue(&wifiToFrontend, &wifiEventBuffer, 8);

    skipWiFiData = false;

    return false;
}

/* USB event buffer for Core 0 processing */
EVENT_FROM_USB usbInputEventBuffer;

/* Track USB connection state from events */
static bool usbConnected = false;

/// @brief Callback for the USB input event queue
/// @param event Received event
void usbInputEvent(void* event)
{
    EVENT_FROM_USB* uEvent = (EVENT_FROM_USB*)event;

    switch(uEvent->event)
    {
        case USB_CONNECTED:
            usbConnected = true;
            bufferPos = 0;
            break;
        case USB_DISCONNECTED:
            usbConnected = false;
            break;
        case USB_DATA_RECEIVED:
            if(!skipUsbData)
                processData((uint8_t*)uEvent->data, uEvent->dataLength, false);
            else
                hadUsbData = true;
            break;
    }
}

/// @brief Process input data from the host application if it is available
void processInput()
{
    event_process_queue(&usbToFrontend, &usbInputEventBuffer, 8);
    processWiFiInput(false);
}

/// @brief Processes input data from the host application to check if there is any cancel capture request
/// @return True if there was input data
bool processCancel()
{
    skipUsbData = true;
    hadUsbData = false;
    event_process_queue(&usbToFrontend, &usbInputEventBuffer, 8);
    skipUsbData = false;

    skipWiFiData = true;
    hadWiFiData = false;
    event_process_queue(&wifiToFrontend, &wifiEventBuffer, 8);
    skipWiFiData = false;

    return hadUsbData || hadWiFiData;
}

/// @brief Main app loop
/// @return Exit code
int main()
{
    #if defined (TURBO_MODE)

        vreg_disable_voltage_limit();
        vreg_set_voltage(VREG_VOLTAGE_1_30);
        sleep_ms(100);
        
        //Overclock Powerrrr!
        set_sys_clock_khz(400000, true);
    
    #else

        set_sys_clock_khz(200000, true);

    #endif

    //Enable systick using CPU clock
    systick_hw->csr = 0x05;

    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);

    uint16_t delay = 0;

    for(int buc = 0; buc < PICO_UNIQUE_BOARD_ID_SIZE_BYTES; buc++)
        delay += id.id[buc];

    delay = (delay & 0x3ff) + ((delay & 0xFC00) >> 6);

    sleep_ms(delay);

    //Initialize USB stdio
    stdio_init_all();

    /* Init event queues for Core 0 side */
    event_machine_init(&wifiToFrontend, wifiEvent, sizeof(EVENT_FROM_WIFI), 8);
    event_machine_init(&usbToFrontend, usbInputEvent, sizeof(EVENT_FROM_USB), 8);

    /* Poll tud_task() on Core 0 until USB is enumerated.
     * Core 1 will take over exclusive TinyUSB access after launch. */
    {
        absolute_time_t deadline = make_timeout_time_ms(2000);
        while (!time_reached(deadline))
            tud_task();
    }

    /* Launch Core 1 — it takes over all USB I/O */
    multicore_launch_core1(runWiFiCore);
    while(!cywReady)
        event_process_queue(&wifiToFrontend, &wifiEventBuffer, 1);

    //Clear message buffer
    memset(messageBuffer, 0, sizeof(messageBuffer));

    //Configure led
    INIT_LED();
    LED_ON();

    while(1)
    {
        //Are we capturing?
        if(capturing)
        {
            //Is the PIO units still working?
            if(!IsCapturing())
            {
                //Retrieve the capture buffer and get info about it.
                uint32_t length, first;
                CHANNEL_MODE mode;
                uint8_t* buffer = GetBuffer(&length, &first, &mode);

                uint8_t stampsLength;
                volatile uint32_t* timestamps = GetTimestamps(&stampsLength);

                //Send the data to the host
                uint8_t* lengthPointer = (uint8_t*)&length;

                if(dataFromWiFi)
                {
                    sleep_ms(2000);
                    wifi_transfer(lengthPointer, 4);
                }
                else
                {
                    sleep_ms(100);
                    usb_bulk_transfer_blocking(lengthPointer, 4);
                }

                sleep_ms(100);

                //Tanslate sample numbers to byte indexes, makes easier to send data
                switch(mode)
                {
                    case MODE_16_CHANNEL:
                        length *= 2;
                        first *= 2;
                        break;
                    case MODE_24_CHANNEL:
                        length *= 4;
                        first *= 4;
                        break;
                }

                //Send the samples
                if(dataFromWiFi)
                {
                    if(first + length > CAPTURE_BUFFER_SIZE)
                    {
                        wifi_transfer(buffer + first, CAPTURE_BUFFER_SIZE - first);
                        wifi_transfer(buffer, (first + length) - CAPTURE_BUFFER_SIZE);
                    }
                    else
                        wifi_transfer(buffer + first, length);

                    wifi_transfer(&stampsLength, 1);

                    if(stampsLength > 1)
                        wifi_transfer((unsigned char*)timestamps, stampsLength * 4);
                }
                else
                {
                    if(first + length > CAPTURE_BUFFER_SIZE)
                    {
                        usb_bulk_transfer_blocking(buffer + first, CAPTURE_BUFFER_SIZE - first);
                        usb_bulk_transfer_blocking(buffer, (first + length) - CAPTURE_BUFFER_SIZE);
                    }
                    else
                        usb_bulk_transfer_blocking(buffer + first, length);

                    usb_bulk_transfer_blocking(&stampsLength, 1);

                    if(stampsLength > 1)
                        usb_bulk_transfer_blocking((unsigned char*)timestamps, stampsLength * 4);
                }

                //Done!
                capturing = false;
            }
            else
            {
                LED_OFF();
                sleep_ms(1000);

                //Check for cancel request
                if(processCancel())
                {
                    //Stop capture
                    StopCapture();
                    capturing = false;
                    LED_ON();
                }
                //Detect USB disconnect during capture wait (via Core 1 events)
                else if(!dataFromWiFi && !usbConnected)
                {
                    StopCapture();
                    capturing = false;
                    bufferPos = 0;
                    LED_ON();
                }
                else
                {
                    LED_ON();
                    #ifdef SUPPORTS_COMPLEX_TRIGGER
                    check_fast_interrupt();
                    #endif
                    sleep_ms(1000);
                }
            }
        }
        else if(streaming_active)
        {
            /* Core 0: compress DMA data into compressed ring buffer.
             * Core 1 transmits from the compressed ring in parallel. */
            RunCompressionLoop();

            /* Wait for Core 1 to finish draining + sending EOF */
            while (stream_transmit_active)
            {
                /* Keep processing input events so stop commands arrive */
                processInput();
                tight_loop_contents();
            }
            CleanupStream();
            streaming_active = false;
        }
        else
        {
            if(blink)
            {
                if(blinkCount++ == 200000)
                {
                    LED_OFF();
                }
                else if(blinkCount == 400000)
                {
                    LED_ON();
                    blinkCount = 0;
                }
            }

            processInput(); //Read incomming data
        }
    }

    return 0;
}
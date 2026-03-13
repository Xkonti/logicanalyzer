
#ifndef __ANALYZER_STRUCTS__
    #define __ANALYZER_STRUCTS__

    #include "pico/stdlib.h"


    //Capture request issued by the host computer
    typedef struct _CAPTURE_REQUEST
    {
        //Indicates tthe trigger type: 0 = edge, 1 = pattern (complex), 2 = pattern (fast)
        uint8_t triggerType;
        //Trigger channel (or base channel for pattern trigger)
        uint8_t trigger;
        
        //Union of the trigger characteristics (inverted or pin count)
        union
        {
            uint8_t inverted;
            uint8_t count;
        };

        //Trigger value of the pattern trigger
        uint16_t triggerValue;
        //Channels to capture
        uint8_t channels[32];
        //Channel count
        uint8_t channelCount;
        //Sampling frequency
        uint32_t frequency;
        //Number of samples stored before the trigger
        uint32_t preSamples;
        //Number of samples stored after the trigger
        uint32_t postSamples;
        //Number of capture loops
        uint16_t loopCount;
        //Measure burst times
        uint8_t measure;
        //Capture mode (0 = 8 channel, 1 = 16 channel, 2 = 24 channel)
        uint8_t captureMode;

    }CAPTURE_REQUEST;

    //Stream request issued by the host computer for real-time compressed streaming
    typedef struct _STREAM_REQUEST
    {
        //Channels to capture
        uint8_t channels[32];
        //Number of channels (1-24)
        uint8_t channelCount;
        //Chunk size in samples (32-1024, must be multiple of 32)
        uint16_t chunkSamples;
        //Sampling frequency in Hz
        uint32_t frequency;
    } STREAM_REQUEST;

    typedef struct _WIFI_SETTINGS
        {
            char apName[33];
            char passwd[64];
            char ipAddress[16];
            uint16_t port;
            char hostname[33];
            uint16_t checksum;

        } WIFI_SETTINGS;

        typedef struct _WIFI_SETTINGS_REQUEST
        {
            char apName[33];
            char passwd[64];
            char ipAddress[16];
            uint16_t port;
            char hostname[33];

        } WIFI_SETTINGS_REQUEST;

        typedef enum
        {
            CYW_READY,
            CONNECTED,
            DISCONNECTED,
            DATA_RECEIVED,
            POWER_STATUS_DATA

        } WIFI_EVENT;

        typedef enum
        {
            LED_ON,
            LED_OFF,
            CONFIG_RECEIVED,
            SEND_DATA,
            GET_POWER_STATUS

        } FRONTEND_EVENT;

        typedef struct _EVENT_FROM_WIFI
        {
            WIFI_EVENT event;
            char data[128];
            uint8_t dataLength;

        } EVENT_FROM_WIFI;

        typedef struct _EVENT_FROM_FRONTEND
        {
            FRONTEND_EVENT event;
            char data[32];
            uint8_t dataLength;

        } EVENT_FROM_FRONTEND;

        typedef struct _POWER_STATUS
        {
            float vsysVoltage;
            bool vbusConnected;

        } POWER_STATUS;

        /* ---- USB event types (Core 1 → Core 0) ---- */

        typedef enum
        {
            USB_DATA_RECEIVED,
            USB_CONNECTED,
            USB_DISCONNECTED

        } USB_EVENT;

        typedef struct _EVENT_FROM_USB
        {
            USB_EVENT event;
            char data[128];
            uint8_t dataLength;

        } EVENT_FROM_USB;

        /* ---- USB send types (Core 0 → Core 1) ---- */

        typedef enum
        {
            USB_SEND_DATA

        } FRONTEND_USB_EVENT;

        typedef struct _EVENT_TO_USB
        {
            FRONTEND_USB_EVENT event;
            char data[48];
            uint8_t dataLength;

        } EVENT_TO_USB;

        /* ---- Bulk transfer descriptor (Core 0 → Core 1, for capture data) ---- */

        typedef struct _USB_BULK_TRANSFER
        {
            const uint8_t* data;
            uint32_t length;
            volatile bool pending;
            volatile bool complete;

    } USB_BULK_TRANSFER;

#endif
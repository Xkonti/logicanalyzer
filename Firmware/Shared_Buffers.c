#include "Shared_Buffers.h"
#include "LogicAnalyzer_Structs.h"
#include "Event_Machine.h"

volatile WIFI_SETTINGS wifiSettings;
EVENT_MACHINE wifiToFrontend;
EVENT_MACHINE frontendToWifi;
EVENT_MACHINE usbToFrontend;
EVENT_MACHINE frontendToUsb;
USB_BULK_TRANSFER usb_bulk;
uint8_t captureBuffer[CAPTURE_BUFFER_SIZE] __attribute__((aligned(4)));

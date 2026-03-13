## Firmware/Hardware Gotchas

These are hard-won lessons from debugging the firmware ↔ software communication:

- **never use `stdio_usb_deinit`** - it's known to cause unrecoverable usb connection loss. Just don't use it. All USB comms have to happen ONLY on Core 1.
- **This firmware targets only the Raspberry Pi Pico 2W** - all other board variants have been removed. The CYW43 WiFi chip is always present and used for both WiFi connectivity and LED control. The gSPI bus runs at 50MHz (the chip's rated max) at the default 200MHz system clock — zero margin.

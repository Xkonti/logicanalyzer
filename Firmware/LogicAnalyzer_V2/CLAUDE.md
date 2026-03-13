## Firmware/Hardware Gotchas

These are hard-won lessons from debugging the firmware ↔ software communication:

- **never use `stdio_usb_deinit`** - it's known to cause unrecoverable usb connection loss. Just don't use it. All USB comms have to happen ONLY on Core 1.

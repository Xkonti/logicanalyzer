## Firmware/Hardware Gotchas

These are hard-won lessons from debugging the firmware ↔ software communication:

- **`cdc_transfer` after `stdio_usb_deinit` requires settling time:** After calling `stdio_usb_deinit()`, the USB stack needs ~100ms to settle before `cdc_transfer` works reliably. Without this delay, data written via `cdc_transfer` is silently lost (never reaches the host). Capture mode already has `sleep_ms(100)` after deinit — streaming mode needs the same. The handshake (`STREAM_STARTED\n`) and info header (8 bytes) are sent via `sendResponse`/`putchar_raw` BEFORE `stdio_usb_deinit` to avoid this issue entirely.
- **`printf` output is lost if `stdio_usb_deinit` runs before flush:** `printf` writes to an internal buffer. The buffer is flushed by `tud_task()` which runs on a background timer (~1ms). If `stdio_usb_deinit()` is called before the timer fires, buffered output is destroyed. This makes `printf`-based debug logging inside `StartStream()` unreliable — messages appear to be sent but never arrive at the host.
- **`cdc_transfer` conflicts with `stdio_usb` when both are active:** `cdc_transfer` writes directly to TinyUSB's CDC interface. When `stdio_usb` is also managing that interface (before deinit), the two paths conflict. Use `sendResponse`/`printf` while stdio is active; use `cdc_transfer` only after `stdio_usb_deinit` + settle delay.

# Frontend-Hardware Communication: Stores, Composables, and UI Data Flow

This document describes how the Vue.js web application communicates with the LogicAnalyzer V2 hardware, focusing on the Pinia stores, Vue composables, UI components, state management, and the complete data flow from raw bytes to rendered waveforms.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Pinia Stores](#pinia-stores)
3. [Vue Composables](#vue-composables)
4. [UI Components](#ui-components)
5. [Connection Lifecycle](#connection-lifecycle)
6. [Capture Mode Data Flow](#capture-mode-data-flow)
7. [Streaming Mode Data Flow](#streaming-mode-data-flow)
8. [Viewport and Rendering Pipeline](#viewport-and-rendering-pipeline)
9. [Settings and Configuration Management](#settings-and-configuration-management)
10. [WiFi Device Discovery](#wifi-device-discovery)
11. [File Import/Export](#file-importexport)

---

## Architecture Overview

The application enforces a strict layered architecture:

```
UI Components
     |  (use composables, never import core/ directly)
Composables (useDevice, useCapture, useStream)
     |  (wrap store access, add component-level state)
Pinia Stores (device, capture, stream, viewport, channel-config, settings)
     |  (reactive state, call into core/)
Core Layer (driver, transport, protocol, compression, renderer)
     |  (framework-agnostic, no Vue imports)
Hardware (Pico 2W via Web Serial API / future WebSocket)
```

**Key rule** (from `Software/Web/CLAUDE.md`, line 55): Components never import from `core/` directly. The data flow is: `core/ -> stores/ -> composables/ -> components/`.

---

## Pinia Stores

### 1. Device Store (`useDeviceStore`)

**File:** `Software/Web/src/stores/device.js`

The central store for device connection state. Holds the driver instance and connection status flags.

**Reactive state:**
| Ref | Type | Purpose |
|-----|------|---------|
| `driver` | `shallowRef(null)` | `AnalyzerDriver` instance (line 7). Uses `shallowRef` because the driver is a complex object with private state that should not be deeply reactive. Wrapped with `markRaw()` on creation (line 32). |
| `connected` | `ref(false)` | Whether a device is currently connected (line 8) |
| `capturing` | `ref(false)` | Whether a capture is in progress (line 9) |
| `streaming` | `ref(false)` | Whether streaming is active (line 10) |
| `deviceInfo` | `ref(null)` | Device capabilities returned from init handshake (line 11) |
| `error` | `ref(null)` | Last error message string (line 12) |

**Computed getters** (lines 15-19):
- `version` - device firmware version string (e.g., `"ANALYZER_V6_5"`)
- `maxFrequency` - maximum capture frequency in Hz
- `blastFrequency` - blast mode frequency in Hz
- `channelCount` - number of hardware channels (typically 24)
- `bufferSize` - device sample buffer size in bytes

**Actions:**
- `connect(transportOptions)` (line 21) - Creates a `SerialTransport`, opens it, creates an `AnalyzerDriver`, performs the init handshake, and stores the driver instance. Both transport and driver are wrapped with `markRaw()` to prevent Vue reactivity from proxying them.
- `disconnect()` (line 46) - Disconnects the driver, resets all state flags to defaults.
- `blinkLed()` / `stopBlinkLed()` (lines 62, 71) - Sends LED blink commands for device identification.
- `enterBootloader()` (line 80) - Reboots the device into bootloader mode and disconnects.

### 2. Capture Store (`useCaptureStore`)

**File:** `Software/Web/src/stores/capture.js`

Manages capture configuration (persisted to localStorage) and capture results.

**Persisted configuration** (lines 13-22, all via `useLocalStorage`):
| Key | localStorage key | Default | Purpose |
|-----|-----------------|---------|---------|
| `frequency` | `la-cap-frequency` | `1000000` | Sampling frequency in Hz |
| `preTriggerSamples` | `la-cap-pre-samples` | `100` | Samples before trigger |
| `postTriggerSamples` | `la-cap-post-samples` | `1000` | Samples after trigger |
| `loopCount` | `la-cap-loop-count` | `0` | 0 = single, >0 = burst mode |
| `measureBursts` | `la-cap-measure-bursts` | `false` | Measure timing between bursts |
| `triggerType` | `la-cap-trigger-type` | `TRIGGER_EDGE` (0) | Edge/Complex/Fast/Blast |
| `triggerChannel` | `la-cap-trigger-channel` | `0` | Which channel triggers |
| `triggerInverted` | `la-cap-trigger-inverted` | `false` | Negative edge trigger |
| `triggerBitCount` | `la-cap-trigger-bit-count` | `1` | Bits for pattern trigger |
| `triggerPattern` | `la-cap-trigger-pattern` | `0` | Pattern value for Complex/Fast |

**Capture results** (lines 31-34):
| Ref | Type | Purpose |
|-----|------|---------|
| `capturedChannels` | `shallowRef([])` | Array of `AnalyzerChannel` objects with `samples: Uint8Array` |
| `bursts` | `shallowRef(null)` | Array of `BurstInfo` objects (burst mode only) |
| `regions` | `shallowRef([])` | User-defined `SampleRegion` annotations |
| `captureError` | `shallowRef(null)` | Error message from last capture attempt |

**Computed** (lines 25-28): `channels` is derived from the `channelConfig` store, mapping selected channel numbers to `AnalyzerChannel` objects via `createChannel()`.

**Key action: `startCapture()`** (line 83):
1. Guards: checks driver exists, not already capturing
2. Sets `device.capturing = true`
3. Clears any active stream data via `useStreamStore().clearStream()` (line 99)
4. Calls `device.driver.startCapture(session, callback)` with a session built from current config
5. The callback receives `{ success, session, error }`. On success, stores `result.session.captureChannels` and `result.session.bursts`
6. Finally sets `device.capturing = false`

**`buildSession()`** (line 36): Assembles a `CaptureSession` object from the current store state, mapping channel-config channels into the session format expected by the driver.

### 3. Stream Store (`useStreamStore`)

**File:** `Software/Web/src/stores/stream.js`

Manages realtime streaming configuration, state, and the high-performance data ingestion pipeline.

**Persisted configuration** (lines 40-42):
| Key | localStorage key | Default | Purpose |
|-----|-----------------|---------|---------|
| `streamFrequency` | `la-stream-frequency` | `250000` | Stream sampling frequency |
| `streamChunkSize` | `la-stream-chunk-size` | `512` | Samples per chunk |
| `maxDisplaySamples` | `la-stream-max-samples` | `50000` | Rolling buffer max size |

**Rate limits** (lines 11-36): `STREAM_RATE_LIMITS` is a lookup table mapping channel count (1-24) to maximum recommended frequency (90% of USB benchmark). For example: 1ch = 6.31 MHz, 8ch = 910 kHz, 24ch = 303 kHz.

**Streaming state** (lines 45-50):
| Ref | Type | Purpose |
|-----|------|---------|
| `streaming` | `ref(false)` | Whether stream is active |
| `streamError` | `ref(null)` | Error from stream |
| `streamWarning` | `ref(null)` | Non-fatal warning (e.g., overflow) |
| `streamChannels` | `shallowRef([])` | Channel objects with rolling `samples` buffers |
| `sampleCount` | `ref(0)` | Current total sample count |
| `following` | `ref(true)` | Whether viewport auto-scrolls to latest data |

**Performance-critical batching** (lines 56-59): The stream store uses a **time-based synchronous flushing** strategy instead of `requestAnimationFrame` to avoid starvation from the microtask-driven read loop:
- `pendingChunks` - non-reactive array of buffered chunks (plain JS, not a `ref`)
- `lastFlushTime` - timestamp of last flush
- `FLUSH_INTERVAL_MS = 16` (~60fps target)

**`onChunk(channels, chunkSamples)`** (line 77): Called by the driver's read loop for each decompressed chunk:
1. Unpacks the transposed bitstream via `unpackBitstream()` (line 64) - converts packed bits (`chunkSamples/8` bytes per channel) into per-sample 0/1 `Uint8Array`
2. Pushes the unpacked data to `pendingChunks`
3. If `FLUSH_INTERVAL_MS` has elapsed since last flush, calls `flushChunks()`

**`flushChunks()`** (line 110): Merges all pending chunks into existing channel sample arrays:
1. Calculates total new samples across all pending chunks
2. For each channel, allocates a combined `Uint8Array(existingLen + totalNew)`
3. Copies existing samples, then appends each chunk's data
4. Trims to `maxDisplaySamples` from the end (rolling window)
5. Triggers reactivity by replacing `streamChannels.value` with new array
6. If `following` is true, updates the viewport to show the latest data (lines 150-155)

**`onStreamEnd(endStatus, error)`** (line 91): Called when the stream read loop ends. Handles specific end statuses:
- `STREAM_OVERFLOW` - sets warning about data rate exceeding device capacity
- `STREAM_TIMEOUT` - sets error with debug info
- `STREAM_DISCONN` - sets error about USB disconnect

**`startStream(channelsToStream)`** (line 158):
1. Guards: driver exists, not capturing, not already streaming, channels selected
2. Checks frequency against `STREAM_RATE_LIMITS` and sets warning if exceeded
3. Creates channel objects with empty sample buffers
4. Calls `device.driver.startStream(config, onChunk, onStreamEnd)`
5. If the device returns an `actualFrequency` different from requested (PIO clamping), updates `streamFrequency`

### 4. Viewport Store (`useViewportStore`)

**File:** `Software/Web/src/stores/viewport.js`

Controls which portion of the sample data is visible in the waveform viewer.

**State:**
- `firstSample` - `ref(0)` - index of first visible sample (line 12)
- `visibleSamples` - `ref(100)` - number of samples in the visible window (line 13)

**`getEffectiveTotalSamples()`** (line 15): Determines the total sample count based on the active data source. If streaming is active or stream channels have data, uses `stream.totalSamples`; otherwise uses `capture.totalSamples`. This makes the viewport work seamlessly with both modes.

**Clamping** (line 20): All viewport operations pass through `clamp()` which enforces `MIN_VISIBLE_SAMPLES = 10` and keeps the view within bounds.

**Navigation actions:** `zoomIn/zoomOut` (uses `ZOOM_FACTOR = 0.5`), `scrollTo`, `scrollBy`, `scrollLeft/scrollRight` (uses `SCROLL_FACTOR = 0.1`), `fitAll`, `reset`.

### 5. Channel Config Store (`useChannelConfigStore`)

**File:** `Software/Web/src/stores/channel-config.js`

Manages channel selection and naming, persisted to localStorage.

**State:**
- `selectedChannels` - `useLocalStorage('la-selected-channels', [])` - sorted array of selected channel numbers (line 5)
- `channelNames` - `useLocalStorage('la-channel-names', Array(24).fill(''))` - user-assigned labels (line 6)

**Actions:** `toggleChannel(num)`, `selectRange(start, end, enabled)`, `setName(num, name)`, `setSelectedChannels(nums)`.

This store is **shared** between capture and stream modes - both use the same channel selection.

### 6. Settings Store (`useSettingsStore`)

**File:** `Software/Web/src/stores/settings.js`

Global application settings.

- `autoReconnect` - `useLocalStorage('la-auto-reconnect', false)` (line 5)
- `theme` - `useLocalStorage('la-theme', 'dark')` (line 6)

---

## Vue Composables

Composables bridge the gap between stores and components. They provide a flattened, reactive interface with writable computed properties for `v-model` binding, convenience computed flags, and action wrappers.

### `useDevice()`

**File:** `Software/Web/src/composables/useDevice.js`

Wraps `useDeviceStore` and adds a local `connecting` ref (line 8) that tracks the async connection operation. This allows the UI to show a loading spinner during the Web Serial port picker dialog.

Returns a `reactive({...})` object (line 49) exposing:
- `isWebSerialAvailable` - from boot file's exported ref
- `isConnected`, `isCapturing`, `connecting`, `deviceInfo`, `error`
- `deviceVersion`, `channelCount`, `maxFrequency`, `bufferSize`
- Actions: `connect()`, `disconnect()`, `clearError()`, `blinkLed()`, `stopBlinkLed()`, `enterBootloader()`

### `useCapture()`

**File:** `Software/Web/src/composables/useCapture.js`

The largest composable. Creates **writable computed properties** using the `configRef()` helper (line 13) for every capture configuration field, enabling direct `v-model` binding in templates:

```js
function configRef(store, key) {
  return computed({
    get: () => store[key],
    set: (v) => { store[key] = v },
  })
}
```

**Convenience computed flags** (lines 60-87):
- `canCapture` - connected AND not capturing AND settings valid AND channels selected
- `canStop` - connected AND capturing
- `captureMode` - 0/1/2 based on highest selected channel number (8ch/16ch/24ch)
- `captureModeLabel` - human-readable string
- `isBlastMode`, `isEdgeTrigger`, `isPatternTrigger`, `isFastPattern`, `isBurstMode`

**`getChannelColor(channelNumber)`** (line 114): Maps channel numbers to the 64-color palette from `Software/Web/src/core/renderer/colors.js` (line 11).

### `useStream()`

**File:** `Software/Web/src/composables/useStream.js`

Wraps `useStreamStore` with writable config refs and adds:
- `canStartStream` - connected AND not capturing AND not streaming AND channels selected (line 37)
- `recommendedFrequency` - lookup from `STREAM_RATE_LIMITS` based on current channel count (line 42)
- `isOverRecommended` - whether current frequency exceeds the recommended limit (line 47)

The `startStream()` action (line 52) passes `capture.channels` (from the shared channel-config store) to the stream store.

### `useVersionCheck()`

**File:** `Software/Web/src/composables/useVersionCheck.js`

Not related to hardware communication directly. Polls a server-hosted `version.json` file hourly to detect application updates.

---

## UI Components

### MainLayout (`Software/Web/src/layouts/MainLayout.vue`)

The root layout (line 1-16) renders:
- **Header toolbar:** `CaptureToolbar` (capture/stream controls) + `ConnectionPanel` (connect/disconnect)
- **Page container:** routes to `IndexPage`

### ConnectionPanel (`Software/Web/src/components/connection/ConnectionPanel.vue`)

**Lines 1-89.** Uses `useDevice()` composable. Renders:

1. **Disconnected state:** "Connect" button with USB icon. Clicking calls `device.connect()` which triggers the browser's Web Serial port picker dialog. Shows loading spinner via `device.connecting`. Disabled if Web Serial API is unavailable (line 16).

2. **Connected state:** Green chip showing `device.deviceVersion` (e.g., "ANALYZER_V6_5") with a popup menu showing device details (channel count, max frequency, buffer size). "Disconnect" button next to it.

3. **Error state:** Red dismissible chip showing `device.error`.

4. **Web Serial unavailable:** Yellow warning chip (line 3-10).

### CaptureToolbar (`Software/Web/src/components/capture/CaptureToolbar.vue`)

**Lines 1-111.** Uses both `useCapture()` and `useStream()`. Renders a horizontal button bar:

- **Capture button** (line 3) - Opens `CaptureDialog`. Disabled if not connected, already capturing, or streaming.
- **Stop button** (line 14) - Visible during capture. Calls `cap.stopCapture()`.
- **Repeat button** (line 22) - Visible after a capture completes. Calls `cap.repeatCapture()`.
- **Separator** (line 35)
- **Realtime button** (line 37) - Opens `StreamDialog`. Disabled via `stream.canStartStream`.
- **Stop Realtime button** (line 48) - Visible during streaming. Calls `stream.stopStream()`.
- **Error/warning chips** for both capture and stream errors (lines 58-92).

### CaptureDialog (`Software/Web/src/components/capture/CaptureDialog.vue`)

**Lines 1-140.** Modal dialog for configuring and starting a capture.

Uses `useCapture()` for config fields bound via `v-model` (e.g., `v-model.number="cap.frequency"` on line 13). These write through the composable's writable computed properties directly to the Pinia store, which persists to localStorage.

**Sections:**
1. **Sampling:** Frequency, pre/post trigger samples with dynamic hints showing valid ranges from `cap.currentLimits` (lines 119-134).
2. **Trigger:** Delegates to `TriggerConfig` component.
3. **Channels:** Uses `ChannelSelector` component, with data from `useChannelConfigStore()` directly.
4. **Validation banner:** Shows if `cap.settingsValid` is false.

**Start action** (line 136): Calls `cap.startCapture()` and closes the dialog.

### StreamDialog (`Software/Web/src/components/capture/StreamDialog.vue`)

**Lines 1-174.** Modal dialog for configuring and starting realtime streaming.

Uses local refs (`localFrequency`, `localChunkSize`, `localMaxSamples`) that are initialized from the stream composable but only committed on start (line 167-171). This prevents in-progress edits from affecting a running stream.

**Frequency guidance** (lines 146-158): Shows recommended max frequency based on channel count from `STREAM_RATE_LIMITS` and warns if exceeded.

**Chunk size guidance** (lines 128-143): Calculates estimated updates/sec (`freq / chunkSize`) and recommends a chunk size for >= 5fps.

**Start action** (line 167): Commits local values to the stream store, then calls `stream.startStream()`.

### TriggerConfig (`Software/Web/src/components/capture/TriggerConfig.vue`)

**Lines 1-201.** Configures trigger settings via `useCapture()`.

Two modes selected via toggle:
- **Edge mode** (lines 19-63): Channel selector buttons, negative edge checkbox, blast mode toggle, burst mode with count and measurement options.
- **Pattern mode** (lines 67-90): First channel, binary pattern string, fast pattern toggle.

**Blast mode** (line 122): When enabled, locks frequency to `blastFrequency`, forces `preTriggerSamples = 0`, disables burst mode.

**Pattern string conversion** (lines 178-196): Converts between LSB-first binary string (UI display) and integer pattern value (firmware format).

### ChannelSelector (`Software/Web/src/components/shared/ChannelSelector.vue`)

**Lines 1-78.** Reusable component for channel selection, used by both CaptureDialog and StreamDialog.

Groups channels in sets of 8 (lines 68-77). Each group has "All"/"None" batch buttons. Each channel has a checkbox and a label input field. Emits events (`toggle`, `select-range`, `update:name`) consumed by the parent.

### WaveformViewer (`Software/Web/src/components/viewer/WaveformViewer.vue`)

**Lines 1-146.** The main waveform display container using CSS Grid layout:

```
[corner]     [TimelineRuler]
[ChannelLabels] [WaveformCanvas]
[--- scroll/zoom controls ---]
```

**Scroll controls** (lines 12-61): Zoom in/out buttons, a `q-slider` for horizontal scrolling, "Fit All" button, and a "Follow" toggle (visible only during streaming) that enables/disables auto-scrolling.

**Auto-fit on capture** (line 90): Watches `cap.hasCapture` and calls `viewport.fitAll()` when a new capture arrives.

**Follow toggle** (line 86): When the user manually scrolls during streaming, `following` is set to `false`.

### WaveformCanvas (`Software/Web/src/components/viewer/WaveformCanvas.vue`)

**Lines 1-171.** The core rendering component. Creates and manages a `WaveformRenderer` instance.

**Active channel selection** (line 28): Determines which channels to render:
```js
const activeChannels = computed(() => {
  if (stream.isStreaming || stream.streamChannels.length > 0) return stream.streamChannels
  return cap.capturedChannels
})
```
Stream data takes priority over capture data.

**Reactive rendering** (line 136): A `watchEffect` automatically re-renders whenever any dependency changes:
1. Maps channel data to the renderer format via `mapChannels()`
2. Sets viewport from the viewport store
3. Conditionally sets capture markers (trigger, bursts, regions) - skipped during streaming
4. Calls `renderer.resize()` and `renderer.render()`

**Scroll/zoom via wheel** (line 67): Intercepts wheel events on the canvas:
- `Ctrl+Wheel` = zoom in/out centered on cursor position (using `renderer.sampleAtX()`)
- `Wheel` = horizontal scroll by 10% of visible samples
- Disables `following` on manual interaction during streaming

**Resize handling** (line 91): Uses `ResizeObserver` to detect container size changes and schedules a re-render via `requestAnimationFrame`.

### ChannelLabels (`Software/Web/src/components/viewer/ChannelLabels.vue`)

**Lines 1-96.** Renders channel labels beside the waveform canvas.

Uses the same `activeChannels` logic (line 43) to show either stream or capture channels. Each label shows a color dot, channel name (or fallback "Ch N"), and a visibility toggle button.

### TimelineRuler (`Software/Web/src/components/viewer/TimelineRuler.vue`)

**Lines 1-86.** Renders the time/sample axis above the waveform.

**Frequency source** (line 22): Uses stream frequency when streaming, capture frequency otherwise:
```js
const activeFrequency = computed(() => {
  if (stream.isStreaming || stream.streamChannels.length > 0) return stream.streamFrequency
  return cap.frequency
})
```

### IndexPage (`Software/Web/src/pages/IndexPage.vue`)

**Lines 1-40.** The main page. Shows either:
- An empty state message ("No capture loaded") when no data is available
- The `WaveformViewer` component when capture or stream data exists

---

## Connection Lifecycle

### Connect Flow

```
User clicks "Connect" button
  -> ConnectionPanel calls device.connect()
    -> useDevice composable sets connecting = true
      -> useDeviceStore.connect()
        -> new SerialTransport(transportOptions)
          -> navigator.serial.requestPort({filters: [{vendorId: 0x1209, productId: 0x3020}]})
            [Browser shows port picker dialog]
          -> port.open({baudRate: 115200, bufferSize: 1048576})
          -> port.setSignals({requestToSend: true, dataTerminalReady: true})
          -> [200ms delay for firmware boot]
          -> reader = port.readable.getReader()
          -> [drain pending boot data]
          -> writer = port.writable.getWriter()
        -> new AnalyzerDriver()
        -> driver.connect(transport)
          -> Sends CMD_DEVICE_INIT (0x00) in framed OutputPacket
          -> Reads 5-line init response:
            1. Version string (e.g., "ANALYZER_V6_5") - validated against MIN_MAJOR=6, MIN_MINOR=5
            2. "FREQ:100000000" - max sampling frequency
            3. "BLASTFREQ:200000000" - blast mode frequency
            4. "BUFFER:262144" - sample buffer size
            5. "CHANNELS:24" - channel count
          -> Stores device capabilities
        -> store.driver = markRaw(driver)
        -> store.connected = true
        -> store.deviceInfo = driver.getDeviceInfo()
```

**Source files:** `Software/Web/src/stores/device.js` lines 21-43, `Software/Web/src/core/transport/serial.js` lines 52-86, `Software/Web/src/core/driver/analyzer.js` lines 84-99, `Software/Web/src/core/protocol/parser.js` lines 55-105.

### Disconnect Flow

```
User clicks "Disconnect"
  -> device.disconnect()
    -> driver.disconnect()
      -> transport.disconnect()
        -> reader.releaseLock()
        -> writer.releaseLock()
        -> port.close()
    -> Reset all store state: driver=null, connected=false, capturing=false, streaming=false
```

**Source:** `Software/Web/src/stores/device.js` lines 46-60, `Software/Web/src/core/transport/serial.js` lines 88-118.

---

## Capture Mode Data Flow

### Complete data path: User click to rendered waveform

```
1. User clicks "Start Capture" in CaptureDialog
   -> CaptureDialog.onStart() (CaptureDialog.vue:136)
     -> cap.startCapture() (useCapture.js:90)
       -> capture.startCapture() (capture.js:83)

2. Store prepares session
   -> capture.buildSession() assembles CaptureSession from current config (capture.js:36)
   -> Sets device.capturing = true (capture.js:95)
   -> Clears stream data: useStreamStore().clearStream() (capture.js:98-99)

3. Driver composes and sends request
   -> driver.startCapture(session, callback) (analyzer.js:291)
   -> driver.validateSettings(session) (analyzer.js:164) - checks against device limits
   -> driver.composeRequest(session) (analyzer.js:242) - builds low-level params
     -> For Complex/Fast triggers: applies trigger delay offset (analyzer.js:264-267)
   -> buildCaptureRequest(request) (packets.js:119) - builds 56-byte struct
   -> OutputPacket wraps with framing: [0x55 0xAA] [escaped payload] [0xAA 0x55]
   -> transport.write(packet) - sends over USB serial

4. Device acknowledges
   -> parseCaptureStartResponse(transport) reads "CAPTURE_STARTED" line (parser.js:113)
   -> If not "CAPTURE_STARTED", capture fails with device error message

5. Device captures and sends data
   -> parseCaptureData(transport, mode, loopCount, measureBursts) (parser.js:133)
   -> Reads 4-byte sample count (UInt32 LE)
   -> Reads sampleCount * bytesPerSample bytes of raw sample data
     -> 8ch mode: 1 byte/sample, 16ch: 2 bytes/sample, 24ch: 4 bytes/sample
   -> Parses into Uint32Array (one uint32 per sample, bits = channel states)
   -> Reads 1-byte timestamp flag
   -> If timestamps present (burst mode): reads (loopCount+2) * 4 bytes of UInt32 LE timestamps

6. Driver extracts per-channel samples
   -> extractSamples(rawSamples, channelIndex) (samples.js:15)
   -> For each channel: masks the channel's bit from each uint32 sample
   -> Result: Uint8Array with 0/1 per sample per channel
   -> If burst timestamps present: processBurstTimestamps() (samples.js:36)
     -> Converts SysTick values (200MHz clock, 5ns/tick) to BurstInfo objects
     -> Handles counter rollover and jitter correction

7. Callback stores results in Pinia
   -> callback({ success: true, session }) (capture.js:104-106)
   -> capturedChannels.value = result.session.captureChannels
   -> bursts.value = result.session.bursts

8. Vue reactivity triggers rendering
   -> WaveformCanvas.watchEffect detects capturedChannels change (WaveformCanvas.vue:136)
   -> Maps channels to renderer format
   -> renderer.setChannels() / renderer.setViewport() / renderer.render()
   -> WaveformViewer watches cap.hasCapture, calls viewport.fitAll() (WaveformViewer.vue:90)
```

### Stop Capture

**Source:** `Software/Web/src/core/driver/analyzer.js` lines 355-369.

```
cap.stopCapture()
  -> driver.stopCapture()
    -> Sends raw 0xFF byte (CMD_STOP_CAPTURE, not framed in OutputPacket)
    -> Waits 2000ms
    -> Disconnects and reconnects transport (resets serial state)
  -> device.capturing = false
```

---

## Streaming Mode Data Flow

### Complete streaming pipeline

```
1. User clicks "Start Realtime" in StreamDialog
   -> StreamDialog.onStart() (StreamDialog.vue:167)
     -> Commits local config to stream store (frequency, chunkSize, maxSamples)
     -> stream.startStream() (useStream.js:52)
       -> streamStore.startStream(capture.channels) (stream.js:158)

2. Store sends stream request
   -> buildStreamRequest(config) (packets.js:101) - builds 40-byte struct:
     [32 bytes: channel numbers, zero-padded]
     [1 byte: channelCount]
     [1 byte: padding]
     [2 bytes: chunkSamples LE16]
     [4 bytes: frequency LE32]
   -> OutputPacket wraps with CMD_START_STREAM (0x0A) + framing
   -> transport.write(packet)

3. Device handshake
   -> Reads "STREAM_STARTED" line (analyzer.js:432-435)
   -> Reads 8-byte info header (analyzer.js:439-444):
     [2 bytes: chunkSamples LE16]
     [1 byte: numChannels]
     [1 byte: reserved]
     [4 bytes: actualFrequency LE32]
   -> If actualFrequency differs from requested, updates streamFrequency (stream.js:221)

4. Async read loop (fire-and-forget)
   -> driver.#readStreamLoop() (analyzer.js:464)
   -> Loop:
     a. Read 2 bytes: compressed chunk size (LE16)
     b. If size == 0: EOF, break
     c. Read compressedSize bytes
     d. decompressChunk(compressed, numChannels, chunkSamples) (decoder.js:77)
        -> Parses 2-bit header per channel: ALL_ZERO(01), ALL_ONE(10), RAW(00), NIBBLE_ENC(11)
        -> For NIBBLE_ENC: decodes nibble prefix codes (run-length encoding)
        -> Returns per-channel transposed bitstreams (chunkSamples/8 bytes each)
     e. Calls onChunk(channels, chunkSamples)

5. Stream store processes chunks
   -> onChunk(channels, chunkSamples) (stream.js:77)
     -> unpackBitstream(packed, chunkSamples) (stream.js:64)
       -> For each sample: extracts bit from packed byte array
       -> Result: Uint8Array with 0/1 per sample
     -> Pushes to pendingChunks array (non-reactive)
     -> If 16ms+ since last flush: flushChunks()

6. flushChunks() merges into reactive state
   -> flushChunks() (stream.js:110)
   -> For each channel:
     a. Allocates combined Uint8Array(existingLen + totalNew)
     b. Copies existing samples
     c. Appends all pending chunk data
     d. Trims to maxDisplaySamples from the end (rolling window)
   -> streamChannels.value = updated (triggers reactivity)
   -> sampleCount.value = total sample count
   -> If following: viewport.setView(total - visible, visible) (auto-scroll)

7. Vue reactivity drives re-render
   -> WaveformCanvas.watchEffect detects streamChannels change
   -> Maps stream channels to renderer format
   -> Sets viewport, skips capture markers (trigger/bursts/regions)
   -> renderer.render()
```

### Stop Stream

**Source:** `Software/Web/src/core/driver/analyzer.js` lines 498-532, `Software/Web/src/stores/stream.js` lines 232-242.

```
stream.stopStream()
  -> driver.stopStream()
    -> Sends CMD_STOP_STREAM (0x0B) in framed OutputPacket
    -> Polls driver.#streaming flag for up to 5 seconds (50ms intervals)
    -> Read loop should detect EOF marker and end naturally
    -> If timeout: force-disconnects and reconnects transport
  -> streaming = false, device.streaming = false
```

### Stream end handling

The driver's read loop (analyzer.js:464) can end in several ways:
- **Normal EOF:** compressedSize == 0, reads status line, calls `onEnd(statusLine, null)`
- **Error:** exception during read, calls `onEnd(null, errorMessage)`

The store's `onStreamEnd()` (stream.js:91) maps status strings to user messages:
- `STREAM_OVERFLOW` -> warning: "data rate exceeded device capacity"
- `STREAM_TIMEOUT` -> error with debug info
- `STREAM_DISCONN` -> error: "device detected USB disconnect"

---

## Viewport and Rendering Pipeline

### Viewport Store Integration

The viewport store (`Software/Web/src/stores/viewport.js`) is the single source of truth for what portion of data is displayed. It serves both capture and streaming modes via `getEffectiveTotalSamples()` (line 15).

### Rendering Chain

```
Data changes (capture results or stream chunks)
  |
  v
WaveformCanvas.watchEffect() (WaveformCanvas.vue:136)
  |-- activeChannels computed: picks stream or capture channels
  |-- mapChannels(): extracts channelNumber, channelColor, visible, samples
  |-- renderer.setChannels(mapped)
  |-- renderer.setViewport(firstSample, visibleSamples)
  |-- renderer.setPreTriggerSamples() / setBursts() / setRegions()
  |-- renderer.resize() -- handles high-DPI (devicePixelRatio)
  |-- renderer.render()
        |
        v
      WaveformRenderer.render() (waveform-renderer.js:186)
        |-- Clear canvas
        |-- Draw backgrounds (alternating dark stripes)
        |-- Draw regions (semi-transparent overlays)
        |-- Draw grid (at high zoom only, <201 samples visible)
        |-- Draw waveforms:
        |     |-- samplesPerPixel <= 2: _drawChannelDetailed()
        |     |     |-- RLE-optimized: only emits lineTo at transitions
        |     |     |-- Two passes: fill (semi-transparent) + signal line
        |     |-- samplesPerPixel > 2: _drawChannelDecimated()
        |           |-- computeColumnSummary(): per-pixel 0/1/2 (low/high/mixed)
        |           |-- Batched fill rectangles for high/mixed columns
        |           |-- Signal trace with vertical transition bars for mixed columns
        |-- Draw trigger marker (white line at preTriggerSamples)
        |-- Draw burst markers (dashed lines at burst starts)
        |-- Draw user marker (cyan dashed line)

TimelineRuler.watchEffect() (TimelineRuler.vue:66)
  |-- Sets viewport and frequency (stream or capture)
  |-- TimelineRenderer.render()
        |-- Computes niceTickInterval (1-2-5 progression)
        |-- Draws minor ticks (30% opacity)
        |-- Draws major ticks with time/sample labels
        |-- Time labels use formatTime() for adaptive units (s/ms/us/ns)
```

### Scroll/Zoom Interaction

User interactions update the viewport store, which triggers re-renders via the `watchEffect`:

- **Wheel scroll** (WaveformCanvas.vue:67): Updates `viewport.scrollBy()` or `viewport.zoomIn()/zoomOut()` with cursor-centered zoom
- **Slider** (WaveformViewer.vue:85): Updates `viewport.setView()`
- **Zoom buttons** (WaveformViewer.vue:12-49): Call viewport methods
- **Fit All** (WaveformViewer.vue:47): Sets viewport to show all samples
- **Follow toggle** (WaveformViewer.vue:50): During streaming, toggles `stream.following` which controls auto-scroll in `flushChunks()`

---

## Settings and Configuration Management

### Persistence Strategy

All configuration uses `@vueuse/core`'s `useLocalStorage()` which synchronizes reactive refs with `window.localStorage`:

| localStorage key | Store | Default | Purpose |
|-----------------|-------|---------|---------|
| `la-cap-frequency` | capture | 1000000 | Capture frequency |
| `la-cap-pre-samples` | capture | 100 | Pre-trigger samples |
| `la-cap-post-samples` | capture | 1000 | Post-trigger samples |
| `la-cap-loop-count` | capture | 0 | Burst loop count |
| `la-cap-measure-bursts` | capture | false | Burst timing measurement |
| `la-cap-trigger-type` | capture | 0 (EDGE) | Trigger type |
| `la-cap-trigger-channel` | capture | 0 | Trigger channel |
| `la-cap-trigger-inverted` | capture | false | Negative edge |
| `la-cap-trigger-bit-count` | capture | 1 | Pattern trigger width |
| `la-cap-trigger-pattern` | capture | 0 | Pattern trigger value |
| `la-stream-frequency` | stream | 250000 | Stream frequency |
| `la-stream-chunk-size` | stream | 512 | Stream chunk size |
| `la-stream-max-samples` | stream | 50000 | Rolling display buffer |
| `la-selected-channels` | channel-config | [] | Selected channel numbers |
| `la-channel-names` | channel-config | Array(24).fill('') | Channel labels |
| `la-auto-reconnect` | settings | false | Auto-reconnect flag |
| `la-theme` | settings | 'dark' | UI theme |

### Validation

Settings validation happens in `AnalyzerDriver.validateSettings()` (`Software/Web/src/core/driver/analyzer.js` lines 164-233). It checks:
- Channel numbers within device range
- Frequency within `minFrequency` to `maxFrequency` (or exactly `blastFrequency` for blast mode)
- Pre/post samples within device limits based on capture mode
- Total samples within buffer capacity
- Trigger-specific constraints (pattern width, blast mode restrictions)
- Burst mode constraints (loop count, measurement requirements)

The capture store exposes `settingsValid` (line 71) and `currentLimits` (line 63) as computed properties that re-evaluate whenever settings or channel selection changes.

### Sample Rate Limits

The capture store computes `currentLimits` by calling `driver.getLimits(channelNumbers)` (capture.js:68), which calculates buffer-based limits:
- `bytesPerSample`: 1 (8ch), 2 (16ch), 4 (24ch)
- `totalSamples = bufferSize / bytesPerSample`
- `maxPreSamples = totalSamples / 10`
- `maxPostSamples = totalSamples - 2`

---

## WiFi Device Discovery

**Current status: Not yet implemented.**

The transport layer (`Software/Web/src/core/transport/types.js` line 8) documents a future `WebSocketTransport` alongside the current `SerialTransport`. The `ITransport` interface (lines 1-13) is designed to be transport-agnostic, so the driver and all higher layers would work unchanged with a WebSocket transport.

The firmware defines `CMD_NETWORK_CONFIG = 0x02` (`Software/Web/src/core/protocol/commands.js` line 5) for WiFi configuration, but no frontend implementation exists yet.

The `SerialTransport` constructor accepts `options.port` to allow pre-selected ports (line 41 of serial.js), which could be used for remembered devices in a future WiFi discovery flow.

---

## File Import/Export

### LAC Format (JSON)

**Source:** `Software/Web/src/core/capture/formats.js`

The `.lac` format is a JSON file with PascalCase field names (matching the C# desktop app):
```json
{
  "Settings": { "Frequency": ..., "CaptureChannels": [...], ... },
  "Samples": null,
  "SelectedRegions": [...]
}
```

- `parseLac(jsonString)` (line 142): Converts PascalCase to camelCase, handles legacy `Samples` array (root-level packed multi-channel data from older versions).
- `serializeLac(session, regions)` (line 162): Converts camelCase back to PascalCase.

**Load flow:** `capture.loadLac(jsonString)` (capture.js:127) updates both channel-config store (selected channels, names) and capture store (all config fields + results).

### CSV Format

- `parseCsv(csvString)` (formats.js:178): Header row = channel names, data rows = 0/1 values.
- `serializeCsv(session)` (formats.js:214): Exports current capture data.

**Load flow:** `capture.loadCsv(csvString)` (capture.js:154) updates channel selection and replaces capture data.

---

## Web Serial API Boot Check

**File:** `Software/Web/src/boot/webserial.js`

Runs before the Vue app mounts. Exports `webSerialAvailable` ref (line 5) which is `true` only if `navigator.serial` exists (Chromium-only API). If unavailable, shows a persistent Quasar notification warning users to use Chrome or Edge.

This ref is consumed by `useDevice()` composable (line 9) and displayed in both `ConnectionPanel` (line 4) and `IndexPage` (line 3).

---

## Summary of Key Design Decisions

1. **`shallowRef` for large data:** `capturedChannels`, `streamChannels`, `bursts`, `regions` all use `shallowRef` to avoid deep reactivity on potentially large `Uint8Array` data. Mutations trigger by replacing the entire value.

2. **`markRaw` for driver objects:** Both `SerialTransport` and `AnalyzerDriver` are wrapped with `markRaw()` to prevent Vue's proxy system from interfering with their private fields and Web Serial API handles.

3. **Time-based batching for streaming:** The stream store uses synchronous time-based flushing (16ms interval) rather than `requestAnimationFrame` because the stream read loop runs in microtasks, which can starve rAF callbacks.

4. **Shared channel selection:** Both capture and streaming modes use the same `channelConfig` store for channel selection, avoiding duplicate configuration.

5. **Transport abstraction:** The `ITransport` interface (`readLine()`, `readBytes()`, `write()`, `connect()`, `disconnect()`) decouples the protocol layer from the physical transport, enabling future WebSocket support and easy testing with `createMockTransport()`.

6. **Two-pass rendering:** Waveforms are drawn in two passes (fill + line) for the professional PulseView/Saleae aesthetic. The renderer automatically switches between detailed (RLE) and decimated (per-pixel summary) modes based on zoom level.

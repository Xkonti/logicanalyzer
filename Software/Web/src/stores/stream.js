import { ref, shallowRef, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { useDeviceStore } from './device.js'
import { useViewportStore } from './viewport.js'
import { createChannel } from '../core/driver/types.js'

export const useStreamStore = defineStore('stream', () => {
  // Config (persisted)
  const streamFrequency = useLocalStorage('la-stream-frequency', 250000)
  const streamChunkSize = useLocalStorage('la-stream-chunk-size', 512)
  const maxDisplaySamples = useLocalStorage('la-stream-max-samples', 50000)

  // State
  const streaming = ref(false)
  const streamError = ref(null)
  const streamWarning = ref(null)
  const streamChannels = shallowRef([])
  const sampleCount = ref(0)
  const following = ref(true)

  // Skip detection
  const totalDmaSkips = ref(0)
  const totalTransmitSkips = ref(0)
  const dmaSkipsPerSec = ref(0)
  const transmitSkipsPerSec = ref(0)
  let streamStartedAt = 0

  // Loss region tracking (absolute sample coordinates)
  const lossRegions = shallowRef([]) // { absoluteFirst, absoluteLast }[]
  const displayOffset = ref(0) // absoluteSamplesReceived - displayBufferLength

  // Computed
  const hasStream = computed(() => streaming.value && streamChannels.value.length > 0)
  const totalSamples = computed(() => sampleCount.value)

  const displayLossRegions = computed(() => {
    const offset = displayOffset.value
    const count = sampleCount.value
    if (count === 0) return []

    const result = []
    for (const region of lossRegions.value) {
      const first = region.absoluteFirst - offset
      const last = region.absoluteLast - offset
      if (last < 0) continue
      if (first >= count) continue
      result.push({
        firstSample: Math.max(0, first),
        lastSample: Math.min(count - 1, last),
      })
    }
    return result
  })

  // Time-based batching state (non-reactive for performance)
  let pendingChunks = []
  let lastFlushTime = 0
  let absoluteSamplesReceived = 0
  let samplesSinceLastReport = 0
  const FLUSH_INTERVAL_MS = 16 // ~60fps

  /**
   * Unpacks a transposed bitstream (chunkSamples/8 bytes) into per-sample 0/1 Uint8Array.
   */
  function unpackBitstream(packed, chunkSamples) {
    const out = new Uint8Array(chunkSamples)
    for (let s = 0; s < chunkSamples; s++) {
      out[s] = (packed[s >> 3] >> (s & 7)) & 1
    }
    return out
  }

  /**
   * Called by the driver's read loop for each decompressed chunk.
   * Uses time-based synchronous flushing to avoid rAF starvation
   * from microtask-driven read loops.
   */
  function onChunk(channels, chunkSamples) {
    absoluteSamplesReceived += chunkSamples
    samplesSinceLastReport += chunkSamples

    const unpacked = channels.map((ch) => unpackBitstream(ch, chunkSamples))
    pendingChunks.push({ unpacked, chunkSamples })

    const now = performance.now()
    if (now - lastFlushTime >= FLUSH_INTERVAL_MS) {
      lastFlushTime = now
      flushChunks()
    }
  }

  /**
   * Called when the read loop ends (EOF or error).
   */
  function onStreamEnd(endStatus, error) {
    // Flush any remaining buffered chunks
    flushChunks()

    if (error) {
      streamError.value = error
    }
    if (endStatus?.startsWith('STREAM_TIMEOUT')) {
      streamError.value = `Stream timeout — no data produced. Debug: ${endStatus}`
    } else if (endStatus?.startsWith('STREAM_DISCONN')) {
      streamError.value = 'Stream ended — device detected USB disconnect'
    }
    streaming.value = false
    const device = useDeviceStore()
    device.streaming = false
  }

  /**
   * Called by the driver when a skip report frame is received.
   */
  function onSkipReport({ dmaSkips, txSkips }) {
    totalDmaSkips.value += dmaSkips
    totalTransmitSkips.value += txSkips

    const elapsed = (performance.now() - streamStartedAt) / 1000
    if (elapsed > 0) {
      dmaSkipsPerSec.value = Math.round(totalDmaSkips.value / elapsed)
      transmitSkipsPerSec.value = Math.round(totalTransmitSkips.value / elapsed)
    }

    // Mark samples received since the last report as a lossy region
    if (samplesSinceLastReport > 0) {
      const absoluteLast = absoluteSamplesReceived - 1
      const absoluteFirst = absoluteLast - samplesSinceLastReport + 1
      lossRegions.value = [...lossRegions.value, { absoluteFirst, absoluteLast }]
      samplesSinceLastReport = 0
    }
  }

  function flushChunks() {
    if (pendingChunks.length === 0) return

    const chunks = pendingChunks
    pendingChunks = []

    const current = streamChannels.value
    if (current.length === 0) return

    const max = maxDisplaySamples.value

    // Calculate total new samples
    let totalNew = 0
    for (const chunk of chunks) {
      totalNew += chunk.chunkSamples
    }

    const updated = current.map((ch, chIdx) => {
      const existing = ch.samples
      const existingLen = existing ? existing.length : 0

      // Allocate combined buffer
      const combined = new Uint8Array(existingLen + totalNew)
      if (existing) combined.set(existing)

      let offset = existingLen
      for (const chunk of chunks) {
        combined.set(chunk.unpacked[chIdx], offset)
        offset += chunk.chunkSamples
      }

      // Trim to maxDisplaySamples from the end
      const trimmed = combined.length > max ? combined.slice(combined.length - max) : combined
      return { ...ch, samples: trimmed }
    })

    streamChannels.value = updated
    sampleCount.value = updated[0]?.samples?.length ?? 0

    // Update display offset for loss region coordinate mapping and prune old regions
    displayOffset.value = absoluteSamplesReceived - sampleCount.value
    const offset = displayOffset.value
    const regions = lossRegions.value
    if (regions.length > 0 && regions[0].absoluteLast < offset) {
      lossRegions.value = regions.filter((r) => r.absoluteLast >= offset)
    }

    // Auto-scroll viewport to follow latest data
    if (following.value) {
      const viewport = useViewportStore()
      const total = sampleCount.value
      const visible = viewport.visibleSamples
      viewport.setView(Math.max(0, total - visible), visible)
    }
  }

  async function startStream(channelsToStream) {
    const device = useDeviceStore()
    console.log('[stream] startStream called', {
      hasDriver: !!device.driver,
      capturing: device.capturing,
      streaming: device.streaming,
      channelCount: channelsToStream?.length,
    })
    if (!device.driver) {
      streamError.value = 'Not connected'
      console.warn('[stream] bail: not connected')
      return
    }
    if (device.capturing || device.streaming) {
      streamError.value = 'Device is busy'
      console.warn('[stream] bail: device busy', {
        capturing: device.capturing,
        streaming: device.streaming,
      })
      return
    }
    if (!channelsToStream || channelsToStream.length === 0) {
      streamError.value = 'No channels selected'
      console.warn('[stream] bail: no channels')
      return
    }

    streamError.value = null
    streamWarning.value = null
    totalDmaSkips.value = 0
    totalTransmitSkips.value = 0
    dmaSkipsPerSec.value = 0
    transmitSkipsPerSec.value = 0
    lossRegions.value = []
    displayOffset.value = 0
    absoluteSamplesReceived = 0
    samplesSinceLastReport = 0
    streamStartedAt = performance.now()

    const channelNumbers = channelsToStream.map((ch) => ch.channelNumber)
    const freq = streamFrequency.value

    // Create channel objects with empty sample buffers
    streamChannels.value = channelsToStream.map((ch) =>
      createChannel(ch.channelNumber, ch.channelName, ch.channelColor),
    )
    sampleCount.value = 0
    following.value = true
    pendingChunks = []
    lastFlushTime = 0

    console.log('[stream] calling driver.startStream', {
      channels: channelNumbers,
      frequency: freq,
      chunkSamples: streamChunkSize.value,
    })

    const result = await device.driver.startStream(
      { channels: channelNumbers, frequency: freq, chunkSamples: streamChunkSize.value },
      onChunk,
      onStreamEnd,
      onSkipReport,
    )

    console.log('[stream] driver.startStream returned', result)

    if (result.started) {
      // Use actual PIO frequency for timeline (may differ from requested if clamped)
      if (result.actualFrequency && result.actualFrequency !== freq) {
        streamFrequency.value = result.actualFrequency
      }
      streaming.value = true
      device.streaming = true
    } else {
      streamError.value = result.error || 'Failed to start stream'
      streamChannels.value = []
    }
  }

  async function stopStream() {
    if (!streaming.value) return

    const device = useDeviceStore()
    if (device.driver) {
      await device.driver.stopStream()
    }
    // onStreamEnd callback should have handled this, but force cleanup as fallback
    streaming.value = false
    device.streaming = false
  }

  function clearStream() {
    streaming.value = false
    streamError.value = null
    streamWarning.value = null
    streamChannels.value = []
    sampleCount.value = 0
    following.value = true
    pendingChunks = []
    lastFlushTime = 0
    totalDmaSkips.value = 0
    totalTransmitSkips.value = 0
    dmaSkipsPerSec.value = 0
    transmitSkipsPerSec.value = 0
    lossRegions.value = []
    displayOffset.value = 0
    absoluteSamplesReceived = 0
    samplesSinceLastReport = 0
    streamStartedAt = 0
    const device = useDeviceStore()
    device.streaming = false
  }

  return {
    streamFrequency,
    streamChunkSize,
    maxDisplaySamples,
    streaming,
    streamError,
    streamWarning,
    streamChannels,
    sampleCount,
    following,
    hasStream,
    totalSamples,
    totalDmaSkips,
    totalTransmitSkips,
    dmaSkipsPerSec,
    transmitSkipsPerSec,
    displayLossRegions,
    startStream,
    stopStream,
    clearStream,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStreamStore, import.meta.hot))
}

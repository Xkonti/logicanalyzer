import { ref, shallowRef, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { useDeviceStore } from './device.js'
import { useViewportStore } from './viewport.js'
import { createChannel } from '../core/driver/types.js'

/**
 * Recommended max streaming frequency per channel count (90% of USB benchmark).
 */
export const STREAM_RATE_LIMITS = {
  1: 6310000,
  2: 3630000,
  3: 2410000,
  4: 1820000,
  5: 1450000,
  6: 1210000,
  7: 1040000,
  8: 910000,
  9: 806000,
  10: 728000,
  11: 661000,
  12: 606000,
  13: 559000,
  14: 519000,
  15: 484000,
  16: 454000,
  17: 427000,
  18: 404000,
  19: 382000,
  20: 364000,
  21: 346000,
  22: 330000,
  23: 316000,
  24: 303000,
}

export const useStreamStore = defineStore('stream', () => {
  // Config (persisted)
  const streamFrequency = useLocalStorage('la-stream-frequency', 250000)
  const maxDisplaySamples = useLocalStorage('la-stream-max-samples', 50000)

  // State
  const streaming = ref(false)
  const streamError = ref(null)
  const streamWarning = ref(null)
  const streamChannels = shallowRef([])
  const sampleCount = ref(0)
  const following = ref(true)

  // Computed
  const hasStream = computed(() => streaming.value && streamChannels.value.length > 0)
  const totalSamples = computed(() => sampleCount.value)

  // Time-based batching state (non-reactive for performance)
  let pendingChunks = []
  let lastFlushTime = 0
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
    if (endStatus === 'STREAM_OVERFLOW') {
      streamWarning.value = 'Stream ended due to overflow — data rate exceeded device capacity'
    }
    streaming.value = false
    const device = useDeviceStore()
    device.streaming = false
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
    if (!device.driver) {
      streamError.value = 'Not connected'
      return
    }
    if (device.capturing || device.streaming) {
      streamError.value = 'Device is busy'
      return
    }
    if (!channelsToStream || channelsToStream.length === 0) {
      streamError.value = 'No channels selected'
      return
    }

    streamError.value = null
    streamWarning.value = null

    const channelNumbers = channelsToStream.map((ch) => ch.channelNumber)
    const freq = streamFrequency.value
    const limit = STREAM_RATE_LIMITS[channelNumbers.length]

    if (limit && freq > limit) {
      streamWarning.value = `Frequency ${formatFreq(freq)} exceeds recommended ${formatFreq(limit)} for ${channelNumbers.length}ch — data dropouts may occur`
    }

    // Create channel objects with empty sample buffers
    streamChannels.value = channelsToStream.map((ch) =>
      createChannel(ch.channelNumber, ch.channelName, ch.channelColor),
    )
    sampleCount.value = 0
    following.value = true
    pendingChunks = []
    lastFlushTime = 0

    const result = await device.driver.startStream(
      { channels: channelNumbers, frequency: freq },
      onChunk,
      onStreamEnd,
    )

    if (result.started) {
      streaming.value = true
      device.streaming = true
    } else {
      streamError.value = 'Failed to start stream'
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
    const device = useDeviceStore()
    device.streaming = false
  }

  return {
    streamFrequency,
    maxDisplaySamples,
    streaming,
    streamError,
    streamWarning,
    streamChannels,
    sampleCount,
    following,
    hasStream,
    totalSamples,
    startStream,
    stopStream,
    clearStream,
  }
})

function formatFreq(hz) {
  if (hz >= 1000000) return `${(hz / 1000000).toFixed(1)} MHz`
  if (hz >= 1000) return `${(hz / 1000).toFixed(0)} kHz`
  return `${hz} Hz`
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStreamStore, import.meta.hot))
}

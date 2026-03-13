import { computed, reactive } from 'vue'
import { useStreamStore } from '../stores/stream.js'
import { useDeviceStore } from '../stores/device.js'
import { useCaptureStore } from '../stores/capture.js'

function configRef(store, key) {
  return computed({
    get: () => store[key],
    set: (v) => {
      store[key] = v
    },
  })
}

export function useStream() {
  const stream = useStreamStore()
  const device = useDeviceStore()
  const capture = useCaptureStore()

  // Config (writable)
  const streamFrequency = configRef(stream, 'streamFrequency')
  const streamChunkSize = configRef(stream, 'streamChunkSize')
  const maxDisplaySamples = configRef(stream, 'maxDisplaySamples')
  const following = configRef(stream, 'following')

  // State
  const isStreaming = computed(() => stream.streaming)
  const streamError = computed(() => stream.streamError)
  const streamWarning = computed(() => stream.streamWarning)
  const hasStream = computed(() => stream.hasStream)
  const totalSamples = computed(() => stream.totalSamples)

  // Skip stats
  const totalDmaSkips = computed(() => stream.totalDmaSkips)
  const totalTransmitSkips = computed(() => stream.totalTransmitSkips)
  const dmaSkipsPerSec = computed(() => stream.dmaSkipsPerSec)
  const transmitSkipsPerSec = computed(() => stream.transmitSkipsPerSec)

  // Data
  const streamChannels = computed(() => stream.streamChannels)
  const lossRegions = computed(() => stream.displayLossRegions)

  // Capability
  const canStartStream = computed(
    () => device.connected && !device.capturing && !device.streaming && capture.channels.length > 0,
  )

  // Actions
  async function startStream() {
    await stream.startStream(capture.channels)
  }

  async function stopStream() {
    await stream.stopStream()
  }

  function clearStream() {
    stream.clearStream()
  }

  function clearError() {
    stream.streamError = null
  }

  function clearWarning() {
    stream.streamWarning = null
  }

  return reactive({
    // Config
    streamFrequency,
    streamChunkSize,
    maxDisplaySamples,
    following,

    // State
    isStreaming,
    streamError,
    streamWarning,
    hasStream,
    totalSamples,

    // Skip stats
    totalDmaSkips,
    totalTransmitSkips,
    dmaSkipsPerSec,
    transmitSkipsPerSec,

    // Data
    streamChannels,
    lossRegions,

    // Capability
    canStartStream,

    // Actions
    startStream,
    stopStream,
    clearStream,
    clearError,
    clearWarning,
  })
}

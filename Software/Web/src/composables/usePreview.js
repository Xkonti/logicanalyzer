import { computed, reactive } from 'vue'
import { usePreviewStore } from '../stores/preview.js'
import { useDeviceStore } from '../stores/device.js'
import { useCaptureStore } from '../stores/capture.js'
import { CHANNEL_PALETTE } from '../core/renderer/colors.js'

/** Creates a writable computed that reads/writes a store property. */
function configRef(store, key) {
  return computed({
    get: () => store[key],
    set: (v) => {
      store[key] = v
    },
  })
}

export function usePreview() {
  const preview = usePreviewStore()
  const device = useDeviceStore()
  const capture = useCaptureStore()

  // Config (writable)
  const probingFrequency = configRef(preview, 'probingFrequency')
  const maxDisplaySamples = configRef(preview, 'maxDisplaySamples')
  const following = configRef(preview, 'following')

  // State
  const isPreviewing = computed(() => preview.previewing)
  const previewError = computed(() => preview.previewError)
  const hasPreview = computed(() => preview.hasPreview)
  const totalSamples = computed(() => preview.totalSamples)

  // Data
  const previewChannels = computed(() => preview.previewChannels)

  // Capability
  const canStartPreview = computed(
    () =>
      device.connected &&
      !device.capturing &&
      !device.previewing &&
      capture.channels.length > 0,
  )

  // Actions
  async function startPreview() {
    await preview.startPreview(capture.channels)
  }

  async function stopPreview() {
    await preview.stopPreview()
  }

  function clearPreview() {
    preview.clearPreview()
  }

  function clearError() {
    preview.previewError = null
  }

  function getChannelColor(channelNumber) {
    return CHANNEL_PALETTE[channelNumber % CHANNEL_PALETTE.length]
  }

  function toggleChannelVisibility(channelNumber) {
    const channels = preview.previewChannels
    const ch = channels.find((c) => c.channelNumber === channelNumber)
    if (!ch) return
    ch.hidden = !ch.hidden
    preview.previewChannels = [...channels]
  }

  return reactive({
    // Config (writable)
    probingFrequency,
    maxDisplaySamples,
    following,

    // State
    isPreviewing,
    previewError,
    hasPreview,
    totalSamples,

    // Data
    previewChannels,

    // Capability
    canStartPreview,

    // Actions
    startPreview,
    stopPreview,
    clearPreview,
    clearError,
    getChannelColor,
    toggleChannelVisibility,
  })
}

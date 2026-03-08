import { ref, shallowRef, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { useDeviceStore } from './device.js'
import { useViewportStore } from './viewport.js'
import { createChannel } from '../core/driver/types.js'

export const usePreviewStore = defineStore('preview', () => {
  // Config (persisted via localStorage)
  const probingFrequency = useLocalStorage('la-preview-frequency', 120)
  const maxDisplaySamples = useLocalStorage('la-preview-max-samples', 10000)

  // State
  const previewing = ref(false)
  const previewError = ref(null)
  const previewChannels = shallowRef([])
  const following = ref(true)
  const sampleCount = ref(0)

  // Computed
  const hasPreview = computed(() => previewing.value && previewChannels.value.length > 0)
  const totalSamples = computed(() => sampleCount.value)

  /**
   * Splits probingFrequency into intervalsPerSecond and samplesPerInterval
   * matching the desktop PreviewDialog algorithm.
   */
  function computePreviewParams(freq) {
    let intervalsPerSecond = Math.min(60, freq)
    let samplesPerInterval = Math.max(1, Math.min(16, Math.ceil(freq / intervalsPerSecond)))
    while (intervalsPerSecond * samplesPerInterval < freq && intervalsPerSecond < 60) {
      intervalsPerSecond++
    }
    return { intervalsPerSecond, samplesPerInterval }
  }

  /**
   * Appends preview packet samples to channel buffers.
   * @param {number[][]} packetSamples - samples[sampleIdx][channelIdx] = 0|1
   */
  function addSamples(packetSamples) {
    const channels = previewChannels.value
    if (channels.length === 0 || packetSamples.length === 0) return

    const max = maxDisplaySamples.value
    const newSampleCount = packetSamples.length

    const updated = channels.map((ch, chIdx) => {
      const existing = ch.samples
      const existingLen = existing ? existing.length : 0

      // Build new samples array: existing + new packet data
      const combined = new Uint8Array(existingLen + newSampleCount)
      if (existing) combined.set(existing)
      for (let s = 0; s < newSampleCount; s++) {
        combined[existingLen + s] = packetSamples[s][chIdx]
      }

      // Trim to maxDisplaySamples from the end
      const trimmed = combined.length > max ? combined.slice(combined.length - max) : combined

      return { ...ch, samples: trimmed }
    })

    previewChannels.value = updated
    sampleCount.value = updated[0]?.samples?.length ?? 0

    // Auto-scroll viewport to follow latest data
    if (following.value) {
      const viewport = useViewportStore()
      const total = sampleCount.value
      const visible = viewport.visibleSamples
      viewport.setView(Math.max(0, total - visible), visible)
    }
  }

  async function startPreview(channelsToPreview) {
    const device = useDeviceStore()
    if (!device.driver) {
      previewError.value = 'Not connected'
      return
    }
    if (device.capturing || device.previewing) {
      previewError.value = 'Device is busy'
      return
    }
    if (!channelsToPreview || channelsToPreview.length === 0) {
      previewError.value = 'No channels selected'
      return
    }

    previewError.value = null
    const channelNumbers = channelsToPreview.map((ch) => ch.channelNumber)
    const { intervalsPerSecond, samplesPerInterval } = computePreviewParams(probingFrequency.value)

    // Create channel objects with empty sample buffers
    previewChannels.value = channelsToPreview.map((ch) =>
      createChannel(ch.channelNumber, ch.channelName, ch.channelColor),
    )
    sampleCount.value = 0
    following.value = true

    const started = await device.driver.startPreview(
      { channels: channelNumbers, intervalsPerSecond, samplesPerInterval },
      addSamples,
    )

    if (started) {
      previewing.value = true
      device.previewing = true
    } else {
      previewError.value = 'Failed to start preview'
      previewChannels.value = []
    }
  }

  async function stopPreview() {
    const device = useDeviceStore()
    previewing.value = false
    device.previewing = false

    if (device.driver) {
      await device.driver.stopPreview()
    }

    previewChannels.value = []
    sampleCount.value = 0
  }

  function clearPreview() {
    previewing.value = false
    previewError.value = null
    previewChannels.value = []
    sampleCount.value = 0
    following.value = true
    const device = useDeviceStore()
    device.previewing = false
  }

  return {
    probingFrequency,
    maxDisplaySamples,
    previewing,
    previewError,
    previewChannels,
    following,
    sampleCount,
    hasPreview,
    totalSamples,
    computePreviewParams,
    addSamples,
    startPreview,
    stopPreview,
    clearPreview,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePreviewStore, import.meta.hot))
}

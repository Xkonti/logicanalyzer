import { computed, reactive } from 'vue'
import { useCaptureStore } from '../stores/capture.js'
import { useDeviceStore } from '../stores/device.js'
import {
  TRIGGER_EDGE,
  TRIGGER_COMPLEX,
  TRIGGER_FAST,
  TRIGGER_BLAST,
} from '../core/protocol/commands.js'
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

export function useCapture() {
  const capture = useCaptureStore()
  const device = useDeviceStore()

  // --- Config (writable computed for v-model) ---
  const frequency = configRef(capture, 'frequency')
  const preTriggerSamples = configRef(capture, 'preTriggerSamples')
  const postTriggerSamples = configRef(capture, 'postTriggerSamples')
  const loopCount = configRef(capture, 'loopCount')
  const measureBursts = configRef(capture, 'measureBursts')
  const triggerType = configRef(capture, 'triggerType')
  const triggerChannel = configRef(capture, 'triggerChannel')
  const triggerInverted = configRef(capture, 'triggerInverted')
  const triggerBitCount = configRef(capture, 'triggerBitCount')
  const triggerPattern = configRef(capture, 'triggerPattern')

  // --- Channel state ---
  const channels = computed(() => capture.channels)

  // --- Results ---
  const capturedChannels = computed(() => capture.capturedChannels)
  const bursts = computed(() => capture.bursts)
  const regions = computed(() => capture.regions)
  const captureError = computed(() => capture.captureError)
  const hasCapture = computed(() => capture.hasCapture)
  const totalSamples = computed(() => capture.totalSamples)

  // --- Device-derived ---
  const currentLimits = computed(() => capture.currentLimits)
  const settingsValid = computed(() => capture.settingsValid)
  const isConnected = computed(() => device.connected)
  const isCapturing = computed(() => device.capturing)
  const minFrequency = computed(() => device.driver?.minFrequency ?? 0)
  const maxFrequency = computed(() => device.maxFrequency)
  const blastFrequency = computed(() => device.blastFrequency)
  const channelCount = computed(() => device.channelCount)

  // --- Convenience computed ---
  const canCapture = computed(
    () =>
      device.connected &&
      !device.capturing &&
      !device.previewing &&
      capture.settingsValid &&
      capture.channels.length > 0,
  )
  const canStop = computed(() => device.connected && device.capturing)

  const captureMode = computed(() => {
    const nums = capture.channels.map((c) => c.channelNumber)
    if (nums.length === 0) return 0
    const max = Math.max(...nums)
    return max < 8 ? 0 : max < 16 ? 1 : 2
  })

  const captureModeLabel = computed(() => {
    const labels = ['8 Channel', '16 Channel', '24 Channel']
    return labels[captureMode.value] ?? '8 Channel'
  })

  const isBlastMode = computed(() => capture.triggerType === TRIGGER_BLAST)
  const isEdgeTrigger = computed(() => capture.triggerType === TRIGGER_EDGE)
  const isPatternTrigger = computed(
    () => capture.triggerType === TRIGGER_COMPLEX || capture.triggerType === TRIGGER_FAST,
  )
  const isFastPattern = computed(() => capture.triggerType === TRIGGER_FAST)
  const isBurstMode = computed(() => capture.loopCount > 0)

  // --- Actions ---
  async function startCapture() {
    await capture.startCapture()
  }

  async function stopCapture() {
    await capture.stopCapture()
  }

  async function repeatCapture() {
    await capture.startCapture()
  }

  function addChannel(number, name = '', color = null) {
    capture.addChannel(number, name, color)
  }

  function removeChannel(number) {
    capture.removeChannel(number)
  }

  function toggleChannel(number, name = '') {
    const exists = capture.channels.find((ch) => ch.channelNumber === number)
    if (exists) {
      capture.removeChannel(number)
    } else {
      capture.addChannel(number, name)
    }
  }

  function setAllChannels(enabled) {
    if (enabled) {
      const existing = new Set(capture.channels.map((ch) => ch.channelNumber))
      for (let i = 0; i < device.channelCount; i++) {
        if (!existing.has(i)) {
          capture.addChannel(i)
        }
      }
    } else {
      const numbers = capture.channels.map((ch) => ch.channelNumber)
      for (const num of numbers) {
        capture.removeChannel(num)
      }
    }
  }

  function toggleChannelVisibility(channelNumber) {
    capture.toggleChannelVisibility(channelNumber)
  }

  function clearCapture() {
    capture.clearCapture()
  }

  function clearError() {
    capture.captureError = null
  }

  function getChannelColor(channelNumber) {
    return CHANNEL_PALETTE[channelNumber % CHANNEL_PALETTE.length]
  }

  return reactive({
    // Config (writable)
    frequency,
    preTriggerSamples,
    postTriggerSamples,
    loopCount,
    measureBursts,
    triggerType,
    triggerChannel,
    triggerInverted,
    triggerBitCount,
    triggerPattern,

    // Channel state
    channels,

    // Results
    capturedChannels,
    bursts,
    regions,
    captureError,
    hasCapture,
    totalSamples,

    // Device-derived
    currentLimits,
    settingsValid,
    isConnected,
    isCapturing,
    minFrequency,
    maxFrequency,
    blastFrequency,
    channelCount,

    // Convenience
    canCapture,
    canStop,
    captureMode,
    captureModeLabel,
    isBlastMode,
    isEdgeTrigger,
    isPatternTrigger,
    isFastPattern,
    isBurstMode,

    // Actions
    startCapture,
    stopCapture,
    repeatCapture,
    addChannel,
    removeChannel,
    toggleChannel,
    setAllChannels,
    toggleChannelVisibility,
    clearCapture,
    clearError,
    getChannelColor,
  })
}

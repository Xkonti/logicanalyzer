import { shallowRef, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { useDeviceStore } from './device.js'
import { useChannelConfigStore } from './channel-config.js'
import { createChannel, getTotalSamples } from '../core/driver/types.js'
import { createRegion } from '../core/capture/types.js'
import { parseLac, serializeLac, parseCsv, serializeCsv } from '../core/capture/formats.js'
import { TRIGGER_EDGE } from '../core/protocol/commands.js'

export const useCaptureStore = defineStore('capture', () => {
  // Session config (persisted via localStorage)
  const frequency = useLocalStorage('la-cap-frequency', 1000000)
  const preTriggerSamples = useLocalStorage('la-cap-pre-samples', 100)
  const postTriggerSamples = useLocalStorage('la-cap-post-samples', 1000)
  const loopCount = useLocalStorage('la-cap-loop-count', 0)
  const measureBursts = useLocalStorage('la-cap-measure-bursts', false)
  const triggerType = useLocalStorage('la-cap-trigger-type', TRIGGER_EDGE)
  const triggerChannel = useLocalStorage('la-cap-trigger-channel', 0)
  const triggerInverted = useLocalStorage('la-cap-trigger-inverted', false)
  const triggerBitCount = useLocalStorage('la-cap-trigger-bit-count', 1)
  const triggerPattern = useLocalStorage('la-cap-trigger-pattern', 0)

  // Channels derived from channel-config store
  const channels = computed(() => {
    const config = useChannelConfigStore()
    return config.selectedChannels.map((num) => createChannel(num, config.channelNames[num]))
  })

  // Capture results
  const capturedChannels = shallowRef([])
  const bursts = shallowRef(null)
  const regions = shallowRef([])
  const captureError = shallowRef(null)

  function buildSession() {
    return {
      frequency: frequency.value,
      preTriggerSamples: preTriggerSamples.value,
      postTriggerSamples: postTriggerSamples.value,
      loopCount: loopCount.value,
      measureBursts: measureBursts.value,
      captureChannels: channels.value.map((ch) => ({ ...ch, samples: null })),
      bursts: null,
      triggerType: triggerType.value,
      triggerChannel: triggerChannel.value,
      triggerInverted: triggerInverted.value,
      triggerBitCount: triggerBitCount.value,
      triggerPattern: triggerPattern.value,
    }
  }

  // Getters
  const totalSamples = computed(() => {
    if (capturedChannels.value.length === 0) return 0
    return getTotalSamples({
      preTriggerSamples: preTriggerSamples.value,
      postTriggerSamples: postTriggerSamples.value,
      loopCount: loopCount.value,
    })
  })

  const currentLimits = computed(() => {
    const device = useDeviceStore()
    if (!device.driver) return null
    const channelNumbers = channels.value.map((c) => c.channelNumber)
    if (channelNumbers.length === 0) return null
    return device.driver.getLimits(channelNumbers)
  })

  const settingsValid = computed(() => {
    const device = useDeviceStore()
    if (!device.driver) return false
    if (channels.value.length === 0) return false
    return device.driver.validateSettings(buildSession())
  })

  const hasCapture = computed(() => capturedChannels.value.length > 0)

  const session = computed(() => buildSession())

  // Actions
  async function startCapture() {
    const device = useDeviceStore()
    if (!device.driver) {
      captureError.value = 'Not connected'
      return
    }
    if (device.capturing) {
      captureError.value = 'Already capturing'
      return
    }

    captureError.value = null
    device.capturing = true

    try {
      const sess = buildSession()
      await device.driver.startCapture(sess, (result) => {
        if (result.success) {
          capturedChannels.value = result.session.captureChannels
          bursts.value = result.session.bursts ?? null
          captureError.value = null
        } else {
          captureError.value = result.error || 'Capture failed'
        }
      })
    } catch (err) {
      captureError.value = err.message
    } finally {
      device.capturing = false
    }
  }

  async function stopCapture() {
    const device = useDeviceStore()
    if (!device.driver) return false
    const result = await device.driver.stopCapture()
    device.capturing = false
    return result
  }

  async function loadLac(jsonString) {
    const { session: sess, regions: loadedRegions } = parseLac(jsonString)
    const channelConfig = useChannelConfigStore()

    // Update channel-config from file
    channelConfig.setSelectedChannels(sess.captureChannels.map((ch) => ch.channelNumber))
    for (const ch of sess.captureChannels) {
      if (ch.channelName) channelConfig.setName(ch.channelNumber, ch.channelName)
    }

    frequency.value = sess.frequency
    preTriggerSamples.value = sess.preTriggerSamples
    postTriggerSamples.value = sess.postTriggerSamples
    loopCount.value = sess.loopCount
    measureBursts.value = sess.measureBursts
    triggerType.value = sess.triggerType
    triggerChannel.value = sess.triggerChannel
    triggerInverted.value = sess.triggerInverted
    triggerBitCount.value = sess.triggerBitCount
    triggerPattern.value = sess.triggerPattern

    capturedChannels.value = sess.captureChannels
    bursts.value = sess.bursts
    regions.value = loadedRegions
    captureError.value = null
  }

  async function loadCsv(csvString) {
    const { channels: loadedChannels } = parseCsv(csvString)
    const channelConfig = useChannelConfigStore()

    // Update channel-config from loaded channels
    channelConfig.setSelectedChannels(loadedChannels.map((ch) => ch.channelNumber))
    for (const ch of loadedChannels) {
      if (ch.channelName) channelConfig.setName(ch.channelNumber, ch.channelName)
    }

    capturedChannels.value = loadedChannels
    preTriggerSamples.value = 0
    postTriggerSamples.value = loadedChannels[0]?.samples?.length ?? 0
    loopCount.value = 0
    bursts.value = null
    regions.value = []
    captureError.value = null
  }

  async function exportLac() {
    const sess = {
      frequency: frequency.value,
      preTriggerSamples: preTriggerSamples.value,
      postTriggerSamples: postTriggerSamples.value,
      loopCount: loopCount.value,
      measureBursts: measureBursts.value,
      captureChannels: capturedChannels.value,
      bursts: bursts.value,
      triggerType: triggerType.value,
      triggerChannel: triggerChannel.value,
      triggerInverted: triggerInverted.value,
      triggerBitCount: triggerBitCount.value,
      triggerPattern: triggerPattern.value,
    }
    return serializeLac(sess, regions.value)
  }

  async function exportCsv() {
    const sess = {
      frequency: frequency.value,
      preTriggerSamples: preTriggerSamples.value,
      postTriggerSamples: postTriggerSamples.value,
      loopCount: loopCount.value,
      captureChannels: capturedChannels.value,
    }
    return serializeCsv(sess)
  }

  async function updateConfig(partial) {
    if ('frequency' in partial) frequency.value = partial.frequency
    if ('preTriggerSamples' in partial) preTriggerSamples.value = partial.preTriggerSamples
    if ('postTriggerSamples' in partial) postTriggerSamples.value = partial.postTriggerSamples
    if ('loopCount' in partial) loopCount.value = partial.loopCount
    if ('measureBursts' in partial) measureBursts.value = partial.measureBursts
    if ('triggerType' in partial) triggerType.value = partial.triggerType
    if ('triggerChannel' in partial) triggerChannel.value = partial.triggerChannel
    if ('triggerInverted' in partial) triggerInverted.value = partial.triggerInverted
    if ('triggerBitCount' in partial) triggerBitCount.value = partial.triggerBitCount
    if ('triggerPattern' in partial) triggerPattern.value = partial.triggerPattern
  }

  async function addRegion(firstSample, lastSample, name = '', color = undefined) {
    regions.value = [...regions.value, createRegion(firstSample, lastSample, name, color)]
  }

  async function removeRegion(index) {
    regions.value = regions.value.filter((_, i) => i !== index)
  }

  async function toggleChannelVisibility(channelNumber) {
    const channels = capturedChannels.value
    const ch = channels.find((c) => c.channelNumber === channelNumber)
    if (!ch) return
    ch.hidden = !ch.hidden
    capturedChannels.value = [...channels]
  }

  async function clearCapture() {
    capturedChannels.value = []
    bursts.value = null
    regions.value = []
    captureError.value = null
  }

  return {
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
    channels,
    capturedChannels,
    bursts,
    regions,
    captureError,
    totalSamples,
    currentLimits,
    settingsValid,
    hasCapture,
    session,
    startCapture,
    stopCapture,
    loadLac,
    loadCsv,
    exportLac,
    exportCsv,
    updateConfig,
    addRegion,
    removeRegion,
    toggleChannelVisibility,
    clearCapture,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCaptureStore, import.meta.hot))
}

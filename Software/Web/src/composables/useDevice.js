import { ref, computed } from 'vue'
import { useDeviceStore } from '../stores/device.js'
import { webSerialAvailable } from '../boot/webserial.js'

export function useDevice() {
  const store = useDeviceStore()
  const connecting = ref(false)

  const isWebSerialAvailable = computed(() => webSerialAvailable.value)
  const isConnected = computed(() => store.connected)
  const isCapturing = computed(() => store.capturing)
  const deviceInfo = computed(() => store.deviceInfo)
  const error = computed(() => store.error)

  const deviceVersion = computed(() => store.version)
  const channelCount = computed(() => store.channelCount)
  const maxFrequency = computed(() => store.maxFrequency)
  const bufferSize = computed(() => store.bufferSize)

  async function connect() {
    connecting.value = true
    try {
      await store.connect()
    } finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    await store.disconnect()
  }

  function clearError() {
    store.error = null
  }

  async function blinkLed() {
    return await store.blinkLed()
  }

  async function stopBlinkLed() {
    return await store.stopBlinkLed()
  }

  async function enterBootloader() {
    return await store.enterBootloader()
  }

  return {
    isWebSerialAvailable,
    isConnected,
    isCapturing,
    connecting,
    deviceInfo,
    error,
    deviceVersion,
    channelCount,
    maxFrequency,
    bufferSize,
    connect,
    disconnect,
    clearError,
    blinkLed,
    stopBlinkLed,
    enterBootloader,
  }
}

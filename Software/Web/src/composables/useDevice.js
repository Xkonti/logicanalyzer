import { ref, computed, reactive } from 'vue'
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
  const transportType = computed(() => store.transportType)

  async function connect() {
    connecting.value = true
    try {
      await store.connect()
    } finally {
      connecting.value = false
    }
  }

  async function connectWiFi(host, port) {
    connecting.value = true
    try {
      await store.connect({ type: 'websocket', host, port })
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

  async function sendNetworkConfig(config) {
    return await store.sendNetworkConfig(config)
  }

  return reactive({
    isWebSerialAvailable,
    isConnected,
    isCapturing,
    connecting,
    transportType,
    deviceInfo,
    error,
    deviceVersion,
    channelCount,
    maxFrequency,
    bufferSize,
    connect,
    connectWiFi,
    disconnect,
    clearError,
    blinkLed,
    stopBlinkLed,
    enterBootloader,
    sendNetworkConfig,
  })
}

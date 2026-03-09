import { ref, shallowRef, computed, markRaw } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { AnalyzerDriver } from '../core/driver/analyzer.js'
import { SerialTransport } from '../core/transport/serial.js'

export const useDeviceStore = defineStore('device', () => {
  const driver = shallowRef(null)
  const connected = ref(false)
  const capturing = ref(false)
  const previewing = ref(false)
  const streaming = ref(false)
  const deviceInfo = ref(null)
  const error = ref(null)

  // Getters
  const version = computed(() => deviceInfo.value?.name ?? null)
  const maxFrequency = computed(() => deviceInfo.value?.maxFrequency ?? 0)
  const blastFrequency = computed(() => deviceInfo.value?.blastFrequency ?? 0)
  const channelCount = computed(() => deviceInfo.value?.channels ?? 0)
  const bufferSize = computed(() => deviceInfo.value?.bufferSize ?? 0)

  async function connect(transportOptions = {}) {
    error.value = null

    if (connected.value) {
      await disconnect()
    }

    try {
      const transport = markRaw(new SerialTransport(transportOptions))
      await transport.connect()

      const drv = markRaw(new AnalyzerDriver())
      await drv.connect(transport)

      driver.value = drv
      connected.value = true
      deviceInfo.value = drv.getDeviceInfo()
    } catch (err) {
      driver.value = null
      connected.value = false
      deviceInfo.value = null
      error.value = err.message
    }
  }

  async function disconnect() {
    if (driver.value) {
      try {
        await driver.value.disconnect()
      } catch {
        // ignore disconnect errors
      }
    }
    driver.value = null
    connected.value = false
    capturing.value = false
    previewing.value = false
    streaming.value = false
    deviceInfo.value = null
    error.value = null
  }

  async function blinkLed() {
    if (!driver.value) {
      error.value = 'Not connected'
      return false
    }
    error.value = null
    return await driver.value.blinkLed()
  }

  async function stopBlinkLed() {
    if (!driver.value) {
      error.value = 'Not connected'
      return false
    }
    error.value = null
    return await driver.value.stopBlinkLed()
  }

  async function enterBootloader() {
    if (!driver.value) {
      error.value = 'Not connected'
      return false
    }
    error.value = null
    const result = await driver.value.enterBootloader()
    if (result) {
      // Device is rebooting
      await disconnect()
    }
    return result
  }

  return {
    driver,
    connected,
    capturing,
    previewing,
    streaming,
    deviceInfo,
    error,
    version,
    maxFrequency,
    blastFrequency,
    channelCount,
    bufferSize,
    connect,
    disconnect,
    blinkLed,
    stopBlinkLed,
    enterBootloader,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDeviceStore, import.meta.hot))
}

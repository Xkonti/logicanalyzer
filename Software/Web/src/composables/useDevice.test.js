import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDevice } from './useDevice.js'

// Mock core modules (same pattern as device.test.js)
vi.mock('../core/driver/analyzer.js', () => {
  class MockAnalyzerDriver {
    _connected = false
    get connected() {
      return this._connected
    }
    async connect() {
      this._connected = true
    }
    async disconnect() {
      this._connected = false
    }
    getDeviceInfo() {
      return {
        name: 'ANALYZER_V6_5',
        maxFrequency: 100000000,
        blastFrequency: 200000000,
        channels: 24,
        bufferSize: 262144,
        modeLimits: [{}, {}, {}],
      }
    }
    async blinkLed() {
      return true
    }
    async stopBlinkLed() {
      return true
    }
    async enterBootloader() {
      return true
    }
  }
  return { AnalyzerDriver: MockAnalyzerDriver }
})

vi.mock('../core/transport/serial.js', () => {
  class MockSerialTransport {
    _connected = false
    get connected() {
      return this._connected
    }
    async connect() {
      this._connected = true
    }
    async disconnect() {
      this._connected = false
    }
  }
  return { SerialTransport: MockSerialTransport }
})

vi.mock('../boot/webserial.js', async () => {
  const { ref } = await import('vue')
  return { webSerialAvailable: ref(true) }
})

describe('useDevice', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('reflects initial disconnected state', () => {
    const device = useDevice()
    expect(device.isConnected).toBe(false)
    expect(device.isCapturing).toBe(false)
    expect(device.connecting).toBe(false)
    expect(device.deviceInfo).toBeNull()
    expect(device.error).toBeNull()
    expect(device.deviceVersion).toBeNull()
    expect(device.channelCount).toBe(0)
    expect(device.maxFrequency).toBe(0)
    expect(device.bufferSize).toBe(0)
  })

  it('reflects isWebSerialAvailable from boot ref', async () => {
    const { webSerialAvailable } = await import('../boot/webserial.js')
    webSerialAvailable.value = true
    const device = useDevice()
    expect(device.isWebSerialAvailable).toBe(true)

    webSerialAvailable.value = false
    expect(device.isWebSerialAvailable).toBe(false)

    webSerialAvailable.value = true
  })

  describe('connect', () => {
    it('delegates to store and manages connecting state', async () => {
      const device = useDevice()
      expect(device.connecting).toBe(false)

      const promise = device.connect()
      expect(device.connecting).toBe(true)

      await promise
      expect(device.connecting).toBe(false)
      expect(device.isConnected).toBe(true)
    })

    it('sets connecting to false even on error', async () => {
      const { SerialTransport } = await import('../core/transport/serial.js')
      const origConnect = SerialTransport.prototype.connect
      SerialTransport.prototype.connect = async function () {
        throw new Error('Port not found')
      }

      const device = useDevice()
      await device.connect()
      expect(device.connecting).toBe(false)
      expect(device.error).toBe('Port not found')

      SerialTransport.prototype.connect = origConnect
    })

    it('populates device info after connection', async () => {
      const device = useDevice()
      await device.connect()

      expect(device.deviceVersion).toBe('ANALYZER_V6_5')
      expect(device.channelCount).toBe(24)
      expect(device.maxFrequency).toBe(100000000)
      expect(device.bufferSize).toBe(262144)
    })
  })

  describe('disconnect', () => {
    it('delegates to store', async () => {
      const device = useDevice()
      await device.connect()
      expect(device.isConnected).toBe(true)

      await device.disconnect()
      expect(device.isConnected).toBe(false)
    })
  })

  describe('clearError', () => {
    it('clears the error', async () => {
      const { SerialTransport } = await import('../core/transport/serial.js')
      const origConnect = SerialTransport.prototype.connect
      SerialTransport.prototype.connect = async function () {
        throw new Error('Something went wrong')
      }

      const device = useDevice()
      await device.connect()
      expect(device.error).toBe('Something went wrong')

      device.clearError()
      expect(device.error).toBeNull()

      SerialTransport.prototype.connect = origConnect
    })
  })

  describe('device actions', () => {
    it('blinkLed delegates to store', async () => {
      const device = useDevice()
      await device.connect()
      const result = await device.blinkLed()
      expect(result).toBe(true)
    })

    it('stopBlinkLed delegates to store', async () => {
      const device = useDevice()
      await device.connect()
      const result = await device.stopBlinkLed()
      expect(result).toBe(true)
    })

    it('enterBootloader delegates to store', async () => {
      const device = useDevice()
      await device.connect()
      const result = await device.enterBootloader()
      expect(result).toBe(true)
      expect(device.isConnected).toBe(false)
    })
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDeviceStore } from './device.js'
import { isProxy } from 'vue'

// Mock the core modules
vi.mock('../core/driver/analyzer.js', () => {
  class MockAnalyzerDriver {
    _connected = false
    _capturing = false
    _blinkResult = true
    _stopBlinkResult = true
    _bootloaderResult = true

    get connected() {
      return this._connected
    }
    get capturing() {
      return this._capturing
    }

    async connect(transport) {
      this._connected = true
      this._transport = transport
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
      return this._blinkResult
    }
    async stopBlinkLed() {
      return this._stopBlinkResult
    }
    async enterBootloader() {
      return this._bootloaderResult
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

describe('useDeviceStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has correct initial state', () => {
    const device = useDeviceStore()
    expect(device.driver).toBeNull()
    expect(device.connected).toBe(false)
    expect(device.capturing).toBe(false)
    expect(device.deviceInfo).toBeNull()
    expect(device.error).toBeNull()
  })

  it('computes getters as 0/null when disconnected', () => {
    const device = useDeviceStore()
    expect(device.version).toBeNull()
    expect(device.maxFrequency).toBe(0)
    expect(device.blastFrequency).toBe(0)
    expect(device.channelCount).toBe(0)
    expect(device.bufferSize).toBe(0)
  })

  describe('connect', () => {
    it('sets connected state and device info', async () => {
      const device = useDeviceStore()
      await device.connect()

      expect(device.connected).toBe(true)
      expect(device.driver).not.toBeNull()
      expect(device.deviceInfo).not.toBeNull()
      expect(device.error).toBeNull()
    })

    it('populates getters from device info', async () => {
      const device = useDeviceStore()
      await device.connect()

      expect(device.version).toBe('ANALYZER_V6_5')
      expect(device.maxFrequency).toBe(100000000)
      expect(device.blastFrequency).toBe(200000000)
      expect(device.channelCount).toBe(24)
      expect(device.bufferSize).toBe(262144)
    })

    it('stores driver without Proxy (markRaw)', async () => {
      const device = useDeviceStore()
      await device.connect()

      expect(isProxy(device.driver)).toBe(false)
    })

    it('disconnects first if already connected', async () => {
      const device = useDeviceStore()
      await device.connect()
      const firstDriver = device.driver

      await device.connect()
      expect(device.driver).not.toBe(firstDriver)
      expect(device.connected).toBe(true)
    })
  })

  describe('disconnect', () => {
    it('clears all state', async () => {
      const device = useDeviceStore()
      await device.connect()
      await device.disconnect()

      expect(device.driver).toBeNull()
      expect(device.connected).toBe(false)
      expect(device.capturing).toBe(false)
      expect(device.deviceInfo).toBeNull()
      expect(device.error).toBeNull()
    })

    it('is safe to call when not connected', async () => {
      const device = useDeviceStore()
      await device.disconnect()
      expect(device.connected).toBe(false)
    })
  })

  describe('blinkLed', () => {
    it('returns true on success', async () => {
      const device = useDeviceStore()
      await device.connect()
      const result = await device.blinkLed()
      expect(result).toBe(true)
    })

    it('returns false and sets error when not connected', async () => {
      const device = useDeviceStore()
      const result = await device.blinkLed()
      expect(result).toBe(false)
      expect(device.error).toBe('Not connected')
    })
  })

  describe('stopBlinkLed', () => {
    it('returns true on success', async () => {
      const device = useDeviceStore()
      await device.connect()
      const result = await device.stopBlinkLed()
      expect(result).toBe(true)
    })
  })

  describe('enterBootloader', () => {
    it('returns true and disconnects on success', async () => {
      const device = useDeviceStore()
      await device.connect()
      const result = await device.enterBootloader()
      expect(result).toBe(true)
      // Should auto-disconnect since device is rebooting
      expect(device.connected).toBe(false)
      expect(device.driver).toBeNull()
    })

    it('returns false when not connected', async () => {
      const device = useDeviceStore()
      const result = await device.enterBootloader()
      expect(result).toBe(false)
    })
  })

  describe('error handling', () => {
    it('sets error on connect failure', async () => {
      // Override the mock to throw
      const { SerialTransport } = await import('../core/transport/serial.js')
      const origConnect = SerialTransport.prototype.connect
      SerialTransport.prototype.connect = async function () {
        throw new Error('Port not found')
      }

      const device = useDeviceStore()
      await device.connect()

      expect(device.connected).toBe(false)
      expect(device.error).toBe('Port not found')
      expect(device.driver).toBeNull()

      // Restore
      SerialTransport.prototype.connect = origConnect
    })

    it('clears error on successful action', async () => {
      const device = useDeviceStore()
      device.error = 'Previous error'
      await device.connect()
      expect(device.error).toBeNull()
    })
  })
})

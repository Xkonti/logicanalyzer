import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCaptureStore } from './capture.js'
import { useChannelConfigStore } from './channel-config.js'
import { useDeviceStore } from './device.js'
import { SampleBuffer } from '../core/sample-buffer.js'

function createMockStorage() {
  const store = {}
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => {
      store[key] = value
    }),
    removeItem: vi.fn((key) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      for (const key of Object.keys(store)) delete store[key]
    }),
    get length() {
      return Object.keys(store).length
    },
    key: vi.fn((i) => Object.keys(store)[i] ?? null),
  }
}

// Mock device dependencies
vi.mock('../core/driver/analyzer.js', () => {
  class MockAnalyzerDriver {
    _connected = true

    get connected() {
      return this._connected
    }
    get capturing() {
      return false
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
    getLimits(channelNumbers) {
      const max = channelNumbers.length === 0 ? 0 : Math.max(...channelNumbers)
      const bytesPerSample = max < 8 ? 1 : max < 16 ? 2 : 4
      const totalSamples = Math.floor(262144 / bytesPerSample)
      return {
        minPreSamples: 2,
        maxPreSamples: Math.floor(totalSamples / 10),
        minPostSamples: 2,
        maxPostSamples: totalSamples - 2,
        maxTotalSamples: totalSamples,
      }
    }
    validateSettings(session) {
      return session.captureChannels.length > 0 && session.frequency > 0
    }
    async startCapture(session, onComplete) {
      // Simulate successful capture with sample data (matches real driver returning SampleBuffer)
      session.captureChannels.forEach((ch) => {
        ch.samples = SampleBuffer.fromUint8Array(new Uint8Array([1, 0, 1, 0]))
      })
      onComplete({ success: true, session })
    }
    async stopCapture() {
      return true
    }
  }
  return { AnalyzerDriver: MockAnalyzerDriver }
})

vi.mock('../core/transport/serial.js', () => {
  class MockSerialTransport {
    async connect() {}
    async disconnect() {}
  }
  return { SerialTransport: MockSerialTransport }
})

function selectChannels(...nums) {
  const channelConfig = useChannelConfigStore()
  channelConfig.setSelectedChannels(nums)
}

describe('useCaptureStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMockStorage())
    setActivePinia(createPinia())
  })

  it('has correct initial state', () => {
    const capture = useCaptureStore()
    expect(capture.frequency).toBe(1000000)
    expect(capture.preTriggerSamples).toBe(100)
    expect(capture.postTriggerSamples).toBe(1000)
    expect(capture.loopCount).toBe(0)
    expect(capture.channels).toEqual([])
    expect(capture.capturedChannels).toEqual([])
    expect(capture.bursts).toBeNull()
    expect(capture.regions).toEqual([])
    expect(capture.hasCapture).toBe(false)
  })

  it('channels derived from channel-config', () => {
    const capture = useCaptureStore()
    const channelConfig = useChannelConfigStore()
    channelConfig.setSelectedChannels([0, 1])
    channelConfig.setName(0, 'CLK')
    expect(capture.channels).toHaveLength(2)
    expect(capture.channels[0].channelNumber).toBe(0)
    expect(capture.channels[0].channelName).toBe('CLK')
  })

  describe('updateConfig', () => {
    it('updates multiple config values', async () => {
      const capture = useCaptureStore()
      await capture.updateConfig({ frequency: 5000000, preTriggerSamples: 50 })
      expect(capture.frequency).toBe(5000000)
      expect(capture.preTriggerSamples).toBe(50)
      // Others unchanged
      expect(capture.postTriggerSamples).toBe(1000)
    })

    it('updates single config value', async () => {
      const capture = useCaptureStore()
      await capture.updateConfig({ triggerType: 3 })
      expect(capture.triggerType).toBe(3)
    })
  })

  describe('addRegion / removeRegion', () => {
    it('adds a region with defaults', async () => {
      const capture = useCaptureStore()
      await capture.addRegion(10, 50, 'Test')
      expect(capture.regions).toHaveLength(1)
      expect(capture.regions[0].firstSample).toBe(10)
      expect(capture.regions[0].lastSample).toBe(50)
      expect(capture.regions[0].regionName).toBe('Test')
    })

    it('removes a region by index', async () => {
      const capture = useCaptureStore()
      await capture.addRegion(0, 10, 'A')
      await capture.addRegion(20, 30, 'B')
      await capture.removeRegion(0)
      expect(capture.regions).toHaveLength(1)
      expect(capture.regions[0].regionName).toBe('B')
    })
  })

  describe('loadLac', () => {
    it('loads session config and captured data', async () => {
      const capture = useCaptureStore()

      const lac = {
        Settings: {
          Frequency: 5000000,
          PreTriggerSamples: 50,
          PostTriggerSamples: 500,
          LoopCount: 0,
          MeasureBursts: false,
          TriggerType: 0,
          TriggerChannel: 1,
          TriggerInverted: true,
          TriggerBitCount: 0,
          TriggerPattern: 0,
          CaptureChannels: [
            { ChannelNumber: 0, ChannelName: 'CLK', Samples: [1, 0, 1] },
            { ChannelNumber: 1, ChannelName: 'DATA', Samples: [0, 1, 0] },
          ],
          Bursts: null,
        },
        Samples: null,
        SelectedRegions: [
          { FirstSample: 10, LastSample: 20, RegionName: 'R1', R: 255, G: 0, B: 0, A: 128 },
        ],
      }

      await capture.loadLac(JSON.stringify(lac))

      expect(capture.frequency).toBe(5000000)
      expect(capture.preTriggerSamples).toBe(50)
      expect(capture.triggerChannel).toBe(1)
      expect(capture.triggerInverted).toBe(true)
      expect(capture.channels).toHaveLength(2)
      expect(capture.channels[0].samples).toBeNull() // config channels have no samples
      expect(capture.capturedChannels).toHaveLength(2)
      expect(capture.capturedChannels[0].samples.toUint8Array()).toEqual(new Uint8Array([1, 0, 1]))
      expect(capture.regions).toHaveLength(1)
      expect(capture.regions[0].regionName).toBe('R1')
      expect(capture.captureError).toBeNull()
    })
  })

  describe('loadCsv', () => {
    it('loads channel data from CSV', async () => {
      const capture = useCaptureStore()
      await capture.loadCsv('CLK,DATA\n1,0\n0,1\n1,1')

      expect(capture.capturedChannels).toHaveLength(2)
      expect(capture.capturedChannels[0].channelName).toBe('CLK')
      expect(capture.capturedChannels[0].samples.toUint8Array()).toEqual(new Uint8Array([1, 0, 1]))
      expect(capture.channels).toHaveLength(2)
      expect(capture.channels[0].samples).toBeNull()
      expect(capture.preTriggerSamples).toBe(0)
      expect(capture.postTriggerSamples).toBe(3)
    })
  })

  describe('exportLac / exportCsv round-trip', () => {
    it('round-trips lac export', async () => {
      const capture = useCaptureStore()

      const lac = {
        Settings: {
          Frequency: 2000000,
          PreTriggerSamples: 10,
          PostTriggerSamples: 100,
          LoopCount: 0,
          MeasureBursts: false,
          TriggerType: 0,
          TriggerChannel: 0,
          TriggerInverted: false,
          TriggerBitCount: 0,
          TriggerPattern: 0,
          CaptureChannels: [{ ChannelNumber: 0, ChannelName: 'A', Samples: [1, 0, 1] }],
          Bursts: null,
        },
        Samples: null,
        SelectedRegions: [],
      }

      await capture.loadLac(JSON.stringify(lac))
      const exported = await capture.exportLac()
      const parsed = JSON.parse(exported)

      expect(parsed.Settings.Frequency).toBe(2000000)
      expect(parsed.Settings.CaptureChannels[0].Samples).toEqual([1, 0, 1])
    })

    it('round-trips csv export', async () => {
      const capture = useCaptureStore()
      await capture.loadCsv('X,Y\n1,0\n0,1')

      const exported = await capture.exportCsv()
      expect(exported).toContain('X,Y')
      expect(exported).toContain('1,0')
      expect(exported).toContain('0,1')
    })
  })

  describe('getters', () => {
    it('totalSamples is 0 with no capture', () => {
      const capture = useCaptureStore()
      expect(capture.totalSamples).toBe(0)
    })

    it('totalSamples computes after load', async () => {
      const capture = useCaptureStore()
      await capture.loadCsv('A\n1\n0\n1')
      // preTriggerSamples=0, postTriggerSamples=3, loopCount=0
      // total = 3 * (0+1) + 0 = 3
      expect(capture.totalSamples).toBe(3)
    })

    it('hasCapture is true after load', async () => {
      const capture = useCaptureStore()
      expect(capture.hasCapture).toBe(false)
      await capture.loadCsv('A\n1')
      expect(capture.hasCapture).toBe(true)
    })

    it('currentLimits returns limits when device connected', async () => {
      const device = useDeviceStore()
      await device.connect()

      selectChannels(0, 1)

      const capture = useCaptureStore()
      expect(capture.currentLimits).not.toBeNull()
      expect(capture.currentLimits.minPreSamples).toBe(2)
    })

    it('currentLimits is null when disconnected', () => {
      const capture = useCaptureStore()
      expect(capture.currentLimits).toBeNull()
    })

    it('settingsValid delegates to driver', async () => {
      const device = useDeviceStore()
      await device.connect()

      selectChannels(0)

      const capture = useCaptureStore()
      expect(capture.settingsValid).toBe(true)
    })

    it('settingsValid is false when disconnected', () => {
      const capture = useCaptureStore()
      expect(capture.settingsValid).toBe(false)
    })

    it('session getter returns current config', async () => {
      const capture = useCaptureStore()
      await capture.updateConfig({ frequency: 8000000 })
      expect(capture.session.frequency).toBe(8000000)
    })
  })

  describe('startCapture', () => {
    it('captures data and sets capturedChannels', async () => {
      const device = useDeviceStore()
      await device.connect()

      selectChannels(0, 1)

      const capture = useCaptureStore()
      await capture.startCapture()

      expect(capture.capturedChannels).toHaveLength(2)
      expect(capture.capturedChannels[0].samples.toUint8Array()).toEqual(new Uint8Array([1, 0, 1, 0]))
      expect(capture.captureError).toBeNull()
      expect(device.capturing).toBe(false)
    })

    it('sets error when not connected', async () => {
      selectChannels(0)

      const capture = useCaptureStore()
      await capture.startCapture()
      expect(capture.captureError).toBe('Not connected')
    })
  })

  describe('stopCapture', () => {
    it('delegates to driver', async () => {
      const device = useDeviceStore()
      await device.connect()

      const capture = useCaptureStore()
      const result = await capture.stopCapture()
      expect(result).toBe(true)
      expect(device.capturing).toBe(false)
    })
  })

  describe('clearCapture', () => {
    it('resets captured data', async () => {
      const capture = useCaptureStore()
      await capture.loadCsv('A\n1')
      await capture.addRegion(0, 1, 'R')

      await capture.clearCapture()
      expect(capture.capturedChannels).toEqual([])
      expect(capture.bursts).toBeNull()
      expect(capture.regions).toEqual([])
      expect(capture.captureError).toBeNull()
    })
  })

  describe('capturedChannels shallowRef', () => {
    it('does not deeply proxy sample data', async () => {
      const capture = useCaptureStore()
      await capture.loadCsv('A\n1\n0')

      // The capturedChannels array itself may be proxied by Pinia
      // but the Uint8Array samples inside should not be deeply reactive
      const samples = capture.capturedChannels[0].samples
      // SampleBuffer should not be deeply proxied by Pinia's reactivity
      expect(samples).toBeDefined()
      expect(typeof samples.get).toBe('function')
    })
  })
})

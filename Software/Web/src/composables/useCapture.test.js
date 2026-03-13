import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCapture } from './useCapture.js'
import { useDeviceStore } from '../stores/device.js'
import { useCaptureStore } from '../stores/capture.js'
import { useChannelConfigStore } from '../stores/channel-config.js'

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

vi.mock('../core/driver/analyzer.js', () => {
  class MockAnalyzerDriver {
    _connected = false
    get connected() {
      return this._connected
    }
    get minFrequency() {
      return 3100
    }
    get maxFrequency() {
      return 100000000
    }
    get blastFrequency() {
      return 200000000
    }
    async connect() {
      this._connected = true
    }
    async disconnect() {
      this._connected = false
    }
    getDeviceInfo() {
      return {
        name: 'LA-7.0.0',
        maxFrequency: 100000000,
        blastFrequency: 200000000,
        channels: 24,
        bufferSize: 262144,
        modeLimits: [{}, {}, {}],
      }
    }
    getLimits(channelNumbers) {
      const maxCh = Math.max(...channelNumbers)
      const bytesPerSample = maxCh < 8 ? 1 : maxCh < 16 ? 2 : 4
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
    getCaptureMode(channelNumbers) {
      const max = Math.max(...channelNumbers)
      return max < 8 ? 0 : max < 16 ? 1 : 2
    }
    async startCapture(session, onComplete) {
      for (const ch of session.captureChannels) {
        ch.samples = new Uint8Array([1, 0, 1, 0])
      }
      onComplete({ success: true, session })
    }
    async stopCapture() {
      return true
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

async function connectDevice() {
  const device = useDeviceStore()
  await device.connect()
}

function selectChannels(...nums) {
  const channelConfig = useChannelConfigStore()
  channelConfig.setSelectedChannels(nums)
}

describe('useCapture', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMockStorage())
    setActivePinia(createPinia())
  })

  it('reflects initial disconnected state', () => {
    const cap = useCapture()
    expect(cap.frequency).toBe(1000000)
    expect(cap.preTriggerSamples).toBe(100)
    expect(cap.postTriggerSamples).toBe(1000)
    expect(cap.loopCount).toBe(0)
    expect(cap.measureBursts).toBe(false)
    expect(cap.triggerType).toBe(0) // TRIGGER_EDGE
    expect(cap.triggerChannel).toBe(0)
    expect(cap.triggerInverted).toBe(false)
    expect(cap.channels).toEqual([])
    expect(cap.hasCapture).toBe(false)
    expect(cap.isConnected).toBe(false)
    expect(cap.isCapturing).toBe(false)
    expect(cap.canCapture).toBe(false)
    expect(cap.currentLimits).toBeNull()
  })

  describe('config binding', () => {
    it('frequency is writable and updates store', () => {
      const cap = useCapture()
      const store = useCaptureStore()
      cap.frequency = 5000000
      expect(store.frequency).toBe(5000000)
      expect(cap.frequency).toBe(5000000)
    })

    it('triggerType is writable', () => {
      const cap = useCapture()
      cap.triggerType = 1 // TRIGGER_COMPLEX
      expect(cap.triggerType).toBe(1)
      expect(cap.isPatternTrigger).toBe(true)
      expect(cap.isEdgeTrigger).toBe(false)
    })

    it('loopCount is writable', () => {
      const cap = useCapture()
      cap.loopCount = 5
      expect(cap.loopCount).toBe(5)
      expect(cap.isBurstMode).toBe(true)
    })
  })

  describe('canCapture', () => {
    it('is false when disconnected', () => {
      const cap = useCapture()
      expect(cap.canCapture).toBe(false)
    })

    it('is false when no channels selected', async () => {
      await connectDevice()
      const cap = useCapture()
      expect(cap.canCapture).toBe(false)
    })

    it('is true when connected with valid settings', async () => {
      await connectDevice()
      selectChannels(0)
      const cap = useCapture()
      expect(cap.canCapture).toBe(true)
    })

    it('is false when capturing', async () => {
      await connectDevice()
      selectChannels(0)
      const cap = useCapture()
      const device = useDeviceStore()
      device.capturing = true
      expect(cap.canCapture).toBe(false)
    })
  })

  describe('canStop', () => {
    it('is false when not capturing', async () => {
      await connectDevice()
      const cap = useCapture()
      expect(cap.canStop).toBe(false)
    })

    it('is true when capturing', async () => {
      await connectDevice()
      const cap = useCapture()
      const device = useDeviceStore()
      device.capturing = true
      expect(cap.canStop).toBe(true)
    })
  })

  describe('channels from channel-config', () => {
    it('reflects channel-config selection', () => {
      const cap = useCapture()
      selectChannels(3)
      expect(cap.channels).toHaveLength(1)
      expect(cap.channels[0].channelNumber).toBe(3)
    })

    it('reflects channel names from channel-config', () => {
      const channelConfig = useChannelConfigStore()
      channelConfig.setName(3, 'CLK')
      selectChannels(3)
      const cap = useCapture()
      expect(cap.channels[0].channelName).toBe('CLK')
    })
  })

  describe('captureMode', () => {
    it('is 0 when no channels', () => {
      const cap = useCapture()
      expect(cap.captureMode).toBe(0)
    })

    it('is 0 (8ch) when max channel < 8', () => {
      selectChannels(0, 7)
      const cap = useCapture()
      expect(cap.captureMode).toBe(0)
      expect(cap.captureModeLabel).toBe('8 Channel')
    })

    it('is 1 (16ch) when max channel 8-15', () => {
      selectChannels(0, 10)
      const cap = useCapture()
      expect(cap.captureMode).toBe(1)
      expect(cap.captureModeLabel).toBe('16 Channel')
    })

    it('is 2 (24ch) when max channel >= 16', () => {
      selectChannels(0, 20)
      const cap = useCapture()
      expect(cap.captureMode).toBe(2)
      expect(cap.captureModeLabel).toBe('24 Channel')
    })
  })

  describe('convenience computed', () => {
    it('isBlastMode reflects triggerType', () => {
      const cap = useCapture()
      expect(cap.isBlastMode).toBe(false)
      cap.triggerType = 3 // TRIGGER_BLAST
      expect(cap.isBlastMode).toBe(true)
    })

    it('isEdgeTrigger reflects triggerType', () => {
      const cap = useCapture()
      expect(cap.isEdgeTrigger).toBe(true)
      cap.triggerType = 1
      expect(cap.isEdgeTrigger).toBe(false)
    })

    it('isPatternTrigger for COMPLEX and FAST', () => {
      const cap = useCapture()
      cap.triggerType = 1 // COMPLEX
      expect(cap.isPatternTrigger).toBe(true)
      cap.triggerType = 2 // FAST
      expect(cap.isPatternTrigger).toBe(true)
      cap.triggerType = 0 // EDGE
      expect(cap.isPatternTrigger).toBe(false)
    })

    it('isFastPattern only for FAST', () => {
      const cap = useCapture()
      cap.triggerType = 2
      expect(cap.isFastPattern).toBe(true)
      cap.triggerType = 1
      expect(cap.isFastPattern).toBe(false)
    })

    it('isBurstMode reflects loopCount', () => {
      const cap = useCapture()
      expect(cap.isBurstMode).toBe(false)
      cap.loopCount = 3
      expect(cap.isBurstMode).toBe(true)
    })
  })

  describe('device-derived state', () => {
    it('reflects device connection', async () => {
      const cap = useCapture()
      expect(cap.isConnected).toBe(false)
      expect(cap.channelCount).toBe(0)
      expect(cap.maxFrequency).toBe(0)

      await connectDevice()
      expect(cap.isConnected).toBe(true)
      expect(cap.channelCount).toBe(24)
      expect(cap.maxFrequency).toBe(100000000)
      expect(cap.blastFrequency).toBe(200000000)
    })

    it('currentLimits available after connect with channels', async () => {
      await connectDevice()
      const cap = useCapture()
      expect(cap.currentLimits).toBeNull() // no channels yet
      selectChannels(0)
      expect(cap.currentLimits).not.toBeNull()
      expect(cap.currentLimits.minPreSamples).toBe(2)
    })
  })

  describe('startCapture', () => {
    it('populates capturedChannels on success', async () => {
      await connectDevice()
      selectChannels(0)
      const channelConfig = useChannelConfigStore()
      channelConfig.setName(0, 'CH0')
      const cap = useCapture()
      await cap.startCapture()
      expect(cap.hasCapture).toBe(true)
      expect(cap.capturedChannels).toHaveLength(1)
      expect(cap.capturedChannels[0].samples).toBeInstanceOf(Uint8Array)
    })

    it('sets error when not connected', async () => {
      selectChannels(0)
      const cap = useCapture()
      await cap.startCapture()
      expect(cap.captureError).toBe('Not connected')
    })
  })

  describe('clearCapture', () => {
    it('resets captured data', async () => {
      await connectDevice()
      selectChannels(0)
      const cap = useCapture()
      await cap.startCapture()
      expect(cap.hasCapture).toBe(true)
      cap.clearCapture()
      expect(cap.hasCapture).toBe(false)
      expect(cap.capturedChannels).toHaveLength(0)
    })
  })

  describe('clearError', () => {
    it('clears captureError', async () => {
      const cap = useCapture()
      await cap.startCapture()
      expect(cap.captureError).toBe('Not connected')
      cap.clearError()
      expect(cap.captureError).toBeNull()
    })
  })

  describe('getChannelColor', () => {
    it('returns palette color for channel number', () => {
      const cap = useCapture()
      expect(cap.getChannelColor(0)).toBe('#FF7333')
      expect(cap.getChannelColor(1)).toBe('#33FF57')
    })

    it('wraps around palette', () => {
      const cap = useCapture()
      expect(cap.getChannelColor(64)).toBe(cap.getChannelColor(0))
    })
  })
})

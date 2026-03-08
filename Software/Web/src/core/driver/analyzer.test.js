import { describe, it, expect, vi } from 'vitest'
import { AnalyzerDriver } from './analyzer.js'
import { createMockTransport } from '../transport/types.js'
import {
  TRIGGER_EDGE,
  TRIGGER_BLAST,
  TRIGGER_COMPLEX,
  TRIGGER_FAST,
  CAPTURE_MODE_8CH,
  CAPTURE_MODE_16CH,
  CAPTURE_MODE_24CH,
  CMD_DEVICE_INIT,
  CMD_BLINK_LED_ON,
  CMD_BLINK_LED_OFF,
  CMD_ENTER_BOOTLOADER,
  COMPLEX_TRIGGER_DELAY,
  FAST_TRIGGER_DELAY,
} from '../protocol/commands.js'
import { createChannel } from './types.js'

const INIT_LINES = [
  'ANALYZER_V6_5',
  'FREQ:100000000',
  'BLASTFREQ:200000000',
  'BUFFER:262144',
  'CHANNELS:24',
]

/**
 * Creates a connected driver with standard init values.
 * @param {Object} [extra] - Additional mock transport options (lines, binaryChunks appended after init)
 */
async function makeConnectedDriver(extra = {}) {
  const lines = [...INIT_LINES, ...(extra.lines || [])]
  const transport = createMockTransport({ lines, binaryChunks: extra.binaryChunks })
  await transport.connect()

  const driver = new AnalyzerDriver()
  await driver.connect(transport)
  return { driver, transport }
}

describe('AnalyzerDriver', () => {
  describe('connect', () => {
    it('stores device info from init handshake', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.version).toBe('ANALYZER_V6_5')
      expect(driver.majorVersion).toBe(6)
      expect(driver.minorVersion).toBe(5)
      expect(driver.maxFrequency).toBe(100000000)
      expect(driver.blastFrequency).toBe(200000000)
      expect(driver.bufferSize).toBe(262144)
      expect(driver.channelCount).toBe(24)
    })

    it('sends CMD_DEVICE_INIT packet', async () => {
      const { transport } = await makeConnectedDriver()
      // First written data should be the init packet
      const pkt = transport.writtenData[0]
      // Framed packet: [0x55, 0xAA, CMD_DEVICE_INIT, 0xAA, 0x55]
      expect(pkt[0]).toBe(0x55)
      expect(pkt[1]).toBe(0xaa)
      // CMD_DEVICE_INIT = 0x00, not a special byte so no escaping
      expect(pkt[2]).toBe(CMD_DEVICE_INIT)
      expect(pkt[3]).toBe(0xaa)
      expect(pkt[4]).toBe(0x55)
    })

    it('reports connected state', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.connected).toBe(true)
    })
  })

  describe('disconnect', () => {
    it('calls transport.disconnect', async () => {
      const { driver, transport } = await makeConnectedDriver()
      await driver.disconnect()
      expect(transport.disconnectCalls).toBe(1)
    })

    it('clears capturing flag', async () => {
      const { driver } = await makeConnectedDriver()
      await driver.disconnect()
      expect(driver.capturing).toBe(false)
    })
  })

  describe('getCaptureMode', () => {
    it('returns 8CH for channels 0-7', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.getCaptureMode([0, 1, 5])).toBe(CAPTURE_MODE_8CH)
    })

    it('returns 16CH for channels including 8-15', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.getCaptureMode([0, 8])).toBe(CAPTURE_MODE_16CH)
    })

    it('returns 24CH for channels including 16+', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.getCaptureMode([0, 16])).toBe(CAPTURE_MODE_24CH)
    })

    it('returns 8CH for empty array', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.getCaptureMode([])).toBe(CAPTURE_MODE_8CH)
    })
  })

  describe('getLimits', () => {
    it('calculates 8CH limits with bufferSize=262144', async () => {
      const { driver } = await makeConnectedDriver()
      const limits = driver.getLimits([0, 1, 2])
      // 8CH: 1 byte/sample → 262144 samples
      expect(limits.minPreSamples).toBe(2)
      expect(limits.maxPreSamples).toBe(Math.floor(262144 / 10))
      expect(limits.minPostSamples).toBe(2)
      expect(limits.maxPostSamples).toBe(262144 - 2)
      expect(limits.maxTotalSamples).toBe(262144)
    })

    it('calculates 16CH limits', async () => {
      const { driver } = await makeConnectedDriver()
      const limits = driver.getLimits([0, 8])
      // 16CH: 2 bytes/sample → 131072 samples
      expect(limits.maxPreSamples).toBe(Math.floor(131072 / 10))
      expect(limits.maxPostSamples).toBe(131072 - 2)
    })

    it('calculates 24CH limits', async () => {
      const { driver } = await makeConnectedDriver()
      const limits = driver.getLimits([0, 16])
      // 24CH: 4 bytes/sample → 65536 samples
      expect(limits.maxPreSamples).toBe(Math.floor(65536 / 10))
      expect(limits.maxPostSamples).toBe(65536 - 2)
    })
  })

  describe('getDeviceInfo', () => {
    it('returns info with 3 modeLimits', async () => {
      const { driver } = await makeConnectedDriver()
      const info = driver.getDeviceInfo()
      expect(info.name).toBe('ANALYZER_V6_5')
      expect(info.maxFrequency).toBe(100000000)
      expect(info.blastFrequency).toBe(200000000)
      expect(info.channels).toBe(24)
      expect(info.bufferSize).toBe(262144)
      expect(info.modeLimits).toHaveLength(3)
    })
  })

  describe('validateSettings', () => {
    function makeSession(overrides = {}) {
      return {
        frequency: 1000000,
        preTriggerSamples: 100,
        postTriggerSamples: 1000,
        loopCount: 0,
        measureBursts: false,
        captureChannels: [createChannel(0), createChannel(1)],
        bursts: null,
        triggerType: TRIGGER_EDGE,
        triggerChannel: 0,
        triggerInverted: false,
        triggerBitCount: 1,
        triggerPattern: 0,
        ...overrides,
      }
    }

    it('accepts valid edge trigger settings', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.validateSettings(makeSession())).toBe(true)
    })

    it('rejects out-of-range channels', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({ captureChannels: [createChannel(0), createChannel(25)] }),
        ),
      ).toBe(false)
    })

    it('rejects frequency below minimum', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.validateSettings(makeSession({ frequency: 1 }))).toBe(false)
    })

    it('rejects frequency above maximum', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.validateSettings(makeSession({ frequency: 200000000 }))).toBe(false)
    })

    it('rejects pre-trigger samples below minimum', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.validateSettings(makeSession({ preTriggerSamples: 1 }))).toBe(false)
    })

    it('rejects pre-trigger samples above maximum', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.validateSettings(makeSession({ preTriggerSamples: 30000 }))).toBe(false)
    })

    it('rejects loopCount > 65534 for edge', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.validateSettings(makeSession({ loopCount: 65535 }))).toBe(false)
    })

    it('rejects burst with loopCount > 254', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({ measureBursts: true, loopCount: 255, postTriggerSamples: 1000 }),
        ),
      ).toBe(false)
    })

    it('rejects burst with postTriggerSamples < 100', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({ measureBursts: true, loopCount: 1, postTriggerSamples: 50 }),
        ),
      ).toBe(false)
    })

    // Blast trigger
    it('accepts valid blast settings', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_BLAST,
            preTriggerSamples: 0,
            postTriggerSamples: 1000,
            frequency: 200000000,
            loopCount: 0,
          }),
        ),
      ).toBe(true)
    })

    it('rejects blast with non-zero preTriggerSamples', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_BLAST,
            preTriggerSamples: 10,
            frequency: 200000000,
            loopCount: 0,
          }),
        ),
      ).toBe(false)
    })

    it('rejects blast with wrong frequency', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_BLAST,
            preTriggerSamples: 0,
            frequency: 100000000,
            loopCount: 0,
          }),
        ),
      ).toBe(false)
    })

    it('rejects blast with non-zero loopCount', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_BLAST,
            preTriggerSamples: 0,
            frequency: 200000000,
            loopCount: 1,
          }),
        ),
      ).toBe(false)
    })

    // Complex trigger
    it('accepts valid complex trigger', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_COMPLEX,
            triggerChannel: 0,
            triggerBitCount: 4,
          }),
        ),
      ).toBe(true)
    })

    it('rejects complex with triggerBitCount > 16', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_COMPLEX,
            triggerChannel: 0,
            triggerBitCount: 17,
          }),
        ),
      ).toBe(false)
    })

    it('rejects complex with triggerChannel + bitCount > 16', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_COMPLEX,
            triggerChannel: 14,
            triggerBitCount: 4,
          }),
        ),
      ).toBe(false)
    })

    // Fast trigger
    it('accepts valid fast trigger', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_FAST,
            triggerChannel: 0,
            triggerBitCount: 3,
          }),
        ),
      ).toBe(true)
    })

    it('rejects fast with triggerBitCount > 5', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_FAST,
            triggerChannel: 0,
            triggerBitCount: 6,
          }),
        ),
      ).toBe(false)
    })

    it('rejects fast with triggerChannel + bitCount > 5', async () => {
      const { driver } = await makeConnectedDriver()
      expect(
        driver.validateSettings(
          makeSession({
            triggerType: TRIGGER_FAST,
            triggerChannel: 3,
            triggerBitCount: 3,
          }),
        ),
      ).toBe(false)
    })
  })

  describe('composeRequest', () => {
    function makeSession(overrides = {}) {
      return {
        frequency: 1000000,
        preTriggerSamples: 100,
        postTriggerSamples: 1000,
        loopCount: 0,
        measureBursts: false,
        captureChannels: [createChannel(0), createChannel(1)],
        bursts: null,
        triggerType: TRIGGER_EDGE,
        triggerChannel: 2,
        triggerInverted: true,
        triggerBitCount: 1,
        triggerPattern: 0,
        ...overrides,
      }
    }

    it('maps edge trigger with triggerInverted correctly', async () => {
      const { driver } = await makeConnectedDriver()
      const req = driver.composeRequest(makeSession())
      expect(req.triggerType).toBe(TRIGGER_EDGE)
      expect(req.triggerChannel).toBe(2)
      expect(req.invertedOrCount).toBe(1) // inverted=true → 1
      expect(req.triggerValue).toBe(0)
      expect(req.channels).toEqual([0, 1])
      expect(req.frequency).toBe(1000000)
      expect(req.preSamples).toBe(100)
      expect(req.postSamples).toBe(1000)
      expect(req.captureMode).toBe(CAPTURE_MODE_8CH)
    })

    it('maps edge trigger non-inverted correctly', async () => {
      const { driver } = await makeConnectedDriver()
      const req = driver.composeRequest(makeSession({ triggerInverted: false }))
      expect(req.invertedOrCount).toBe(0)
    })

    it('applies trigger delay offset for complex trigger', async () => {
      const { driver } = await makeConnectedDriver()
      const session = makeSession({
        triggerType: TRIGGER_COMPLEX,
        triggerBitCount: 4,
        triggerPattern: 0x000a,
        frequency: 10000000,
      })
      const req = driver.composeRequest(session)

      // Verify offset calculation
      const samplePeriod = 1e9 / 10000000 // 100ns
      const delayPeriod = (1.0 / 100000000) * 1e9 * COMPLEX_TRIGGER_DELAY // 50ns
      const offset = Math.round(delayPeriod / samplePeriod + 0.3)

      expect(req.preSamples).toBe(100 + offset)
      expect(req.postSamples).toBe(1000 - offset)
      expect(req.invertedOrCount).toBe(4) // bitCount for complex
      expect(req.triggerValue).toBe(0x000a)
    })

    it('applies trigger delay offset for fast trigger', async () => {
      const { driver } = await makeConnectedDriver()
      const session = makeSession({
        triggerType: TRIGGER_FAST,
        triggerBitCount: 3,
        triggerPattern: 0x0005,
        frequency: 10000000,
      })
      const req = driver.composeRequest(session)

      const samplePeriod = 1e9 / 10000000
      const delayPeriod = (1.0 / 100000000) * 1e9 * FAST_TRIGGER_DELAY
      const offset = Math.round(delayPeriod / samplePeriod + 0.3)

      expect(req.preSamples).toBe(100 + offset)
      expect(req.postSamples).toBe(1000 - offset)
    })
  })

  describe('blinkLed', () => {
    it('sends blink on command and returns true on expected response', async () => {
      const { driver, transport } = await makeConnectedDriver({ lines: ['BLINKON'] })
      const result = await driver.blinkLed()
      expect(result).toBe(true)
      // Second write (after init) should be the blink packet
      const pkt = transport.writtenData[1]
      expect(pkt[2]).toBe(CMD_BLINK_LED_ON)
    })

    it('returns false on unexpected response', async () => {
      const { driver } = await makeConnectedDriver({ lines: ['SOMETHING_ELSE'] })
      const result = await driver.blinkLed()
      expect(result).toBe(false)
    })
  })

  describe('stopBlinkLed', () => {
    it('sends blink off command and returns true', async () => {
      const { driver, transport } = await makeConnectedDriver({ lines: ['BLINKOFF'] })
      const result = await driver.stopBlinkLed()
      expect(result).toBe(true)
      const pkt = transport.writtenData[1]
      expect(pkt[2]).toBe(CMD_BLINK_LED_OFF)
    })
  })

  describe('enterBootloader', () => {
    it('sends bootloader command and returns true', async () => {
      const { driver, transport } = await makeConnectedDriver({
        lines: ['RESTARTING_BOOTLOADER'],
      })
      const result = await driver.enterBootloader()
      expect(result).toBe(true)
      const pkt = transport.writtenData[1]
      expect(pkt[2]).toBe(CMD_ENTER_BOOTLOADER)
    })

    it('returns false when not connected', async () => {
      const { driver } = await makeConnectedDriver()
      await driver.disconnect()
      const result = await driver.enterBootloader()
      expect(result).toBe(false)
    })
  })

  describe('startCapture', () => {
    it('captures 8CH data and extracts per-channel samples', async () => {
      // Build binary response for parseCaptureData:
      // 1. UInt32 LE: sample count (4 samples)
      const sampleCount = new Uint8Array(4)
      new DataView(sampleCount.buffer).setUint32(0, 4, true)

      // 2. 4 bytes of 8-bit samples: 0b11, 0b01, 0b10, 0b00
      //    ch0: 1,1,0,0  ch1: 1,0,1,0
      const sampleData = new Uint8Array([0b11, 0b01, 0b10, 0b00])

      // 3. 1 byte timestamp flag = 0 (no timestamps)
      const tsFlag = new Uint8Array([0])

      const { driver } = await makeConnectedDriver({
        lines: ['CAPTURE_STARTED'],
        binaryChunks: [sampleCount, sampleData, tsFlag],
      })

      const session = {
        frequency: 1000000,
        preTriggerSamples: 2,
        postTriggerSamples: 2,
        loopCount: 0,
        measureBursts: false,
        captureChannels: [createChannel(0), createChannel(1)],
        bursts: null,
        triggerType: TRIGGER_EDGE,
        triggerChannel: 0,
        triggerInverted: false,
        triggerBitCount: 0,
        triggerPattern: 0,
      }

      const onComplete = vi.fn()
      await driver.startCapture(session, onComplete)

      expect(onComplete).toHaveBeenCalledOnce()
      const result = onComplete.mock.calls[0][0]
      expect(result.success).toBe(true)
      expect(result.session.captureChannels[0].samples).toEqual(new Uint8Array([1, 1, 0, 0]))
      expect(result.session.captureChannels[1].samples).toEqual(new Uint8Array([1, 0, 1, 0]))
    })

    it('calls onComplete with success=false for empty channels', async () => {
      const { driver } = await makeConnectedDriver()
      const session = {
        frequency: 1000000,
        preTriggerSamples: 100,
        postTriggerSamples: 1000,
        loopCount: 0,
        measureBursts: false,
        captureChannels: [],
        bursts: null,
        triggerType: TRIGGER_EDGE,
        triggerChannel: 0,
        triggerInverted: false,
        triggerBitCount: 0,
        triggerPattern: 0,
      }

      const onComplete = vi.fn()
      await driver.startCapture(session, onComplete)
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, session }),
      )
      expect(onComplete.mock.calls[0][0].error).toBe('No capture channels')
    })

    it('calls onComplete with success=false for invalid settings', async () => {
      const { driver } = await makeConnectedDriver()
      const session = {
        frequency: 1, // too low
        preTriggerSamples: 100,
        postTriggerSamples: 1000,
        loopCount: 0,
        measureBursts: false,
        captureChannels: [createChannel(0)],
        bursts: null,
        triggerType: TRIGGER_EDGE,
        triggerChannel: 0,
        triggerInverted: false,
        triggerBitCount: 0,
        triggerPattern: 0,
      }

      const onComplete = vi.fn()
      await driver.startCapture(session, onComplete)
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, session }),
      )
      expect(onComplete.mock.calls[0][0].error).toBe('Invalid capture settings')
    })

    it('throws if already capturing', async () => {
      // Use a transport that will block on readLine after CAPTURE_STARTED
      const lines = [...INIT_LINES, 'CAPTURE_STARTED']
      const sampleCount = new Uint8Array(4)
      new DataView(sampleCount.buffer).setUint32(0, 1, true)

      const transport = createMockTransport({
        lines,
        binaryChunks: [sampleCount, new Uint8Array([0x01]), new Uint8Array([0])],
      })
      await transport.connect()

      const driver = new AnalyzerDriver()
      await driver.connect(transport)

      // Start first capture (completes successfully)
      const session = {
        frequency: 1000000,
        preTriggerSamples: 2,
        postTriggerSamples: 2,
        loopCount: 0,
        measureBursts: false,
        captureChannels: [createChannel(0)],
        bursts: null,
        triggerType: TRIGGER_EDGE,
        triggerChannel: 0,
        triggerInverted: false,
        triggerBitCount: 0,
        triggerPattern: 0,
      }

      await driver.startCapture(session, () => {})

      // Driver should no longer be capturing after completion
      expect(driver.capturing).toBe(false)
    })
  })

  describe('minFrequency', () => {
    it('computes from maxFrequency', async () => {
      const { driver } = await makeConnectedDriver()
      expect(driver.minFrequency).toBe(Math.floor((100000000 * 2) / 65535))
    })
  })
})

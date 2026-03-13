import { describe, it, expect } from 'vitest'
import { createMockTransport } from '../transport/types.js'
import {
  validateVersion,
  parseInitResponse,
  parseCaptureStartResponse,
  parseCaptureData,
  parseResponseLine,
} from './parser.js'

describe('validateVersion', () => {
  it('accepts valid version LA-7.0.0', () => {
    const result = validateVersion('LA-7.0.0')
    expect(result).toEqual({ valid: true, major: 7, minor: 0, patch: 0 })
  })

  it('accepts higher major version LA-8.0.0', () => {
    const result = validateVersion('LA-8.0.0')
    expect(result).toEqual({ valid: true, major: 8, minor: 0, patch: 0 })
  })

  it('accepts higher minor version LA-7.1.0', () => {
    const result = validateVersion('LA-7.1.0')
    expect(result).toEqual({ valid: true, major: 7, minor: 1, patch: 0 })
  })

  it('accepts higher patch version LA-7.0.1', () => {
    const result = validateVersion('LA-7.0.1')
    expect(result).toEqual({ valid: true, major: 7, minor: 0, patch: 1 })
  })

  it('rejects lower major version LA-6.9.9', () => {
    const result = validateVersion('LA-6.9.9')
    expect(result.valid).toBe(false)
  })

  it('rejects garbage string', () => {
    const result = validateVersion('GARBAGE')
    expect(result.valid).toBe(false)
  })

  it('rejects old format LOGIC_ANALYZER_V6_5', () => {
    const result = validateVersion('LOGIC_ANALYZER_V6_5')
    expect(result.valid).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(validateVersion(null).valid).toBe(false)
    expect(validateVersion(undefined).valid).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateVersion('').valid).toBe(false)
  })
})

describe('parseInitResponse', () => {
  function makeValidLines() {
    return [
      'LA-7.0.0',
      'FREQ:100000000',
      'BLASTFREQ:200000000',
      'BUFFER:262144',
      'CHANNELS:24',
    ]
  }

  it('parses complete valid init response', async () => {
    const transport = createMockTransport({ lines: makeValidLines() })
    await transport.connect()

    const info = await parseInitResponse(transport)
    expect(info).toEqual({
      version: 'LA-7.0.0',
      majorVersion: 7,
      minorVersion: 0,
      maxFrequency: 100000000,
      blastFrequency: 200000000,
      bufferSize: 262144,
      channelCount: 24,
    })
  })

  it('throws on invalid version line', async () => {
    const lines = Array(20).fill('GARBAGE')
    const transport = createMockTransport({ lines })
    await transport.connect()

    await expect(parseInitResponse(transport)).rejects.toThrow(/Invalid device version/)
  })

  it('skips non-version lines before a valid version', async () => {
    const lines = [
      'FREQ:100000000',
      'BLASTFREQ:200000000',
      'LA-7.0.0',
      'FREQ:100000000',
      'BLASTFREQ:200000000',
      'BUFFER:262144',
      'CHANNELS:24',
    ]
    const transport = createMockTransport({ lines })
    await transport.connect()

    const info = await parseInitResponse(transport)
    expect(info.version).toBe('LA-7.0.0')
    expect(info.maxFrequency).toBe(100000000)
  })

  it('throws on invalid FREQ line', async () => {
    const lines = makeValidLines()
    lines[1] = 'NOTFREQ:abc'
    const transport = createMockTransport({ lines })
    await transport.connect()

    await expect(parseInitResponse(transport)).rejects.toThrow(/Invalid frequency response/)
  })

  it('throws on invalid BLASTFREQ line', async () => {
    const lines = makeValidLines()
    lines[2] = 'BLAST:abc'
    const transport = createMockTransport({ lines })
    await transport.connect()

    await expect(parseInitResponse(transport)).rejects.toThrow(/Invalid blast frequency response/)
  })

  it('throws on invalid BUFFER line', async () => {
    const lines = makeValidLines()
    lines[3] = 'BUF:abc'
    const transport = createMockTransport({ lines })
    await transport.connect()

    await expect(parseInitResponse(transport)).rejects.toThrow(/Invalid buffer size response/)
  })

  it('throws on invalid CHANNELS line', async () => {
    const lines = makeValidLines()
    lines[4] = 'CHAN:abc'
    const transport = createMockTransport({ lines })
    await transport.connect()

    await expect(parseInitResponse(transport)).rejects.toThrow(/Invalid channel count response/)
  })

  it('accepts minimum valid version LA-7.0.0', async () => {
    const lines = makeValidLines()
    const transport = createMockTransport({ lines })
    await transport.connect()

    const info = await parseInitResponse(transport)
    expect(info.majorVersion).toBe(7)
    expect(info.minorVersion).toBe(0)
  })
})

describe('parseCaptureStartResponse', () => {
  it('returns the response line from device', async () => {
    const transport = createMockTransport({ lines: ['CAPTURE_STARTED'] })
    await transport.connect()
    expect(await parseCaptureStartResponse(transport)).toBe('CAPTURE_STARTED')
  })

  it('returns unexpected response as-is', async () => {
    const transport = createMockTransport({ lines: ['ERROR'] })
    await transport.connect()
    expect(await parseCaptureStartResponse(transport)).toBe('ERROR')
  })
})

describe('parseCaptureData', () => {
  function uint32LE(value) {
    const buf = new ArrayBuffer(4)
    new DataView(buf).setUint32(0, value, true)
    return new Uint8Array(buf)
  }

  function uint16LE(value) {
    const buf = new ArrayBuffer(2)
    new DataView(buf).setUint16(0, value, true)
    return new Uint8Array(buf)
  }

  it('parses 8-channel capture data correctly', async () => {
    const sampleCount = uint32LE(4)
    const sampleData = new Uint8Array([0x01, 0x02, 0x03, 0x04])
    const tsFlag = new Uint8Array([0]) // no timestamps

    const transport = createMockTransport({
      binaryChunks: [sampleCount, sampleData, tsFlag],
    })
    await transport.connect()

    const result = await parseCaptureData(transport, 0, 0, false)
    expect(result.samples).toEqual(new Uint32Array([1, 2, 3, 4]))
    expect(result.timestamps).toEqual(new Uint32Array(0))
  })

  it('parses 16-channel capture data correctly', async () => {
    // 2 samples, each 2 bytes LE
    const sampleCount = uint32LE(2)
    const sampleData = new Uint8Array([...uint16LE(0x1234), ...uint16LE(0x5678)])
    const tsFlag = new Uint8Array([0])

    const transport = createMockTransport({
      binaryChunks: [sampleCount, sampleData, tsFlag],
    })
    await transport.connect()

    const result = await parseCaptureData(transport, 1, 0, false)
    expect(result.samples).toEqual(new Uint32Array([0x1234, 0x5678]))
  })

  it('parses 24-channel capture data correctly', async () => {
    // 2 samples, each 4 bytes LE
    const sampleCount = uint32LE(2)
    const sampleData = new Uint8Array([...uint32LE(0x00abcdef), ...uint32LE(0x00123456)])
    const tsFlag = new Uint8Array([0])

    const transport = createMockTransport({
      binaryChunks: [sampleCount, sampleData, tsFlag],
    })
    await transport.connect()

    const result = await parseCaptureData(transport, 2, 0, false)
    expect(result.samples).toEqual(new Uint32Array([0x00abcdef, 0x00123456]))
  })

  it('parses timestamp data when present', async () => {
    // loopCount=1, measureBursts=true → expects (1+2)=3 timestamps
    const sampleCount = uint32LE(1)
    const sampleData = new Uint8Array([0xff])
    const tsFlag = new Uint8Array([3]) // stampLength > 0
    const tsData = new Uint8Array([...uint32LE(100), ...uint32LE(200), ...uint32LE(300)])

    const transport = createMockTransport({
      binaryChunks: [sampleCount, sampleData, tsFlag, tsData],
    })
    await transport.connect()

    const result = await parseCaptureData(transport, 0, 1, true)
    expect(result.timestamps).toEqual(new Uint32Array([100, 200, 300]))
  })

  it('returns empty timestamps when flag is zero', async () => {
    const sampleCount = uint32LE(1)
    const sampleData = new Uint8Array([0x00])
    const tsFlag = new Uint8Array([0])

    const transport = createMockTransport({
      binaryChunks: [sampleCount, sampleData, tsFlag],
    })
    await transport.connect()

    const result = await parseCaptureData(transport, 0, 0, false)
    expect(result.timestamps).toEqual(new Uint32Array(0))
  })

  it('handles larger sample counts', async () => {
    const count = 100
    const sampleCount = uint32LE(count)
    const sampleData = new Uint8Array(count)
    for (let i = 0; i < count; i++) sampleData[i] = i & 0xff
    const tsFlag = new Uint8Array([0])

    const transport = createMockTransport({
      binaryChunks: [sampleCount, sampleData, tsFlag],
    })
    await transport.connect()

    const result = await parseCaptureData(transport, 0, 0, false)
    expect(result.samples.length).toBe(count)
    expect(result.samples[0]).toBe(0)
    expect(result.samples[99]).toBe(99)
  })
})

describe('parseResponseLine', () => {
  it('returns true when response matches', async () => {
    const transport = createMockTransport({ lines: ['BLINKON'] })
    await transport.connect()
    expect(await parseResponseLine(transport, 'BLINKON')).toBe(true)
  })

  it('returns false when response does not match', async () => {
    const transport = createMockTransport({ lines: ['UNEXPECTED'] })
    await transport.connect()
    expect(await parseResponseLine(transport, 'BLINKON')).toBe(false)
  })
})

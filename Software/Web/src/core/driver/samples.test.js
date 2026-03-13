import { describe, it, expect } from 'vitest'
import { extractSamples, processBurstTimestamps } from './samples.js'

/** Helper: extract samples and return as plain Uint8Array for assertion. */
function extractAsArray(raw, channelIndex) {
  return extractSamples(raw, channelIndex).toUint8Array()
}

describe('extractSamples', () => {
  it('returns a SampleBuffer with get() and length', () => {
    const raw = new Uint32Array([0b00000001, 0b00000000])
    const buf = extractSamples(raw, 0)
    expect(buf.length).toBe(2)
    expect(buf.get(0)).toBe(1)
    expect(buf.get(1)).toBe(0)
  })

  it('extracts channel 0 from 8-bit samples', () => {
    // Bit 0: 1,0,1,0
    const raw = new Uint32Array([0b00000001, 0b00000000, 0b00000001, 0b00000000])
    expect(extractAsArray(raw, 0)).toEqual(new Uint8Array([1, 0, 1, 0]))
  })

  it('extracts channel 3 from 8-bit samples', () => {
    // Bit 3 = 0x08: set in first and third
    const raw = new Uint32Array([0b00001000, 0b00000000, 0b00001000, 0b00000100])
    expect(extractAsArray(raw, 3)).toEqual(new Uint8Array([1, 0, 1, 0]))
  })

  it('extracts channel 7', () => {
    const raw = new Uint32Array([0x80, 0x00, 0xff])
    expect(extractAsArray(raw, 7)).toEqual(new Uint8Array([1, 0, 1]))
  })

  it('extracts higher channel indices (channel 15)', () => {
    const raw = new Uint32Array([0x8000, 0x0000, 0xffff])
    expect(extractAsArray(raw, 15)).toEqual(new Uint8Array([1, 0, 1]))
  })

  it('extracts channel 23', () => {
    const raw = new Uint32Array([0x800000, 0x000000, 0xffffff])
    expect(extractAsArray(raw, 23)).toEqual(new Uint8Array([1, 0, 1]))
  })

  it('returns all zeros for all-zero input', () => {
    const raw = new Uint32Array([0, 0, 0, 0])
    expect(extractAsArray(raw, 0)).toEqual(new Uint8Array([0, 0, 0, 0]))
    expect(extractAsArray(raw, 5)).toEqual(new Uint8Array([0, 0, 0, 0]))
  })

  it('returns all ones for channel 0 when all-0xFF input', () => {
    const raw = new Uint32Array([0xff, 0xff, 0xff])
    expect(extractAsArray(raw, 0)).toEqual(new Uint8Array([1, 1, 1]))
  })

  it('extracts independent channels from same raw data', () => {
    // Only bit 0 set in all samples
    const raw = new Uint32Array([0x01, 0x01, 0x01])
    expect(extractAsArray(raw, 0)).toEqual(new Uint8Array([1, 1, 1]))
    expect(extractAsArray(raw, 1)).toEqual(new Uint8Array([0, 0, 0]))
  })

  it('handles empty input', () => {
    const raw = new Uint32Array(0)
    expect(extractAsArray(raw, 0)).toEqual(new Uint8Array(0))
  })
})

describe('processBurstTimestamps', () => {
  it('returns empty array for empty timestamps', () => {
    const session = { frequency: 1000000, preTriggerSamples: 10, postTriggerSamples: 100 }
    expect(processBurstTimestamps(new Uint32Array(0), session, 200000000)).toEqual([])
  })

  it('produces first burst with zero gap', () => {
    // 2 timestamps (loopCount=0 gives loopCount+2=2 entries)
    // Use simple values where lower 24 bits inversion is predictable
    const ts = new Uint32Array([0x00ffffff, 0x00fffffe]) // After inversion: 0, 1
    const session = {
      frequency: 200000000,
      preTriggerSamples: 10,
      postTriggerSamples: 100,
      loopCount: 0,
    }
    const result = processBurstTimestamps(ts, session, 200000000)
    expect(result.length).toBe(1)
    expect(result[0].burstSampleStart).toBe(10)
    expect(result[0].burstSampleEnd).toBe(110)
    expect(result[0].burstSampleGap).toBe(0)
    expect(result[0].burstTimeGap).toBe(0)
  })

  it('calculates burst gaps for multiple bursts', () => {
    // 4 timestamps = loopCount=2
    // After lower-24-bit inversion, timestamps should increase
    // Use values where inversion gives: 0, 1000, 3000, 5000
    const ts = new Uint32Array([
      0x00ffffff - 0, // inverts to 0
      0x00ffffff - 1000, // inverts to 1000
      0x00ffffff - 3000, // inverts to 3000
      0x00ffffff - 5000, // inverts to 5000
    ])
    const session = {
      frequency: 200000000,
      preTriggerSamples: 10,
      postTriggerSamples: 100,
      loopCount: 2,
    }
    const result = processBurstTimestamps(ts, session, 200000000)
    expect(result.length).toBe(3)
    // First burst always has zero gap
    expect(result[0].burstSampleGap).toBe(0)
    expect(result[0].burstTimeGap).toBe(0)
    // Second and third bursts should have computed gaps
    expect(result[1].burstSampleStart).toBe(10 + 100)
    expect(result[1].burstSampleEnd).toBe(10 + 200)
    expect(result[2].burstSampleStart).toBe(10 + 200)
    expect(result[2].burstSampleEnd).toBe(10 + 300)
  })
})

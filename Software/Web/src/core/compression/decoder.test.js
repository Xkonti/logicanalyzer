import { describe, it, expect } from 'vitest'
import { NibbleReader, decompressChunk, reverseTranspose } from './decoder.js'
import { generatePattern, forwardTranspose } from './test-patterns.js'

describe('NibbleReader', () => {
  it('reads nibbles MSB-first from packed bytes', () => {
    // byte 0xAB → high nibble 0xA, low nibble 0xB
    // byte 0xCD → high nibble 0xC, low nibble 0xD
    const data = new Uint8Array([0xab, 0xcd])
    const reader = new NibbleReader(data, 0)

    expect(reader.readNibble()).toBe(0xa)
    expect(reader.readNibble()).toBe(0xb)
    expect(reader.readNibble()).toBe(0xc)
    expect(reader.readNibble()).toBe(0xd)
    expect(reader.bytesConsumed).toBe(2)
  })

  it('tracks bytesConsumed correctly at odd nibble positions', () => {
    const data = new Uint8Array([0x12, 0x34])
    const reader = new NibbleReader(data, 0)

    reader.readNibble() // 0x1
    expect(reader.bytesConsumed).toBe(1) // partially into byte 0

    reader.readNibble() // 0x2
    expect(reader.bytesConsumed).toBe(1) // completed byte 0

    reader.readNibble() // 0x3
    expect(reader.bytesConsumed).toBe(2) // partially into byte 1
  })

  it('respects startOffset', () => {
    const data = new Uint8Array([0xff, 0xab])
    const reader = new NibbleReader(data, 1)

    expect(reader.readNibble()).toBe(0xa)
    expect(reader.readNibble()).toBe(0xb)
    expect(reader.bytesConsumed).toBe(1)
  })
})

describe('decompressChunk', () => {
  it('decodes ALL_ZERO header for all channels', () => {
    // 8 channels, 128 samples
    // header: ceil(8/4) = 2 bytes, each channel mode = ALL_ZERO (0x01)
    // byte 0: 0x01 | (0x01<<2) | (0x01<<4) | (0x01<<6) = 0x55
    // byte 1: 0x55
    const data = new Uint8Array([0x55, 0x55])
    const { channels, bytesConsumed } = decompressChunk(data, 8, 128)

    expect(channels).toHaveLength(8)
    expect(bytesConsumed).toBe(2) // header only, no data
    for (let ch = 0; ch < 8; ch++) {
      expect(channels[ch]).toHaveLength(16) // 128/8
      expect(channels[ch].every((b) => b === 0)).toBe(true)
    }
  })

  it('decodes ALL_ONE header for all channels', () => {
    // mode ALL_ONE = 0x02
    // byte: 0x02 | (0x02<<2) | (0x02<<4) | (0x02<<6) = 0xAA
    const data = new Uint8Array([0xaa, 0xaa])
    const { channels, bytesConsumed } = decompressChunk(data, 8, 128)

    expect(channels).toHaveLength(8)
    expect(bytesConsumed).toBe(2)
    for (let ch = 0; ch < 8; ch++) {
      expect(channels[ch]).toHaveLength(16)
      expect(channels[ch].every((b) => b === 0xff)).toBe(true)
    }
  })

  it('decodes RAW channel data', () => {
    // 8ch, 128 samples. Channel 0 = RAW (0x00), channels 1-7 = ALL_ZERO (0x01)
    // header byte 0: 0x00 | (0x01<<2) | (0x01<<4) | (0x01<<6) = 0x54
    // header byte 1: 0x55
    // Then 16 bytes of raw data for channel 0
    const rawData = new Uint8Array(16)
    for (let i = 0; i < 16; i++) rawData[i] = i + 1

    const data = new Uint8Array(2 + 16)
    data[0] = 0x54
    data[1] = 0x55
    data.set(rawData, 2)

    const { channels, bytesConsumed } = decompressChunk(data, 8, 128)

    expect(channels).toHaveLength(8)
    expect(bytesConsumed).toBe(18) // 2 header + 16 raw
    expect(channels[0]).toEqual(rawData)
    for (let ch = 1; ch < 8; ch++) {
      expect(channels[ch].every((b) => b === 0)).toBe(true)
    }
  })

  it('decodes NIBBLE_ENC channel with zero+one runs', () => {
    // 8ch, 128 samples. Channel 0 = NIBBLE_ENC, channels 1-7 = ALL_ZERO
    // header byte 0: 0x03 | (0x01<<2) | (0x01<<4) | (0x01<<6) = 0x57
    // header byte 1: 0x55
    //
    // Channel 0 encoded stream: 16 zero nibbles + 16 one nibbles = 32 nibbles
    // ZERO16 (0x9) + ONE16 (0xE) → packed MSB-first: (0x9 << 4) | 0xE = 0x9E
    const data = new Uint8Array([0x57, 0x55, 0x9e])
    const { channels } = decompressChunk(data, 8, 128)

    expect(channels).toHaveLength(8)
    // Channel 0: 8 bytes 0x00 (16 zero nibbles) + 8 bytes 0xFF (16 one nibbles)
    const ch0 = channels[0]
    expect(ch0).toHaveLength(16)
    for (let j = 0; j < 8; j++) expect(ch0[j]).toBe(0x00)
    for (let j = 8; j < 16; j++) expect(ch0[j]).toBe(0xff)
  })

  it('decodes NIBBLE_ENC with RAW prefix codes', () => {
    // 8ch, 128 samples. Channel 0 = NIBBLE_ENC, rest ALL_ZERO
    // Encoded: RAW1(0x0) + nibble 0x5, then ZERO32(0xA) → 1 + 32 = 33 nibbles
    // Wait, 128 samples = 32 nibbles. So: RAW2(0x1) + 0x5 + 0xA, then ZERO4(0x7) * ...
    // Let's do: RAW2(0x1) + 0x5 + 0xA + ZERO4(0x7) + ZERO4(0x7) + ZERO4(0x7)
    //   + ZERO4(0x7) + ZERO4(0x7) + ZERO2(0x6)
    // = 2 raw + 4+4+4+4+4+2 = 2+22 = 24. Need 32.
    // Simpler: RAW2(0x1) + 0x5 + 0xA + ZERO16(0x9) + ZERO8(0x8) + ZERO4(0x7) + ZERO2(0x6)
    // = 2 + 16 + 8 + 4 + 2 = 32
    // MSB-first packing of prefix+data nibbles:
    // nibbles: [0x1, 0x5, 0xA, 0x9, 0x8, 0x7, 0x6, pad]
    // Bytes: 0x15, 0xA9, 0x87, 0x60 (pad high)
    const data = new Uint8Array([0x57, 0x55, 0x15, 0xa9, 0x87, 0x60])
    const { channels } = decompressChunk(data, 8, 128)

    const ch0 = channels[0]
    expect(ch0).toHaveLength(16)
    // First 2 nibbles: 0x5 and 0xA → byte 0 = (0xA << 4) | 0x5 = 0xA5
    expect(ch0[0]).toBe(0xa5)
    // Remaining 30 nibbles are all zero → bytes 1-15 all 0x00
    for (let j = 1; j < 16; j++) expect(ch0[j]).toBe(0x00)
  })

  it('handles mixed header modes across channels', () => {
    // 4ch, 128 samples
    // ch0=ALL_ZERO(0x01), ch1=ALL_ONE(0x02), ch2=RAW(0x00), ch3=ALL_ZERO(0x01)
    // header: 1 byte = 0x01 | (0x02<<2) | (0x00<<4) | (0x01<<6) = 0x01|0x08|0x00|0x40 = 0x49
    const rawBytes = 16 // 128/8
    const rawCh2 = new Uint8Array(rawBytes)
    rawCh2.fill(0x33)

    const data = new Uint8Array(1 + rawBytes)
    data[0] = 0x49
    data.set(rawCh2, 1)

    const { channels } = decompressChunk(data, 4, 128)

    expect(channels[0].every((b) => b === 0)).toBe(true)
    expect(channels[1].every((b) => b === 0xff)).toBe(true)
    expect(channels[2]).toEqual(rawCh2)
    expect(channels[3].every((b) => b === 0)).toBe(true)
  })
})

describe('reverseTranspose', () => {
  it('reconstructs interleaved samples from per-channel bitstreams', () => {
    // 8ch, 8 samples
    // ch0: 0xFF (all bits set) → sample bit 0 always 1
    // ch1: 0x00 → bit 1 always 0
    // ch2: 0xAA (10101010) → bit 2: 0,1,0,1,0,1,0,1
    // ch3-7: 0x00
    const channels = Array.from({ length: 8 }, () => new Uint8Array([0x00]))
    channels[0] = new Uint8Array([0xff])
    channels[2] = new Uint8Array([0xaa])

    const result = reverseTranspose(channels, 8, 8)
    expect(result).toHaveLength(8) // 8 samples × 1 byte

    // Sample 0: ch0=1,ch2=0 → 0x01
    // Sample 1: ch0=1,ch2=1 → 0x05
    expect(result[0]).toBe(0x01)
    expect(result[1]).toBe(0x05)
    expect(result[2]).toBe(0x01)
    expect(result[3]).toBe(0x05)
    expect(result[4]).toBe(0x01)
    expect(result[5]).toBe(0x05)
    expect(result[6]).toBe(0x01)
    expect(result[7]).toBe(0x05)
  })

  it('handles 16-channel samples (2 bytes per sample)', () => {
    // 16ch, 8 samples
    // ch0: 0xFF, ch8: 0xFF, rest: 0x00
    const channels = Array.from({ length: 16 }, () => new Uint8Array([0x00]))
    channels[0] = new Uint8Array([0xff])
    channels[8] = new Uint8Array([0xff])

    const result = reverseTranspose(channels, 16, 8)
    expect(result).toHaveLength(16) // 8 × 2 bytes

    // Each sample: bit0=1 (ch0), bit8=1 (ch8) → 0x0101 LE → [0x01, 0x01]
    for (let s = 0; s < 8; s++) {
      expect(result[s * 2]).toBe(0x01)
      expect(result[s * 2 + 1]).toBe(0x01)
    }
  })
})

describe('generatePattern', () => {
  it('ALL_ZERO produces all zeros', () => {
    const buf = generatePattern(0, 8, 128)
    expect(buf).toHaveLength(128)
    expect(buf.every((b) => b === 0)).toBe(true)
  })

  it('ALL_ONE produces correct output for 8ch', () => {
    const buf = generatePattern(1, 8, 128)
    expect(buf).toHaveLength(128)
    expect(buf.every((b) => b === 0xff)).toBe(true)
  })

  it('ALL_ONE clears byte 3 for 24ch', () => {
    const buf = generatePattern(1, 24, 128)
    expect(buf).toHaveLength(512) // 128 × 4
    for (let s = 0; s < 128; s++) {
      expect(buf[s * 4]).toBe(0xff)
      expect(buf[s * 4 + 1]).toBe(0xff)
      expect(buf[s * 4 + 2]).toBe(0xff)
      expect(buf[s * 4 + 3]).toBe(0x00)
    }
  })

  it('COUNTER produces deterministic values', () => {
    const buf = generatePattern(4, 16, 128)
    expect(buf).toHaveLength(256) // 128 × 2
    // Sample 0: byte0 = (0*7+3)&0xFF = 3, byte1 = (0*13+5)&0xFF = 5
    expect(buf[0]).toBe(3)
    expect(buf[1]).toBe(5)
    // Sample 1: byte0 = 10, byte1 = 18
    expect(buf[2]).toBe(10)
    expect(buf[3]).toBe(18)
  })

  it('CLOCK alternates zero and one samples', () => {
    const buf = generatePattern(3, 8, 128)
    for (let s = 0; s < 128; s++) {
      expect(buf[s]).toBe(s & 1 ? 0xff : 0x00)
    }
  })

  it('HALF_TOGGLE has first half zero, second half one', () => {
    const buf = generatePattern(2, 8, 128)
    for (let s = 0; s < 64; s++) expect(buf[s]).toBe(0x00)
    for (let s = 64; s < 128; s++) expect(buf[s]).toBe(0xff)
  })

  it('I2C uses all channels as SCL/SDA pairs', () => {
    const buf = generatePattern(6, 8, 512)
    // With 4 SCL/SDA pairs on 8 channels, all bits should be used
    let orAll = 0
    for (let s = 0; s < 512; s++) orAll |= buf[s]
    expect(orAll).toBe(0xff) // all 8 bits active at some point
  })

  it('I2C produces different data with chunkOffset', () => {
    const buf0 = generatePattern(6, 8, 512, 0)
    const buf1 = generatePattern(6, 8, 512, 512)
    // Different chunk offsets should produce different data
    let differs = false
    for (let s = 0; s < 512; s++) {
      if (buf0[s] !== buf1[s]) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })

  it('I2C 1ch has only SCL (bit 0)', () => {
    const buf = generatePattern(6, 1, 128)
    for (let s = 0; s < 128; s++) {
      expect(buf[s] & 0xfe).toBe(0)
    }
  })
})

describe('round-trip transpose', () => {
  const configs = [
    [1, 128],
    [3, 128],
    [5, 256],
    [8, 128],
    [8, 512],
    [12, 128],
    [16, 128],
    [16, 512],
    [20, 256],
    [24, 128],
    [24, 256],
    [24, 512],
  ]

  for (const [ch, chunk] of configs) {
    for (let pat = 0; pat < 7; pat++) {
      it(`forward+reverse transpose: pattern ${pat}, ${ch}ch, ${chunk} samples`, () => {
        const pattern = generatePattern(pat, ch, chunk)
        const channels = forwardTranspose(pattern, ch, chunk)
        const reconstructed = reverseTranspose(channels, ch, chunk)
        expect(reconstructed).toEqual(pattern)
      })
    }
  }
})

describe('all-RAW decompress round-trip', () => {
  // Simulates what the firmware would send if all channels use RAW mode
  for (const [ch, chunk] of [
    [24, 256],
    [24, 512],
  ]) {
    for (let pat = 0; pat < 7; pat++) {
      it(`all-RAW decompress: pattern ${pat}, ${ch}ch, ${chunk} samples`, () => {
        const pattern = generatePattern(pat, ch, chunk)
        const transposed = forwardTranspose(pattern, ch, chunk)

        // Build compressed data: all-RAW header + raw channel data
        const headerBytes = (ch + 3) >> 2
        const rawBytesPerCh = chunk >> 3
        const compressed = new Uint8Array(headerBytes + ch * rawBytesPerCh)
        // Header bytes are all 0x00 (HDR_RAW for every channel)

        let pos = headerBytes
        for (let c = 0; c < ch; c++) {
          compressed.set(transposed[c], pos)
          pos += rawBytesPerCh
        }

        const { channels } = decompressChunk(compressed, ch, chunk)
        const reconstructed = reverseTranspose(channels, ch, chunk)
        expect(reconstructed).toEqual(pattern)
      })
    }
  }
})

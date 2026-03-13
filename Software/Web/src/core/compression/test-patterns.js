/**
 * Test pattern generators for compression verification.
 * Must produce byte-identical output to the C firmware patterns in compress_test.c.
 */

export const PATTERN_NAMES = [
  'ALL_ZERO',
  'ALL_ONE',
  'HALF_TOGGLE',
  'CLOCK',
  'COUNTER',
  'SPI_BUS',
  'I2C',
]

export function bytesPerSample(numChannels) {
  if (numChannels <= 8) return 1
  if (numChannels <= 16) return 2
  return 4
}

/* I2C timing constants (must match firmware) */
const I2C_SAMPLE_US = 4 // 250 kHz
const I2C_BIT_US = 10 // 100 kHz
const I2C_TX_BITS = 28 // 4 idle + start + 8 addr + ACK + 8 data + ACK + stop + 4 idle
const I2C_TX_US = I2C_TX_BITS * I2C_BIT_US // 280 µs

/**
 * Generate I2C traffic on ALL channels, cycling SCL/SDA pairs.
 * ch0=SCL0, ch1=SDA0, ch2=SCL1, ch3=SDA1, ...
 * Each pair is phase-offset by pair*37 µs for channel diversity.
 */
function generateI2cContinuous(buf, bps, numChannels, chunkSamples, chunkOffset) {
  const numPairs = (numChannels + 1) >> 1

  for (let s = 0; s < chunkSamples; s++) {
    const globalS = chunkOffset + s
    const baseTimeUs = globalS * I2C_SAMPLE_US

    for (let pair = 0; pair < numPairs; pair++) {
      const timeUs = baseTimeUs + pair * 37

      const txTime = timeUs % I2C_TX_US
      const txNum = Math.floor(timeUs / I2C_TX_US)
      const bitIdx = Math.floor(txTime / I2C_BIT_US)
      const phaseUs = txTime % I2C_BIT_US

      const pairTx = txNum + pair * 97
      const addr7 = (pairTx * 0x1b + 0x50) & 0x7f
      const addrRw = (addr7 << 1) | (pairTx & 1)
      const dataByte = (pairTx * 0x37 + 0xa5) & 0xff

      let scl, sda

      if (bitIdx < 4 || bitIdx >= 24) {
        scl = 1
        sda = 1
      } else if (bitIdx === 4) {
        scl = phaseUs < 5 ? 1 : 0
        sda = 0
      } else if (bitIdx === 23) {
        scl = phaseUs >= 5 ? 1 : 0
        sda = phaseUs >= 7 ? 1 : 0
      } else {
        const dbit = bitIdx - 5
        scl = phaseUs >= 5 ? 1 : 0

        if (dbit < 8) {
          sda = (addrRw >> (7 - dbit)) & 1
        } else if (dbit === 8) {
          sda = 0
        } else if (dbit < 17) {
          sda = (dataByte >> (7 - (dbit - 9))) & 1
        } else {
          sda = 0
        }
      }

      const sclCh = pair * 2
      const sdaCh = pair * 2 + 1

      if (sclCh < numChannels) {
        buf[s * bps + (sclCh >> 3)] |= scl << (sclCh & 7)
      }
      if (sdaCh < numChannels) {
        buf[s * bps + (sdaCh >> 3)] |= sda << (sdaCh & 7)
      }
    }
  }
}

/**
 * Generate a test pattern matching the firmware's generate_pattern().
 *
 * @param {number} patternId - 0..6
 * @param {number} numChannels - 1..24
 * @param {number} chunkSamples - 128, 256, or 512
 * @param {number} [chunkOffset=0] - sample offset for I2C continuity across chunks
 * @returns {Uint8Array}
 */
export function generatePattern(patternId, numChannels, chunkSamples, chunkOffset = 0) {
  const bps = bytesPerSample(numChannels)
  const buf = new Uint8Array(chunkSamples * bps)

  switch (patternId) {
    case 0: // ALL_ZERO — already zeroed
      break

    case 1: // ALL_ONE
      for (let s = 0; s < chunkSamples; s++) {
        const off = s * bps
        buf[off] = 0xff
        if (bps >= 2) buf[off + 1] = 0xff
        if (bps >= 4) {
          buf[off + 2] = 0xff
          buf[off + 3] = 0x00
        }
      }
      break

    case 2: // HALF_TOGGLE — first half zero, second half ones
      for (let s = (chunkSamples >> 1); s < chunkSamples; s++) {
        const off = s * bps
        buf[off] = 0xff
        if (bps >= 2) buf[off + 1] = 0xff
        if (bps >= 4) {
          buf[off + 2] = 0xff
          buf[off + 3] = 0x00
        }
      }
      break

    case 3: // CLOCK — odd samples all-one, even samples all-zero
      for (let s = 0; s < chunkSamples; s++) {
        if (s & 1) {
          const off = s * bps
          buf[off] = 0xff
          if (bps >= 2) buf[off + 1] = 0xff
          if (bps >= 4) {
            buf[off + 2] = 0xff
            buf[off + 3] = 0x00
          }
        }
      }
      break

    case 4: // COUNTER — deterministic pseudo-random per byte
      for (let s = 0; s < chunkSamples; s++) {
        const off = s * bps
        buf[off] = (s * 7 + 3) & 0xff
        if (bps >= 2) buf[off + 1] = (s * 13 + 5) & 0xff
        if (bps >= 4) {
          buf[off + 2] = (s * 17 + 11) & 0xff
          buf[off + 3] = 0x00
        }
      }
      break

    case 5: {
      // SPI_BUS
      let pos = 0
      let byteIdx = 0
      while (pos < chunkSamples) {
        const mosiByte = (byteIdx * 0xa5 + 0x3c) & 0xff
        const misoByte = (byteIdx * 0x5a + 0xc3) & 0xff
        for (let i = 0; i < 4 && pos < chunkSamples; i++, pos++) buf[pos * bps] = 0x01
        for (let bit = 7; bit >= 0 && pos < chunkSamples; bit--) {
          const mosiBit = (mosiByte >> bit) & 1
          const misoBit = (misoByte >> bit) & 1
          const dataVal = (mosiBit << 2) | (misoBit << 3)
          if (pos < chunkSamples) buf[pos++ * bps] = dataVal
          if (pos < chunkSamples) buf[pos++ * bps] = dataVal | 0x02
        }
        for (let i = 0; i < 4 && pos < chunkSamples; i++, pos++) buf[pos * bps] = 0x01
        byteIdx++
      }
      break
    }

    case 6:
      // I2C continuous — all channels active, cycling SCL/SDA pairs
      generateI2cContinuous(buf, bps, numChannels, chunkSamples, chunkOffset)
      return buf // Skip channel mask — bits set explicitly per channel
  }

  // Mask off bits above numChannels (handles non-multiple-of-8 counts)
  const mask = new Uint8Array(bps)
  for (let ch = 0; ch < numChannels; ch++) {
    mask[ch >> 3] |= 1 << (ch & 7)
  }
  for (let s = 0; s < chunkSamples; s++) {
    for (let b = 0; b < bps; b++) {
      buf[s * bps + b] &= mask[b]
    }
  }

  return buf
}

/**
 * Forward bit-transpose: interleaved samples -> per-channel bitstreams.
 * JS equivalent of the firmware's transpose_chunk_*ch() functions.
 * Used for offline testing without hardware.
 *
 * @param {Uint8Array} samples - interleaved sample data
 * @param {number} numChannels
 * @param {number} chunkSamples
 * @returns {Uint8Array[]} per-channel bitstreams (chunkSamples/8 bytes each)
 */
export function forwardTranspose(samples, numChannels, chunkSamples) {
  const bps = bytesPerSample(numChannels)
  const rawBytes = chunkSamples >> 3
  const channels = new Array(numChannels)

  for (let ch = 0; ch < numChannels; ch++) {
    const chData = new Uint8Array(rawBytes)
    const byteInSample = ch >> 3
    const bitInByte = ch & 7

    for (let s = 0; s < chunkSamples; s++) {
      if ((samples[s * bps + byteInSample] >> bitInByte) & 1) {
        chData[s >> 3] |= 1 << (s & 7)
      }
    }
    channels[ch] = chData
  }

  return channels
}

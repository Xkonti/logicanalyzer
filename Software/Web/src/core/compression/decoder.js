/**
 * Stream compression decoder for RP2350 logic analyzer.
 *
 * Decompresses per-channel nibble-encoded data produced by stream_compress.c.
 * Framework-agnostic — no Vue/Quasar imports.
 */

// Header mode codes (2 bits per channel, LSB-first packing)
export const HDR_RAW = 0x00
export const HDR_ALL_ZERO = 0x01
export const HDR_ALL_ONE = 0x02
export const HDR_NIBBLE_ENC = 0x03

// Nibble prefix code lookup: index → { type, count }
// type: 'raw' = read N data nibbles, 'zero'/'one' = emit N fill nibbles
const NIBBLE_CODES = [
  { type: 'raw', count: 1 }, // 0x0: RAW1
  { type: 'raw', count: 2 }, // 0x1: RAW2
  { type: 'raw', count: 3 }, // 0x2: RAW3
  { type: 'raw', count: 6 }, // 0x3: RAW6
  { type: 'raw', count: 4 }, // 0x4: RAW4
  { type: 'raw', count: 8 }, // 0x5: RAW8
  { type: 'zero', count: 2 }, // 0x6: ZERO2
  { type: 'zero', count: 4 }, // 0x7: ZERO4
  { type: 'zero', count: 8 }, // 0x8: ZERO8
  { type: 'zero', count: 16 }, // 0x9: ZERO16
  { type: 'zero', count: 32 }, // 0xA: ZERO32
  { type: 'one', count: 2 }, // 0xB: ONE2
  { type: 'one', count: 4 }, // 0xC: ONE4
  { type: 'one', count: 8 }, // 0xD: ONE8
  { type: 'one', count: 16 }, // 0xE: ONE16
  { type: 'one', count: 32 }, // 0xF: ONE32
]

/**
 * Reads nibbles MSB-first from a packed byte stream.
 * Matches the encoder's bw_put4() packing order.
 */
export class NibbleReader {
  #data
  #startOffset
  #offset
  #high // true = next read is high nibble of current byte

  constructor(data, startOffset) {
    this.#data = data
    this.#startOffset = startOffset
    this.#offset = startOffset
    this.#high = true
  }

  readNibble() {
    const byte = this.#data[this.#offset]
    if (this.#high) {
      this.#high = false
      return (byte >> 4) & 0xf
    }
    this.#high = true
    this.#offset++
    return byte & 0xf
  }

  get bytesConsumed() {
    return this.#offset - this.#startOffset + (this.#high ? 0 : 1)
  }
}

/**
 * Decompress one chunk of compressed data.
 *
 * @param {Uint8Array} data - compressed chunk bytes
 * @param {number} numChannels - active channel count (1..24)
 * @param {number} chunkSamples - samples per chunk (128, 256, or 512)
 * @returns {{ channels: Uint8Array[], bytesConsumed: number }}
 *   channels[ch] = transposed bitstream (chunkSamples/8 bytes per channel)
 */
export function decompressChunk(data, numChannels, chunkSamples) {
  const rawBytes = chunkSamples >> 3
  const headerBytes = (numChannels + 3) >> 2

  // Parse header: 2 bits per channel, LSB-first
  const modes = new Uint8Array(numChannels)
  for (let ch = 0; ch < numChannels; ch++) {
    modes[ch] = (data[ch >> 2] >> ((ch & 3) * 2)) & 0x03
  }

  const channels = new Array(numChannels)
  let dataPos = headerBytes

  for (let ch = 0; ch < numChannels; ch++) {
    switch (modes[ch]) {
      case HDR_ALL_ZERO:
        channels[ch] = new Uint8Array(rawBytes)
        break

      case HDR_ALL_ONE: {
        const buf = new Uint8Array(rawBytes)
        buf.fill(0xff)
        channels[ch] = buf
        break
      }

      case HDR_RAW:
        channels[ch] = data.slice(dataPos, dataPos + rawBytes)
        dataPos += rawBytes
        break

      case HDR_NIBBLE_ENC: {
        const chunkNibbles = chunkSamples >> 2
        const nibbles = new Uint8Array(chunkNibbles)
        const reader = new NibbleReader(data, dataPos)
        let outPos = 0

        while (outPos < chunkNibbles) {
          const info = NIBBLE_CODES[reader.readNibble()]

          if (info.type === 'raw') {
            for (let i = 0; i < info.count && outPos < chunkNibbles; i++) {
              nibbles[outPos++] = reader.readNibble()
            }
          } else {
            const fill = info.type === 'one' ? 0xf : 0x0
            for (let i = 0; i < info.count && outPos < chunkNibbles; i++) {
              nibbles[outPos++] = fill
            }
          }
        }

        dataPos += reader.bytesConsumed

        // Repack nibbles into transposed bytes (little-endian nibble order)
        // byte j = (nibble[2j+1] << 4) | nibble[2j]
        const result = new Uint8Array(rawBytes)
        for (let j = 0; j < rawBytes; j++) {
          result[j] = ((nibbles[2 * j + 1] << 4) | nibbles[2 * j]) & 0xff
        }
        channels[ch] = result
        break
      }
    }
  }

  return { channels, bytesConsumed: dataPos }
}

/**
 * Reverse the bit-transpose: convert per-channel bitstreams back to
 * interleaved sample bytes.
 *
 * @param {Uint8Array[]} channels - per-channel transposed bitstreams
 * @param {number} numChannels
 * @param {number} chunkSamples
 * @returns {Uint8Array} interleaved samples (chunkSamples × bytesPerSample)
 */
export function reverseTranspose(channels, numChannels, chunkSamples) {
  const bytesPerSample = numChannels <= 8 ? 1 : numChannels <= 16 ? 2 : 4
  const output = new Uint8Array(chunkSamples * bytesPerSample)

  for (let s = 0; s < chunkSamples; s++) {
    let val = 0
    const byteIdx = s >> 3
    const bitIdx = s & 7

    for (let ch = 0; ch < numChannels; ch++) {
      if ((channels[ch][byteIdx] >> bitIdx) & 1) {
        val |= 1 << ch
      }
    }

    const off = s * bytesPerSample
    output[off] = val & 0xff
    if (bytesPerSample >= 2) output[off + 1] = (val >> 8) & 0xff
    if (bytesPerSample >= 4) {
      output[off + 2] = (val >> 16) & 0xff
      output[off + 3] = (val >> 24) & 0xff
    }
  }

  return output
}

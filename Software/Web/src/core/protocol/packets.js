import {
  FRAME_HEADER_0,
  FRAME_HEADER_1,
  FRAME_FOOTER_0,
  FRAME_FOOTER_1,
  ESCAPE_BYTE,
} from './commands.js'

/**
 * Builds and serializes output packets with byte-stuffing.
 * Ports OutputPacket from AnalyzerDriverBase.cs lines 110-168.
 *
 * Wire format: [0x55 0xAA] [escaped payload] [0xAA 0x55]
 * Escaping: bytes 0xAA, 0x55, 0xF0 → [0xF0, byte ^ 0xF0]
 */
export class OutputPacket {
  #dataBuffer = []

  /** @param {number} byte */
  addByte(byte) {
    this.#dataBuffer.push(byte & 0xff)
  }

  /** @param {Uint8Array|number[]} bytes */
  addBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.#dataBuffer.push(bytes[i] & 0xff)
    }
  }

  /** @param {string} str - ASCII string */
  addString(str) {
    for (let i = 0; i < str.length; i++) {
      this.#dataBuffer.push(str.charCodeAt(i) & 0xff)
    }
  }

  clear() {
    this.#dataBuffer.length = 0
  }

  /** @returns {Uint8Array} */
  serialize() {
    const result = []
    result.push(FRAME_HEADER_0, FRAME_HEADER_1)

    for (let i = 0; i < this.#dataBuffer.length; i++) {
      const byte = this.#dataBuffer[i]
      if (byte === 0xaa || byte === 0x55 || byte === ESCAPE_BYTE) {
        result.push(ESCAPE_BYTE, byte ^ ESCAPE_BYTE)
      } else {
        result.push(byte)
      }
    }

    result.push(FRAME_FOOTER_0, FRAME_FOOTER_1)
    return new Uint8Array(result)
  }
}

/**
 * Builds the 56-byte CaptureRequest struct in little-endian format.
 * Matches the C struct layout with default alignment padding:
 *   offset 3: 1 byte padding before uint16_t triggerValue
 *   offset 39: 1 byte padding before uint32_t frequency
 *
 * Ports CaptureRequest from AnalyzerDriverBase.cs lines 171-187
 * and Firmware/LogicAnalyzer_V2/LogicAnalyzer_Structs.h.
 *
 * @param {Object} session
 * @param {number} session.triggerType - 0=Edge, 1=Complex, 2=Fast, 3=Blast
 * @param {number} session.triggerChannel - trigger channel number
 * @param {number} session.invertedOrCount - inverted flag (Edge/Blast) or bit count (Complex/Fast)
 * @param {number} session.triggerValue - pattern for Complex/Fast triggers
 * @param {number[]} session.channels - channel numbers (up to 32)
 * @param {number} session.channelCount
 * @param {number} session.frequency
 * @param {number} session.preSamples
 * @param {number} session.postSamples
 * @param {number} session.loopCount
 * @param {number} session.measure - 0 or 1
 * @param {number} session.captureMode - 0=8ch, 1=16ch, 2=24ch
 * @returns {Uint8Array} exactly 56 bytes
 */
export function buildCaptureRequest(session) {
  const buffer = new ArrayBuffer(56)
  const view = new DataView(buffer)

  view.setUint8(0, session.triggerType)
  view.setUint8(1, session.triggerChannel)
  view.setUint8(2, session.invertedOrCount)
  // offset 3: alignment padding (already zero)
  view.setUint16(4, session.triggerValue, true) // little-endian

  // channels: 32-byte zero-padded array at offset 6
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < Math.min(session.channels.length, 32); i++) {
    bytes[6 + i] = session.channels[i]
  }

  view.setUint8(38, session.channelCount)
  // offset 39: alignment padding (already zero)
  view.setUint32(40, session.frequency, true)
  view.setUint32(44, session.preSamples, true)
  view.setUint32(48, session.postSamples, true)
  view.setUint16(52, session.loopCount, true)
  view.setUint8(54, session.measure)
  view.setUint8(55, session.captureMode)

  return new Uint8Array(buffer)
}

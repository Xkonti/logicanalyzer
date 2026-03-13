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
/**
 * Builds the 40-byte StreamRequest struct in little-endian format.
 * Matches the C firmware STREAM_REQUEST with natural alignment:
 *   offset 0:  uint8_t[32] channels (zero-padded)
 *   offset 32: uint8_t channelCount
 *   offset 33: padding
 *   offset 34: uint16_t chunkSamples (LE)
 *   offset 36: uint32_t frequency (LE)
 *
 * @param {Object} config
 * @param {number[]} config.channels - channel numbers (up to 32)
 * @param {number} config.channelCount
 * @param {number} config.chunkSamples - chunk size in samples (32-1024, multiple of 32)
 * @param {number} config.frequency - sampling frequency in Hz
 * @returns {Uint8Array} exactly 40 bytes
 */
export function buildStreamRequest(config) {
  const buffer = new ArrayBuffer(40)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // channels: 32-byte zero-padded array at offset 0
  for (let i = 0; i < Math.min(config.channels.length, 32); i++) {
    bytes[i] = config.channels[i]
  }

  view.setUint8(32, config.channelCount)
  // offset 33: alignment padding (already zero)
  view.setUint16(34, config.chunkSamples, true) // little-endian
  view.setUint32(36, config.frequency, true) // little-endian

  return new Uint8Array(buffer)
}

/**
 * Writes a null-padded ASCII string into a Uint8Array at the given offset.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {string} str
 * @param {number} maxLen - field size (including null terminator space)
 */
function writeNullPaddedString(bytes, offset, str, maxLen) {
  const len = Math.min(str.length, maxLen - 1)
  for (let i = 0; i < len; i++) {
    bytes[offset + i] = str.charCodeAt(i) & 0xff
  }
  // remaining bytes are already zero from ArrayBuffer initialization
}

/**
 * Builds the WIFI_SETTINGS_REQUEST struct.
 * Matches firmware LogicAnalyzer_Structs.h WIFI_SETTINGS_REQUEST
 * and C# AnalyzerDriverBase.cs NetConfig with natural alignment.
 *
 * Layout (GCC ARM / C# Sequential, matching alignment conventions
 * used in buildCaptureRequest and buildStreamRequest):
 *   offset 0:   char[33]   apName
 *   offset 33:  char[64]   passwd
 *   offset 97:  char[16]   ipAddress
 *   offset 113: 1 byte     alignment padding (uint16_t needs 2-byte alignment)
 *   offset 114: uint16_t   port (LE)
 *   offset 116: char[33]   hostname
 *   offset 149: 1 byte     trailing struct alignment padding
 *   Total: 150 bytes
 *
 * @param {Object} config
 * @param {string} config.ssid - WiFi SSID (max 32 chars)
 * @param {string} config.password - WiFi password (max 63 chars)
 * @param {string} config.ipAddress - IPv4 address string (max 15 chars)
 * @param {number} config.port - TCP port (1-65535)
 * @param {string} [config.hostname=''] - Device hostname (max 32 chars)
 * @returns {Uint8Array} exactly 150 bytes
 */
export function buildNetworkConfigRequest({ ssid, password, ipAddress, port, hostname = '' }) {
  const buffer = new ArrayBuffer(150)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  writeNullPaddedString(bytes, 0, ssid, 33)
  writeNullPaddedString(bytes, 33, password, 64)
  writeNullPaddedString(bytes, 97, ipAddress, 16)
  // offset 113: alignment padding (already zero)
  view.setUint16(114, port, true) // little-endian
  writeNullPaddedString(bytes, 116, hostname, 33)

  return new Uint8Array(buffer)
}

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

import { MIN_MAJOR_VERSION, MIN_MINOR_VERSION, MIN_PATCH_VERSION } from './commands.js'

const VERSION_REGEX = /^LA-(\d+)\.(\d+)\.(\d+)$/
const FREQ_REGEX = /^FREQ:(\d+)$/
const BLAST_FREQ_REGEX = /^BLASTFREQ:(\d+)$/
const BUFFER_REGEX = /^BUFFER:(\d+)$/
const CHANNELS_REGEX = /^CHANNELS:(\d+)$/
const SSID_REGEX = /^SSID:(.*)$/
const HOSTNAME_REGEX = /^HOSTNAME:(.*)$/

/**
 * Validates a device version string in "LA-major.minor.patch" format.
 *
 * @param {string} versionString
 * @returns {{ valid: boolean, major: number, minor: number, patch: number }}
 */
export function validateVersion(versionString) {
  const match = VERSION_REGEX.exec(versionString || '')
  if (!match) {
    return { valid: false, major: 0, minor: 0, patch: 0 }
  }

  const major = parseInt(match[1], 10)
  const minor = parseInt(match[2], 10)
  const patch = parseInt(match[3], 10)
  const valid =
    major > MIN_MAJOR_VERSION ||
    (major === MIN_MAJOR_VERSION &&
      (minor > MIN_MINOR_VERSION || (minor === MIN_MINOR_VERSION && patch >= MIN_PATCH_VERSION)))

  return { valid, major, minor, patch }
}

/**
 * @typedef {Object} DeviceInfo
 * @property {string} version - Raw version string
 * @property {number} majorVersion
 * @property {number} minorVersion
 * @property {number} maxFrequency
 * @property {number} blastFrequency
 * @property {number} bufferSize
 * @property {number} channelCount
 * @property {string} ssid - Configured WiFi SSID (empty if none)
 * @property {string} hostname - Configured hostname (empty if none)
 */

/**
 * Reads the 5-line device init handshake response.
 * Ports LogicAnalyzerDriver.cs lines 133-189 (InitSerialPort handshake).
 *
 * Expected line order:
 *   1. Version string (e.g., "LA-7.0.0")
 *   2. "FREQ:100000000"
 *   3. "BLASTFREQ:200000000"
 *   4. "BUFFER:262144"
 *   5. "CHANNELS:24"
 *   6. "SSID:<name>" (may be empty)
 *   7. "HOSTNAME:<name>" (may be empty)
 *
 * @param {import('../transport/types.js').ITransport} transport
 * @returns {Promise<DeviceInfo>}
 */
export async function parseInitResponse(transport) {
  // Skip any non-version lines that may remain from firmware boot noise.
  // The drain in serial.js clears most of it, but partial chunks may linger.
  const MAX_SKIP = 20
  let versionLine
  let ver
  for (let i = 0; i < MAX_SKIP; i++) {
    versionLine = await transport.readLine()
    ver = validateVersion(versionLine)
    if (ver.valid) break
  }
  if (!ver.valid) {
    throw new Error(
      `Invalid device version "${versionLine}", minimum supported: V${MIN_MAJOR_VERSION}_${MIN_MINOR_VERSION}`,
    )
  }

  const freqLine = await transport.readLine()
  const freqMatch = FREQ_REGEX.exec(freqLine)
  if (!freqMatch) {
    throw new Error(`Invalid frequency response: "${freqLine}"`)
  }

  const blastLine = await transport.readLine()
  const blastMatch = BLAST_FREQ_REGEX.exec(blastLine)
  if (!blastMatch) {
    throw new Error(`Invalid blast frequency response: "${blastLine}"`)
  }

  const bufLine = await transport.readLine()
  const bufMatch = BUFFER_REGEX.exec(bufLine)
  if (!bufMatch) {
    throw new Error(`Invalid buffer size response: "${bufLine}"`)
  }

  const chanLine = await transport.readLine()
  const chanMatch = CHANNELS_REGEX.exec(chanLine)
  if (!chanMatch) {
    throw new Error(`Invalid channel count response: "${chanLine}"`)
  }

  const ssidLine = await transport.readLine()
  const ssidMatch = SSID_REGEX.exec(ssidLine)
  if (!ssidMatch) {
    throw new Error(`Invalid SSID response: "${ssidLine}"`)
  }

  const hostnameLine = await transport.readLine()
  const hostnameMatch = HOSTNAME_REGEX.exec(hostnameLine)
  if (!hostnameMatch) {
    throw new Error(`Invalid hostname response: "${hostnameLine}"`)
  }

  return {
    version: versionLine,
    majorVersion: ver.major,
    minorVersion: ver.minor,
    maxFrequency: parseInt(freqMatch[1], 10),
    blastFrequency: parseInt(blastMatch[1], 10),
    bufferSize: parseInt(bufMatch[1], 10),
    channelCount: parseInt(chanMatch[1], 10),
    ssid: ssidMatch[1],
    hostname: hostnameMatch[1],
  }
}

/**
 * Reads the capture start acknowledgment.
 *
 * @param {import('../transport/types.js').ITransport} transport
 * @returns {Promise<string>} the response line from the device
 */
export async function parseCaptureStartResponse(transport) {
  return await transport.readLine()
}

/**
 * Reads binary capture data from the device.
 * Ports LogicAnalyzerDriver.cs ReadCapture (lines 442-527).
 *
 * Wire format:
 *   1. UInt32 LE: sample count
 *   2. sample_count * bytesPerSample bytes of raw sample data
 *   3. 1 byte: timestamp flag (0 = none, >0 = has timestamps)
 *   4. If timestamps: (loopCount + 2) * 4 bytes of UInt32 LE timestamps
 *
 * @param {import('../transport/types.js').ITransport} transport
 * @param {number} captureMode - 0=8ch, 1=16ch, 2=24ch
 * @param {number} loopCount
 * @param {boolean} measureBursts
 * @returns {Promise<{ samples: Uint32Array, timestamps: Uint32Array }>}
 */
export async function parseCaptureData(transport, captureMode, loopCount, measureBursts) {
  // Read sample count (4 bytes, UInt32 LE)
  const countBytes = await transport.readBytes(4)
  const countView = new DataView(countBytes.buffer, countBytes.byteOffset, 4)
  const sampleCount = countView.getUint32(0, true)

  // Determine bytes per sample
  const bytesPerSample = captureMode === 0 ? 1 : captureMode === 1 ? 2 : 4

  // Read raw sample data
  const rawBytes = await transport.readBytes(sampleCount * bytesPerSample)
  const rawView = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.length)

  // Parse samples into Uint32Array
  const samples = new Uint32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    if (captureMode === 0) {
      samples[i] = rawView.getUint8(i)
    } else if (captureMode === 1) {
      samples[i] = rawView.getUint16(i * 2, true)
    } else {
      samples[i] = rawView.getUint32(i * 4, true)
    }
  }

  // Read timestamp flag
  const flagBytes = await transport.readBytes(1)
  const stampLength = flagBytes[0]

  // Read timestamps if present
  let timestamps = new Uint32Array(0)
  if (stampLength > 0 && loopCount > 0 && measureBursts) {
    const tsCount = loopCount + 2
    const tsBytes = await transport.readBytes(tsCount * 4)
    const tsView = new DataView(tsBytes.buffer, tsBytes.byteOffset, tsBytes.length)
    timestamps = new Uint32Array(tsCount)
    for (let i = 0; i < tsCount; i++) {
      timestamps[i] = tsView.getUint32(i * 4, true)
    }
  }

  return { samples, timestamps }
}

/**
 * Reads a single line and checks if it matches the expected response.
 *
 * @param {import('../transport/types.js').ITransport} transport
 * @param {string} expectedResponse
 * @returns {Promise<boolean>}
 */
export async function parseResponseLine(transport, expectedResponse) {
  const line = await transport.readLine()
  return line === expectedResponse
}

/**
 * High-level device driver for the LogicAnalyzer.
 * Ports AnalyzerDriverBase + LogicAnalyzerDriver from SharedDriver.
 */

import { OutputPacket, buildCaptureRequest } from '../protocol/packets.js'
import {
  parseInitResponse,
  parseCaptureStartResponse,
  parseCaptureData,
  parseResponseLine,
} from '../protocol/parser.js'
import {
  CMD_DEVICE_INIT,
  CMD_START_CAPTURE,
  CMD_STOP_CAPTURE,
  CMD_ENTER_BOOTLOADER,
  CMD_BLINK_LED_ON,
  CMD_BLINK_LED_OFF,
  TRIGGER_EDGE,
  TRIGGER_BLAST,
  TRIGGER_FAST,
  CAPTURE_MODE_8CH,
  CAPTURE_MODE_16CH,
  CAPTURE_MODE_24CH,
  COMPLEX_TRIGGER_DELAY,
  FAST_TRIGGER_DELAY,
} from '../protocol/commands.js'
import { extractSamples, processBurstTimestamps } from './samples.js'

export class AnalyzerDriver {
  #transport = null
  #version = null
  #majorVersion = 0
  #minorVersion = 0
  #maxFrequency = 0
  #blastFrequency = 0
  #bufferSize = 0
  #channelCount = 0
  #capturing = false

  get version() {
    return this.#version
  }
  get majorVersion() {
    return this.#majorVersion
  }
  get minorVersion() {
    return this.#minorVersion
  }
  get maxFrequency() {
    return this.#maxFrequency
  }
  get blastFrequency() {
    return this.#blastFrequency
  }
  get minFrequency() {
    return Math.floor((this.#maxFrequency * 2) / 65535)
  }
  get bufferSize() {
    return this.#bufferSize
  }
  get channelCount() {
    return this.#channelCount
  }
  get capturing() {
    return this.#capturing
  }
  get connected() {
    return this.#transport?.connected ?? false
  }

  /**
   * Connect to the device via a transport, perform init handshake.
   * @param {import('../transport/types.js').ITransport} transport
   */
  async connect(transport) {
    this.#transport = transport

    const pkt = new OutputPacket()
    pkt.addByte(CMD_DEVICE_INIT)
    await transport.write(pkt.serialize())

    const info = await parseInitResponse(transport)
    this.#version = info.version
    this.#majorVersion = info.majorVersion
    this.#minorVersion = info.minorVersion
    this.#maxFrequency = info.maxFrequency
    this.#blastFrequency = info.blastFrequency
    this.#bufferSize = info.bufferSize
    this.#channelCount = info.channelCount
  }

  async disconnect() {
    this.#capturing = false
    if (this.#transport) {
      await this.#transport.disconnect()
    }
  }

  /**
   * Determines capture mode from channel numbers.
   * @param {number[]} channelNumbers
   * @returns {number} CAPTURE_MODE_8CH/16CH/24CH
   */
  getCaptureMode(channelNumbers) {
    const max = channelNumbers.length === 0 ? 0 : Math.max(...channelNumbers)
    return max < 8 ? CAPTURE_MODE_8CH : max < 16 ? CAPTURE_MODE_16CH : CAPTURE_MODE_24CH
  }

  /**
   * Calculates capture limits for given channels.
   * @param {number[]} channelNumbers
   * @returns {import('./types.js').CaptureLimits}
   */
  getLimits(channelNumbers) {
    const mode = this.getCaptureMode(channelNumbers)
    const bytesPerSample = mode === CAPTURE_MODE_8CH ? 1 : mode === CAPTURE_MODE_16CH ? 2 : 4
    const totalSamples = Math.floor(this.#bufferSize / bytesPerSample)

    return {
      minPreSamples: 2,
      maxPreSamples: Math.floor(totalSamples / 10),
      minPostSamples: 2,
      maxPostSamples: totalSamples - 2,
      maxTotalSamples: 2 + (totalSamples - 2), // minPreSamples + maxPostSamples
    }
  }

  /**
   * Returns full device info with limits for all 3 capture modes.
   * @returns {import('./types.js').DeviceInfo}
   */
  getDeviceInfo() {
    const range8 = Array.from({ length: 7 }, (_, i) => i)
    const range16 = Array.from({ length: 15 }, (_, i) => i)
    const range24 = Array.from({ length: 23 }, (_, i) => i)

    return {
      name: this.#version ?? 'Unknown',
      maxFrequency: this.#maxFrequency,
      blastFrequency: this.#blastFrequency,
      channels: this.#channelCount,
      bufferSize: this.#bufferSize,
      modeLimits: [this.getLimits(range8), this.getLimits(range16), this.getLimits(range24)],
    }
  }

  /**
   * Validates capture session settings.
   * Ports ValidateSettings from LogicAnalyzerDriver.cs lines 734-799.
   *
   * @param {import('./types.js').CaptureSession} session
   * @returns {boolean}
   */
  validateSettings(session) {
    const channelNumbers = session.captureChannels.map((c) => c.channelNumber)
    const limits = this.getLimits(channelNumbers)
    const requestedSamples =
      session.preTriggerSamples + session.postTriggerSamples * (session.loopCount + 1)

    const minChan = Math.min(...channelNumbers)
    const maxChan = Math.max(...channelNumbers)

    if (session.triggerType === TRIGGER_EDGE) {
      if (
        minChan < 0 ||
        maxChan > this.#channelCount - 1 ||
        session.triggerChannel < 0 ||
        session.triggerChannel > this.#channelCount || // channelCount = ext trigger
        session.preTriggerSamples < limits.minPreSamples ||
        session.postTriggerSamples < limits.minPostSamples ||
        session.preTriggerSamples > limits.maxPreSamples ||
        session.postTriggerSamples > limits.maxPostSamples ||
        requestedSamples > limits.maxTotalSamples ||
        session.frequency < this.minFrequency ||
        session.frequency > this.#maxFrequency ||
        (session.measureBursts && session.loopCount > 254) ||
        (session.measureBursts && session.postTriggerSamples < 100) ||
        session.loopCount > 65534
      ) {
        return false
      }
    } else if (session.triggerType === TRIGGER_BLAST) {
      if (
        minChan < 0 ||
        maxChan > this.#channelCount - 1 ||
        session.triggerChannel < 0 ||
        session.triggerChannel > this.#channelCount ||
        session.preTriggerSamples < 0 ||
        session.preTriggerSamples > 0 || // must be exactly 0
        session.postTriggerSamples < limits.minPostSamples ||
        session.postTriggerSamples > limits.maxTotalSamples ||
        requestedSamples > limits.maxTotalSamples ||
        session.frequency < this.#blastFrequency ||
        session.frequency > this.#blastFrequency || // must equal blastFrequency
        session.loopCount !== 0
      ) {
        return false
      }
    } else {
      // Complex or Fast
      const maxBitCount = session.triggerType === TRIGGER_FAST ? 5 : 16
      if (
        minChan < 0 ||
        maxChan > this.#channelCount - 1 ||
        session.triggerBitCount < 1 ||
        session.triggerBitCount > maxBitCount ||
        session.triggerChannel < 0 ||
        session.triggerChannel > 15 ||
        session.triggerChannel + session.triggerBitCount > maxBitCount ||
        session.preTriggerSamples < limits.minPreSamples ||
        session.postTriggerSamples < limits.minPostSamples ||
        session.preTriggerSamples > limits.maxPreSamples ||
        session.postTriggerSamples > limits.maxPostSamples ||
        requestedSamples > limits.maxTotalSamples ||
        session.frequency < this.minFrequency ||
        session.frequency > this.#maxFrequency
      ) {
        return false
      }
    }

    return true
  }

  /**
   * Composes the low-level capture request from a session.
   * Ports ComposeRequest from LogicAnalyzerDriver.cs lines 682-731.
   *
   * @param {import('./types.js').CaptureSession} session
   * @returns {Object} params for buildCaptureRequest()
   */
  composeRequest(session) {
    const channelNumbers = session.captureChannels.map((c) => c.channelNumber)
    const mode = this.getCaptureMode(channelNumbers)

    if (session.triggerType === TRIGGER_EDGE || session.triggerType === TRIGGER_BLAST) {
      return {
        triggerType: session.triggerType,
        triggerChannel: session.triggerChannel,
        invertedOrCount: session.triggerInverted ? 1 : 0,
        triggerValue: 0,
        channels: channelNumbers,
        channelCount: session.captureChannels.length,
        frequency: session.frequency,
        preSamples: session.preTriggerSamples,
        postSamples: session.postTriggerSamples,
        loopCount: session.loopCount,
        measure: session.measureBursts ? 1 : 0,
        captureMode: mode,
      }
    }

    // Complex or Fast — apply trigger delay offset
    const samplePeriod = 1e9 / session.frequency
    const delay = session.triggerType === TRIGGER_FAST ? FAST_TRIGGER_DELAY : COMPLEX_TRIGGER_DELAY
    const delayPeriod = (1.0 / this.#maxFrequency) * 1e9 * delay
    const offset = Math.round(delayPeriod / samplePeriod + 0.3)

    return {
      triggerType: session.triggerType,
      triggerChannel: session.triggerChannel,
      invertedOrCount: session.triggerBitCount,
      triggerValue: session.triggerPattern,
      channels: channelNumbers,
      channelCount: session.captureChannels.length,
      frequency: session.frequency,
      preSamples: session.preTriggerSamples + offset,
      postSamples: session.postTriggerSamples - offset,
      loopCount: session.loopCount,
      measure: session.measureBursts ? 1 : 0,
      captureMode: mode,
    }
  }

  /**
   * Starts a capture. Sends command, reads response and data, extracts samples.
   *
   * @param {import('./types.js').CaptureSession} session
   * @param {(result: import('./types.js').CaptureResult) => void} onComplete
   */
  async startCapture(session, onComplete) {
    if (this.#capturing) throw new Error('Already capturing')
    if (!this.#transport?.connected) throw new Error('Not connected')
    if (!session.captureChannels || session.captureChannels.length === 0) {
      onComplete?.({ success: false, session })
      return
    }

    if (!this.validateSettings(session)) {
      onComplete?.({ success: false, session })
      return
    }

    try {
      const request = this.composeRequest(session)
      const mode = request.captureMode

      const pkt = new OutputPacket()
      pkt.addByte(CMD_START_CAPTURE)
      pkt.addBytes(buildCaptureRequest(request))
      await this.#transport.write(pkt.serialize())

      const started = await parseCaptureStartResponse(this.#transport)
      if (!started) {
        onComplete?.({ success: false, session })
        return
      }

      this.#capturing = true

      const { samples: rawSamples, timestamps } = await parseCaptureData(
        this.#transport,
        mode,
        session.loopCount,
        session.measureBursts,
      )

      // Extract per-channel samples
      for (let i = 0; i < session.captureChannels.length; i++) {
        session.captureChannels[i].samples = extractSamples(rawSamples, i)
      }

      // Process burst timestamps if present
      if (timestamps.length > 0) {
        session.bursts = processBurstTimestamps(timestamps, session, this.#blastFrequency)
      }

      this.#capturing = false
      onComplete?.({ success: true, session })
    } catch {
      this.#capturing = false
      onComplete?.({ success: false, session })
    }
  }

  /**
   * Stops an ongoing capture. Sends raw 0xFF, waits, reconnects.
   * @returns {Promise<boolean>}
   */
  async stopCapture() {
    if (!this.#capturing) return false
    this.#capturing = false

    try {
      await this.#transport.write(new Uint8Array([CMD_STOP_CAPTURE]))
      await new Promise((r) => setTimeout(r, 2000))
      await this.#transport.disconnect()
      await this.#transport.connect()
    } catch {
      // Ignore errors during stop (matches C# catch { })
    }

    return true
  }

  /** @returns {Promise<boolean>} */
  async blinkLed() {
    const pkt = new OutputPacket()
    pkt.addByte(CMD_BLINK_LED_ON)
    await this.#transport.write(pkt.serialize())
    return parseResponseLine(this.#transport, 'BLINKON')
  }

  /** @returns {Promise<boolean>} */
  async stopBlinkLed() {
    const pkt = new OutputPacket()
    pkt.addByte(CMD_BLINK_LED_OFF)
    await this.#transport.write(pkt.serialize())
    return parseResponseLine(this.#transport, 'BLINKOFF')
  }

  /** @returns {Promise<boolean>} */
  async enterBootloader() {
    if (this.#capturing || !this.#transport?.connected) return false
    const pkt = new OutputPacket()
    pkt.addByte(CMD_ENTER_BOOTLOADER)
    await this.#transport.write(pkt.serialize())
    return parseResponseLine(this.#transport, 'RESTARTING_BOOTLOADER')
  }
}

/**
 * High-level device driver for the LogicAnalyzer.
 * Ports AnalyzerDriverBase + LogicAnalyzerDriver from SharedDriver.
 */

import {
  OutputPacket,
  buildCaptureRequest,
  buildPreviewRequest,
  buildStreamRequest,
} from '../protocol/packets.js'
import {
  parseInitResponse,
  parseCaptureStartResponse,
  parseCaptureData,
  parsePreviewPacket,
  parseResponseLine,
} from '../protocol/parser.js'
import {
  CMD_DEVICE_INIT,
  CMD_START_CAPTURE,
  CMD_STOP_CAPTURE,
  CMD_START_PREVIEW,
  CMD_STOP_PREVIEW,
  CMD_START_STREAM,
  CMD_STOP_STREAM,
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
import { decompressChunk } from '../compression/decoder.js'

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
  #previewing = false
  #streaming = false

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
  get previewing() {
    return this.#previewing
  }
  get streaming() {
    return this.#streaming
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
    this.#previewing = false
    this.#streaming = false
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
    if (this.#previewing) throw new Error('Preview is active')
    if (this.#streaming) throw new Error('Streaming is active')
    if (!this.#transport?.connected) throw new Error('Not connected')
    if (!session.captureChannels || session.captureChannels.length === 0) {
      onComplete?.({ success: false, session, error: 'No capture channels' })
      return
    }

    if (!this.validateSettings(session)) {
      onComplete?.({ success: false, session, error: 'Invalid capture settings' })
      return
    }

    try {
      const request = this.composeRequest(session)
      const mode = request.captureMode

      const pkt = new OutputPacket()
      pkt.addByte(CMD_START_CAPTURE)
      pkt.addBytes(buildCaptureRequest(request))
      await this.#transport.write(pkt.serialize())

      const response = await parseCaptureStartResponse(this.#transport)
      if (response !== 'CAPTURE_STARTED') {
        onComplete?.({
          success: false,
          session,
          error: `Device responded "${response}" instead of CAPTURE_STARTED`,
        })
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
    } catch (err) {
      this.#capturing = false
      onComplete?.({ success: false, session, error: err?.message ?? String(err) })
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

  /**
   * Starts realtime preview. Sends CMD_START_PREVIEW, reads "PREVIEW_STARTED",
   * then launches an async read loop calling onData for each packet.
   *
   * Ports StartRealtimePreview from LogicAnalyzerDriver.cs lines 965-1029.
   *
   * @param {Object} config
   * @param {number[]} config.channels - channel numbers to monitor
   * @param {number} config.intervalsPerSecond - 1-60
   * @param {number} config.samplesPerInterval - 1-16
   * @param {(samples: number[][]) => void} onData - called for each preview packet
   * @returns {Promise<boolean>} true if preview started successfully
   */
  async startPreview(config, onData) {
    if (this.#capturing || this.#previewing || this.#streaming) return false
    if (!this.#transport?.connected) return false

    if (!config.channels || config.channels.length === 0 || config.channels.length > 24) return false
    if (config.intervalsPerSecond < 1 || config.intervalsPerSecond > 60) return false
    if (config.samplesPerInterval < 1 || config.samplesPerInterval > 16) return false

    try {
      const intervalUs = Math.floor(1000000 / config.intervalsPerSecond)

      const pkt = new OutputPacket()
      pkt.addByte(CMD_START_PREVIEW)
      pkt.addBytes(
        buildPreviewRequest({
          channels: config.channels,
          intervalUs,
          channelCount: config.channels.length,
          samplesPerInterval: config.samplesPerInterval,
        }),
      )
      await this.#transport.write(pkt.serialize())

      const response = await this.#transport.readLine()
      if (response !== 'PREVIEW_STARTED') return false

      this.#previewing = true

      // Fire-and-forget the read loop (don't await)
      this.#readPreviewLoop(config.channels.length, config.samplesPerInterval, onData)

      return true
    } catch {
      return false
    }
  }

  /**
   * Internal async loop that continuously reads preview packets.
   * @param {number} channelCount
   * @param {number} samplesPerInterval
   * @param {(samples: number[][]) => void} onData
   */
  async #readPreviewLoop(channelCount, samplesPerInterval, onData) {
    try {
      while (this.#previewing) {
        const samples = await parsePreviewPacket(this.#transport, channelCount, samplesPerInterval)
        if (this.#previewing) {
          onData(samples)
        }
      }
    } catch {
      // Expected when preview is stopped (transport disconnects)
      if (this.#previewing) {
        this.#previewing = false
      }
    }
  }

  /**
   * Starts streaming capture. Sends CMD_START_STREAM, reads handshake,
   * then launches an async read loop calling onChunk for each decompressed chunk.
   *
   * @param {Object} config
   * @param {number[]} config.channels - channel numbers to capture
   * @param {number} config.frequency - sampling frequency in Hz
   * @param {(channels: Uint8Array[], chunkSamples: number) => void} onChunk
   * @returns {Promise<{started: boolean, chunkSamples?: number, numChannels?: number, endStatus?: string}>}
   */
  async startStream(config, onChunk) {
    if (this.#capturing || this.#previewing || this.#streaming) return { started: false }
    if (!this.#transport?.connected) return { started: false }

    if (!config.channels || config.channels.length === 0 || config.channels.length > 24) {
      return { started: false }
    }

    try {
      const pkt = new OutputPacket()
      pkt.addByte(CMD_START_STREAM)
      pkt.addBytes(
        buildStreamRequest({
          channels: config.channels,
          channelCount: config.channels.length,
          frequency: config.frequency,
        }),
      )
      await this.#transport.write(pkt.serialize())

      const response = await this.#transport.readLine()
      if (response !== 'STREAM_STARTED') return { started: false }

      // Read 4-byte info header: [chunkSamples LE16][numChannels u8][reserved u8]
      const info = await this.#transport.readBytes(4)
      const chunkSamples = info[0] | (info[1] << 8)
      const numChannels = info[2]

      this.#streaming = true

      // Fire-and-forget the read loop
      this.#streamEndStatus = null
      this.#readStreamLoop(numChannels, chunkSamples, onChunk)

      return { started: true, chunkSamples, numChannels }
    } catch {
      return { started: false }
    }
  }

  #streamEndStatus = null

  /**
   * Internal async loop that reads compressed stream chunks until EOF.
   */
  async #readStreamLoop(numChannels, chunkSamples, onChunk) {
    try {
      while (true) {
        const sizeBytes = await this.#transport.readBytes(2)
        const compressedSize = sizeBytes[0] | (sizeBytes[1] << 8)
        if (compressedSize === 0) break // EOF marker

        const compressed = await this.#transport.readBytes(compressedSize)
        const { channels } = decompressChunk(compressed, numChannels, chunkSamples)
        onChunk(channels, chunkSamples)
      }

      this.#streaming = false
      const endLine = await this.#transport.readLine()
      this.#streamEndStatus = endLine // "STREAM_DONE" or "STREAM_OVERFLOW"
    } catch {
      if (this.#streaming) {
        this.#streaming = false
      }
    }
  }

  /**
   * Stops streaming capture. Sends CMD_STOP_STREAM, waits for read loop to finish,
   * then reconnects transport.
   *
   * @returns {Promise<{stopped: boolean, endStatus?: string}>}
   */
  async stopStream() {
    if (!this.#streaming) return { stopped: false }

    try {
      // Send stop command
      const pkt = new OutputPacket()
      pkt.addByte(CMD_STOP_STREAM)
      await this.#transport.write(pkt.serialize())

      // Wait for read loop to finish (it reads until EOF)
      const maxWait = 5000
      const start = Date.now()
      while (this.#streaming && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 50))
      }

      const endStatus = this.#streamEndStatus

      // Reconnect transport (same pattern as preview stop)
      await new Promise((r) => setTimeout(r, 200))
      await this.#transport.disconnect()
      await new Promise((r) => setTimeout(r, 1))
      await this.#transport.connect()

      return { stopped: true, endStatus }
    } catch {
      this.#streaming = false
      return { stopped: false }
    }
  }

  /**
   * Stops realtime preview. Signals the read loop to stop, sends CMD_STOP_PREVIEW,
   * then disconnects and reconnects the transport.
   *
   * Ports StopRealtimePreview from LogicAnalyzerDriver.cs lines 1105-1157.
   *
   * @returns {Promise<boolean>}
   */
  async stopPreview() {
    if (!this.#previewing) return false
    this.#previewing = false

    try {
      // Wait for the read loop to notice the flag change
      await new Promise((r) => setTimeout(r, 200))

      // Send stop command
      const pkt = new OutputPacket()
      pkt.addByte(CMD_STOP_PREVIEW)
      await this.#transport.write(pkt.serialize())

      // Wait, then reconnect (matches C# serial close/reopen pattern)
      await new Promise((r) => setTimeout(r, 500))
      await this.#transport.disconnect()
      await new Promise((r) => setTimeout(r, 1))
      await this.#transport.connect()
    } catch {
      // Ignore errors during stop (matches C# catch { })
    }

    return true
  }
}

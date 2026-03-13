/**
 * High-level device driver for the LogicAnalyzer.
 * Ports AnalyzerDriverBase + LogicAnalyzerDriver from SharedDriver.
 */

import {
  OutputPacket,
  buildCaptureRequest,
  buildStreamRequest,
  buildNetworkConfigRequest,
} from '../protocol/packets.js'

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}
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
  CMD_START_STREAM,
  CMD_STOP_STREAM,
  CMD_NETWORK_CONFIG,
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
  #ssid = ''
  #hostname = ''
  #capturing = false
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
    this.#ssid = info.ssid
    this.#hostname = info.hostname
  }

  async disconnect() {
    this.#capturing = false
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
      ssid: this.#ssid,
      hostname: this.#hostname,
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
   * Sends network configuration to the device.
   * Ports SendNetworkConfig from LogicAnalyzerDriver.cs lines 870-906.
   *
   * @param {Object} config
   * @param {string} config.ssid
   * @param {string} config.password
   * @param {string} config.ipAddress
   * @param {number} config.port
   * @param {string} [config.hostname='']
   * @returns {Promise<boolean>} true if device responds "SETTINGS_SAVED"
   */
  async sendNetworkConfig({ ssid, password, ipAddress, port, hostname = '' }) {
    if (this.#capturing || this.#streaming) throw new Error('Device is busy')
    if (!this.#transport?.connected) throw new Error('Not connected')

    const pkt = new OutputPacket()
    pkt.addByte(CMD_NETWORK_CONFIG)
    pkt.addBytes(buildNetworkConfigRequest({ ssid, password, ipAddress, port, hostname }))
    await this.#transport.write(pkt.serialize())

    return await withTimeout(
      parseResponseLine(this.#transport, 'SETTINGS_SAVED'),
      5000,
      'Timeout: no response from device within 5s',
    )
  }

  /**
   * Starts streaming capture. Sends CMD_START_STREAM, reads handshake,
   * then launches an async read loop calling onChunk for each decompressed chunk.
   *
   * @param {Object} config
   * @param {number[]} config.channels - channel numbers to capture
   * @param {number} config.frequency - sampling frequency in Hz
   * @param {(channels: Uint8Array[], chunkSamples: number) => void} onChunk
   * @param {(endStatus: string|null, error: string|null) => void} onEnd
   * @param {(report: {dmaSkips: number, txSkips: number}) => void} [onSkipReport]
   * @returns {Promise<{started: boolean, chunkSamples?: number, numChannels?: number}>}
   */
  async startStream(config, onChunk, onEnd, onSkipReport) {
    if (this.#capturing || this.#streaming) return { started: false }
    if (!this.#transport?.connected) return { started: false }

    if (!config.channels || config.channels.length === 0 || config.channels.length > 24) {
      return { started: false }
    }

    try {
      const reqBytes = buildStreamRequest({
        channels: config.channels,
        channelCount: config.channels.length,
        chunkSamples: config.chunkSamples || 512,
        frequency: config.frequency,
      })

      const pkt = new OutputPacket()
      pkt.addByte(CMD_START_STREAM)
      pkt.addBytes(reqBytes)
      const serialized = pkt.serialize()
      console.log(`[stream] sending ${serialized.length} bytes to device`)
      await this.#transport.write(serialized)
      console.log('[stream] write complete, waiting for handshake...')

      // Read handshake — skip any [SD] debug lines from firmware
      let response
      while (true) {
        response = await withTimeout(
          this.#transport.readLine(),
          5000,
          'Timeout: no handshake from device within 5s',
        )
        if (response.startsWith('[SD]')) {
          console.log('[stream] firmware debug:', response)
          continue
        }
        break
      }
      console.log('[stream] handshake response:', JSON.stringify(response))
      if (response !== 'STREAM_STARTED') {
        return { started: false, error: `Device error: ${response}` }
      }

      // Read 8-byte info header: [chunkSamples LE16][numChannels u8][reserved u8][actualFreq LE32]
      console.log('[stream] reading 8-byte info header...')
      const info = await withTimeout(
        this.#transport.readBytes(8),
        5000,
        'Timeout: no info header from device within 5s',
      )
      const chunkSamples = info[0] | (info[1] << 8)
      const numChannels = info[2]
      const actualFrequency = info[4] | (info[5] << 8) | (info[6] << 16) | (info[7] << 24)
      console.log('[stream] info header:', { chunkSamples, numChannels, actualFrequency })

      this.#streaming = true

      // Fire-and-forget the read loop
      this.#streamEndStatus = null
      this.#readStreamLoop(numChannels, chunkSamples, onChunk, onEnd, onSkipReport)

      return { started: true, chunkSamples, numChannels, actualFrequency }
    } catch (err) {
      console.error('[stream] startStream error:', err)
      return { started: false, error: err?.message }
    }
  }

  #streamEndStatus = null

  /**
   * Internal async loop that reads compressed stream chunks until EOF.
   */
  async #readStreamLoop(numChannels, chunkSamples, onChunk, onEnd, onSkipReport) {
    let chunksReceived = 0
    try {
      console.log(`[stream] read loop started: ${numChannels}ch, ${chunkSamples} samples/chunk`)
      while (true) {
        const sizeBytes = await withTimeout(
          this.#transport.readBytes(2),
          8000,
          'Timeout: no stream chunk size from device within 8s',
        )
        const compressedSize = sizeBytes[0] | (sizeBytes[1] << 8)
        if (compressedSize === 0) break // EOF marker

        // Skip report frame: 0xFFFF marker
        if (compressedSize === 0xffff) {
          const countBytes = await this.#transport.readBytes(1)
          const count = countBytes[0]
          const compressSkipsRaw = await this.#transport.readBytes(count * 2)
          const transmitSkipsRaw = await this.#transport.readBytes(count * 2)

          // Sum uint16 LE entries
          let dmaSkips = 0
          let txSkips = 0
          for (let i = 0; i < count; i++) {
            dmaSkips += compressSkipsRaw[i * 2] | (compressSkipsRaw[i * 2 + 1] << 8)
            txSkips += transmitSkipsRaw[i * 2] | (transmitSkipsRaw[i * 2 + 1] << 8)
          }

          if (dmaSkips > 0 || txSkips > 0) {
            console.warn(`[stream] skip report: ${dmaSkips} DMA skips, ${txSkips} transmit skips`)
            onSkipReport?.({ dmaSkips, txSkips })
          }
          continue
        }

        const compressed = await withTimeout(
          this.#transport.readBytes(compressedSize),
          5000,
          `Timeout: no stream chunk data (${compressedSize} bytes) within 5s`,
        )
        const { channels } = decompressChunk(compressed, numChannels, chunkSamples)
        chunksReceived++
        onChunk(channels, chunkSamples)
      }

      this.#streaming = false
      console.log(`[stream] EOF received after ${chunksReceived} chunks`)
      const endLine = await this.#transport.readLine()
      this.#streamEndStatus = endLine
      console.log(`[stream] end status: ${endLine}`)
      onEnd?.(endLine, null)
    } catch (err) {
      console.error(`[stream] read loop error after ${chunksReceived} chunks:`, err)
      this.#streaming = false
      onEnd?.(null, err?.message ?? 'Stream read error')
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

      // Wait for read loop to finish (it reads until EOF + status line)
      const maxWait = 5000
      const start = Date.now()
      while (this.#streaming && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 50))
      }

      // Force cleanup if read loop didn't finish in time
      if (this.#streaming) {
        console.warn('[stream] read loop did not finish within timeout, reconnecting transport')
        this.#streaming = false
        try {
          await this.#transport.disconnect()
          await new Promise((r) => setTimeout(r, 100))
          await this.#transport.connect()
        } catch {
          // Ignore reconnect errors
        }
      }

      return { stopped: true, endStatus: this.#streamEndStatus }
    } catch {
      this.#streaming = false
      return { stopped: false }
    }
  }

}

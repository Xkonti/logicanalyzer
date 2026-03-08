import {
  DEFAULT_BAUD_RATE,
  DEFAULT_BUFFER_SIZE,
  DEFAULT_VENDOR_ID,
  DEFAULT_PRODUCT_ID,
} from '../protocol/commands.js'

/**
 * Web Serial API transport implementation.
 * Ports the serial connection logic from LogicAnalyzerDriver.cs (lines 93-196).
 *
 * Uses a single unified byte buffer for both readLine() and readBytes(),
 * avoiding the C# StreamReader/BinaryReader buffering conflict.
 *
 * @implements {import('./types.js').ITransport}
 */
export class SerialTransport {
  #port = null
  #reader = null
  #writer = null
  #buffer = new Uint8Array(0)
  #connected = false
  #options

  /**
   * @param {Object} [options]
   * @param {number} [options.baudRate=115200]
   * @param {number} [options.bufferSize=1048576] - MUST be 1MB+; Web Serial default is 255
   * @param {number} [options.vendorId=0x1209]
   * @param {number} [options.productId=0x3020]
   * @param {SerialPort} [options.port] - Pre-selected port (skips requestPort picker)
   */
  constructor(options = {}) {
    this.#options = {
      baudRate: options.baudRate ?? DEFAULT_BAUD_RATE,
      bufferSize: options.bufferSize ?? DEFAULT_BUFFER_SIZE,
      vendorId: options.vendorId ?? DEFAULT_VENDOR_ID,
      productId: options.productId ?? DEFAULT_PRODUCT_ID,
    }
    if (options.port) {
      this.#port = options.port
    }
    /** @type {(() => void) | null} */
    this.onDisconnect = null
  }

  get connected() {
    return this.#connected
  }

  async connect() {
    // Request port from browser picker if not pre-provided
    if (!this.#port) {
      this.#port = await navigator.serial.requestPort({
        filters: [
          {
            usbVendorId: this.#options.vendorId,
            usbProductId: this.#options.productId,
          },
        ],
      })
    }

    await this.#port.open({
      baudRate: this.#options.baudRate,
      bufferSize: this.#options.bufferSize,
    })

    await this.#port.setSignals({
      requestToSend: true,
      dataTerminalReady: true,
    })

    // Wait 200ms for firmware boot messages to settle (matches C# Thread.Sleep(200))
    await new Promise((r) => setTimeout(r, 200))

    this.#reader = this.#port.readable.getReader()

    // Drain any pending bytes in the input buffer (matches C# sp.DiscardInBuffer())
    await this.#drainPendingData()

    this.#writer = this.#port.writable.getWriter()
    this.#buffer = new Uint8Array(0)
    this.#connected = true
  }

  async disconnect() {
    this.#connected = false

    if (this.#reader) {
      try {
        this.#reader.releaseLock()
      } catch {
        // ignore — may already be released
      }
      this.#reader = null
    }

    if (this.#writer) {
      try {
        this.#writer.releaseLock()
      } catch {
        // ignore
      }
      this.#writer = null
    }

    if (this.#port) {
      try {
        await this.#port.close()
      } catch {
        // ignore — may already be closed
      }
    }

    this.#buffer = new Uint8Array(0)
  }

  /** @param {Uint8Array} data */
  async write(data) {
    if (!this.#connected) throw new Error('Transport not connected')
    await this.#writer.write(data)
  }

  /**
   * Read a newline-delimited text line.
   * Strips trailing \r and \n.
   * @returns {Promise<string>}
   */
  async readLine() {
    if (!this.#connected) throw new Error('Transport not connected')

    const decoder = new TextDecoder()

    while (true) {
      // Search buffer for newline
      const nlIndex = this.#buffer.indexOf(0x0a)
      if (nlIndex !== -1) {
        // Extract line (excluding \n), strip trailing \r
        let lineBytes = this.#buffer.slice(0, nlIndex)
        if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d) {
          lineBytes = lineBytes.slice(0, -1)
        }
        this.#buffer = this.#buffer.slice(nlIndex + 1)
        return decoder.decode(lineBytes)
      }

      // Need more data
      const { value, done } = await this.#reader.read()
      if (done) throw new Error('Serial stream closed while reading line')
      this.#appendToBuffer(value)
    }
  }

  /**
   * Read exactly count bytes.
   * @param {number} count
   * @returns {Promise<Uint8Array>}
   */
  async readBytes(count) {
    if (!this.#connected) throw new Error('Transport not connected')

    while (this.#buffer.length < count) {
      const { value, done } = await this.#reader.read()
      if (done) throw new Error('Serial stream closed while reading bytes')
      this.#appendToBuffer(value)
    }

    const result = this.#buffer.slice(0, count)
    this.#buffer = this.#buffer.slice(count)
    return result
  }

  /** @param {Uint8Array} chunk */
  #appendToBuffer(chunk) {
    const merged = new Uint8Array(this.#buffer.length + chunk.length)
    merged.set(this.#buffer, 0)
    merged.set(chunk, this.#buffer.length)
    this.#buffer = merged
  }

  async #drainPendingData() {
    // Do a single non-blocking read attempt to clear any boot messages.
    // Use a short timeout race — if no data arrives, that's fine.
    try {
      const result = await Promise.race([
        this.#reader.read(),
        new Promise((r) => setTimeout(() => r({ value: null, done: false }), 100)),
      ])
      // Discard whatever we got — it's boot noise
      if (result.value) {
        // intentionally discarded
      }
    } catch {
      // ignore drain errors
    }
  }
}

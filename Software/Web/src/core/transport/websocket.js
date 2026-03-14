/**
 * WebSocket transport implementation for WiFi connections.
 *
 * Uses the same unified byte buffer approach as SerialTransport —
 * all incoming WS binary messages are appended to a single buffer,
 * and readLine()/readBytes() consume from the front.
 *
 * @implements {import('./types.js').ITransport}
 */
export class WebSocketTransport {
  #ws = null
  #buffer = new Uint8Array(0)
  #connected = false
  #host
  #port
  #dataResolve = null
  #disconnecting = false

  /**
   * @param {Object} options
   * @param {string} options.host - IP address or hostname of the device
   * @param {number} [options.port=4046] - TCP port
   */
  constructor({ host, port = 4046 }) {
    this.#host = host
    this.#port = port
    /** @type {(() => void) | null} */
    this.onDisconnect = null
  }

  get connected() {
    return this.#connected
  }

  async connect() {
    this.#buffer = new Uint8Array(0)
    this.#disconnecting = false

    const ws = new WebSocket(`ws://${this.#host}:${this.#port}`)
    ws.binaryType = 'arraybuffer'

    await new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.onopen = null
        ws.onerror = null
        resolve()
      }
      ws.onerror = () => {
        ws.onopen = null
        ws.onerror = null
        reject(new Error(`WebSocket connection failed to ${this.#host}:${this.#port}`))
      }
      ws.onclose = () => {
        ws.onopen = null
        ws.onerror = null
        reject(new Error(`WebSocket connection closed before open to ${this.#host}:${this.#port}`))
      }
    })

    ws.onmessage = (event) => {
      const chunk = new Uint8Array(event.data)
      this.#appendToBuffer(chunk)
      if (this.#dataResolve) {
        const resolve = this.#dataResolve
        this.#dataResolve = null
        resolve()
      }
    }

    ws.onclose = () => {
      if (!this.#connected) return
      this.#connected = false
      this.#rejectPendingRead()
      if (!this.#disconnecting) {
        this.onDisconnect?.()
      }
    }

    ws.onerror = () => {
      // onerror is always followed by onclose, which handles cleanup
    }

    this.#ws = ws
    this.#connected = true
  }

  async disconnect() {
    if (!this.#ws) return

    this.#disconnecting = true
    this.#connected = false
    this.#rejectPendingRead()

    try {
      this.#ws.onmessage = null
      this.#ws.onclose = null
      this.#ws.onerror = null
      this.#ws.close(1000)
    } catch {
      // ignore — may already be closed
    }

    this.#ws = null
    this.#buffer = new Uint8Array(0)
  }

  /** @param {Uint8Array} data */
  async write(data) {
    if (!this.#connected) throw new Error('Transport not connected')
    this.#ws.send(data)
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
      const nlIndex = this.#buffer.indexOf(0x0a)
      if (nlIndex !== -1) {
        let lineBytes = this.#buffer.slice(0, nlIndex)
        if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d) {
          lineBytes = lineBytes.slice(0, -1)
        }
        this.#buffer = this.#buffer.slice(nlIndex + 1)
        return decoder.decode(lineBytes)
      }

      if (!this.#connected) throw new Error('WebSocket closed while reading line')
      await this.#waitForData()
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
      if (!this.#connected) throw new Error('WebSocket closed while reading bytes')
      await this.#waitForData()
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

  /** Wait until onmessage appends new data (or connection closes). */
  #waitForData() {
    return new Promise((resolve, reject) => {
      if (!this.#connected) {
        reject(new Error('WebSocket closed'))
        return
      }
      this.#dataResolve = resolve
    })
  }

  /** Reject any pending read waiters. */
  #rejectPendingRead() {
    if (this.#dataResolve) {
      const resolve = this.#dataResolve
      this.#dataResolve = null
      // Resolve (not reject) — the read loop will check #connected and throw
      resolve()
    }
  }
}

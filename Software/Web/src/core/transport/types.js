/**
 * Transport interface for communicating with the logic analyzer device.
 * Implementations: SerialTransport (Web Serial API), future WebSocketTransport.
 *
 * @typedef {Object} ITransport
 * @property {boolean} connected - Whether the transport is currently connected
 * @property {() => Promise<void>} connect - Open the connection
 * @property {() => Promise<void>} disconnect - Close the connection (idempotent)
 * @property {(data: Uint8Array) => Promise<void>} write - Write raw bytes
 * @property {() => Promise<string>} readLine - Read a newline-delimited text line (strips \n and \r)
 * @property {(count: number) => Promise<Uint8Array>} readBytes - Read exactly count bytes
 * @property {(() => void) | null} onDisconnect - Callback for unexpected disconnection
 */

/**
 * Creates a mock transport for testing.
 *
 * @param {Object} [options]
 * @param {string[]} [options.lines] - Lines to return from readLine() in FIFO order
 * @param {Uint8Array[]} [options.binaryChunks] - Byte arrays to return from readBytes() in FIFO order
 * @returns {ITransport & { writtenData: Uint8Array[], connectCalls: number, disconnectCalls: number }}
 */
export function createMockTransport(options = {}) {
  const lines = [...(options.lines || [])]
  const binaryChunks = [...(options.binaryChunks || [])]
  const writtenData = []
  let connectCalls = 0
  let disconnectCalls = 0
  let _connected = false

  return {
    get connected() {
      return _connected
    },

    async connect() {
      connectCalls++
      _connected = true
    },

    async disconnect() {
      disconnectCalls++
      _connected = false
    },

    async write(data) {
      if (!_connected) throw new Error('Transport not connected')
      writtenData.push(new Uint8Array(data))
    },

    async readLine() {
      if (!_connected) throw new Error('Transport not connected')
      if (lines.length === 0) throw new Error('Mock transport: no more lines to read')
      return lines.shift()
    },

    async readBytes(count) {
      if (!_connected) throw new Error('Transport not connected')
      if (binaryChunks.length === 0)
        throw new Error('Mock transport: no more binary chunks to read')
      const chunk = binaryChunks.shift()
      if (chunk.length !== count) {
        throw new Error(
          `Mock transport: requested ${count} bytes but chunk has ${chunk.length} bytes`,
        )
      }
      return chunk
    },

    onDisconnect: null,
    writtenData,
    get connectCalls() {
      return connectCalls
    },
    get disconnectCalls() {
      return disconnectCalls
    },
  }
}

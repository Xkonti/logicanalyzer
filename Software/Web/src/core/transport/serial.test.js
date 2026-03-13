import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SerialTransport } from './serial.js'

/**
 * Creates a mock SerialPort matching the Web Serial API shape.
 * Tests can push data via mockPort.pushData(chunk).
 */
function createMockSerialPort() {
  const readableChunks = []
  let readResolve = null
  const writtenChunks = []

  const readerMock = {
    read: vi.fn(async () => {
      if (readableChunks.length > 0) {
        return { value: readableChunks.shift(), done: false }
      }
      return new Promise((resolve) => {
        readResolve = resolve
      })
    }),
    releaseLock: vi.fn(),
  }

  const writerMock = {
    write: vi.fn(async (data) => {
      writtenChunks.push(new Uint8Array(data))
    }),
    releaseLock: vi.fn(),
  }

  const mockPort = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setSignals: vi.fn(async () => {}),
    readable: {
      getReader: vi.fn(() => readerMock),
    },
    writable: {
      getWriter: vi.fn(() => writerMock),
    },

    // Test helpers
    pushData(chunk) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      if (readResolve) {
        const r = readResolve
        readResolve = null
        r({ value: data, done: false })
      } else {
        readableChunks.push(data)
      }
    },
    get writtenChunks() {
      return writtenChunks
    },
    readerMock,
    writerMock,
  }

  return mockPort
}

function textBytes(str) {
  return new TextEncoder().encode(str)
}

beforeEach(() => {
  // Mock navigator.serial — can't assign directly since navigator is read-only
  vi.stubGlobal('navigator', {
    serial: {
      requestPort: vi.fn(),
    },
  })
})

describe('SerialTransport.connect', () => {
  it('requests port with correct VID/PID filter', async () => {
    const mockPort = createMockSerialPort()
    // Push some data so the drain read doesn't hang
    mockPort.pushData(new Uint8Array(0))
    navigator.serial.requestPort.mockResolvedValue(mockPort)

    const transport = new SerialTransport()
    await transport.connect()

    expect(navigator.serial.requestPort).toHaveBeenCalledWith({
      filters: [{ usbVendorId: 0x1209, usbProductId: 0x3020 }],
    })
  })

  it('opens port with 115200 baud and 1MB buffer', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    navigator.serial.requestPort.mockResolvedValue(mockPort)

    const transport = new SerialTransport()
    await transport.connect()

    expect(mockPort.open).toHaveBeenCalledWith({
      baudRate: 115200,
      bufferSize: 1048576,
    })
  })

  it('sets RTS and DTR signals', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    navigator.serial.requestPort.mockResolvedValue(mockPort)

    const transport = new SerialTransport()
    await transport.connect()

    expect(mockPort.setSignals).toHaveBeenCalledWith({
      requestToSend: true,
      dataTerminalReady: true,
    })
  })

  it('uses a pre-provided port without requesting', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))

    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()

    expect(navigator.serial.requestPort).not.toHaveBeenCalled()
    expect(mockPort.open).toHaveBeenCalled()
  })

  it('sets connected to true after successful connect', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    navigator.serial.requestPort.mockResolvedValue(mockPort)

    const transport = new SerialTransport()
    expect(transport.connected).toBe(false)
    await transport.connect()
    expect(transport.connected).toBe(true)
  })

  it('throws if port.open fails', async () => {
    const mockPort = createMockSerialPort()
    mockPort.open.mockRejectedValue(new Error('Port busy'))
    navigator.serial.requestPort.mockResolvedValue(mockPort)

    const transport = new SerialTransport()
    await expect(transport.connect()).rejects.toThrow('Port busy')
  })
})

describe('SerialTransport.readLine', () => {
  async function createConnectedTransport() {
    const mockPort = createMockSerialPort()
    // Push empty data for drain
    mockPort.pushData(new Uint8Array(0))
    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()
    return { transport, mockPort }
  }

  it('reads a complete line from a single chunk', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(textBytes('HELLO\n'))
    expect(await transport.readLine()).toBe('HELLO')
  })

  it('strips trailing carriage return', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(textBytes('HELLO\r\n'))
    expect(await transport.readLine()).toBe('HELLO')
  })

  it('accumulates across multiple chunks', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(textBytes('HEL'))
    mockPort.pushData(textBytes('LO\n'))
    expect(await transport.readLine()).toBe('HELLO')
  })

  it('returns multiple lines from a single chunk', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(textBytes('LINE1\nLINE2\n'))
    expect(await transport.readLine()).toBe('LINE1')
    expect(await transport.readLine()).toBe('LINE2')
  })

  it('handles empty line', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(textBytes('\n'))
    expect(await transport.readLine()).toBe('')
  })
})

describe('SerialTransport.readBytes', () => {
  async function createConnectedTransport() {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()
    return { transport, mockPort }
  }

  it('reads exact byte count from a single chunk', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    mockPort.pushData(data)
    const result = await transport.readBytes(10)
    expect(result).toEqual(data)
  })

  it('accumulates bytes across multiple small chunks', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(new Uint8Array([1, 2, 3]))
    mockPort.pushData(new Uint8Array([4, 5, 6]))
    mockPort.pushData(new Uint8Array([7, 8, 9, 10]))
    const result = await transport.readBytes(10)
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
  })

  it('preserves leftover bytes in buffer', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    mockPort.pushData(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]))
    const first = await transport.readBytes(10)
    expect(first).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    const second = await transport.readBytes(5)
    expect(second).toEqual(new Uint8Array([11, 12, 13, 14, 15]))
  })

  it('handles interleaved readLine then readBytes', async () => {
    const { transport, mockPort } = await createConnectedTransport()
    // Push text line followed by binary data in a single chunk
    const combined = new Uint8Array([...textBytes('OK\n'), 0xde, 0xad, 0xbe, 0xef])
    mockPort.pushData(combined)

    const line = await transport.readLine()
    expect(line).toBe('OK')

    const bytes = await transport.readBytes(4)
    expect(bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })
})

describe('SerialTransport.write', () => {
  it('writes data through the writer', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()

    await transport.write(new Uint8Array([0x01, 0x02, 0x03]))
    expect(mockPort.writerMock.write).toHaveBeenCalledWith(new Uint8Array([0x01, 0x02, 0x03]))
  })

  it('throws when not connected', async () => {
    const transport = new SerialTransport()
    await expect(transport.write(new Uint8Array([0x01]))).rejects.toThrow('Transport not connected')
  })
})

describe('SerialTransport.disconnect', () => {
  it('releases reader and writer locks before closing', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()

    await transport.disconnect()
    expect(mockPort.readerMock.releaseLock).toHaveBeenCalled()
    expect(mockPort.writerMock.releaseLock).toHaveBeenCalled()
    expect(mockPort.close).toHaveBeenCalled()
  })

  it('sets connected to false', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()
    expect(transport.connected).toBe(true)

    await transport.disconnect()
    expect(transport.connected).toBe(false)
  })

  it('is idempotent', async () => {
    const mockPort = createMockSerialPort()
    mockPort.pushData(new Uint8Array(0))
    const transport = new SerialTransport({ port: mockPort })
    await transport.connect()

    await transport.disconnect()
    await transport.disconnect() // should not throw
    expect(transport.connected).toBe(false)
  })
})

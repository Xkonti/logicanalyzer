import { describe, it, expect } from 'vitest'
import { OutputPacket, buildCaptureRequest } from './packets.js'

describe('OutputPacket.serialize', () => {
  it('wraps empty payload with header and footer', () => {
    const pkt = new OutputPacket()
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0xaa, 0x55]))
  })

  it('serializes a single non-special byte', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0x00)
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0x00, 0xaa, 0x55]))
  })

  it('escapes 0xAA in payload', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0xaa)
    // 0xAA ^ 0xF0 = 0x5A
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0xf0, 0x5a, 0xaa, 0x55]))
  })

  it('escapes 0x55 in payload', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0x55)
    // 0x55 ^ 0xF0 = 0xA5
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0xf0, 0xa5, 0xaa, 0x55]))
  })

  it('escapes 0xF0 in payload', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0xf0)
    // 0xF0 ^ 0xF0 = 0x00
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0xf0, 0x00, 0xaa, 0x55]))
  })

  it('does not escape other bytes', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0x01)
    pkt.addByte(0x7f)
    pkt.addByte(0xfe)
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0x01, 0x7f, 0xfe, 0xaa, 0x55]))
  })

  it('serializes init command correctly', () => {
    // Matches C# code: pack.AddByte(0); baseStream.Write(pack.Serialize());
    const pkt = new OutputPacket()
    pkt.addByte(0x00)
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0x00, 0xaa, 0x55]))
  })

  it('serializes multiple bytes with mixed escaping', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0x01) // no escape
    pkt.addByte(0xaa) // escape → [0xF0, 0x5A]
    pkt.addByte(0x02) // no escape
    expect(pkt.serialize()).toEqual(
      new Uint8Array([0x55, 0xaa, 0x01, 0xf0, 0x5a, 0x02, 0xaa, 0x55]),
    )
  })

  it('addBytes appends multiple bytes', () => {
    const pkt = new OutputPacket()
    pkt.addBytes([0x01, 0x02, 0x03])
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0x01, 0x02, 0x03, 0xaa, 0x55]))
  })

  it('addBytes accepts Uint8Array', () => {
    const pkt = new OutputPacket()
    pkt.addBytes(new Uint8Array([0x04, 0x05]))
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0x04, 0x05, 0xaa, 0x55]))
  })

  it('addString converts ASCII characters', () => {
    const pkt = new OutputPacket()
    pkt.addString('AB')
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0x41, 0x42, 0xaa, 0x55]))
  })

  it('clear resets the buffer', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0x01)
    pkt.clear()
    expect(pkt.serialize()).toEqual(new Uint8Array([0x55, 0xaa, 0xaa, 0x55]))
  })

  it('escapes all three special bytes in sequence', () => {
    const pkt = new OutputPacket()
    pkt.addByte(0x55) // → [0xF0, 0xA5]
    pkt.addByte(0xaa) // → [0xF0, 0x5A]
    pkt.addByte(0xf0) // → [0xF0, 0x00]
    expect(pkt.serialize()).toEqual(
      new Uint8Array([0x55, 0xaa, 0xf0, 0xa5, 0xf0, 0x5a, 0xf0, 0x00, 0xaa, 0x55]),
    )
  })
})

describe('buildCaptureRequest', () => {
  function makeSession(overrides = {}) {
    return {
      triggerType: 0,
      triggerChannel: 0,
      invertedOrCount: 0,
      triggerValue: 0,
      channels: [0, 1, 2],
      channelCount: 3,
      frequency: 1000000,
      preSamples: 100,
      postSamples: 500,
      loopCount: 0,
      measure: 0,
      captureMode: 0,
      ...overrides,
    }
  }

  it('produces exactly 54 bytes', () => {
    const result = buildCaptureRequest(makeSession())
    expect(result.length).toBe(54)
  })

  it('encodes triggerType at offset 0', () => {
    expect(buildCaptureRequest(makeSession({ triggerType: 0 }))[0]).toBe(0)
    expect(buildCaptureRequest(makeSession({ triggerType: 1 }))[0]).toBe(1)
    expect(buildCaptureRequest(makeSession({ triggerType: 2 }))[0]).toBe(2)
    expect(buildCaptureRequest(makeSession({ triggerType: 3 }))[0]).toBe(3)
  })

  it('encodes triggerChannel at offset 1', () => {
    expect(buildCaptureRequest(makeSession({ triggerChannel: 5 }))[1]).toBe(5)
  })

  it('encodes invertedOrCount at offset 2', () => {
    expect(buildCaptureRequest(makeSession({ invertedOrCount: 1 }))[2]).toBe(1)
  })

  it('encodes triggerValue as little-endian uint16 at offset 3', () => {
    const result = buildCaptureRequest(makeSession({ triggerValue: 0x1234 }))
    expect(result[3]).toBe(0x34) // low byte
    expect(result[4]).toBe(0x12) // high byte
  })

  it('encodes channels as zero-padded 32-byte array at offset 5', () => {
    const result = buildCaptureRequest(makeSession({ channels: [0, 1, 2] }))
    expect(result[5]).toBe(0)
    expect(result[6]).toBe(1)
    expect(result[7]).toBe(2)
    // remaining should be zero
    for (let i = 8; i < 37; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('encodes channelCount at offset 37', () => {
    expect(buildCaptureRequest(makeSession({ channelCount: 8 }))[37]).toBe(8)
  })

  it('encodes frequency as little-endian uint32 at offset 38', () => {
    // 1000000 = 0x000F4240
    const result = buildCaptureRequest(makeSession({ frequency: 1000000 }))
    expect(result[38]).toBe(0x40) // lowest byte
    expect(result[39]).toBe(0x42)
    expect(result[40]).toBe(0x0f)
    expect(result[41]).toBe(0x00) // highest byte
  })

  it('encodes preSamples as little-endian uint32 at offset 42', () => {
    // 256 = 0x00000100
    const result = buildCaptureRequest(makeSession({ preSamples: 256 }))
    expect(result[42]).toBe(0x00)
    expect(result[43]).toBe(0x01)
    expect(result[44]).toBe(0x00)
    expect(result[45]).toBe(0x00)
  })

  it('encodes postSamples as little-endian uint32 at offset 46', () => {
    // 1024 = 0x00000400
    const result = buildCaptureRequest(makeSession({ postSamples: 1024 }))
    expect(result[46]).toBe(0x00)
    expect(result[47]).toBe(0x04)
    expect(result[48]).toBe(0x00)
    expect(result[49]).toBe(0x00)
  })

  it('encodes loopCount as little-endian uint16 at offset 50', () => {
    const result = buildCaptureRequest(makeSession({ loopCount: 300 }))
    expect(result[50]).toBe(0x2c) // 300 & 0xFF
    expect(result[51]).toBe(0x01) // 300 >> 8
  })

  it('encodes measure at offset 52', () => {
    expect(buildCaptureRequest(makeSession({ measure: 1 }))[52]).toBe(1)
    expect(buildCaptureRequest(makeSession({ measure: 0 }))[52]).toBe(0)
  })

  it('encodes captureMode at offset 53', () => {
    expect(buildCaptureRequest(makeSession({ captureMode: 0 }))[53]).toBe(0)
    expect(buildCaptureRequest(makeSession({ captureMode: 1 }))[53]).toBe(1)
    expect(buildCaptureRequest(makeSession({ captureMode: 2 }))[53]).toBe(2)
  })

  it('full round-trip: OutputPacket wrapping a CaptureRequest', () => {
    const session = makeSession()
    const reqBytes = buildCaptureRequest(session)

    const pkt = new OutputPacket()
    pkt.addByte(0x01) // CMD_START_CAPTURE
    pkt.addBytes(reqBytes)

    const serialized = pkt.serialize()
    // Should start with header and end with footer
    expect(serialized[0]).toBe(0x55)
    expect(serialized[1]).toBe(0xaa)
    expect(serialized[serialized.length - 2]).toBe(0xaa)
    expect(serialized[serialized.length - 1]).toBe(0x55)
    // Command byte 0x01 is not a special byte, so it should appear at index 2
    expect(serialized[2]).toBe(0x01)
  })
})

import { describe, it, expect } from 'vitest'
import { OutputPacket, buildCaptureRequest, buildNetworkConfigRequest } from './packets.js'

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

  it('produces exactly 56 bytes (matching C struct with alignment padding)', () => {
    const result = buildCaptureRequest(makeSession())
    expect(result.length).toBe(56)
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

  it('has padding byte at offset 3', () => {
    const result = buildCaptureRequest(makeSession())
    expect(result[3]).toBe(0)
  })

  it('encodes triggerValue as little-endian uint16 at offset 4', () => {
    const result = buildCaptureRequest(makeSession({ triggerValue: 0x1234 }))
    expect(result[4]).toBe(0x34) // low byte
    expect(result[5]).toBe(0x12) // high byte
  })

  it('encodes channels as zero-padded 32-byte array at offset 6', () => {
    const result = buildCaptureRequest(makeSession({ channels: [0, 1, 2] }))
    expect(result[6]).toBe(0)
    expect(result[7]).toBe(1)
    expect(result[8]).toBe(2)
    // remaining should be zero
    for (let i = 9; i < 38; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('encodes channelCount at offset 38', () => {
    expect(buildCaptureRequest(makeSession({ channelCount: 8 }))[38]).toBe(8)
  })

  it('has padding byte at offset 39', () => {
    const result = buildCaptureRequest(makeSession())
    expect(result[39]).toBe(0)
  })

  it('encodes frequency as little-endian uint32 at offset 40', () => {
    // 1000000 = 0x000F4240
    const result = buildCaptureRequest(makeSession({ frequency: 1000000 }))
    expect(result[40]).toBe(0x40) // lowest byte
    expect(result[41]).toBe(0x42)
    expect(result[42]).toBe(0x0f)
    expect(result[43]).toBe(0x00) // highest byte
  })

  it('encodes preSamples as little-endian uint32 at offset 44', () => {
    // 256 = 0x00000100
    const result = buildCaptureRequest(makeSession({ preSamples: 256 }))
    expect(result[44]).toBe(0x00)
    expect(result[45]).toBe(0x01)
    expect(result[46]).toBe(0x00)
    expect(result[47]).toBe(0x00)
  })

  it('encodes postSamples as little-endian uint32 at offset 48', () => {
    // 1024 = 0x00000400
    const result = buildCaptureRequest(makeSession({ postSamples: 1024 }))
    expect(result[48]).toBe(0x00)
    expect(result[49]).toBe(0x04)
    expect(result[50]).toBe(0x00)
    expect(result[51]).toBe(0x00)
  })

  it('encodes loopCount as little-endian uint16 at offset 52', () => {
    const result = buildCaptureRequest(makeSession({ loopCount: 300 }))
    expect(result[52]).toBe(0x2c) // 300 & 0xFF
    expect(result[53]).toBe(0x01) // 300 >> 8
  })

  it('encodes measure at offset 54', () => {
    expect(buildCaptureRequest(makeSession({ measure: 1 }))[54]).toBe(1)
    expect(buildCaptureRequest(makeSession({ measure: 0 }))[54]).toBe(0)
  })

  it('encodes captureMode at offset 55', () => {
    expect(buildCaptureRequest(makeSession({ captureMode: 0 }))[55]).toBe(0)
    expect(buildCaptureRequest(makeSession({ captureMode: 1 }))[55]).toBe(1)
    expect(buildCaptureRequest(makeSession({ captureMode: 2 }))[55]).toBe(2)
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

describe('buildNetworkConfigRequest', () => {
  function makeConfig(overrides = {}) {
    return {
      ssid: 'MyNetwork',
      password: 'secret123',
      ipAddress: '192.168.4.1',
      port: 4045,
      hostname: 'logicanalyzer',
      ...overrides,
    }
  }

  it('produces exactly 150 bytes', () => {
    expect(buildNetworkConfigRequest(makeConfig()).length).toBe(150)
  })

  it('encodes SSID as null-padded ASCII at offset 0', () => {
    const result = buildNetworkConfigRequest(makeConfig({ ssid: 'test' }))
    expect(result[0]).toBe(0x74) // 't'
    expect(result[1]).toBe(0x65) // 'e'
    expect(result[2]).toBe(0x73) // 's'
    expect(result[3]).toBe(0x74) // 't'
    // remaining bytes in field should be zero
    for (let i = 4; i < 33; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('encodes password at offset 33', () => {
    const result = buildNetworkConfigRequest(makeConfig({ password: 'pw' }))
    expect(result[33]).toBe(0x70) // 'p'
    expect(result[34]).toBe(0x77) // 'w'
    for (let i = 35; i < 97; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('encodes IP address at offset 97', () => {
    const result = buildNetworkConfigRequest(makeConfig({ ipAddress: '10.0.0.1' }))
    expect(result[97]).toBe(0x31) // '1'
    expect(result[98]).toBe(0x30) // '0'
    expect(result[99]).toBe(0x2e) // '.'
    expect(result[100]).toBe(0x30) // '0'
    for (let i = 105; i < 113; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('has alignment padding byte at offset 113', () => {
    const result = buildNetworkConfigRequest(makeConfig())
    expect(result[113]).toBe(0)
  })

  it('encodes port as little-endian uint16 at offset 114', () => {
    const result = buildNetworkConfigRequest(makeConfig({ port: 4045 }))
    // 4045 = 0x0FCD → low byte 0xCD, high byte 0x0F
    expect(result[114]).toBe(0xcd)
    expect(result[115]).toBe(0x0f)
  })

  it('encodes hostname at offset 116', () => {
    const result = buildNetworkConfigRequest(makeConfig({ hostname: 'myhost' }))
    expect(result[116]).toBe(0x6d) // 'm'
    expect(result[117]).toBe(0x79) // 'y'
    expect(result[118]).toBe(0x68) // 'h'
    expect(result[119]).toBe(0x6f) // 'o'
    expect(result[120]).toBe(0x73) // 's'
    expect(result[121]).toBe(0x74) // 't'
    for (let i = 122; i < 149; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('handles empty hostname', () => {
    const result = buildNetworkConfigRequest(makeConfig({ hostname: '' }))
    for (let i = 116; i < 149; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('defaults hostname to empty string', () => {
    const result = buildNetworkConfigRequest({
      ssid: 'net',
      password: 'pass',
      ipAddress: '1.2.3.4',
      port: 80,
    })
    for (let i = 116; i < 149; i++) {
      expect(result[i]).toBe(0)
    }
  })

  it('truncates SSID longer than 32 chars', () => {
    const longSsid = 'A'.repeat(40)
    const result = buildNetworkConfigRequest(makeConfig({ ssid: longSsid }))
    // Should write 32 chars (max 33 field - 1 for null)
    for (let i = 0; i < 32; i++) {
      expect(result[i]).toBe(0x41) // 'A'
    }
    // Last byte of the 33-byte field should be null
    expect(result[32]).toBe(0)
  })

  it('full round-trip: OutputPacket wrapping a NetworkConfigRequest', () => {
    const reqBytes = buildNetworkConfigRequest(makeConfig())

    const pkt = new OutputPacket()
    pkt.addByte(0x02) // CMD_NETWORK_CONFIG
    pkt.addBytes(reqBytes)

    const serialized = pkt.serialize()
    expect(serialized[0]).toBe(0x55)
    expect(serialized[1]).toBe(0xaa)
    expect(serialized[serialized.length - 2]).toBe(0xaa)
    expect(serialized[serialized.length - 1]).toBe(0x55)
    expect(serialized[2]).toBe(0x02)
  })
})

import { describe, it, expect } from 'vitest'
import { parseLac, serializeLac, parseCsv, serializeCsv } from './formats.js'

describe('parseLac', () => {
  it('parses modern format with per-channel samples', () => {
    const lac = {
      Settings: {
        Frequency: 1000000,
        PreTriggerSamples: 10,
        PostTriggerSamples: 100,
        LoopCount: 0,
        MeasureBursts: false,
        CaptureChannels: [
          {
            ChannelNumber: 0,
            ChannelName: 'CLK',
            ChannelColor: null,
            Hidden: false,
            Samples: [1, 0, 1, 0],
          },
          {
            ChannelNumber: 1,
            ChannelName: 'DATA',
            ChannelColor: 0xff0000ff,
            Hidden: true,
            Samples: [0, 1, 0, 1],
          },
        ],
        Bursts: null,
        TriggerType: 0,
        TriggerChannel: 0,
        TriggerInverted: false,
        TriggerBitCount: 0,
        TriggerPattern: 0,
      },
      Samples: null,
      SelectedRegions: [],
    }

    const { session, regions } = parseLac(JSON.stringify(lac))
    expect(session.frequency).toBe(1000000)
    expect(session.preTriggerSamples).toBe(10)
    expect(session.postTriggerSamples).toBe(100)
    expect(session.captureChannels).toHaveLength(2)
    expect(session.captureChannels[0].channelName).toBe('CLK')
    expect(session.captureChannels[0].samples).toEqual(new Uint8Array([1, 0, 1, 0]))
    expect(session.captureChannels[1].channelColor).toBe(0xff0000ff)
    expect(session.captureChannels[1].hidden).toBe(true)
    expect(regions).toEqual([])
  })

  it('parses legacy format with root Samples array', () => {
    const lac = {
      Settings: {
        Frequency: 1000000,
        PreTriggerSamples: 10,
        PostTriggerSamples: 100,
        CaptureChannels: [
          { ChannelNumber: 0, ChannelName: 'A', Samples: null },
          { ChannelNumber: 1, ChannelName: 'B', Samples: null },
        ],
      },
      // Legacy: packed samples where bit 0 = ch0, bit 1 = ch1
      Samples: [0b11, 0b01, 0b10, 0b00],
      SelectedRegions: null,
    }

    const { session } = parseLac(JSON.stringify(lac))
    expect(session.captureChannels[0].samples).toEqual(new Uint8Array([1, 1, 0, 0]))
    expect(session.captureChannels[1].samples).toEqual(new Uint8Array([1, 0, 1, 0]))
  })

  it('parses regions with R/G/B/A color', () => {
    const lac = {
      Settings: {
        Frequency: 1000000,
        PreTriggerSamples: 0,
        PostTriggerSamples: 100,
        CaptureChannels: [],
      },
      Samples: null,
      SelectedRegions: [
        {
          FirstSample: 10,
          LastSample: 50,
          RegionName: 'Test Region',
          R: 255,
          G: 128,
          B: 0,
          A: 200,
        },
      ],
    }

    const { regions } = parseLac(JSON.stringify(lac))
    expect(regions).toHaveLength(1)
    expect(regions[0].firstSample).toBe(10)
    expect(regions[0].lastSample).toBe(50)
    expect(regions[0].regionName).toBe('Test Region')
    expect(regions[0].regionColor).toEqual({ r: 255, g: 128, b: 0, a: 200 })
  })

  it('handles null optional fields', () => {
    const lac = {
      Settings: {
        Frequency: 1000000,
        PreTriggerSamples: 0,
        PostTriggerSamples: 100,
        CaptureChannels: [],
      },
      Samples: null,
      SelectedRegions: null,
    }

    const { session, regions } = parseLac(JSON.stringify(lac))
    expect(session.bursts).toBeNull()
    expect(regions).toEqual([])
  })

  it('parses bursts', () => {
    const lac = {
      Settings: {
        Frequency: 1000000,
        PreTriggerSamples: 10,
        PostTriggerSamples: 100,
        LoopCount: 1,
        CaptureChannels: [],
        Bursts: [
          { BurstSampleStart: 10, BurstSampleEnd: 110, BurstSampleGap: 0, BurstTimeGap: 0 },
          {
            BurstSampleStart: 110,
            BurstSampleEnd: 210,
            BurstSampleGap: 500,
            BurstTimeGap: 50000,
          },
        ],
      },
      Samples: null,
      SelectedRegions: [],
    }

    const { session } = parseLac(JSON.stringify(lac))
    expect(session.bursts).toHaveLength(2)
    expect(session.bursts[0].burstSampleGap).toBe(0)
    expect(session.bursts[1].burstSampleGap).toBe(500)
    expect(session.bursts[1].burstTimeGap).toBe(50000)
  })
})

describe('serializeLac', () => {
  it('round-trips through parseLac', () => {
    const session = {
      frequency: 2000000,
      preTriggerSamples: 20,
      postTriggerSamples: 200,
      loopCount: 0,
      measureBursts: false,
      captureChannels: [
        {
          channelNumber: 0,
          channelName: 'SDA',
          channelColor: null,
          hidden: false,
          samples: new Uint8Array([1, 0, 1]),
        },
      ],
      bursts: null,
      triggerType: 0,
      triggerChannel: 0,
      triggerInverted: false,
      triggerBitCount: 0,
      triggerPattern: 0,
    }
    const regions = [
      {
        firstSample: 5,
        lastSample: 15,
        regionName: 'R1',
        regionColor: { r: 100, g: 200, b: 50, a: 180 },
      },
    ]

    const json = serializeLac(session, regions)
    const result = parseLac(json)

    expect(result.session.frequency).toBe(2000000)
    expect(result.session.preTriggerSamples).toBe(20)
    expect(result.session.captureChannels[0].channelName).toBe('SDA')
    expect(result.session.captureChannels[0].samples).toEqual(new Uint8Array([1, 0, 1]))
    expect(result.regions[0].regionName).toBe('R1')
    expect(result.regions[0].regionColor).toEqual({ r: 100, g: 200, b: 50, a: 180 })
  })

  it('uses PascalCase keys in output', () => {
    const session = {
      frequency: 1000000,
      preTriggerSamples: 10,
      postTriggerSamples: 100,
      loopCount: 0,
      measureBursts: false,
      captureChannels: [],
      bursts: null,
      triggerType: 0,
      triggerChannel: 0,
      triggerInverted: false,
      triggerBitCount: 0,
      triggerPattern: 0,
    }

    const json = serializeLac(session)
    const parsed = JSON.parse(json)

    expect(parsed).toHaveProperty('Settings')
    expect(parsed).toHaveProperty('Samples')
    expect(parsed).toHaveProperty('SelectedRegions')
    expect(parsed.Settings).toHaveProperty('Frequency')
    expect(parsed.Settings).toHaveProperty('PreTriggerSamples')
    expect(parsed.Settings).toHaveProperty('CaptureChannels')
    expect(parsed.Samples).toBeNull()
  })

  it('flattens region color to R/G/B/A', () => {
    const session = {
      frequency: 1000000,
      preTriggerSamples: 0,
      postTriggerSamples: 100,
      loopCount: 0,
      measureBursts: false,
      captureChannels: [],
      bursts: null,
      triggerType: 0,
      triggerChannel: 0,
      triggerInverted: false,
      triggerBitCount: 0,
      triggerPattern: 0,
    }
    const regions = [
      {
        firstSample: 0,
        lastSample: 10,
        regionName: 'Test',
        regionColor: { r: 10, g: 20, b: 30, a: 40 },
      },
    ]

    const json = serializeLac(session, regions)
    const parsed = JSON.parse(json)

    expect(parsed.SelectedRegions[0].R).toBe(10)
    expect(parsed.SelectedRegions[0].G).toBe(20)
    expect(parsed.SelectedRegions[0].B).toBe(30)
    expect(parsed.SelectedRegions[0].A).toBe(40)
    // Should NOT have a nested RegionColor object
    expect(parsed.SelectedRegions[0].RegionColor).toBeUndefined()
  })

  it('converts Uint8Array samples to plain array', () => {
    const session = {
      frequency: 1000000,
      preTriggerSamples: 0,
      postTriggerSamples: 3,
      loopCount: 0,
      measureBursts: false,
      captureChannels: [
        {
          channelNumber: 0,
          channelName: '',
          channelColor: null,
          hidden: false,
          samples: new Uint8Array([1, 0, 1]),
        },
      ],
      bursts: null,
      triggerType: 0,
      triggerChannel: 0,
      triggerInverted: false,
      triggerBitCount: 0,
      triggerPattern: 0,
    }

    const json = serializeLac(session)
    const parsed = JSON.parse(json)
    // Should be a plain array, not a Uint8Array serialization artifact
    expect(Array.isArray(parsed.Settings.CaptureChannels[0].Samples)).toBe(true)
    expect(parsed.Settings.CaptureChannels[0].Samples).toEqual([1, 0, 1])
  })
})

describe('parseCsv', () => {
  it('parses header and data rows', () => {
    const csv = 'CLK,DATA\n1,0\n0,1\n1,1\n0,0'
    const { channels } = parseCsv(csv)
    expect(channels).toHaveLength(2)
    expect(channels[0].channelName).toBe('CLK')
    expect(channels[0].samples).toEqual(new Uint8Array([1, 0, 1, 0]))
    expect(channels[1].channelName).toBe('DATA')
    expect(channels[1].samples).toEqual(new Uint8Array([0, 1, 1, 0]))
  })

  it('parses single channel', () => {
    const csv = 'Signal\n1\n0\n1'
    const { channels } = parseCsv(csv)
    expect(channels).toHaveLength(1)
    expect(channels[0].channelName).toBe('Signal')
    expect(channels[0].samples).toEqual(new Uint8Array([1, 0, 1]))
  })

  it('returns empty for header only', () => {
    const csv = 'CLK,DATA'
    const { channels } = parseCsv(csv)
    expect(channels).toHaveLength(2)
    expect(channels[0].samples).toEqual(new Uint8Array(0))
  })

  it('returns empty for empty string', () => {
    const { channels } = parseCsv('')
    expect(channels).toEqual([])
  })

  it('assigns sequential channelNumber', () => {
    const csv = 'A,B,C\n1,0,1'
    const { channels } = parseCsv(csv)
    expect(channels[0].channelNumber).toBe(0)
    expect(channels[1].channelNumber).toBe(1)
    expect(channels[2].channelNumber).toBe(2)
  })
})

describe('serializeCsv', () => {
  it('round-trips through parseCsv', () => {
    const session = {
      frequency: 1000000,
      preTriggerSamples: 0,
      postTriggerSamples: 3,
      loopCount: 0,
      captureChannels: [
        { channelNumber: 0, channelName: 'CLK', samples: new Uint8Array([1, 0, 1]) },
        { channelNumber: 1, channelName: 'DATA', samples: new Uint8Array([0, 1, 0]) },
      ],
    }

    const csv = serializeCsv(session)
    const { channels } = parseCsv(csv)
    expect(channels[0].channelName).toBe('CLK')
    expect(channels[0].samples).toEqual(new Uint8Array([1, 0, 1]))
    expect(channels[1].channelName).toBe('DATA')
    expect(channels[1].samples).toEqual(new Uint8Array([0, 1, 0]))
  })

  it('uses fallback channel names', () => {
    const session = {
      frequency: 1000000,
      preTriggerSamples: 0,
      postTriggerSamples: 2,
      loopCount: 0,
      captureChannels: [
        { channelNumber: 0, channelName: '', samples: new Uint8Array([1, 0]) },
        { channelNumber: 1, channelName: '', samples: new Uint8Array([0, 1]) },
      ],
    }

    const csv = serializeCsv(session)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Channel 1,Channel 2')
  })

  it('returns empty string for no channels', () => {
    const session = {
      frequency: 1000000,
      preTriggerSamples: 0,
      postTriggerSamples: 0,
      loopCount: 0,
      captureChannels: [],
    }
    expect(serializeCsv(session)).toBe('')
  })
})

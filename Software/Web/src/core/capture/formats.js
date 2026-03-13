/**
 * .lac (JSON) and .csv file format read/write.
 * Ports ExportedCapture.cs, SampleRegion.cs (with custom JSON converter),
 * and MainWindow.axaml.cs CSV export (lines 1117-1164).
 *
 * Uses explicit PascalCase↔camelCase field mapping (not generic recursive)
 * to handle special cases: flat R/G/B/A color, Uint8Array samples, legacy UInt128 field.
 */

import { getTotalSamples } from '../driver/types.js'
import { SampleBuffer } from '../sample-buffer.js'

// ─── Internal mapping: .lac JSON (PascalCase) → JS (camelCase) ───

function channelFromLac(ch) {
  const raw = ch.Samples ? new Uint8Array(ch.Samples) : null
  return {
    channelNumber: ch.ChannelNumber,
    channelName: ch.ChannelName ?? '',
    channelColor: ch.ChannelColor ?? null,
    hidden: ch.Hidden ?? false,
    samples: raw ? SampleBuffer.fromUint8Array(raw) : null,
  }
}

function burstFromLac(b) {
  return {
    burstSampleStart: b.BurstSampleStart,
    burstSampleEnd: b.BurstSampleEnd,
    burstSampleGap: b.BurstSampleGap,
    burstTimeGap: b.BurstTimeGap,
  }
}

function regionFromLac(r) {
  return {
    firstSample: r.FirstSample,
    lastSample: r.LastSample,
    regionName: r.RegionName ?? '',
    regionColor: {
      r: r.R ?? 255,
      g: r.G ?? 255,
      b: r.B ?? 255,
      a: r.A ?? 128,
    },
  }
}

function sessionFromLac(s) {
  return {
    frequency: s.Frequency,
    preTriggerSamples: s.PreTriggerSamples,
    postTriggerSamples: s.PostTriggerSamples,
    loopCount: s.LoopCount ?? 0,
    measureBursts: s.MeasureBursts ?? false,
    captureChannels: (s.CaptureChannels || []).map(channelFromLac),
    bursts: s.Bursts ? s.Bursts.map(burstFromLac) : null,
    triggerType: s.TriggerType ?? 0,
    triggerChannel: s.TriggerChannel ?? 0,
    triggerInverted: s.TriggerInverted ?? false,
    triggerBitCount: s.TriggerBitCount ?? 0,
    triggerPattern: s.TriggerPattern ?? 0,
  }
}

// ─── Internal mapping: JS (camelCase) → .lac JSON (PascalCase) ───

function channelToLac(ch) {
  let samplesArray = null
  if (ch.samples) {
    const raw = ch.samples.toUint8Array ? ch.samples.toUint8Array() : ch.samples
    samplesArray = Array.from(raw)
  }
  return {
    ChannelNumber: ch.channelNumber,
    ChannelName: ch.channelName,
    ChannelColor: ch.channelColor,
    Hidden: ch.hidden,
    Samples: samplesArray,
  }
}

function burstToLac(b) {
  return {
    BurstSampleStart: b.burstSampleStart,
    BurstSampleEnd: b.burstSampleEnd,
    BurstSampleGap: b.burstSampleGap,
    BurstTimeGap: b.burstTimeGap,
  }
}

function regionToLac(r) {
  return {
    FirstSample: r.firstSample,
    LastSample: r.lastSample,
    RegionName: r.regionName,
    R: r.regionColor.r,
    G: r.regionColor.g,
    B: r.regionColor.b,
    A: r.regionColor.a,
  }
}

function sessionToLac(s) {
  return {
    Frequency: s.frequency,
    PreTriggerSamples: s.preTriggerSamples,
    PostTriggerSamples: s.postTriggerSamples,
    LoopCount: s.loopCount,
    MeasureBursts: s.measureBursts,
    CaptureChannels: s.captureChannels.map(channelToLac),
    Bursts: s.bursts ? s.bursts.map(burstToLac) : null,
    TriggerType: s.triggerType,
    TriggerChannel: s.triggerChannel,
    TriggerInverted: s.triggerInverted,
    TriggerBitCount: s.triggerBitCount,
    TriggerPattern: s.triggerPattern,
  }
}

// ─── Legacy: extract per-channel samples from root Samples[] (UInt128 packed) ───

/**
 * When a .lac file has the legacy root `Samples` array instead of per-channel `Samples`,
 * extract bits into per-channel Uint8Arrays.
 * Max 24 channels, so values fit in JS number.
 */
function applyLegacySamples(session, legacySamples) {
  if (!legacySamples || legacySamples.length === 0) return
  for (const ch of session.captureChannels) {
    if (ch.samples) continue // already has per-channel data
    const mask = 1 << ch.channelNumber
    const raw = new Uint8Array(legacySamples.length)
    for (let i = 0; i < legacySamples.length; i++) {
      raw[i] = (legacySamples[i] & mask) !== 0 ? 1 : 0
    }
    ch.samples = SampleBuffer.fromUint8Array(raw)
  }
}

// ─── Public API ───

/**
 * Parses a .lac JSON string into session + regions.
 *
 * @param {string} jsonString
 * @returns {{ session: import('../driver/types.js').CaptureSession, regions: import('./types.js').SampleRegion[] }}
 */
export function parseLac(jsonString) {
  const data = JSON.parse(jsonString)
  const session = sessionFromLac(data.Settings)

  // Handle legacy root Samples array
  if (data.Samples) {
    applyLegacySamples(session, data.Samples)
  }

  const regions = (data.SelectedRegions || []).map(regionFromLac)
  return { session, regions }
}

/**
 * Serializes session + regions to .lac JSON string.
 *
 * @param {import('../driver/types.js').CaptureSession} session
 * @param {import('./types.js').SampleRegion[]} [regions=[]]
 * @returns {string}
 */
export function serializeLac(session, regions = []) {
  const data = {
    Settings: sessionToLac(session),
    Samples: null, // Legacy field, always null in new files
    SelectedRegions: regions.map(regionToLac),
  }
  return JSON.stringify(data)
}

/**
 * Parses a CSV string into channel data.
 * Header row: channel names. Data rows: 0/1 values per column.
 *
 * @param {string} csvString
 * @returns {{ channels: import('../driver/types.js').AnalyzerChannel[] }}
 */
export function parseCsv(csvString) {
  const lines = csvString.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return { channels: [] }

  const headers = lines[0].split(',').map((h) => h.trim())
  const channelCount = headers.length

  // Pre-allocate sample arrays
  const sampleCount = lines.length - 1
  const samplesArrays = headers.map(() => new Uint8Array(sampleCount))

  for (let row = 1; row < lines.length; row++) {
    const values = lines[row].split(',')
    for (let col = 0; col < channelCount; col++) {
      samplesArrays[col][row - 1] = parseInt(values[col], 10) || 0
    }
  }

  const channels = headers.map((name, i) => ({
    channelNumber: i,
    channelName: name,
    channelColor: null,
    hidden: false,
    samples: SampleBuffer.fromUint8Array(samplesArrays[i]),
  }))

  return { channels }
}

/**
 * Serializes capture session to CSV string.
 * Header: channel names (fallback "Channel N+1"). Rows: per-sample values.
 *
 * @param {import('../driver/types.js').CaptureSession} session
 * @returns {string}
 */
export function serializeCsv(session) {
  const channels = session.captureChannels
  if (channels.length === 0) return ''

  // Header row
  const header = channels.map((ch, i) => ch.channelName || `Channel ${i + 1}`).join(',')

  const totalSamples = getTotalSamples(session)
  const lines = [header]

  for (let s = 0; s < totalSamples; s++) {
    const row = channels
      .map((ch) => {
        if (!ch.samples) return 0
        return ch.samples.get ? ch.samples.get(s) : ch.samples[s]
      })
      .join(',')
    lines.push(row)
  }

  return lines.join('\n')
}

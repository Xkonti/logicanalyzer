/**
 * Sample extraction and burst timestamp processing.
 * Ports ExtractSamples (LogicAnalyzerDriver.cs:672) and
 * burst processing (LogicAnalyzerDriver.cs:529-616).
 */

import { SampleBuffer } from '../sample-buffer.js'

/**
 * Extracts per-channel sample data from raw packed samples.
 * Each raw sample is a uint32 with bits representing channel states.
 * Returns a SampleBuffer with pre-built decimation pyramid.
 *
 * @param {Uint32Array} rawSamples - Packed multi-channel samples
 * @param {number} channelIndex - Which channel to extract (0-based bit position)
 * @returns {SampleBuffer} 0/1 per sample with decimation pyramid
 */
export function extractSamples(rawSamples, channelIndex) {
  const mask = 1 << channelIndex
  const raw = new Uint8Array(rawSamples.length)
  for (let i = 0; i < rawSamples.length; i++) {
    raw[i] = (rawSamples[i] & mask) !== 0 ? 1 : 0
  }
  return SampleBuffer.fromUint8Array(raw)
}

/**
 * Processes raw burst timestamps from the device into BurstInfo entries.
 * Ports LogicAnalyzerDriver.cs ReadCapture lines 529-616.
 *
 * Timestamps are SysTick values from a 200MHz clock (5ns per tick).
 * Lower 24 bits count down (must be inverted).
 *
 * @param {Uint32Array} timestamps - Raw timestamps from device (loopCount + 2 entries)
 * @param {import('./types.js').CaptureSession} session
 * @param {number} blastFrequency
 * @returns {import('./types.js').BurstInfo[]}
 */
export function processBurstTimestamps(timestamps, session, blastFrequency) {
  if (timestamps.length === 0) return []

  const tickLength = 1e9 / blastFrequency
  const nsPerSample = 1e9 / session.frequency
  const ticksPerSample = nsPerSample / tickLength
  const nsPerBurst = nsPerSample * session.postTriggerSamples
  const ticksPerBurst = nsPerBurst / tickLength

  // Copy timestamps to regular array for mutation
  // Invert lower 24 bits (SysTick counts down)
  const ts = new Array(timestamps.length)
  for (let i = 0; i < timestamps.length; i++) {
    const raw = timestamps[i]
    ts[i] = (raw & 0xff000000) | (0x00ffffff - (raw & 0x00ffffff))
  }

  // Adjust for rollover and jitter
  for (let i = 1; i < ts.length; i++) {
    // Handle rollover: if current < previous, add 0xFFFFFFFF
    let top = ts[i] < ts[i - 1] ? ts[i] + 0xffffffff : ts[i]

    // Jitter correction: if gap between timestamps is less than expected burst duration,
    // shift all subsequent timestamps forward
    if (top - ts[i - 1] <= ticksPerBurst) {
      const diff = ticksPerBurst - (top - ts[i - 1]) + ticksPerSample * 2
      for (let j = i; j < ts.length; j++) {
        ts[j] += diff
      }
    }
  }

  // Calculate delays between bursts
  // First two timestamps are sync + first burst end, so delays start at index 2
  const delays = new Array(ts.length - 2)
  for (let i = 2; i < ts.length; i++) {
    const top = ts[i] < ts[i - 1] ? ts[i] + 0xffffffff : ts[i]
    delays[i - 2] = (top - ts[i - 1] - ticksPerBurst) * tickLength
  }

  // Build BurstInfo array
  const bursts = []
  for (let i = 1; i < ts.length; i++) {
    if (i === 1) {
      // First burst: no gap
      bursts.push({
        burstSampleStart: session.preTriggerSamples,
        burstSampleEnd: session.preTriggerSamples + session.postTriggerSamples,
        burstSampleGap: 0,
        burstTimeGap: 0,
      })
    } else {
      bursts.push({
        burstSampleStart: session.preTriggerSamples + session.postTriggerSamples * (i - 1),
        burstSampleEnd: session.preTriggerSamples + session.postTriggerSamples * i,
        burstSampleGap: Math.round(delays[i - 2] / nsPerSample),
        burstTimeGap: Math.round(delays[i - 2]),
      })
    }
  }

  return bursts
}

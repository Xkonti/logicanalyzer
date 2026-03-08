/**
 * Domain type definitions for the LogicAnalyzer driver.
 * Ports CaptureSession.cs, AnalyzerChannel.cs, BurstInfo.cs, CaptureModes.cs.
 */

/**
 * @typedef {Object} CaptureSession
 * @property {number} frequency - Sampling frequency in Hz
 * @property {number} preTriggerSamples
 * @property {number} postTriggerSamples
 * @property {number} loopCount - 0 = single capture, >0 = burst mode
 * @property {boolean} measureBursts - Whether to measure burst timing
 * @property {AnalyzerChannel[]} captureChannels
 * @property {BurstInfo[]|null} bursts
 * @property {number} triggerType - 0=Edge, 1=Complex, 2=Fast, 3=Blast
 * @property {number} triggerChannel
 * @property {boolean} triggerInverted - For Edge trigger
 * @property {number} triggerBitCount - For Complex/Fast trigger
 * @property {number} triggerPattern - For Complex/Fast trigger
 */

/**
 * @typedef {Object} AnalyzerChannel
 * @property {number} channelNumber
 * @property {string} channelName
 * @property {number|null} channelColor - ARGB-packed uint (matches C# uint?)
 * @property {boolean} hidden
 * @property {Uint8Array|null} samples - 0/1 per sample
 */

/**
 * @typedef {Object} CaptureLimits
 * @property {number} minPreSamples
 * @property {number} maxPreSamples
 * @property {number} minPostSamples
 * @property {number} maxPostSamples
 * @property {number} maxTotalSamples
 */

/**
 * @typedef {Object} BurstInfo
 * @property {number} burstSampleStart
 * @property {number} burstSampleEnd
 * @property {number} burstSampleGap - Number of samples in gap
 * @property {number} burstTimeGap - Nanoseconds
 */

/**
 * @typedef {Object} CaptureResult
 * @property {boolean} success
 * @property {CaptureSession} session
 */

/**
 * Creates an AnalyzerChannel with default values.
 *
 * @param {number} number - Channel number (0-based)
 * @param {string} [name='']
 * @param {number|null} [color=null] - ARGB-packed uint
 * @returns {AnalyzerChannel}
 */
export function createChannel(number, name = '', color = null) {
  return {
    channelNumber: number,
    channelName: name,
    channelColor: color,
    hidden: false,
    samples: null,
  }
}

/**
 * Computes total sample count for a capture session.
 * Matches C# CaptureSession.TotalSamples property.
 *
 * @param {CaptureSession} session
 * @returns {number}
 */
export function getTotalSamples(session) {
  return session.postTriggerSamples * (session.loopCount + 1) + session.preTriggerSamples
}

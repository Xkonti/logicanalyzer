/**
 * Canvas 2D waveform renderer for the logic analyzer.
 *
 * Renders digital signal waveforms with:
 * - Filled waveform traces (gold-standard PulseView/Saleae style)
 * - Alternating channel backgrounds
 * - Grid lines at high zoom levels
 * - Trigger, burst, and user markers
 * - Region overlays
 * - High-DPI (retina) support
 *
 * Two rendering modes selected automatically:
 * - Detailed (<=2 samples/pixel): individual transitions with RLE optimization
 * - Decimated (>2 samples/pixel): per-pixel-column min/max with transition bars
 */

import { getChannelColor, withAlpha, BG_CHANNEL_COLORS, COLORS } from './colors.js'

/** Minimum height per channel in CSS pixels. */
export const MIN_CHANNEL_HEIGHT = 30

/** Maximum height per channel in CSS pixels. */
export const MAX_CHANNEL_HEIGHT = 64

/** Fraction of channel height used as top/bottom margin for the waveform trace. */
const CHANNEL_MARGIN_RATIO = 0.2

/** Width of the waveform signal line in CSS pixels. */
const SIGNAL_LINE_WIDTH = 1.5

/** Alpha value for the semi-transparent waveform fill. */
const FILL_ALPHA = 0.15

/** Width of marker lines (trigger, user, burst). */
const MARKER_LINE_WIDTH = 2

/**
 * Compute a per-pixel-column summary of a channel's sample data.
 * Each entry is 0 (all low), 1 (all high), or 2 (mixed/transition).
 *
 * Exported for testing — the renderer calls this internally.
 *
 * @param {Uint8Array} samples - full sample buffer
 * @param {number} firstSample - index of first visible sample
 * @param {number} samplesPerPixel - samples per pixel column
 * @param {number} pixelCount - number of pixel columns
 * @returns {Uint8Array} summary array (0=low, 1=high, 2=mixed)
 */
export function computeColumnSummary(samples, firstSample, samplesPerPixel, pixelCount) {
  const summary = new Uint8Array(pixelCount)
  const totalSamples = samples.length

  for (let px = 0; px < pixelCount; px++) {
    const sStart = Math.floor(firstSample + px * samplesPerPixel)
    const sEnd = Math.min(Math.ceil(firstSample + (px + 1) * samplesPerPixel), totalSamples)

    if (sStart >= totalSamples) {
      summary[px] = 0
      continue
    }

    let hasHigh = false
    let hasLow = false
    for (let s = sStart; s < sEnd; s++) {
      if (samples[s]) hasHigh = true
      else hasLow = true
      if (hasHigh && hasLow) break
    }

    summary[px] = hasHigh && hasLow ? 2 : hasHigh ? 1 : 0
  }

  return summary
}

export class WaveformRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    // Data state
    this.channels = []
    this.firstSample = 0
    this.visibleSamples = 100
    this.preTriggerSamples = 0
    this.userMarker = null
    this.regions = []
    this.bursts = []

    // Layout cache (CSS pixels)
    this._width = 0
    this._height = 0
    this._dpr = 1
    this._visibleChannels = []
    this._channelHeight = 0
  }

  // ── Data setters ───────────────────────────────────────────────────────

  /** Set the channel data array. Recomputes visible-channel list. */
  setChannels(channels) {
    this.channels = channels
    this._visibleChannels = channels.filter((ch) => ch.visible !== false)
  }

  /** Set the viewport (which samples are visible). */
  setViewport(firstSample, visibleSamples) {
    this.firstSample = firstSample
    this.visibleSamples = Math.max(1, visibleSamples)
  }

  /** Set the pre-trigger sample count (draws a white trigger line). */
  setPreTriggerSamples(n) {
    this.preTriggerSamples = n
  }

  /** Set the user marker position (sample index) or null to clear. */
  setUserMarker(sampleIndex) {
    this.userMarker = sampleIndex
  }

  /** Set the region overlays array. */
  setRegions(regions) {
    this.regions = regions
  }

  /** Set the burst marker sample indices array. */
  setBursts(bursts) {
    this.bursts = bursts
  }

  // ── Layout ─────────────────────────────────────────────────────────────

  /**
   * Handle canvas resize. Must be called when the container size changes
   * and once before the first render.
   */
  resize() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this._dpr = dpr
    this._width = rect.width
    this._height = rect.height
  }

  /** The minimum height (CSS px) required to fit all visible channels. */
  get minHeight() {
    return this._visibleChannels.length * MIN_CHANNEL_HEIGHT
  }

  /** Current channel height (CSS px). */
  get channelHeight() {
    return this._channelHeight
  }

  // ── Coordinate helpers ─────────────────────────────────────────────────

  /** Get sample index at pixel x (CSS px). */
  sampleAtX(x) {
    if (this._width === 0) return this.firstSample
    return Math.floor((x / this._width) * this.visibleSamples) + this.firstSample
  }

  /** Get pixel x (CSS px) for a sample index. */
  xAtSample(sampleIndex) {
    return ((sampleIndex - this.firstSample) / this.visibleSamples) * this._width
  }

  /** Get visible channel display index at pixel y (CSS px), or -1 if out of range. */
  channelAtY(y) {
    if (this._channelHeight === 0 || this._visibleChannels.length === 0) return -1
    const idx = Math.floor(y / this._channelHeight)
    return idx >= 0 && idx < this._visibleChannels.length ? idx : -1
  }

  /** Get the visible channel at a display index. */
  getVisibleChannel(displayIndex) {
    return this._visibleChannels[displayIndex] ?? null
  }

  // ── Main render ────────────────────────────────────────────────────────

  /** Render the current state to the canvas. */
  render() {
    const { ctx } = this
    const width = this._width
    const height = this._height
    const dpr = this._dpr

    if (width === 0 || height === 0) return

    // Set up transform for high-DPI and clear
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const channels = this._visibleChannels
    if (channels.length === 0 || this.visibleSamples === 0) return

    const channelHeight = Math.min(MAX_CHANNEL_HEIGHT, Math.max(MIN_CHANNEL_HEIGHT, height / channels.length))
    this._channelHeight = channelHeight
    const totalHeight = channelHeight * channels.length

    // Clip to rendered area
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, totalHeight)
    ctx.clip()

    // Render layers bottom-to-top
    this._drawBackgrounds(ctx, channels.length, channelHeight, width)
    this._drawRegions(ctx, width, totalHeight)
    this._drawGrid(ctx, width, totalHeight)
    this._drawWaveforms(ctx, channels, channelHeight, width)
    this._drawTriggerMarker(ctx, totalHeight)
    this._drawBurstMarkers(ctx, totalHeight)
    this._drawUserMarker(ctx, totalHeight)

    ctx.restore()
  }

  // ── Render layers ──────────────────────────────────────────────────────

  _drawBackgrounds(ctx, channelCount, channelHeight, width) {
    for (let i = 0; i < channelCount; i++) {
      ctx.fillStyle = BG_CHANNEL_COLORS[i % 2]
      ctx.fillRect(0, i * channelHeight, width, channelHeight)
    }
  }

  _drawRegions(ctx, width, totalHeight) {
    for (const region of this.regions) {
      const first = Math.min(region.firstSample, region.lastSample)
      const count = Math.abs(region.lastSample - region.firstSample)
      const x = this.xAtSample(first)
      const w = (count / this.visibleSamples) * width
      ctx.fillStyle = region.regionColor || COLORS.selectionFill
      ctx.fillRect(x, 0, w, totalHeight)
    }
  }

  _drawGrid(ctx, width, totalHeight) {
    if (this.visibleSamples >= 201) return

    const sampleWidth = width / this.visibleSamples

    // Major grid: line at sample center
    ctx.strokeStyle = COLORS.gridLine
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let s = 0; s < this.visibleSamples; s++) {
      const x = Math.round(s * sampleWidth + sampleWidth / 2) + 0.5
      ctx.moveTo(x, 0)
      ctx.lineTo(x, totalHeight)
    }
    ctx.stroke()

    // Minor grid: dash lines at sample boundaries (very zoomed in only)
    if (this.visibleSamples < 101) {
      ctx.strokeStyle = COLORS.gridDash
      ctx.beginPath()
      for (let s = 0; s <= this.visibleSamples; s++) {
        const x = Math.round(s * sampleWidth) + 0.5
        ctx.moveTo(x, 0)
        ctx.lineTo(x, totalHeight)
      }
      ctx.stroke()
    }
  }

  _drawWaveforms(ctx, channels, channelHeight, width) {
    const samplesPerPixel = this.visibleSamples / width

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i]
      const samples = channel.samples
      if (!samples || samples.length === 0) continue

      const margin = channelHeight * CHANNEL_MARGIN_RATIO
      const yHi = i * channelHeight + margin
      const yLo = (i + 1) * channelHeight - margin
      const color = getChannelColor(channel)

      if (samplesPerPixel <= 2) {
        this._drawChannelDetailed(ctx, samples, yHi, yLo, width, color)
      } else {
        this._drawChannelDecimated(ctx, samples, yHi, yLo, width, color, samplesPerPixel)
      }
    }
  }

  /**
   * Detailed rendering: individual transitions using RLE optimization.
   * Used when zoomed in (<=2 samples per pixel).
   * Draws fill + signal line in two passes through the data.
   */
  _drawChannelDetailed(ctx, samples, yHi, yLo, width, color) {
    const { firstSample, visibleSamples } = this
    const lastSample = Math.min(firstSample + visibleSamples, samples.length)
    if (firstSample >= samples.length) return

    const sampleWidth = width / visibleSamples
    const endX = (lastSample - firstSample) * sampleWidth

    // Pass 1: fill — trace waveform then close along baseline
    ctx.fillStyle = withAlpha(color, FILL_ALPHA)
    ctx.beginPath()
    this._traceWaveform(ctx, samples, firstSample, lastSample, sampleWidth, yHi, yLo)
    ctx.lineTo(endX, yLo)
    ctx.lineTo(0, yLo)
    ctx.closePath()
    ctx.fill()

    // Pass 2: signal line
    ctx.strokeStyle = color
    ctx.lineWidth = SIGNAL_LINE_WIDTH
    ctx.beginPath()
    this._traceWaveform(ctx, samples, firstSample, lastSample, sampleWidth, yHi, yLo)
    ctx.stroke()
  }

  /**
   * Trace the waveform shape onto the current path.
   * Uses RLE: only emits lineTo at transitions.
   * Draws slanted transitions so it's easy to see exactly between
   * which two samples a value change occurred.
   */
  _traceWaveform(ctx, samples, firstSample, lastSample, sampleWidth, yHi, yLo) {
    const slantHalf = Math.min(sampleWidth * 0.15, 4)

    let currentValue = samples[firstSample]
    let currentY = currentValue ? yHi : yLo
    ctx.moveTo(0, currentY)

    for (let i = firstSample + 1; i < lastSample; i++) {
      const val = samples[i]
      if (val !== currentValue) {
        const x = (i - firstSample) * sampleWidth
        ctx.lineTo(x - slantHalf, currentY)
        currentValue = val
        currentY = val ? yHi : yLo
        ctx.lineTo(x + slantHalf, currentY)
      }
    }

    ctx.lineTo((lastSample - firstSample) * sampleWidth, currentY)
  }

  /**
   * Decimated rendering: per-pixel-column min/max summary.
   * Used when zoomed out (>2 samples per pixel).
   */
  _drawChannelDecimated(ctx, samples, yHi, yLo, width, color, samplesPerPixel) {
    const { firstSample } = this
    const pixelCount = Math.ceil(width)
    const summary = computeColumnSummary(samples, firstSample, samplesPerPixel, pixelCount)

    // Pass 1: fill — batch adjacent high/mixed columns into single fillRect calls
    ctx.fillStyle = withAlpha(color, FILL_ALPHA)
    let fillStart = -1
    for (let px = 0; px <= pixelCount; px++) {
      const isHigh = px < pixelCount && summary[px] !== 0
      if (isHigh && fillStart === -1) {
        fillStart = px
      } else if (!isHigh && fillStart !== -1) {
        ctx.fillRect(fillStart, yHi, px - fillStart, yLo - yHi)
        fillStart = -1
      }
    }

    // Pass 2: signal trace
    ctx.strokeStyle = color
    ctx.lineWidth = SIGNAL_LINE_WIDTH
    ctx.beginPath()

    let prevState = -1 // -1=none, 0=low, 1=high, 2=mixed

    for (let px = 0; px < pixelCount; px++) {
      const state = summary[px]

      if (state === 2) {
        // Mixed column: draw vertical transition bar
        if (prevState === 1) ctx.lineTo(px, yHi)
        else if (prevState === 0) ctx.lineTo(px, yLo)
        ctx.moveTo(px + 0.5, yHi)
        ctx.lineTo(px + 0.5, yLo)
        prevState = 2
      } else {
        const y = state === 1 ? yHi : yLo

        if (prevState === -1 || prevState === 2) {
          // Start a new horizontal segment
          ctx.moveTo(px, y)
        } else if (state !== prevState) {
          // State changed: draw horizontal to edge then vertical transition
          const prevY = prevState === 1 ? yHi : yLo
          ctx.lineTo(px, prevY)
          ctx.lineTo(px, y)
        }

        prevState = state
      }
    }

    // Close final horizontal segment
    if (prevState === 1) ctx.lineTo(pixelCount, yHi)
    else if (prevState === 0) ctx.lineTo(pixelCount, yLo)

    ctx.stroke()
  }

  // ── Markers ────────────────────────────────────────────────────────────

  _drawTriggerMarker(ctx, totalHeight) {
    if (this.preTriggerSamples <= 0) return
    const x = this.xAtSample(this.preTriggerSamples)
    if (x < 0 || x > this._width) return

    ctx.strokeStyle = COLORS.triggerLine
    ctx.lineWidth = MARKER_LINE_WIDTH
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, totalHeight)
    ctx.stroke()
  }

  _drawBurstMarkers(ctx, totalHeight) {
    if (!this.bursts || this.bursts.length === 0) return

    ctx.strokeStyle = COLORS.burstLine
    ctx.lineWidth = MARKER_LINE_WIDTH
    ctx.setLineDash([6, 3, 2, 3])

    ctx.beginPath()
    for (const burst of this.bursts) {
      const sampleIndex = typeof burst === 'number' ? burst : burst.sampleIndex
      const x = this.xAtSample(sampleIndex)
      if (x < -1 || x > this._width + 1) continue
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, totalHeight)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  _drawUserMarker(ctx, totalHeight) {
    if (this.userMarker == null) return
    const x = this.xAtSample(this.userMarker)
    if (x < -1 || x > this._width + 1) return

    ctx.strokeStyle = COLORS.userMarker
    ctx.lineWidth = MARKER_LINE_WIDTH
    ctx.setLineDash([6, 3, 2, 3])
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, totalHeight)
    ctx.stroke()
    ctx.setLineDash([])
  }

  /** Release resources. */
  dispose() {
    this.channels = []
    this._visibleChannels = []
    this.regions = []
    this.bursts = []
    this.canvas = null
    this.ctx = null
  }
}

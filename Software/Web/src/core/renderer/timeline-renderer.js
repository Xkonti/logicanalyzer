/**
 * Canvas 2D timeline ruler renderer for the logic analyzer.
 *
 * Draws an adaptive timeline with:
 * - Major/minor tick marks that scale with zoom level
 * - Sample number labels
 * - Time labels when sample frequency is known
 * - High-DPI support
 */

import { COLORS } from './colors.js'

/** Height of the timeline ruler in CSS pixels. */
export const TIMELINE_HEIGHT = 32

/** Font used for timeline labels. */
const FONT = '11px system-ui, -apple-system, sans-serif'

/** Minimum pixels between major tick labels. */
const MIN_LABEL_SPACING = 80

/**
 * Calculate a "nice" tick interval for the given visible range.
 * Returns an interval from the 1-2-5 progression (e.g., 1, 2, 5, 10, 20, 50, …).
 *
 * @param {number} visibleSamples
 * @param {number} maxTicks - desired maximum number of major ticks
 * @returns {number}
 */
export function niceTickInterval(visibleSamples, maxTicks) {
  if (visibleSamples <= 0 || maxTicks <= 0) return 1
  const rough = visibleSamples / maxTicks
  if (rough <= 1) return 1

  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const fraction = rough / mag

  let nice
  if (fraction <= 1.5) nice = 1
  else if (fraction <= 3.5) nice = 2
  else if (fraction <= 7.5) nice = 5
  else nice = 10

  return Math.max(1, nice * mag)
}

/**
 * Format a time value for display on the timeline.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  const abs = Math.abs(seconds)
  if (abs === 0) return '0 s'
  if (abs >= 1) return `${Number(seconds.toPrecision(4))} s`
  if (abs >= 1e-3) return `${Number((seconds * 1e3).toPrecision(4))} ms`
  if (abs >= 1e-6) return `${Number((seconds * 1e6).toPrecision(4))} \u00B5s`
  return `${Number((seconds * 1e9).toPrecision(4))} ns`
}

export class TimelineRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    this.firstSample = 0
    this.visibleSamples = 100
    this.frequency = 0 // Hz; 0 = unknown → show sample numbers only

    this._width = 0
    this._height = 0
    this._dpr = 1
  }

  setViewport(firstSample, visibleSamples) {
    this.firstSample = firstSample
    this.visibleSamples = Math.max(1, visibleSamples)
  }

  setFrequency(frequency) {
    this.frequency = frequency
  }

  /** Handle canvas resize. Call when container size changes and before first render. */
  resize() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this._dpr = dpr
    this._width = rect.width
    this._height = rect.height
  }

  /** Render the timeline ruler. */
  render() {
    const { ctx } = this
    const width = this._width
    const height = this._height
    const dpr = this._dpr

    if (width === 0 || height === 0) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = COLORS.timelineBackground
    ctx.fillRect(0, 0, width, height)

    if (this.visibleSamples === 0) return

    const maxTicks = Math.floor(width / MIN_LABEL_SPACING)
    const interval = niceTickInterval(this.visibleSamples, maxTicks)
    const minorInterval = interval > 1 ? interval / (interval % 5 === 0 ? 5 : 2) : 0
    const sampleWidth = width / this.visibleSamples

    // Start at the first aligned tick before the viewport
    const firstTick = Math.ceil(this.firstSample / interval) * interval

    // When individual samples are visible, offset ticks to sample centers
    // so they align with the waveform grid lines and cursor.
    const centerOffset = sampleWidth >= 1 ? sampleWidth / 2 : 0

    // Draw minor ticks first (behind major)
    if (minorInterval > 0) {
      const firstMinor = Math.ceil(this.firstSample / minorInterval) * minorInterval
      ctx.strokeStyle = COLORS.timelineTick
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.3
      ctx.beginPath()
      for (let s = firstMinor; s < this.firstSample + this.visibleSamples; s += minorInterval) {
        const x = Math.round((s - this.firstSample) * sampleWidth + centerOffset) + 0.5
        ctx.moveTo(x, height * 0.65)
        ctx.lineTo(x, height)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Draw major ticks and labels
    ctx.strokeStyle = COLORS.timelineTick
    ctx.lineWidth = 1
    ctx.fillStyle = COLORS.text
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'

    ctx.beginPath()
    const labelY = 2
    const tickTop = height * 0.55
    const lastSample = this.firstSample + this.visibleSamples

    for (let s = firstTick; s < lastSample; s += interval) {
      const x = Math.round((s - this.firstSample) * sampleWidth + centerOffset) + 0.5

      // Tick line
      ctx.moveTo(x, tickTop)
      ctx.lineTo(x, height)

      // Label
      let label
      if (this.frequency > 0) {
        label = formatTime(s / this.frequency)
      } else {
        label = String(s)
      }
      ctx.fillText(label, x, labelY)
    }
    ctx.stroke()

    // Draw a thin bottom border
    ctx.strokeStyle = COLORS.gridLine
    ctx.beginPath()
    ctx.moveTo(0, height - 0.5)
    ctx.lineTo(width, height - 0.5)
    ctx.stroke()
  }

  /** Release resources. */
  dispose() {
    this.canvas = null
    this.ctx = null
  }
}

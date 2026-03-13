/**
 * Canvas 2D minimap renderer for the logic analyzer.
 *
 * Draws a compressed overview of all visible channel waveforms across the
 * entire capture/stream, with a draggable viewport rectangle overlay showing
 * the currently visible portion.
 *
 * Uses the same column-summary decimation as WaveformRenderer — including
 * SampleBuffer's pre-decimated pyramid levels — so rendering is O(pixelCount)
 * regardless of total sample count.
 */

import { getChannelColor, withAlpha, COLORS } from './colors.js'
import { SampleBuffer } from '../sample-buffer.js'
import { computeColumnSummary } from './waveform-renderer.js'

/** Minimum viewport rectangle width in CSS pixels. */
const MIN_VIEWPORT_WIDTH = 4

/** Alpha for high-state channel pixels. */
const CHANNEL_ALPHA = 0.8

/** Alpha for mixed-state channel pixels. */
const MIXED_ALPHA = 0.4

export class MinimapRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    this.channels = []
    this.totalSamples = 0
    this.firstSample = 0
    this.visibleSamples = 100

    this._width = 0
    this._height = 0
    this._dpr = 1
    this._visibleChannels = []
  }

  // ── Data setters ────────────────────────────────────────────────────────

  setChannels(channels) {
    this.channels = channels
    this._visibleChannels = channels.filter((ch) => ch.visible !== false)
  }

  setTotalSamples(total) {
    this.totalSamples = Math.max(0, total)
  }

  setViewport(firstSample, visibleSamples) {
    this.firstSample = firstSample
    this.visibleSamples = Math.max(1, visibleSamples)
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  resize() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this._dpr = dpr
    this._width = rect.width
    this._height = rect.height
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────

  /** Convert CSS pixel x to sample index across the full data range. */
  sampleAtX(x) {
    if (this._width === 0 || this.totalSamples === 0) return 0
    return Math.floor((x / this._width) * this.totalSamples)
  }

  /** Get the viewport rectangle bounds in CSS pixels. */
  getViewportRect() {
    if (this.totalSamples === 0) return { x: 0, width: 0 }
    const x = (this.firstSample / this.totalSamples) * this._width
    const w = Math.max(MIN_VIEWPORT_WIDTH, (this.visibleSamples / this.totalSamples) * this._width)
    return { x, width: w }
  }

  /** Check whether a CSS pixel x coordinate is inside the viewport rectangle. */
  isInsideViewport(px) {
    const rect = this.getViewportRect()
    return px >= rect.x && px <= rect.x + rect.width
  }

  // ── Main render ─────────────────────────────────────────────────────────

  render() {
    const { ctx } = this
    const width = this._width
    const height = this._height
    const dpr = this._dpr

    if (width === 0 || height === 0) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = COLORS.minimapBackground
    ctx.fillRect(0, 0, width, height)

    const channels = this._visibleChannels
    if (channels.length === 0 || this.totalSamples === 0) return

    // Draw channel waveforms
    this._drawChannels(ctx, channels, width, height)

    // Draw viewport overlay
    this._drawViewport(ctx, width, height)
  }

  // ── Render layers ───────────────────────────────────────────────────────

  _drawChannels(ctx, channels, width, height) {
    const bandHeight = height / channels.length
    const samplesPerPixel = this.totalSamples / width
    const pixelCount = Math.ceil(width)

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i]
      const samples = channel.samples
      if (!samples || samples.length === 0) continue

      const yTop = i * bandHeight
      const color = getChannelColor(channel)

      const summary =
        samples instanceof SampleBuffer
          ? samples.getColumnSummary(0, samplesPerPixel, pixelCount)
          : computeColumnSummary(samples, 0, samplesPerPixel, pixelCount)

      // Draw high pixels
      ctx.fillStyle = withAlpha(color, CHANNEL_ALPHA)
      for (let px = 0; px < pixelCount; px++) {
        if (summary[px] === 1) {
          ctx.fillRect(px, yTop, 1, bandHeight)
        }
      }

      // Draw mixed pixels at lower alpha
      ctx.fillStyle = withAlpha(color, MIXED_ALPHA)
      for (let px = 0; px < pixelCount; px++) {
        if (summary[px] === 2) {
          ctx.fillRect(px, yTop, 1, bandHeight)
        }
      }
    }
  }

  _drawViewport(ctx, width, height) {
    const rect = this.getViewportRect()
    if (rect.width === 0) return

    // Dim areas outside viewport
    ctx.fillStyle = COLORS.minimapDimOverlay
    if (rect.x > 0) {
      ctx.fillRect(0, 0, rect.x, height)
    }
    const rightEdge = rect.x + rect.width
    if (rightEdge < width) {
      ctx.fillRect(rightEdge, 0, width - rightEdge, height)
    }

    // Viewport rectangle fill
    ctx.fillStyle = COLORS.minimapViewportFill
    ctx.fillRect(rect.x, 0, rect.width, height)

    // Viewport rectangle border
    ctx.strokeStyle = COLORS.minimapViewportStroke
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(rect.x) + 0.5, 0.5, Math.round(rect.width) - 1, height - 1)
  }

  /** Release resources. */
  dispose() {
    this.channels = []
    this._visibleChannels = []
    this.canvas = null
    this.ctx = null
  }
}

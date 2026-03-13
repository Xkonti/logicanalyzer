import { describe, it, expect, beforeEach } from 'vitest'
import { MinimapRenderer } from './minimap-renderer.js'

// ── Mock canvas helper ────────────────────────────────────────────────────────

function createMockCanvas(width = 300, height = 24) {
  const ops = []
  const ctx = {
    setTransform: (...args) => ops.push(['setTransform', ...args]),
    clearRect: (...args) => ops.push(['clearRect', ...args]),
    fillRect: (...args) => ops.push(['fillRect', ...args]),
    strokeRect: (...args) => ops.push(['strokeRect', ...args]),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...args) => ops.push(['moveTo', ...args]),
    lineTo: (...args) => ops.push(['lineTo', ...args]),
    stroke: () => ops.push(['stroke']),
    fill: () => ops.push(['fill']),
    closePath: () => ops.push(['closePath']),
    save: () => ops.push(['save']),
    restore: () => ops.push(['restore']),
    rect: () => {},
    clip: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    fillText: () => {},
    setLineDash: () => {},
  }
  const canvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
    width: 0,
    height: 0,
  }
  return { canvas, ctx, ops }
}

// ── Constructor + resize ──────────────────────────────────────────────────────

describe('MinimapRenderer', () => {
  let renderer, canvas

  beforeEach(() => {
    const mock = createMockCanvas(400, 24)
    canvas = mock.canvas
    renderer = new MinimapRenderer(canvas)
    renderer.resize()
  })

  it('stores canvas dimensions after resize', () => {
    expect(renderer._width).toBe(400)
    expect(renderer._height).toBe(24)
    expect(renderer._dpr).toBeGreaterThan(0)
  })

  // ── Data setters ────────────────────────────────────────────────────────

  describe('setChannels', () => {
    it('filters hidden channels', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([1]) },
        { channelNumber: 1, visible: false, samples: new Uint8Array([1]) },
        { channelNumber: 2, visible: true, samples: new Uint8Array([0]) },
      ])
      expect(renderer._visibleChannels.length).toBe(2)
      expect(renderer._visibleChannels[0].channelNumber).toBe(0)
      expect(renderer._visibleChannels[1].channelNumber).toBe(2)
    })
  })

  describe('setTotalSamples', () => {
    it('stores total samples', () => {
      renderer.setTotalSamples(1000)
      expect(renderer.totalSamples).toBe(1000)
    })

    it('clamps negative to zero', () => {
      renderer.setTotalSamples(-5)
      expect(renderer.totalSamples).toBe(0)
    })
  })

  describe('setViewport', () => {
    it('stores viewport values', () => {
      renderer.setViewport(100, 50)
      expect(renderer.firstSample).toBe(100)
      expect(renderer.visibleSamples).toBe(50)
    })

    it('clamps visibleSamples to minimum 1', () => {
      renderer.setViewport(0, 0)
      expect(renderer.visibleSamples).toBe(1)
    })
  })

  // ── Coordinate helpers ──────────────────────────────────────────────────

  describe('sampleAtX', () => {
    it('converts pixel to sample index', () => {
      renderer.setTotalSamples(1000)
      // 400px wide, 1000 total → 2.5 samples per pixel
      expect(renderer.sampleAtX(0)).toBe(0)
      expect(renderer.sampleAtX(200)).toBe(500)
      expect(renderer.sampleAtX(400)).toBe(1000)
    })

    it('returns 0 when no data', () => {
      renderer.setTotalSamples(0)
      expect(renderer.sampleAtX(100)).toBe(0)
    })

    it('returns 0 when width is 0', () => {
      const mock = createMockCanvas(0, 24)
      const r = new MinimapRenderer(mock.canvas)
      r.resize()
      r.setTotalSamples(1000)
      expect(r.sampleAtX(0)).toBe(0)
    })
  })

  describe('getViewportRect', () => {
    it('returns correct bounds', () => {
      renderer.setTotalSamples(1000)
      renderer.setViewport(250, 500) // 25%-75% of data
      const rect = renderer.getViewportRect()
      // x = 250/1000 * 400 = 100
      expect(rect.x).toBe(100)
      // width = 500/1000 * 400 = 200
      expect(rect.width).toBe(200)
    })

    it('clamps width to minimum', () => {
      renderer.setTotalSamples(1000000)
      renderer.setViewport(0, 10) // tiny viewport
      const rect = renderer.getViewportRect()
      // Natural width = 10/1000000 * 400 ≈ 0.004 → clamped to 4
      expect(rect.width).toBe(4)
    })

    it('returns zero-width rect when no data', () => {
      renderer.setTotalSamples(0)
      const rect = renderer.getViewportRect()
      expect(rect.x).toBe(0)
      expect(rect.width).toBe(0)
    })
  })

  describe('isInsideViewport', () => {
    it('returns true for click inside viewport rect', () => {
      renderer.setTotalSamples(1000)
      renderer.setViewport(250, 500) // rect at x=100, width=200
      expect(renderer.isInsideViewport(150)).toBe(true)
      expect(renderer.isInsideViewport(100)).toBe(true) // left edge
      expect(renderer.isInsideViewport(300)).toBe(true) // right edge
    })

    it('returns false for click outside viewport rect', () => {
      renderer.setTotalSamples(1000)
      renderer.setViewport(250, 500) // rect at x=100, width=200
      expect(renderer.isInsideViewport(50)).toBe(false)
      expect(renderer.isInsideViewport(350)).toBe(false)
    })
  })

  // ── Render safety ───────────────────────────────────────────────────────

  describe('render', () => {
    it('does not throw with no channels', () => {
      renderer.setChannels([])
      renderer.setTotalSamples(1000)
      renderer.setViewport(0, 100)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with totalSamples=0', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([1, 0, 1]) },
      ])
      renderer.setTotalSamples(0)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with empty samples', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array(0) },
      ])
      renderer.setTotalSamples(100)
      renderer.setViewport(0, 50)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with single channel', () => {
      const samples = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
      renderer.setChannels([{ channelNumber: 0, visible: true, samples }])
      renderer.setTotalSamples(10)
      renderer.setViewport(0, 10)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with multiple channels', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([1, 0, 1, 0, 1]) },
        { channelNumber: 1, visible: true, samples: new Uint8Array([0, 1, 0, 1, 0]) },
        { channelNumber: 2, visible: true, samples: new Uint8Array([1, 1, 0, 0, 1]) },
      ])
      renderer.setTotalSamples(5)
      renderer.setViewport(0, 5)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with viewport at end of data', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([1, 0, 1, 0, 1]) },
      ])
      renderer.setTotalSamples(5)
      renderer.setViewport(3, 2) // last 2 samples
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw on zero-sized canvas', () => {
      const mock = createMockCanvas(0, 0)
      const r = new MinimapRenderer(mock.canvas)
      r.resize()
      r.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([1, 0]) },
      ])
      r.setTotalSamples(2)
      expect(() => r.render()).not.toThrow()
    })
  })

  // ── Dispose ─────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('clears references', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([1]) },
      ])
      renderer.dispose()
      expect(renderer.channels).toEqual([])
      expect(renderer._visibleChannels).toEqual([])
      expect(renderer.canvas).toBeNull()
      expect(renderer.ctx).toBeNull()
    })
  })
})

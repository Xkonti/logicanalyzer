import { describe, it, expect, beforeEach } from 'vitest'
import { computeColumnSummary, WaveformRenderer, MIN_CHANNEL_HEIGHT } from './waveform-renderer.js'

// ── computeColumnSummary (pure function) ─────────────────────────────────────

describe('computeColumnSummary', () => {
  it('returns all-low for zero samples', () => {
    const samples = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])
    const summary = computeColumnSummary(samples, 0, 2, 4)
    expect([...summary]).toEqual([0, 0, 0, 0])
  })

  it('returns all-high for constant-high samples', () => {
    const samples = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1])
    const summary = computeColumnSummary(samples, 0, 2, 4)
    expect([...summary]).toEqual([1, 1, 1, 1])
  })

  it('detects transitions as mixed (2)', () => {
    const samples = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1])
    // 2 samples per pixel, 4 columns
    const summary = computeColumnSummary(samples, 0, 2, 4)
    // Each column spans 2 samples: [0,1], [0,1], [0,1], [0,1] → all mixed
    expect([...summary]).toEqual([2, 2, 2, 2])
  })

  it('handles mixed and constant regions', () => {
    const samples = new Uint8Array([0, 0, 0, 1, 1, 1, 1, 0])
    // 2 samples per pixel, 4 columns
    // col 0: [0,0]=low, col 1: [0,1]=mixed, col 2: [1,1]=high, col 3: [1,0]=mixed
    const summary = computeColumnSummary(samples, 0, 2, 4)
    expect([...summary]).toEqual([0, 2, 1, 2])
  })

  it('respects firstSample offset', () => {
    const samples = new Uint8Array([0, 0, 1, 1, 0, 0])
    // Start at sample 2, 2 samples per pixel, 2 columns
    // col 0: [1,1]=high, col 1: [0,0]=low
    const summary = computeColumnSummary(samples, 2, 2, 2)
    expect([...summary]).toEqual([1, 0])
  })

  it('clamps to sample array bounds', () => {
    const samples = new Uint8Array([0, 1, 1])
    // Start at 0, 2 spp, 4 columns — last 2 columns go past end
    const summary = computeColumnSummary(samples, 0, 2, 4)
    // col 0: [0,1]=mixed, col 1: [1]=high, col 2: past end=0, col 3: past end=0
    expect(summary[0]).toBe(2)
    expect(summary[1]).toBe(1)
    expect(summary[2]).toBe(0) // past end
    expect(summary[3]).toBe(0) // past end
  })

  it('handles firstSample beyond sample array', () => {
    const samples = new Uint8Array([0, 1])
    const summary = computeColumnSummary(samples, 100, 2, 3)
    expect([...summary]).toEqual([0, 0, 0])
  })

  it('handles single sample per column', () => {
    const samples = new Uint8Array([0, 1, 0, 1])
    const summary = computeColumnSummary(samples, 0, 1, 4)
    expect([...summary]).toEqual([0, 1, 0, 1])
  })

  it('handles large samples per pixel', () => {
    // 100 samples, all high except first and last
    const samples = new Uint8Array(100)
    samples.fill(1, 1, 99)
    // 50 samples per pixel, 2 columns
    // col 0: samples 0-49 (has low at 0, rest high) = mixed
    // col 1: samples 50-99 (has low at 99, rest high) = mixed
    const summary = computeColumnSummary(samples, 0, 50, 2)
    expect([...summary]).toEqual([2, 2])
  })
})

// ── WaveformRenderer (class with mock canvas) ───────────────────────────────

function createMockCanvas(width = 800, height = 400) {
  const calls = []
  const ctx = {
    setTransform: (...args) => calls.push(['setTransform', ...args]),
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    clip: () => calls.push(['clip']),
    beginPath: () => calls.push(['beginPath']),
    closePath: () => calls.push(['closePath']),
    rect: (...args) => calls.push(['rect', ...args]),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    stroke: () => calls.push(['stroke']),
    fill: () => calls.push(['fill']),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    fillText: (...args) => calls.push(['fillText', ...args]),
    setLineDash: (d) => calls.push(['setLineDash', d]),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  }
  const canvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
    width: 0,
    height: 0,
  }
  return { canvas, ctx, calls }
}

describe('WaveformRenderer', () => {
  let renderer, canvas

  beforeEach(() => {
    ;({ canvas } = createMockCanvas(800, 400))
    renderer = new WaveformRenderer(canvas)
    renderer.resize()
  })

  describe('constructor and resize', () => {
    it('sets canvas dimensions on resize', () => {
      expect(renderer._width).toBe(800)
      expect(renderer._height).toBe(400)
    })

    it('applies device pixel ratio', () => {
      // In test environment window.devicePixelRatio may be undefined
      expect(renderer._dpr).toBe(1)
      expect(canvas.width).toBe(800)
      expect(canvas.height).toBe(400)
    })
  })

  describe('setChannels', () => {
    it('filters out hidden channels', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([0]) },
        { channelNumber: 1, visible: false, samples: new Uint8Array([0]) },
        { channelNumber: 2, visible: true, samples: new Uint8Array([0]) },
      ])
      expect(renderer._visibleChannels).toHaveLength(2)
      expect(renderer._visibleChannels[0].channelNumber).toBe(0)
      expect(renderer._visibleChannels[1].channelNumber).toBe(2)
    })

    it('treats channels without visible property as visible', () => {
      renderer.setChannels([
        { channelNumber: 0, samples: new Uint8Array([0]) },
        { channelNumber: 1, samples: new Uint8Array([0]) },
      ])
      expect(renderer._visibleChannels).toHaveLength(2)
    })
  })

  describe('setViewport', () => {
    it('stores first sample and visible samples', () => {
      renderer.setViewport(100, 500)
      expect(renderer.firstSample).toBe(100)
      expect(renderer.visibleSamples).toBe(500)
    })

    it('clamps visible samples to at least 1', () => {
      renderer.setViewport(0, 0)
      expect(renderer.visibleSamples).toBe(1)

      renderer.setViewport(0, -10)
      expect(renderer.visibleSamples).toBe(1)
    })
  })

  describe('coordinate helpers', () => {
    beforeEach(() => {
      renderer.setViewport(100, 800)
    })

    it('sampleAtX converts pixel to sample index', () => {
      // 800 pixels, 800 samples → 1 sample per pixel
      expect(renderer.sampleAtX(0)).toBe(100) // first visible
      expect(renderer.sampleAtX(400)).toBe(500) // middle
      expect(renderer.sampleAtX(799)).toBe(899) // near end
    })

    it('xAtSample converts sample index to pixel', () => {
      expect(renderer.xAtSample(100)).toBe(0)
      expect(renderer.xAtSample(500)).toBe(400)
      expect(renderer.xAtSample(900)).toBe(800)
    })

    it('sampleAtX and xAtSample are approximate inverses', () => {
      for (const sample of [100, 250, 500, 750, 899]) {
        const x = renderer.xAtSample(sample)
        const recovered = renderer.sampleAtX(x)
        expect(Math.abs(recovered - sample)).toBeLessThanOrEqual(1)
      }
    })

    it('channelAtY returns -1 when no channels set', () => {
      expect(renderer.channelAtY(0)).toBe(-1)
    })

    it('channelAtY returns correct channel index', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([0]) },
        { channelNumber: 1, visible: true, samples: new Uint8Array([0]) },
        { channelNumber: 2, visible: true, samples: new Uint8Array([0]) },
      ])
      renderer.setViewport(0, 100)
      renderer.render() // compute _channelHeight

      const ch = renderer.channelHeight
      expect(renderer.channelAtY(0)).toBe(0)
      expect(renderer.channelAtY(ch - 1)).toBe(0)
      expect(renderer.channelAtY(ch)).toBe(1)
      expect(renderer.channelAtY(ch * 2)).toBe(2)
    })

    it('channelAtY returns -1 for y below rendered area', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([0]) },
      ])
      renderer.setViewport(0, 100)
      renderer.render()

      expect(renderer.channelAtY(-1)).toBe(-1)
    })
  })

  describe('getVisibleChannel', () => {
    it('returns the channel at the display index', () => {
      const ch0 = { channelNumber: 0, visible: true, samples: new Uint8Array([0]) }
      const ch1 = { channelNumber: 1, visible: false, samples: new Uint8Array([0]) }
      const ch2 = { channelNumber: 2, visible: true, samples: new Uint8Array([0]) }
      renderer.setChannels([ch0, ch1, ch2])

      expect(renderer.getVisibleChannel(0)).toBe(ch0)
      expect(renderer.getVisibleChannel(1)).toBe(ch2) // ch1 is hidden
      expect(renderer.getVisibleChannel(2)).toBeNull()
    })
  })

  describe('minHeight', () => {
    it('returns 0 when no channels', () => {
      expect(renderer.minHeight).toBe(0)
    })

    it('returns channelCount * MIN_CHANNEL_HEIGHT', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array([0]) },
        { channelNumber: 1, visible: true, samples: new Uint8Array([0]) },
        { channelNumber: 2, visible: true, samples: new Uint8Array([0]) },
      ])
      expect(renderer.minHeight).toBe(3 * MIN_CHANNEL_HEIGHT)
    })
  })

  describe('render', () => {
    it('does not throw with no channels', () => {
      renderer.setViewport(0, 100)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with empty samples', () => {
      renderer.setChannels([{ channelNumber: 0, visible: true, samples: new Uint8Array(0) }])
      renderer.setViewport(0, 100)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw in detailed mode', () => {
      // 100 samples, 800px → < 1 sample/pixel → detailed mode
      const samples = new Uint8Array(100)
      samples[10] = 1
      samples[20] = 1
      renderer.setChannels([{ channelNumber: 0, visible: true, samples }])
      renderer.setViewport(0, 100)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw in decimated mode', () => {
      // 10000 samples, 800px → ~12.5 samples/pixel → decimated mode
      const samples = new Uint8Array(10000)
      for (let i = 0; i < 10000; i++) samples[i] = i % 2
      renderer.setChannels([{ channelNumber: 0, visible: true, samples }])
      renderer.setViewport(0, 10000)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw with markers and regions set', () => {
      const samples = new Uint8Array(100)
      renderer.setChannels([{ channelNumber: 0, visible: true, samples }])
      renderer.setViewport(0, 100)
      renderer.setPreTriggerSamples(50)
      renderer.setUserMarker(75)
      renderer.setBursts([10, 30])
      renderer.setRegions([{ firstSample: 20, lastSample: 40, regionColor: 'rgba(255,0,0,0.3)' }])
      expect(() => renderer.render()).not.toThrow()
    })

    it('handles multiple channels of different lengths', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array(100) },
        { channelNumber: 1, visible: true, samples: new Uint8Array(200) },
        { channelNumber: 2, visible: true, samples: new Uint8Array(50) },
      ])
      renderer.setViewport(0, 150)
      expect(() => renderer.render()).not.toThrow()
    })

    it('handles viewport beyond sample data', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array(100) },
      ])
      renderer.setViewport(200, 100) // starts past end of data
      expect(() => renderer.render()).not.toThrow()
    })
  })

  describe('setCursorX', () => {
    it('stores cursor position', () => {
      renderer.setCursorX(200.5)
      expect(renderer.cursorX).toBe(200.5)
    })

    it('accepts null to hide cursor', () => {
      renderer.setCursorX(200)
      renderer.setCursorX(null)
      expect(renderer.cursorX).toBeNull()
    })
  })

  describe('cursor line rendering', () => {
    it('does not throw when cursor is set', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array(100) },
      ])
      renderer.setViewport(0, 100)
      renderer.setCursorX(400)
      expect(() => renderer.render()).not.toThrow()
    })

    it('does not throw when cursor is null', () => {
      renderer.setChannels([
        { channelNumber: 0, visible: true, samples: new Uint8Array(100) },
      ])
      renderer.setViewport(0, 100)
      renderer.setCursorX(null)
      expect(() => renderer.render()).not.toThrow()
    })

    it('initializes cursorX as null', () => {
      expect(renderer.cursorX).toBeNull()
    })
  })

  describe('dispose', () => {
    it('clears all references', () => {
      renderer.setChannels([{ channelNumber: 0, visible: true, samples: new Uint8Array(10) }])
      renderer.setRegions([{ firstSample: 0, lastSample: 5 }])
      renderer.setBursts([1, 2, 3])

      renderer.dispose()

      expect(renderer.channels).toEqual([])
      expect(renderer._visibleChannels).toEqual([])
      expect(renderer.regions).toEqual([])
      expect(renderer.bursts).toEqual([])
      expect(renderer.canvas).toBeNull()
      expect(renderer.ctx).toBeNull()
    })
  })
})

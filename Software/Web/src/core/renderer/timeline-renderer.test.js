import { describe, it, expect } from 'vitest'
import { niceTickInterval, formatTime, TimelineRenderer, TIMELINE_HEIGHT } from './timeline-renderer.js'

// ── niceTickInterval (pure function) ─────────────────────────────────────────

describe('niceTickInterval', () => {
  it('returns 1 for very small ranges', () => {
    expect(niceTickInterval(5, 10)).toBe(1)
    expect(niceTickInterval(10, 10)).toBe(1)
  })

  it('follows the 1-2-5 progression', () => {
    // 100 samples, 10 ticks → rough interval ~10 → nice = 10
    expect(niceTickInterval(100, 10)).toBe(10)

    // 200 samples, 10 ticks → rough interval ~20 → nice = 20
    expect(niceTickInterval(200, 10)).toBe(20)

    // 500 samples, 10 ticks → rough interval ~50 → nice = 50
    expect(niceTickInterval(500, 10)).toBe(50)

    // 1000 samples, 10 ticks → rough interval ~100 → nice = 100
    expect(niceTickInterval(1000, 10)).toBe(100)
  })

  it('returns intervals that divide the range into roughly maxTicks parts', () => {
    const interval = niceTickInterval(10000, 8)
    const ticks = 10000 / interval
    // Should produce 5-15 ticks (reasonable range)
    expect(ticks).toBeGreaterThanOrEqual(3)
    expect(ticks).toBeLessThanOrEqual(20)
  })

  it('handles edge cases', () => {
    expect(niceTickInterval(0, 10)).toBe(1)
    expect(niceTickInterval(100, 0)).toBe(1)
    expect(niceTickInterval(1, 100)).toBe(1)
  })

  it('scales correctly across orders of magnitude', () => {
    const i1 = niceTickInterval(100, 5)
    const i2 = niceTickInterval(100000, 5)
    // i2 should be ~1000x i1
    expect(i2 / i1).toBeGreaterThan(500)
    expect(i2 / i1).toBeLessThan(2000)
  })
})

// ── formatTime (pure function) ───────────────────────────────────────────────

describe('formatTime', () => {
  it('formats zero', () => {
    expect(formatTime(0)).toBe('0 s')
  })

  it('formats seconds', () => {
    expect(formatTime(1)).toBe('1 s')
    expect(formatTime(2.5)).toBe('2.5 s')
    expect(formatTime(100)).toBe('100 s')
  })

  it('formats milliseconds', () => {
    expect(formatTime(0.001)).toBe('1 ms')
    expect(formatTime(0.0125)).toBe('12.5 ms')
    expect(formatTime(0.5)).toBe('500 ms')
  })

  it('formats microseconds', () => {
    expect(formatTime(0.000001)).toBe('1 \u00B5s')
    expect(formatTime(0.0000125)).toBe('12.5 \u00B5s')
    expect(formatTime(0.0005)).toBe('500 \u00B5s')
  })

  it('formats nanoseconds', () => {
    expect(formatTime(0.000000001)).toBe('1 ns')
    expect(formatTime(0.0000000125)).toBe('12.5 ns')
    expect(formatTime(0.0000005)).toBe('500 ns')
  })

  it('handles negative times', () => {
    const result = formatTime(-0.001)
    expect(result).toContain('ms')
    expect(result).toContain('-')
  })
})

// ── TIMELINE_HEIGHT constant ─────────────────────────────────────────────────

describe('TIMELINE_HEIGHT', () => {
  it('matches the C# reference (32px)', () => {
    expect(TIMELINE_HEIGHT).toBe(32)
  })
})

// ── TimelineRenderer ─────────────────────────────────────────────────────────

function createMockCanvas(width = 800, height = 32) {
  const ctx = {
    setTransform: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillRect: () => {},
    fillText: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  }
  return {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
    width: 0,
    height: 0,
  }
}

describe('TimelineRenderer', () => {
  it('constructs without error', () => {
    const canvas = createMockCanvas()
    const renderer = new TimelineRenderer(canvas)
    expect(renderer).toBeDefined()
  })

  it('resizes correctly', () => {
    const canvas = createMockCanvas(1024, 32)
    const renderer = new TimelineRenderer(canvas)
    renderer.resize()
    expect(renderer._width).toBe(1024)
    expect(renderer._height).toBe(32)
  })

  it('renders without error with sample numbers', () => {
    const canvas = createMockCanvas()
    const renderer = new TimelineRenderer(canvas)
    renderer.resize()
    renderer.setViewport(0, 1000)
    expect(() => renderer.render()).not.toThrow()
  })

  it('renders without error with time labels', () => {
    const canvas = createMockCanvas()
    const renderer = new TimelineRenderer(canvas)
    renderer.resize()
    renderer.setViewport(0, 10000)
    renderer.setFrequency(1000000) // 1 MHz
    expect(() => renderer.render()).not.toThrow()
  })

  it('renders without error with zero visible samples', () => {
    const canvas = createMockCanvas()
    const renderer = new TimelineRenderer(canvas)
    renderer.resize()
    renderer.setViewport(0, 0)
    expect(() => renderer.render()).not.toThrow()
  })

  it('renders without error when viewport is offset', () => {
    const canvas = createMockCanvas()
    const renderer = new TimelineRenderer(canvas)
    renderer.resize()
    renderer.setViewport(50000, 500)
    renderer.setFrequency(100000000)
    expect(() => renderer.render()).not.toThrow()
  })

  it('dispose clears references', () => {
    const canvas = createMockCanvas()
    const renderer = new TimelineRenderer(canvas)
    renderer.dispose()
    expect(renderer.canvas).toBeNull()
    expect(renderer.ctx).toBeNull()
  })
})

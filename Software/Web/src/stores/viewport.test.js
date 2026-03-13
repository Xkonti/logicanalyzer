import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useViewportStore, ZOOM_LEVELS } from './viewport.js'
import { useCaptureStore } from './capture.js'

// Need the same mocks as capture.test.js for device store transitive dependency
import { vi } from 'vitest'

vi.mock('../core/driver/analyzer.js', () => {
  class MockAnalyzerDriver {
    async connect() {}
    async disconnect() {}
    getDeviceInfo() {
      return {
        name: 'TEST',
        maxFrequency: 100000000,
        blastFrequency: 200000000,
        channels: 24,
        bufferSize: 262144,
        modeLimits: [],
      }
    }
  }
  return { AnalyzerDriver: MockAnalyzerDriver }
})

vi.mock('../core/transport/serial.js', () => {
  class MockSerialTransport {
    async connect() {}
    async disconnect() {}
  }
  return { SerialTransport: MockSerialTransport }
})

/**
 * Helper to set up capture store with known totalSamples.
 * Loads a CSV to set capturedChannels and derives totalSamples from that.
 */
async function setupCapture(sampleCount) {
  const capture = useCaptureStore()
  const samples = Array(sampleCount).fill('1').join('\n')
  await capture.loadCsv(`CH0\n${samples}`)
  return capture
}

describe('ZOOM_LEVELS', () => {
  it('starts at minimum visible samples', () => {
    expect(ZOOM_LEVELS[0]).toBe(10)
  })

  it('is strictly increasing', () => {
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      expect(ZOOM_LEVELS[i]).toBeGreaterThan(ZOOM_LEVELS[i - 1])
    }
  })

  it('contains only integers', () => {
    for (const level of ZOOM_LEVELS) {
      expect(Number.isInteger(level)).toBe(true)
    }
  })

  it('covers a large range', () => {
    expect(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]).toBeGreaterThanOrEqual(1e10)
  })
})

describe('useViewportStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has correct initial state', () => {
    const viewport = useViewportStore()
    expect(viewport.firstSample).toBe(0)
    expect(viewport.visibleSamples).toBe(100)
  })

  describe('setView', () => {
    it('sets firstSample and visibleSamples', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(50, 200)
      expect(viewport.firstSample).toBe(50)
      expect(viewport.visibleSamples).toBe(200)
    })

    it('clamps firstSample to non-negative', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(-10, 100)
      expect(viewport.firstSample).toBe(0)
    })

    it('clamps firstSample so view does not exceed total', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(950, 100)
      expect(viewport.firstSample).toBe(900)
      expect(viewport.visibleSamples).toBe(100)
    })

    it('clamps visibleSamples to minimum', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 3)
      expect(viewport.visibleSamples).toBe(10) // MIN_VISIBLE_SAMPLES
    })

    it('clamps visibleSamples to total', async () => {
      await setupCapture(500)
      const viewport = useViewportStore()
      await viewport.setView(0, 9999)
      expect(viewport.visibleSamples).toBe(500)
      expect(viewport.firstSample).toBe(0)
    })
  })

  describe('zoomIn', () => {
    it('steps to next smaller zoom level', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      // Set to an exact zoom level (ZOOM_LEVELS includes 15)
      await viewport.setView(0, 15)
      await viewport.zoomIn()
      expect(viewport.visibleSamples).toBe(10) // one step down
    })

    it('does not zoom below minimum', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 10)
      await viewport.zoomIn()
      expect(viewport.visibleSamples).toBe(10) // stays at MIN
    })

    it('maintains center on zoom (default fraction=0.5)', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 23)
      // Center is at 111, zoom in → 15, fraction=0.5
      await viewport.zoomIn()
      expect(viewport.visibleSamples).toBe(15)
      // firstSample = round(111 - 0.5 * 15) = round(103.5) = 104
      expect(viewport.firstSample).toBe(104)
    })

    it('accepts anchor with fraction', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 80)
      // Cursor at sample 120 (fraction = (120-100)/80 = 0.25 from left)
      await viewport.zoomIn(120, 0.25)
      // New visible = 53, newFirst = round(120 - 0.25 * 53) = round(106.75) = 107
      expect(viewport.firstSample).toBe(107)
      expect(viewport.visibleSamples).toBe(53)
    })

    it('preserves screen position of anchor sample', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(200, 120)
      // Cursor at pixel 75% from left → sample = 200 + 0.75 * 120 = 290
      const anchor = 290
      const fraction = 0.75
      await viewport.zoomIn(anchor, fraction)
      // Verify anchor is still near 75% in the new viewport
      const newFraction =
        (anchor - viewport.firstSample) / viewport.visibleSamples
      expect(newFraction).toBeCloseTo(0.75, 1)
    })

    it('snaps down from a non-level value', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      // 200 is between zoom levels 180 and 270
      await viewport.setView(0, 200)
      await viewport.zoomIn()
      // findZoomIndex(200) finds 180 (largest <= 200), which is < 200, so stays at 180
      expect(viewport.visibleSamples).toBe(180)
    })
  })

  describe('zoomOut', () => {
    it('steps to next larger zoom level', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      // 15 is a zoom level
      await viewport.setView(0, 15)
      await viewport.zoomOut()
      expect(viewport.visibleSamples).toBe(23) // next level up
    })

    it('preserves screen position of anchor on zoom out', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(200, 80)
      // Cursor at 30% from left → sample 224
      const anchor = 224
      const fraction = 0.3
      await viewport.zoomOut(anchor, fraction)
      const newFraction =
        (anchor - viewport.firstSample) / viewport.visibleSamples
      expect(newFraction).toBeCloseTo(0.3, 1)
    })

    it('does not zoom beyond total samples', async () => {
      await setupCapture(500)
      const viewport = useViewportStore()
      await viewport.setView(0, 500)
      await viewport.zoomOut()
      expect(viewport.visibleSamples).toBe(500)
    })
  })

  describe('scrollTo', () => {
    it('centers view on given sample', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 100)
      await viewport.scrollTo(500)
      expect(viewport.firstSample).toBe(450)
      expect(viewport.visibleSamples).toBe(100)
    })

    it('clamps when scrolling near end', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 100)
      await viewport.scrollTo(990)
      expect(viewport.firstSample).toBe(900) // 1000 - 100
    })

    it('clamps when scrolling near start', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(500, 100)
      await viewport.scrollTo(5)
      expect(viewport.firstSample).toBe(0)
    })
  })

  describe('scrollBy', () => {
    it('scrolls forward', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 100)
      await viewport.scrollBy(50)
      expect(viewport.firstSample).toBe(150)
    })

    it('scrolls backward', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 100)
      await viewport.scrollBy(-30)
      expect(viewport.firstSample).toBe(70)
    })

    it('clamps to zero on negative overflow', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(10, 100)
      await viewport.scrollBy(-100)
      expect(viewport.firstSample).toBe(0)
    })
  })

  describe('scrollLeft / scrollRight', () => {
    it('scrollLeft moves backward by 10%', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 100)
      await viewport.scrollLeft()
      expect(viewport.firstSample).toBe(90) // 100 - floor(100 * 0.1)
    })

    it('scrollRight moves forward by 10%', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 100)
      await viewport.scrollRight()
      expect(viewport.firstSample).toBe(110)
    })
  })

  describe('fitAll', () => {
    it('shows all samples', async () => {
      await setupCapture(500)
      const viewport = useViewportStore()
      await viewport.setView(100, 50)
      await viewport.fitAll()
      expect(viewport.firstSample).toBe(0)
      expect(viewport.visibleSamples).toBe(500)
    })

    it('does nothing with no capture data', async () => {
      const viewport = useViewportStore()
      await viewport.setView(0, 100)
      await viewport.fitAll()
      // Should not crash, values unchanged
      expect(viewport.firstSample).toBe(0)
      expect(viewport.visibleSamples).toBe(100)
    })
  })

  describe('reset', () => {
    it('resets to defaults', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(500, 200)
      await viewport.reset()
      expect(viewport.firstSample).toBe(0)
      expect(viewport.visibleSamples).toBe(100)
    })
  })

  describe('getters', () => {
    it('lastVisibleSample', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(100, 50)
      expect(viewport.lastVisibleSample).toBe(149)
    })

    it('canZoomIn is true when above minimum', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 100)
      expect(viewport.canZoomIn).toBe(true)
    })

    it('canZoomIn is false at minimum', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 10)
      expect(viewport.canZoomIn).toBe(false)
    })

    it('canZoomOut is true when below total', async () => {
      await setupCapture(1000)
      const viewport = useViewportStore()
      await viewport.setView(0, 100)
      expect(viewport.canZoomOut).toBe(true)
    })

    it('canZoomOut is false when showing all', async () => {
      await setupCapture(100)
      const viewport = useViewportStore()
      await viewport.fitAll()
      expect(viewport.canZoomOut).toBe(false)
    })

    it('totalSamples mirrors capture store', async () => {
      const viewport = useViewportStore()
      expect(viewport.totalSamples).toBe(0)

      await setupCapture(500)
      expect(viewport.totalSamples).toBe(500)
    })
  })

  describe('edge cases', () => {
    it('all operations safe with totalSamples=0', async () => {
      const viewport = useViewportStore()
      // No capture loaded, totalSamples = 0
      await viewport.zoomIn()
      await viewport.zoomOut()
      await viewport.scrollTo(100)
      await viewport.scrollBy(50)
      await viewport.scrollLeft()
      await viewport.scrollRight()
      await viewport.fitAll()
      // Should not crash
      expect(viewport.firstSample).toBe(0)
    })
  })
})

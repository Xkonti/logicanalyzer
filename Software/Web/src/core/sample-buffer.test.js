import { describe, it, expect } from 'vitest'
import { SampleBuffer } from './sample-buffer.js'
import { computeColumnSummary } from './renderer/waveform-renderer.js'

describe('SampleBuffer', () => {
  describe('ring buffer basics', () => {
    it('starts empty', () => {
      const buf = new SampleBuffer(100)
      expect(buf.length).toBe(0)
      expect(buf.capacity).toBe(100)
    })

    it('appends and reads samples', () => {
      const buf = new SampleBuffer(100)
      buf.append(new Uint8Array([0, 1, 1, 0, 1]))
      expect(buf.length).toBe(5)
      expect(buf.get(0)).toBe(0)
      expect(buf.get(1)).toBe(1)
      expect(buf.get(2)).toBe(1)
      expect(buf.get(3)).toBe(0)
      expect(buf.get(4)).toBe(1)
    })

    it('appends multiple chunks', () => {
      const buf = new SampleBuffer(100)
      buf.append(new Uint8Array([1, 0]))
      buf.append(new Uint8Array([0, 1, 1]))
      expect(buf.length).toBe(5)
      expect(buf.get(0)).toBe(1)
      expect(buf.get(4)).toBe(1)
    })

    it('wraps around when capacity exceeded', () => {
      const buf = new SampleBuffer(5)
      buf.append(new Uint8Array([1, 0, 1, 0, 1])) // full
      buf.append(new Uint8Array([0, 0])) // overwrites first 2

      expect(buf.length).toBe(5)
      // oldest remaining: [1, 0, 1, 0, 0]
      expect(buf.get(0)).toBe(1)
      expect(buf.get(1)).toBe(0)
      expect(buf.get(2)).toBe(1)
      expect(buf.get(3)).toBe(0)
      expect(buf.get(4)).toBe(0)
    })

    it('wraps around with large overflow', () => {
      const buf = new SampleBuffer(4)
      buf.append(new Uint8Array([1, 0, 1, 0, 1, 1, 0, 0, 1, 0]))
      // capacity 4, appended 10 → keeps last 4: [0, 1, 0]... wait
      // last 4 samples: indices 6,7,8,9 → [0, 0, 1, 0]
      expect(buf.length).toBe(4)
      expect(buf.get(0)).toBe(0)
      expect(buf.get(1)).toBe(0)
      expect(buf.get(2)).toBe(1)
      expect(buf.get(3)).toBe(0)
    })

    it('handles empty chunk append', () => {
      const buf = new SampleBuffer(10)
      buf.append(new Uint8Array([1, 0]))
      buf.append(new Uint8Array([]))
      expect(buf.length).toBe(2)
    })
  })

  describe('flat mode', () => {
    it('throws on overflow in flat mode', () => {
      const buf = new SampleBuffer(3, { ring: false })
      buf.append(new Uint8Array([1, 0, 1]))
      expect(() => buf.append(new Uint8Array([0]))).toThrow('flat buffer overflow')
    })

    it('works within capacity', () => {
      const buf = new SampleBuffer(5, { ring: false })
      buf.append(new Uint8Array([1, 0, 1]))
      expect(buf.length).toBe(3)
      expect(buf.get(0)).toBe(1)
      expect(buf.get(2)).toBe(1)
    })
  })

  describe('fromUint8Array', () => {
    it('creates buffer with correct data', () => {
      const data = new Uint8Array([0, 1, 1, 0, 0, 1, 0, 1, 1, 0])
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.length).toBe(10)
      for (let i = 0; i < 10; i++) {
        expect(buf.get(i)).toBe(data[i])
      }
    })

    it('builds pyramid for data with complete groups', () => {
      // 10 samples → 1 pyramid entry at level 0
      const data = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(1)
      expect(buf.getPyramidEntry(0, 0)).toBe(2) // hasHigh only
    })
  })

  describe('toUint8Array', () => {
    it('returns all data', () => {
      const buf = new SampleBuffer(10)
      buf.append(new Uint8Array([0, 1, 1, 0, 1]))
      const arr = buf.toUint8Array()
      expect(arr).toEqual(new Uint8Array([0, 1, 1, 0, 1]))
    })

    it('handles wrap-around', () => {
      const buf = new SampleBuffer(4)
      buf.append(new Uint8Array([1, 0, 1, 0])) // full
      buf.append(new Uint8Array([1, 1])) // wraps
      const arr = buf.toUint8Array()
      expect(arr).toEqual(new Uint8Array([1, 0, 1, 1]))
    })

    it('returns slice with start and count', () => {
      const buf = new SampleBuffer(10)
      buf.append(new Uint8Array([0, 1, 1, 0, 1]))
      const arr = buf.toUint8Array(1, 3)
      expect(arr).toEqual(new Uint8Array([1, 1, 0]))
    })

    it('returns empty array for zero count', () => {
      const buf = new SampleBuffer(10)
      buf.append(new Uint8Array([0, 1]))
      const arr = buf.toUint8Array(0, 0)
      expect(arr).toEqual(new Uint8Array([]))
    })
  })

  describe('decimation pyramid', () => {
    it('produces correct level-0 entry for all-low group', () => {
      const data = new Uint8Array(10).fill(0)
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(1)
      expect(buf.getPyramidEntry(0, 0)).toBe(1) // hasLow only
    })

    it('produces correct level-0 entry for all-high group', () => {
      const data = new Uint8Array(10).fill(1)
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(1)
      expect(buf.getPyramidEntry(0, 0)).toBe(2) // hasHigh only
    })

    it('produces correct level-0 entry for mixed group', () => {
      const data = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(1)
      expect(buf.getPyramidEntry(0, 0)).toBe(3) // both
    })

    it('builds multiple level-0 entries', () => {
      // 30 samples → 3 level-0 entries
      const data = new Uint8Array(30)
      data.fill(0, 0, 10) // group 0: all low
      data.fill(1, 10, 20) // group 1: all high
      data.fill(0, 20, 25) // group 2: mixed
      data.fill(1, 25, 30)

      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(3)
      expect(buf.getPyramidEntry(0, 0)).toBe(1) // hasLow
      expect(buf.getPyramidEntry(0, 1)).toBe(2) // hasHigh
      expect(buf.getPyramidEntry(0, 2)).toBe(3) // mixed
    })

    it('does not create level-0 entry for incomplete group', () => {
      // 15 samples → 1 complete group, 5 leftover
      const data = new Uint8Array(15).fill(1)
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(1)
    })

    it('builds level-1 entry from 100 samples', () => {
      // 100 samples → 10 level-0 entries → 1 level-1 entry
      const data = new Uint8Array(100).fill(1)
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(10)
      expect(buf.getPyramidLength(1)).toBe(1)
      expect(buf.getPyramidEntry(1, 0)).toBe(2) // hasHigh only
    })

    it('builds level-2 entry from 1000 samples', () => {
      const data = new Uint8Array(1000).fill(0)
      const buf = SampleBuffer.fromUint8Array(data)
      expect(buf.getPyramidLength(0)).toBe(100)
      expect(buf.getPyramidLength(1)).toBe(10)
      expect(buf.getPyramidLength(2)).toBe(1)
      expect(buf.getPyramidEntry(2, 0)).toBe(1) // hasLow only
    })

    it('cascades mixed flags through levels', () => {
      // 100 samples: first 50 low, last 50 high
      const data = new Uint8Array(100)
      data.fill(0, 0, 50)
      data.fill(1, 50, 100)
      const buf = SampleBuffer.fromUint8Array(data)

      // Level 0: groups 0-4 are all-low, groups 5-9 are all-high
      expect(buf.getPyramidEntry(0, 0)).toBe(1)
      expect(buf.getPyramidEntry(0, 4)).toBe(1)
      expect(buf.getPyramidEntry(0, 5)).toBe(2)
      expect(buf.getPyramidEntry(0, 9)).toBe(2)

      // Level 1: single entry should be mixed (has both low and high groups)
      expect(buf.getPyramidLength(1)).toBe(1)
      expect(buf.getPyramidEntry(1, 0)).toBe(3) // both flags
    })

    it('handles accumulator continuity across multiple appends', () => {
      const buf = new SampleBuffer(100)
      // Append 7 samples, then 3 more to complete a group of 10
      buf.append(new Uint8Array([1, 1, 1, 1, 1, 1, 1]))
      expect(buf.getPyramidLength(0)).toBe(0) // not enough yet

      buf.append(new Uint8Array([1, 1, 1]))
      expect(buf.getPyramidLength(0)).toBe(1)
      expect(buf.getPyramidEntry(0, 0)).toBe(2) // all high
    })

    it('handles accumulator continuity with mixed values across boundary', () => {
      const buf = new SampleBuffer(100)
      buf.append(new Uint8Array([0, 0, 0, 0, 0])) // 5 lows
      buf.append(new Uint8Array([1, 1, 1, 1, 1])) // 5 highs → completes group
      expect(buf.getPyramidLength(0)).toBe(1)
      expect(buf.getPyramidEntry(0, 0)).toBe(3) // mixed
    })
  })

  describe('pyramid with ring buffer trim', () => {
    it('trims pyramid entries when raw data wraps', () => {
      const buf = new SampleBuffer(20)

      // Fill with 20 samples (2 level-0 entries)
      buf.append(new Uint8Array(20).fill(0))
      expect(buf.getPyramidLength(0)).toBe(2)

      // Append 10 more → oldest 10 trimmed → should have 2 entries still
      buf.append(new Uint8Array(10).fill(1))
      expect(buf.length).toBe(20)
      expect(buf.getPyramidLength(0)).toBe(2)
    })

    it('pyramid reflects data after trim', () => {
      const buf = new SampleBuffer(20)

      // Fill with 20 lows
      buf.append(new Uint8Array(20).fill(0))
      expect(buf.getPyramidEntry(0, 0)).toBe(1) // hasLow
      expect(buf.getPyramidEntry(0, 1)).toBe(1)

      // Append 10 highs → oldest 10 (lows) trimmed
      buf.append(new Uint8Array(10).fill(1))
      // Now have: 10 lows + 10 highs
      // Entry 0 should be low (the remaining original lows), entry 1 should be high
      // After trim, pyramid[0] should have entries [low, high]
      expect(buf.getPyramidLength(0)).toBe(2)
    })
  })

  describe('getColumnSummary', () => {
    it('returns all-low for zero data', () => {
      const buf = SampleBuffer.fromUint8Array(new Uint8Array(100).fill(0))
      const summary = buf.getColumnSummary(0, 10, 10)
      for (let i = 0; i < 10; i++) {
        expect(summary[i]).toBe(0) // low
      }
    })

    it('returns all-high for one data', () => {
      const buf = SampleBuffer.fromUint8Array(new Uint8Array(100).fill(1))
      const summary = buf.getColumnSummary(0, 10, 10)
      for (let i = 0; i < 10; i++) {
        expect(summary[i]).toBe(1) // high
      }
    })

    it('returns mixed for alternating data', () => {
      const data = new Uint8Array(100)
      for (let i = 0; i < 100; i++) data[i] = i % 2
      const buf = SampleBuffer.fromUint8Array(data)
      const summary = buf.getColumnSummary(0, 10, 10)
      for (let i = 0; i < 10; i++) {
        expect(summary[i]).toBe(2) // mixed
      }
    })

    it('matches computeColumnSummary for small samplesPerPixel', () => {
      // samplesPerPixel < 10 → uses raw scan path
      const data = new Uint8Array(50)
      for (let i = 0; i < 50; i++) data[i] = i < 25 ? 0 : 1

      const buf = SampleBuffer.fromUint8Array(data)

      const spp = 5
      const pixelCount = 10
      const bufSummary = buf.getColumnSummary(0, spp, pixelCount)
      const rawSummary = computeColumnSummary(data, 0, spp, pixelCount)

      expect(bufSummary).toEqual(rawSummary)
    })

    it('produces correct results using pyramid for large samplesPerPixel', () => {
      // 1000 samples, 100 spp, 10 pixels → uses level-1 (factor=100)
      const data = new Uint8Array(1000)
      data.fill(0, 0, 500) // first half low
      data.fill(1, 500, 1000) // second half high

      const buf = SampleBuffer.fromUint8Array(data)
      const summary = buf.getColumnSummary(0, 100, 10)

      // Pixels 0-4: all low, pixels 5-9: all high
      for (let i = 0; i < 5; i++) expect(summary[i]).toBe(0)
      for (let i = 5; i < 10; i++) expect(summary[i]).toBe(1)
    })

    it('handles partial coverage at end', () => {
      const buf = SampleBuffer.fromUint8Array(new Uint8Array(50).fill(1))
      // Request 10 pixels at 10 spp, but only 50 samples → last 5 pixels have no data
      const summary = buf.getColumnSummary(0, 10, 10)
      for (let i = 0; i < 5; i++) expect(summary[i]).toBe(1) // high
      for (let i = 5; i < 10; i++) expect(summary[i]).toBe(0) // no data
    })

    it('uses pyramid at large scale', () => {
      // 10000 samples → uses level-2 (factor=1000) at 1000 spp
      const data = new Uint8Array(10000).fill(1)
      const buf = SampleBuffer.fromUint8Array(data)
      const summary = buf.getColumnSummary(0, 1000, 10)
      for (let i = 0; i < 10; i++) expect(summary[i]).toBe(1)
    })
  })

  describe('clear', () => {
    it('resets all state', () => {
      const buf = new SampleBuffer(100)
      buf.append(new Uint8Array(50).fill(1))
      expect(buf.length).toBe(50)
      expect(buf.getPyramidLength(0)).toBe(5)

      buf.clear()
      expect(buf.length).toBe(0)
      expect(buf.getPyramidLength(0)).toBe(0)
    })

    it('allows reuse after clear', () => {
      const buf = new SampleBuffer(100)
      buf.append(new Uint8Array(50).fill(1))
      buf.clear()
      buf.append(new Uint8Array([0, 1, 0]))
      expect(buf.length).toBe(3)
      expect(buf.get(0)).toBe(0)
      expect(buf.get(1)).toBe(1)
    })
  })
})

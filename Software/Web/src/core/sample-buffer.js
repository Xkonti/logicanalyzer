/**
 * Ring buffer with multi-level decimation pyramid for logic analyzer sample data.
 *
 * Provides O(1) append (no full-buffer copies) and O(1) per-pixel summary lookups
 * at any zoom level via pre-computed decimation levels.
 *
 * Framework-agnostic — no Vue/Quasar imports.
 */

/** Decimation factor per level — each level aggregates 10 entries from the previous. */
const DECIMATION_FACTOR = 10

/** Number of decimation pyramid levels (10x, 100x, 1000x, 10000x). */
const PYRAMID_LEVELS = 4

/** Cumulative factors for each pyramid level. */
const LEVEL_FACTORS = [10, 100, 1000, 10000]

/**
 * Decimation encoding (stored in pyramid Uint8Arrays):
 *   bit 0 = hasLow  (at least one sample in the group was 0)
 *   bit 1 = hasHigh (at least one sample in the group was 1)
 *
 * Possible values: 1 = all low, 2 = all high, 3 = mixed (both)
 */
const HAS_LOW = 1
const HAS_HIGH = 2

export class SampleBuffer {
  /**
   * @param {number} capacity - Maximum number of raw samples
   * @param {{ ring?: boolean }} [options]
   */
  constructor(capacity, { ring = true } = {}) {
    this._capacity = capacity
    this._ring = ring
    this._data = new Uint8Array(capacity)
    this._head = 0
    this._length = 0
    this._totalAppended = 0

    // Decimation pyramid — each level is a mini ring buffer
    this._pyramid = new Array(PYRAMID_LEVELS)
    this._accumulators = new Array(PYRAMID_LEVELS)

    for (let level = 0; level < PYRAMID_LEVELS; level++) {
      const levelCapacity = Math.ceil(capacity / LEVEL_FACTORS[level])
      this._pyramid[level] = {
        data: new Uint8Array(levelCapacity),
        capacity: levelCapacity,
        head: 0,
        length: 0,
      }
      this._accumulators[level] = { hasLow: false, hasHigh: false, count: 0 }
    }
  }

  /**
   * Creates a flat (non-ring) SampleBuffer from an existing Uint8Array.
   * Builds the full decimation pyramid in one pass.
   *
   * @param {Uint8Array} data - Raw 0/1 sample data
   * @returns {SampleBuffer}
   */
  static fromUint8Array(data) {
    const buffer = new SampleBuffer(data.length, { ring: false })
    buffer.append(data)
    return buffer
  }

  /** Number of valid samples currently stored. */
  get length() {
    return this._length
  }

  /** Total capacity of the raw sample buffer. */
  get capacity() {
    return this._capacity
  }

  /**
   * Read a sample by logical index (0 = oldest stored sample).
   * @param {number} index
   * @returns {number} 0 or 1
   */
  get(index) {
    return this._data[(this._head + index) % this._capacity]
  }

  /**
   * Append a chunk of samples. In ring mode, old samples are discarded
   * when capacity is exceeded. In flat mode, appending beyond capacity throws.
   *
   * @param {Uint8Array} chunk - 0/1 sample values to append
   */
  append(chunk) {
    const chunkLen = chunk.length
    if (chunkLen === 0) return

    if (!this._ring && this._length + chunkLen > this._capacity) {
      throw new Error(
        `SampleBuffer: flat buffer overflow (${this._length} + ${chunkLen} > ${this._capacity})`,
      )
    }

    // Feed all samples into the decimation pyramid (must happen before any trimming)
    for (let i = 0; i < chunkLen; i++) {
      this._feedSample(chunk[i])
    }

    // If chunk is larger than capacity, only write the tail that fits
    let writeChunk = chunk
    let writeLen = chunkLen
    if (chunkLen >= this._capacity) {
      writeChunk = chunk.subarray(chunkLen - this._capacity)
      writeLen = this._capacity
    }

    // Write position in the circular buffer
    const writePos = (this._head + this._length) % this._capacity

    // Write chunk into ring buffer, handling wrap-around
    const spaceToEnd = this._capacity - writePos
    if (writeLen <= spaceToEnd) {
      this._data.set(writeChunk, writePos)
    } else {
      this._data.set(writeChunk.subarray(0, spaceToEnd), writePos)
      this._data.set(writeChunk.subarray(spaceToEnd), 0)
    }

    this._totalAppended += chunkLen

    if (chunkLen >= this._capacity) {
      // Chunk completely replaced buffer contents — head is where we started writing
      this._head = writePos
      this._length = this._capacity
      this._trimPyramid(chunkLen)
    } else {
      const newTotal = this._length + chunkLen
      const overflow = newTotal > this._capacity ? newTotal - this._capacity : 0
      if (overflow > 0) {
        this._head = (this._head + overflow) % this._capacity
        this._length = this._capacity
        this._trimPyramid(overflow)
      } else {
        this._length += chunkLen
      }
    }
  }

  /**
   * Feed a single sample value into the decimation pyramid accumulators.
   * @param {number} value - 0 or 1
   */
  _feedSample(value) {
    const acc = this._accumulators[0]
    if (value) acc.hasHigh = true
    else acc.hasLow = true
    acc.count++

    if (acc.count === DECIMATION_FACTOR) {
      const packed = (acc.hasLow ? HAS_LOW : 0) | (acc.hasHigh ? HAS_HIGH : 0)
      this._writePyramidEntry(0, packed)
      acc.hasLow = false
      acc.hasHigh = false
      acc.count = 0
    }
  }

  /**
   * Write an entry to a pyramid level and cascade upward.
   * @param {number} level
   * @param {number} packed - bit flags (HAS_LOW | HAS_HIGH)
   */
  _writePyramidEntry(level, packed) {
    const pyr = this._pyramid[level]
    const writePos = (pyr.head + pyr.length) % pyr.capacity
    pyr.data[writePos] = packed

    if (pyr.length < pyr.capacity) {
      pyr.length++
    } else {
      // Ring wrap: advance head
      pyr.head = (pyr.head + 1) % pyr.capacity
    }

    // Cascade to next level
    if (level + 1 < PYRAMID_LEVELS) {
      const nextAcc = this._accumulators[level + 1]
      if (packed & HAS_LOW) nextAcc.hasLow = true
      if (packed & HAS_HIGH) nextAcc.hasHigh = true
      nextAcc.count++

      if (nextAcc.count === DECIMATION_FACTOR) {
        const nextPacked = (nextAcc.hasLow ? HAS_LOW : 0) | (nextAcc.hasHigh ? HAS_HIGH : 0)
        this._writePyramidEntry(level + 1, nextPacked)
        nextAcc.hasLow = false
        nextAcc.hasHigh = false
        nextAcc.count = 0
      }
    }
  }

  /**
   * Trim pyramid heads after the raw ring buffer discards samples from the front.
   * @param {number} rawTrimmed - Number of raw samples trimmed
   */
  _trimPyramid() {
    for (let level = 0; level < PYRAMID_LEVELS; level++) {
      const factor = LEVEL_FACTORS[level]
      const pyr = this._pyramid[level]

      // The pyramid should have entries covering the raw data range.
      // After trimming, we know how many complete groups the raw data spans.
      // The pyramid length should not exceed ceil(rawLength / factor).
      const maxEntries = Math.ceil(this._length / factor)
      if (pyr.length > maxEntries) {
        const excess = pyr.length - maxEntries
        pyr.head = (pyr.head + excess) % pyr.capacity
        pyr.length = maxEntries
      }
    }
  }

  /**
   * Materialize a contiguous Uint8Array copy of stored samples.
   * Handles ring buffer wrap-around.
   *
   * @param {number} [start=0] - Logical start index
   * @param {number} [count] - Number of samples (defaults to all from start)
   * @returns {Uint8Array}
   */
  toUint8Array(start = 0, count = undefined) {
    const len = count !== undefined ? count : this._length - start
    if (len <= 0) return new Uint8Array(0)

    const result = new Uint8Array(len)
    const physStart = (this._head + start) % this._capacity

    const spaceToEnd = this._capacity - physStart
    if (len <= spaceToEnd) {
      result.set(this._data.subarray(physStart, physStart + len))
    } else {
      result.set(this._data.subarray(physStart, this._capacity))
      result.set(this._data.subarray(0, len - spaceToEnd), spaceToEnd)
    }

    return result
  }

  /**
   * Produce a per-pixel-column summary using the decimation pyramid.
   * Returns the same 0/1/2 format as the renderer's computeColumnSummary().
   *
   * @param {number} firstSample - Logical index of first visible sample
   * @param {number} samplesPerPixel - How many samples each pixel column spans
   * @param {number} pixelCount - Number of pixel columns to produce
   * @returns {Uint8Array} summary (0=low, 1=high, 2=mixed)
   */
  getColumnSummary(firstSample, samplesPerPixel, pixelCount) {
    // Pick the coarsest pyramid level where factor <= samplesPerPixel
    let level = -1
    for (let i = PYRAMID_LEVELS - 1; i >= 0; i--) {
      if (samplesPerPixel >= LEVEL_FACTORS[i]) {
        level = i
        break
      }
    }

    const summary = new Uint8Array(pixelCount)

    if (level === -1) {
      // samplesPerPixel < 10: scan raw samples directly
      this._columnSummaryFromRaw(summary, firstSample, samplesPerPixel, pixelCount)
    } else {
      this._columnSummaryFromPyramid(summary, firstSample, samplesPerPixel, pixelCount, level)
    }

    return summary
  }

  /**
   * Compute column summary by scanning raw samples.
   * Used when samplesPerPixel < 10 (already fast per pixel).
   */
  _columnSummaryFromRaw(summary, firstSample, samplesPerPixel, pixelCount) {
    for (let px = 0; px < pixelCount; px++) {
      const sStart = Math.floor(firstSample + px * samplesPerPixel)
      const sEnd = Math.min(
        Math.ceil(firstSample + (px + 1) * samplesPerPixel),
        this._length,
      )

      if (sStart >= this._length) {
        summary[px] = 0
        continue
      }

      let hasHigh = false
      let hasLow = false
      for (let s = sStart; s < sEnd; s++) {
        if (this.get(s)) hasHigh = true
        else hasLow = true
        if (hasHigh && hasLow) break
      }

      summary[px] = hasHigh && hasLow ? 2 : hasHigh ? 1 : 0
    }
  }

  /**
   * Compute column summary by reading pre-computed pyramid entries.
   * Each pyramid entry already has hasLow/hasHigh flags, so we just OR them.
   */
  _columnSummaryFromPyramid(summary, firstSample, samplesPerPixel, pixelCount, level) {
    const factor = LEVEL_FACTORS[level]
    const pyr = this._pyramid[level]

    for (let px = 0; px < pixelCount; px++) {
      const rawStart = firstSample + px * samplesPerPixel
      const rawEnd = firstSample + (px + 1) * samplesPerPixel
      const pStart = Math.floor(rawStart / factor)
      const pEnd = Math.ceil(rawEnd / factor)

      let combined = 0
      const maxP = Math.min(pEnd, pyr.length)
      for (let p = pStart; p < maxP; p++) {
        combined |= pyr.data[(pyr.head + p) % pyr.capacity]
        if (combined === 3) break
      }

      // Translate bit flags to 0/1/2 format
      // 0 (or no entries) → 0 (low), 1 (hasLow only) → 0, 2 (hasHigh only) → 1, 3 (both) → 2
      summary[px] = combined === 3 ? 2 : combined & HAS_HIGH ? 1 : 0
    }
  }

  /**
   * Read a pyramid entry by logical index at a given level.
   * Exposed for testing.
   *
   * @param {number} level - Pyramid level (0-3)
   * @param {number} index - Logical index
   * @returns {number} Packed flags (HAS_LOW | HAS_HIGH)
   */
  getPyramidEntry(level, index) {
    const pyr = this._pyramid[level]
    return pyr.data[(pyr.head + index) % pyr.capacity]
  }

  /**
   * Get the number of entries at a pyramid level.
   * @param {number} level
   * @returns {number}
   */
  getPyramidLength(level) {
    return this._pyramid[level].length
  }

  /** Reset all state. */
  clear() {
    this._head = 0
    this._length = 0
    this._totalAppended = 0

    for (let level = 0; level < PYRAMID_LEVELS; level++) {
      const pyr = this._pyramid[level]
      pyr.head = 0
      pyr.length = 0
      this._accumulators[level] = { hasLow: false, hasHigh: false, count: 0 }
    }
  }
}

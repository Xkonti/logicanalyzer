import { ref, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useCaptureStore } from './capture.js'
import { useStreamStore } from './stream.js'

const MIN_VISIBLE_SAMPLES = 10
const SCROLL_FACTOR = 0.1

/**
 * Pregenerated table of zoom levels (visible sample counts).
 * Each step is ~1.5x the previous, producing clean integer values.
 * Covers from MIN_VISIBLE_SAMPLES up to 10 billion — far beyond any real capture.
 */
export const ZOOM_LEVELS = (() => {
  const levels = [MIN_VISIBLE_SAMPLES]
  while (levels[levels.length - 1] < 1e10) {
    const next = Math.round(levels[levels.length - 1] * 1.5)
    levels.push(next)
  }
  return levels
})()

/**
 * Find the index of the largest zoom level <= value.
 * Returns 0 if value is at or below the minimum.
 */
function findZoomIndex(value) {
  let lo = 0
  let hi = ZOOM_LEVELS.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ZOOM_LEVELS[mid] <= value) lo = mid
    else hi = mid - 1
  }
  return lo
}

export const useViewportStore = defineStore('viewport', () => {
  const firstSample = ref(0)
  const visibleSamples = ref(100)

  function getEffectiveTotalSamples() {
    const stream = useStreamStore()
    if (stream.streaming || stream.streamChannels.length > 0) return stream.totalSamples
    return useCaptureStore().totalSamples
  }

  function clamp(first, visible) {
    const total = getEffectiveTotalSamples()
    if (total === 0) return { first: 0, visible }
    const clampedVisible = Math.max(MIN_VISIBLE_SAMPLES, Math.min(visible, total))
    const clampedFirst = Math.max(0, Math.min(first, total - clampedVisible))
    return { first: clampedFirst, visible: clampedVisible }
  }

  // Getters
  const lastVisibleSample = computed(() => firstSample.value + visibleSamples.value - 1)

  const canZoomIn = computed(() => visibleSamples.value > MIN_VISIBLE_SAMPLES)

  const canZoomOut = computed(() => {
    return visibleSamples.value < getEffectiveTotalSamples()
  })

  const totalSamples = computed(() => getEffectiveTotalSamples())

  // Actions
  async function setView(first, count) {
    const { first: f, visible: v } = clamp(first, count)
    firstSample.value = f
    visibleSamples.value = v
  }

  /**
   * Zoom in one level.
   * @param {number|null} anchor - sample index to keep in place (null = viewport center)
   * @param {number} fraction - screen fraction of anchor (0=left, 1=right, 0.5=center)
   */
  async function zoomIn(anchor = null, fraction = 0.5) {
    if (!canZoomIn.value) return
    const idx = findZoomIndex(visibleSamples.value)
    const newIdx = ZOOM_LEVELS[idx] >= visibleSamples.value ? Math.max(0, idx - 1) : idx
    const newVisible = ZOOM_LEVELS[newIdx]
    const mid = anchor ?? firstSample.value + Math.floor(visibleSamples.value / 2)
    const newFirst = Math.round(mid - fraction * newVisible)
    const { first: f, visible: v } = clamp(newFirst, newVisible)
    firstSample.value = f
    visibleSamples.value = v
  }

  /**
   * Zoom out one level.
   * @param {number|null} anchor - sample index to keep in place (null = viewport center)
   * @param {number} fraction - screen fraction of anchor (0=left, 1=right, 0.5=center)
   */
  async function zoomOut(anchor = null, fraction = 0.5) {
    if (!canZoomOut.value) return
    const idx = findZoomIndex(visibleSamples.value)
    const newIdx = Math.min(ZOOM_LEVELS.length - 1, idx + 1)
    const newVisible = ZOOM_LEVELS[newIdx]
    const mid = anchor ?? firstSample.value + Math.floor(visibleSamples.value / 2)
    const newFirst = Math.round(mid - fraction * newVisible)
    const { first: f, visible: v } = clamp(newFirst, newVisible)
    firstSample.value = f
    visibleSamples.value = v
  }

  async function scrollTo(sample) {
    const newFirst = sample - Math.floor(visibleSamples.value / 2)
    const { first: f, visible: v } = clamp(newFirst, visibleSamples.value)
    firstSample.value = f
    visibleSamples.value = v
  }

  async function scrollBy(delta) {
    const { first: f, visible: v } = clamp(firstSample.value + delta, visibleSamples.value)
    firstSample.value = f
    visibleSamples.value = v
  }

  async function scrollLeft() {
    await scrollBy(-Math.max(1, Math.floor(visibleSamples.value * SCROLL_FACTOR)))
  }

  async function scrollRight() {
    await scrollBy(Math.max(1, Math.floor(visibleSamples.value * SCROLL_FACTOR)))
  }

  async function fitAll() {
    const total = getEffectiveTotalSamples()
    if (total === 0) return
    firstSample.value = 0
    visibleSamples.value = total
  }

  async function reset() {
    firstSample.value = 0
    visibleSamples.value = 100
  }

  return {
    firstSample,
    visibleSamples,
    lastVisibleSample,
    canZoomIn,
    canZoomOut,
    totalSamples,
    setView,
    zoomIn,
    zoomOut,
    scrollTo,
    scrollBy,
    scrollLeft,
    scrollRight,
    fitAll,
    reset,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useViewportStore, import.meta.hot))
}

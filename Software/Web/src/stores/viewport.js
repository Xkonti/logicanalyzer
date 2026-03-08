import { ref, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useCaptureStore } from './capture.js'

const MIN_VISIBLE_SAMPLES = 10
const ZOOM_FACTOR = 0.5
const SCROLL_FACTOR = 0.1

export const useViewportStore = defineStore('viewport', () => {
  const firstSample = ref(0)
  const visibleSamples = ref(100)

  function clamp(first, visible) {
    const capture = useCaptureStore()
    const total = capture.totalSamples
    if (total === 0) return { first: 0, visible }
    const clampedVisible = Math.max(MIN_VISIBLE_SAMPLES, Math.min(visible, total))
    const clampedFirst = Math.max(0, Math.min(first, total - clampedVisible))
    return { first: clampedFirst, visible: clampedVisible }
  }

  // Getters
  const lastVisibleSample = computed(() => firstSample.value + visibleSamples.value - 1)

  const canZoomIn = computed(() => visibleSamples.value > MIN_VISIBLE_SAMPLES)

  const canZoomOut = computed(() => {
    const capture = useCaptureStore()
    return visibleSamples.value < capture.totalSamples
  })

  const totalSamples = computed(() => useCaptureStore().totalSamples)

  // Actions
  async function setView(first, count) {
    const { first: f, visible: v } = clamp(first, count)
    firstSample.value = f
    visibleSamples.value = v
  }

  async function zoomIn(center = null) {
    if (!canZoomIn.value) return
    const newVisible = Math.max(MIN_VISIBLE_SAMPLES, Math.floor(visibleSamples.value * ZOOM_FACTOR))
    const mid = center ?? firstSample.value + Math.floor(visibleSamples.value / 2)
    const newFirst = mid - Math.floor(newVisible / 2)
    const { first: f, visible: v } = clamp(newFirst, newVisible)
    firstSample.value = f
    visibleSamples.value = v
  }

  async function zoomOut(center = null) {
    if (!canZoomOut.value) return
    const newVisible = Math.floor(visibleSamples.value / ZOOM_FACTOR)
    const mid = center ?? firstSample.value + Math.floor(visibleSamples.value / 2)
    const newFirst = mid - Math.floor(newVisible / 2)
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
    const capture = useCaptureStore()
    const total = capture.totalSamples
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

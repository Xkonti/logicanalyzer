import { ref } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'

export const useCursorStore = defineStore('cursor', () => {
  /** Sample index under the cursor, or null if cursor is off-canvas. */
  const cursorSample = ref(null)

  /** CSS pixel x position (snapped or raw), or null if cursor is off-canvas. */
  const cursorX = ref(null)

  /** Raw mouse CSS pixel x — preserved across viewport changes for recalculation. */
  const rawX = ref(null)

  function setCursor(sample, x, raw) {
    cursorSample.value = sample
    cursorX.value = x
    rawX.value = raw
  }

  function clearCursor() {
    cursorSample.value = null
    cursorX.value = null
    rawX.value = null
  }

  return {
    cursorSample,
    cursorX,
    rawX,
    setCursor,
    clearCursor,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCursorStore, import.meta.hot))
}

import { ref } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'

export const useCursorStore = defineStore('cursor', () => {
  /** Sample index under the cursor, or null if cursor is off-canvas. */
  const cursorSample = ref(null)

  /** CSS pixel x position (snapped or raw), or null if cursor is off-canvas. */
  const cursorX = ref(null)

  function setCursor(sample, x) {
    cursorSample.value = sample
    cursorX.value = x
  }

  function clearCursor() {
    cursorSample.value = null
    cursorX.value = null
  }

  return {
    cursorSample,
    cursorX,
    setCursor,
    clearCursor,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCursorStore, import.meta.hot))
}

import { onMounted, onBeforeUnmount } from 'vue'
import { InputManager } from 'src/core/input/input-manager.js'
import { useViewportStore } from 'src/stores/viewport.js'
import { useStreamStore } from 'src/stores/stream.js'
import { useCursorStore } from 'src/stores/cursor.js'

/**
 * Composable that wires InputManager to Pinia stores and the waveform renderer.
 *
 * @param {import('vue').Ref<HTMLCanvasElement|null>} canvasRef - template ref to the canvas element
 * @param {import('vue').ShallowRef<import('src/core/renderer/waveform-renderer.js').WaveformRenderer|null>} rendererRef - shallow ref to the renderer
 */
export function useWaveformInput(canvasRef, rendererRef) {
  const viewport = useViewportStore()
  const stream = useStreamStore()
  const cursor = useCursorStore()

  let manager = null

  /**
   * Recalculate cursor sample and snapped position from the raw mouse pixel.
   * Called after viewport changes (zoom) so the cursor stays accurate.
   */
  function updateCursorFromRaw() {
    const renderer = rendererRef.value
    if (!renderer || cursor.rawX == null) return

    const offsetX = cursor.rawX
    const sample = renderer.sampleAtX(offsetX)
    const sampleWidth = renderer._width / renderer.visibleSamples

    let snappedX
    if (sampleWidth >= 1) {
      snappedX = renderer.xAtSample(sample) + sampleWidth / 2
    } else {
      snappedX = offsetX
    }

    cursor.setCursor(sample, snappedX, offsetX)
    renderer.setCursorX(snappedX)
  }

  function handleZoom({ delta }) {
    // Disable follow on manual zoom during stream
    if (stream.streaming) {
      stream.following = false
    }

    // Determine zoom center — use cursor sample if available, otherwise viewport center
    const center = cursor.cursorSample

    if (delta > 0) {
      viewport.zoomIn(center)
    } else {
      viewport.zoomOut(center)
    }

    // Recalculate cursor position for the new viewport
    updateCursorFromRaw()
  }

  function handleCursorMove({ offsetX }) {
    const renderer = rendererRef.value
    if (!renderer) return

    const sample = renderer.sampleAtX(offsetX)
    const sampleWidth = renderer._width / renderer.visibleSamples

    let snappedX
    if (sampleWidth >= 1) {
      snappedX = renderer.xAtSample(sample) + sampleWidth / 2
    } else {
      snappedX = offsetX
    }

    cursor.setCursor(sample, snappedX, offsetX)
    renderer.setCursorX(snappedX)
  }

  function handleCursorLeave() {
    cursor.clearCursor()
    const renderer = rendererRef.value
    if (renderer) renderer.setCursorX(null)
  }

  onMounted(() => {
    manager = new InputManager()

    if (canvasRef.value) {
      manager.bind(canvasRef.value, 'canvas')
    }
    manager.bind(window, 'window')

    manager.on('zoom', handleZoom)
    manager.on('cursor-move', handleCursorMove)
    manager.on('cursor-leave', handleCursorLeave)
  })

  onBeforeUnmount(() => {
    if (manager) {
      manager.dispose()
      manager = null
    }
    cursor.clearCursor()
  })
}

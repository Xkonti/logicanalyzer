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
   * Compute cursor state from a raw pixel position and viewport values.
   * Uses store values (synchronously current) rather than the renderer
   * (which updates asynchronously via watchEffect and may be stale after zoom).
   */
  function computeCursor(offsetX, first, visible, width) {
    const sample = Math.floor((offsetX / width) * visible) + first
    const sampleWidth = width / visible

    let snappedX
    if (sampleWidth >= 1) {
      snappedX = ((sample - first) / visible) * width + sampleWidth / 2
    } else {
      snappedX = offsetX
    }

    return { sample, snappedX }
  }

  /**
   * Recalculate cursor sample and snapped position from the raw mouse pixel.
   * Called after viewport changes (zoom) so the cursor stays accurate.
   */
  function updateCursorFromRaw() {
    const renderer = rendererRef.value
    if (!renderer || cursor.rawX == null) return

    const width = renderer._width
    if (width === 0) return

    const { sample, snappedX } = computeCursor(
      cursor.rawX,
      viewport.firstSample,
      viewport.visibleSamples,
      width,
    )

    cursor.setCursor(sample, snappedX, cursor.rawX)
    renderer.setCursorX(snappedX)
  }

  function handleZoom({ delta }) {
    // Disable follow on manual zoom during stream
    if (stream.streaming) {
      stream.following = false
    }

    const renderer = rendererRef.value
    const width = renderer?._width || 0

    // Compute anchor sample and its screen fraction
    let anchor = null
    let fraction = 0.5
    if (cursor.cursorSample != null && width > 0) {
      anchor = cursor.cursorSample
      fraction = Math.max(0, Math.min(1, cursor.rawX / width))
    }

    if (delta > 0) {
      viewport.zoomIn(anchor, fraction)
    } else {
      viewport.zoomOut(anchor, fraction)
    }

    // Recalculate cursor position for the new viewport
    updateCursorFromRaw()
  }

  function handleCursorMove({ offsetX }) {
    const renderer = rendererRef.value
    if (!renderer) return

    const width = renderer._width
    if (width === 0) return

    const { sample, snappedX } = computeCursor(
      offsetX,
      viewport.firstSample,
      viewport.visibleSamples,
      width,
    )

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

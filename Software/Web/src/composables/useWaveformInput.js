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
  }

  function handleCursorMove({ offsetX }) {
    const renderer = rendererRef.value
    if (!renderer) return

    const sample = renderer.sampleAtX(offsetX)
    const sampleWidth = renderer._width / renderer.visibleSamples

    let snappedX
    if (sampleWidth >= 1) {
      // Zoomed in: snap to center of the sample column
      snappedX = renderer.xAtSample(sample) + sampleWidth / 2
    } else {
      // Zoomed out: follow mouse exactly
      snappedX = offsetX
    }

    cursor.setCursor(sample, snappedX)
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

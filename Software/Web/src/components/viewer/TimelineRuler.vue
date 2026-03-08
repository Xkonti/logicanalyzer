<template>
  <div ref="containerRef" class="timeline-ruler-container">
    <canvas ref="canvasRef" class="timeline-ruler-canvas" />
  </div>
</template>

<script setup>
import { ref, shallowRef, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { TimelineRenderer } from 'src/core/renderer/timeline-renderer.js'
import { useViewportStore } from 'src/stores/viewport.js'
import { useCapture } from 'src/composables/useCapture.js'

const containerRef = ref(null)
const canvasRef = ref(null)
const renderer = shallowRef(null)

const viewport = useViewportStore()
const cap = useCapture()

let resizeObserver = null
let rafId = null

function scheduleRender() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (renderer.value) {
      renderer.value.resize()
      renderer.value.render()
    }
  })
}

onMounted(() => {
  renderer.value = new TimelineRenderer(canvasRef.value)
  renderer.value.resize()

  resizeObserver = new ResizeObserver(() => {
    scheduleRender()
  })
  resizeObserver.observe(containerRef.value)
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (renderer.value) {
    renderer.value.dispose()
    renderer.value = null
  }
})

watchEffect(() => {
  if (!renderer.value) return
  renderer.value.setViewport(viewport.firstSample, viewport.visibleSamples)
  renderer.value.setFrequency(cap.frequency)
  renderer.value.resize()
  renderer.value.render()
})
</script>

<style scoped>
.timeline-ruler-container {
  height: 32px;
  overflow: hidden;
}

.timeline-ruler-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>

<template>
  <div class="minimap-bar">
    <div class="minimap-controls">
      <q-btn
        flat
        dense
        round
        size="sm"
        icon="remove"
        color="grey-4"
        :disable="!viewport.canZoomOut"
        @click="viewport.zoomOut()"
      />
      <span class="zoom-label text-caption">{{ zoomLabel }}</span>
      <q-btn
        flat
        dense
        round
        size="sm"
        icon="add"
        color="grey-4"
        :disable="!viewport.canZoomIn"
        @click="viewport.zoomIn()"
      />
      <q-btn
        flat
        dense
        round
        size="sm"
        icon="fit_screen"
        color="grey-4"
        title="Fit all"
        @click="viewport.fitAll()"
      />
      <q-btn
        v-if="stream.isStreaming"
        flat
        dense
        round
        size="sm"
        :icon="stream.following ? 'gps_fixed' : 'gps_not_fixed'"
        :color="stream.following ? 'positive' : 'grey-4'"
        title="Follow latest data"
        @click="stream.following = !stream.following"
      />
    </div>

    <div
      ref="containerRef"
      class="minimap-canvas-container"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerUp"
    >
      <canvas ref="canvasRef" class="minimap-canvas" />
    </div>
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { MinimapRenderer } from 'src/core/renderer/minimap-renderer.js'
import { useViewportStore } from 'src/stores/viewport.js'
import { useCapture } from 'src/composables/useCapture.js'
import { useStream } from 'src/composables/useStream.js'

const containerRef = ref(null)
const canvasRef = ref(null)
const renderer = shallowRef(null)

const viewport = useViewportStore()
const cap = useCapture()
const stream = useStream()

// ── Active channels (same logic as WaveformCanvas) ─────────────────────

const activeChannels = computed(() => {
  if (stream.isStreaming || stream.streamChannels.length > 0) return stream.streamChannels
  return cap.capturedChannels
})

function mapChannels(channels) {
  if (!channels) return []
  return channels.map((ch) => ({
    channelNumber: ch.channelNumber,
    channelColor: ch.channelColor,
    visible: !ch.hidden,
    samples: ch.samples,
  }))
}

// ── Zoom label ─────────────────────────────────────────────────────────

const zoomLabel = computed(() => {
  if (viewport.canvasWidth === 0 || viewport.visibleSamples === 0) return '1.00x'
  const pps = viewport.canvasWidth / viewport.visibleSamples
  if (pps >= 100) return `${pps.toFixed(0)}x`
  if (pps >= 10) return `${pps.toFixed(1)}x`
  if (pps >= 0.01) return `${pps.toFixed(2)}x`
  return `${pps.toExponential(1)}x`
})

// ── Lifecycle ──────────────────────────────────────────────────────────

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
  renderer.value = new MinimapRenderer(canvasRef.value)
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
  renderer.value.setChannels(mapChannels(activeChannels.value))
  renderer.value.setTotalSamples(viewport.totalSamples)
  renderer.value.setViewport(viewport.firstSample, viewport.visibleSamples)
  renderer.value.resize()
  renderer.value.render()
})

// ── Drag interaction ───────────────────────────────────────────────────

let dragging = false
let dragOffsetSamples = 0

function onPointerDown(e) {
  const r = renderer.value
  if (!r || viewport.totalSamples === 0) return

  const rect = containerRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const clickedSample = r.sampleAtX(x)

  if (r.isInsideViewport(x)) {
    dragging = true
    dragOffsetSamples = clickedSample - viewport.firstSample
    containerRef.value.setPointerCapture(e.pointerId)
  } else {
    if (stream.isStreaming) stream.following = false
    const newFirst = clickedSample - Math.floor(viewport.visibleSamples / 2)
    viewport.setView(newFirst, viewport.visibleSamples)
  }
}

function onPointerMove(e) {
  if (!dragging || !renderer.value) return

  const rect = containerRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const sample = renderer.value.sampleAtX(x)

  if (stream.isStreaming) stream.following = false
  viewport.setView(sample - dragOffsetSamples, viewport.visibleSamples)
}

function onPointerUp(e) {
  if (dragging) {
    dragging = false
    try {
      containerRef.value?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore if already released */
    }
  }
}
</script>

<style scoped>
.minimap-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  height: 32px;
  background: rgb(28, 28, 28);
  border-bottom: 1px solid rgb(60, 60, 60);
}

.minimap-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.zoom-label {
  min-width: 52px;
  text-align: center;
  color: rgba(255, 255, 255, 0.7);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.minimap-canvas-container {
  flex: 1;
  height: 24px;
  overflow: hidden;
  cursor: pointer;
  border-radius: 3px;
  border: 1px solid rgb(50, 50, 50);
}

.minimap-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>

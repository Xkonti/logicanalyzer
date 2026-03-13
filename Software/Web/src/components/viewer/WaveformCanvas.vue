<template>
  <div ref="containerRef" class="waveform-canvas-container">
    <canvas
      ref="canvasRef"
      class="waveform-canvas"
      :style="{ minHeight: minCanvasHeight + 'px' }"
    />
  </div>
</template>

<script setup>
import { ref, shallowRef, watchEffect, computed, onMounted, onBeforeUnmount } from 'vue'
import { WaveformRenderer, MIN_CHANNEL_HEIGHT } from 'src/core/renderer/waveform-renderer.js'
import { COLORS } from 'src/core/renderer/colors.js'
import { useViewportStore } from 'src/stores/viewport.js'
import { useCursorStore } from 'src/stores/cursor.js'
import { useCapture } from 'src/composables/useCapture.js'
import { useStream } from 'src/composables/useStream.js'
import { useWaveformInput } from 'src/composables/useWaveformInput.js'

const emit = defineEmits(['channel-height-update'])

const containerRef = ref(null)
const canvasRef = ref(null)
const renderer = shallowRef(null)

const viewport = useViewportStore()
const cursor = useCursorStore()
const cap = useCapture()
const stream = useStream()

useWaveformInput(canvasRef, renderer)

const activeChannels = computed(() => {
  if (stream.isStreaming || stream.streamChannels.length > 0) return stream.streamChannels
  return cap.capturedChannels
})

const visibleChannelCount = computed(() => {
  return activeChannels.value.filter((ch) => !ch.hidden).length
})

const minCanvasHeight = computed(() => {
  return visibleChannelCount.value * MIN_CHANNEL_HEIGHT
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

function mapBursts(bursts) {
  if (!bursts) return []
  return bursts.map((b) => ({ sampleIndex: b.burstSampleStart }))
}

function mapRegions(regions) {
  if (!regions) return []
  return regions.map((r) => ({
    firstSample: r.firstSample,
    lastSample: r.lastSample,
    regionColor: r.regionColor
      ? `rgba(${r.regionColor.r},${r.regionColor.g},${r.regionColor.b},${r.regionColor.a / 255})`
      : null,
  }))
}

let resizeObserver = null
let rafId = null

function scheduleRender() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (renderer.value) {
      renderer.value.resize()
      renderer.value.render()
      emit('channel-height-update', renderer.value.channelHeight)
      viewport.setCanvasWidth(renderer.value._width)
    }
  })
}

onMounted(() => {
  renderer.value = new WaveformRenderer(canvasRef.value)
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
  renderer.value.setViewport(viewport.firstSample, viewport.visibleSamples)
  // Skip capture-specific markers when showing stream data
  if (stream.isStreaming || stream.streamChannels.length > 0) {
    renderer.value.setPreTriggerSamples(0)
    renderer.value.setBursts([])
    renderer.value.setRegions(
      stream.lossRegions.map((r) => ({
        firstSample: r.firstSample,
        lastSample: r.lastSample,
        regionColor: COLORS.dataLossFill,
      })),
    )
  } else {
    renderer.value.setPreTriggerSamples(cap.preTriggerSamples)
    renderer.value.setBursts(mapBursts(cap.bursts))
    renderer.value.setRegions(mapRegions(cap.regions))
  }
  renderer.value.setCursorX(cursor.cursorX)
  renderer.value.resize()
  renderer.value.render()
  emit('channel-height-update', renderer.value.channelHeight)
  viewport.setCanvasWidth(renderer.value._width)
})

defineExpose({ renderer })
</script>

<style scoped>
.waveform-canvas-container {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
}

.waveform-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>

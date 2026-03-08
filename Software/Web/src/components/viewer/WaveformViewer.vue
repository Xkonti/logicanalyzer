<template>
  <div class="waveform-viewer" :class="{ 'with-led-strip': preview.isPreviewing }">
    <div class="wv-corner" />
    <TimelineRuler class="wv-timeline" />

    <PreviewLedStrip v-if="preview.isPreviewing" class="wv-led-strip" />

    <div class="wv-channels">
      <ChannelLabels class="wv-labels" :channel-height="channelHeight" />
      <WaveformCanvas class="wv-canvas" @channel-height-update="channelHeight = $event" />
    </div>

    <div class="wv-controls">
      <q-btn
        flat
        dense
        round
        size="sm"
        icon="zoom_out"
        color="grey-4"
        :disable="!viewport.canZoomOut"
        @click="viewport.zoomOut()"
      />
      <q-slider
        :model-value="scrollPosition"
        :min="0"
        :max="scrollMax"
        :step="scrollStep"
        dense
        color="grey-6"
        class="col"
        @update:model-value="onScrollChange"
      />
      <q-btn
        flat
        dense
        round
        size="sm"
        icon="zoom_in"
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
        @click="viewport.fitAll()"
      />
      <q-btn
        v-if="preview.isPreviewing"
        flat
        dense
        round
        size="sm"
        :icon="preview.following ? 'gps_fixed' : 'gps_not_fixed'"
        :color="preview.following ? 'positive' : 'grey-4'"
        title="Follow latest data"
        @click="preview.following = !preview.following"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useViewportStore } from 'src/stores/viewport.js'
import { useCapture } from 'src/composables/useCapture.js'
import { usePreview } from 'src/composables/usePreview.js'
import { MIN_CHANNEL_HEIGHT } from 'src/core/renderer/waveform-renderer.js'
import TimelineRuler from './TimelineRuler.vue'
import ChannelLabels from './ChannelLabels.vue'
import WaveformCanvas from './WaveformCanvas.vue'
import PreviewLedStrip from 'src/components/preview/PreviewLedStrip.vue'

const viewport = useViewportStore()
const cap = useCapture()
const preview = usePreview()

const channelHeight = ref(MIN_CHANNEL_HEIGHT)

const scrollPosition = computed(() => viewport.firstSample)
const scrollMax = computed(() => Math.max(0, viewport.totalSamples - viewport.visibleSamples))
const scrollStep = computed(() => Math.max(1, Math.floor(viewport.visibleSamples * 0.01)))

function onScrollChange(val) {
  if (preview.isPreviewing) preview.following = false
  viewport.setView(val, viewport.visibleSamples)
}

watch(
  () => cap.hasCapture,
  (has) => {
    if (has) viewport.fitAll()
  },
)
</script>

<style scoped>
.waveform-viewer {
  display: grid;
  grid-template-columns: 160px 1fr;
  grid-template-rows: 32px 1fr auto;
  height: 100%;
  overflow: hidden;
  background: rgb(28, 28, 28);
}

.waveform-viewer.with-led-strip {
  grid-template-rows: 32px auto 1fr auto;
}

.wv-corner {
  grid-area: 1 / 1;
  background: rgb(28, 28, 28);
  border-right: 1px solid rgb(60, 60, 60);
  border-bottom: 1px solid rgb(60, 60, 60);
}

.wv-timeline {
  grid-area: 1 / 2;
  border-bottom: 1px solid rgb(60, 60, 60);
}

.wv-led-strip {
  grid-column: 1 / -1;
  grid-row: 2;
}

.wv-channels {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 160px 1fr;
  overflow-y: auto;
  overflow-x: hidden;
}

.waveform-viewer:not(.with-led-strip) .wv-channels {
  grid-row: 2;
}

.waveform-viewer.with-led-strip .wv-channels {
  grid-row: 3;
}

.wv-labels {
  grid-column: 1;
}

.wv-canvas {
  grid-column: 2;
}

.wv-controls {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgb(32, 32, 32);
  border-top: 1px solid rgb(60, 60, 60);
}
</style>

<template>
  <div class="waveform-viewer">
    <div class="wv-corner" />
    <TimelineRuler class="wv-timeline" />

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
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useViewportStore } from 'src/stores/viewport.js'
import { useCapture } from 'src/composables/useCapture.js'
import { useStream } from 'src/composables/useStream.js'
import { MIN_CHANNEL_HEIGHT } from 'src/core/renderer/waveform-renderer.js'
import TimelineRuler from './TimelineRuler.vue'
import ChannelLabels from './ChannelLabels.vue'
import WaveformCanvas from './WaveformCanvas.vue'
const viewport = useViewportStore()
const cap = useCapture()
const stream = useStream()

const channelHeight = ref(MIN_CHANNEL_HEIGHT)

const scrollPosition = computed(() => viewport.firstSample)
const scrollMax = computed(() => Math.max(0, viewport.totalSamples - viewport.visibleSamples))
const scrollStep = computed(() => Math.max(1, Math.floor(viewport.visibleSamples * 0.01)))

function onScrollChange(val) {
  if (stream.isStreaming) stream.following = false
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

.wv-channels {
  grid-column: 1 / -1;
  grid-row: 2;
  display: grid;
  grid-template-columns: 160px 1fr;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
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

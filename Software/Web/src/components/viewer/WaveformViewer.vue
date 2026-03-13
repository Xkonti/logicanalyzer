<template>
  <div class="waveform-viewer">
    <MinimapBar class="wv-minimap" />

    <div class="wv-corner" />
    <TimelineRuler class="wv-timeline" />

    <div class="wv-channels">
      <ChannelLabels class="wv-labels" :channel-height="channelHeight" />
      <WaveformCanvas class="wv-canvas" @channel-height-update="channelHeight = $event" />
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useViewportStore } from 'src/stores/viewport.js'
import { useCapture } from 'src/composables/useCapture.js'
import { MIN_CHANNEL_HEIGHT } from 'src/core/renderer/waveform-renderer.js'
import MinimapBar from './MinimapBar.vue'
import TimelineRuler from './TimelineRuler.vue'
import ChannelLabels from './ChannelLabels.vue'
import WaveformCanvas from './WaveformCanvas.vue'
const viewport = useViewportStore()
const cap = useCapture()

const channelHeight = ref(MIN_CHANNEL_HEIGHT)

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
  grid-template-rows: 32px 32px 1fr;
  height: 100%;
  overflow: hidden;
  background: rgb(28, 28, 28);
}

.wv-minimap {
  grid-column: 1 / -1;
  grid-row: 1;
}

.wv-corner {
  grid-area: 2 / 1;
  background: rgb(28, 28, 28);
  border-right: 1px solid rgb(60, 60, 60);
  border-bottom: 1px solid rgb(60, 60, 60);
}

.wv-timeline {
  grid-area: 2 / 2;
  border-bottom: 1px solid rgb(60, 60, 60);
}

.wv-channels {
  grid-column: 1 / -1;
  grid-row: 3;
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
</style>

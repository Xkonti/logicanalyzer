<template>
  <div class="preview-led-strip">
    <div
      v-for="channel in channels"
      :key="channel.channelNumber"
      class="led-item"
    >
      <div
        class="led-dot"
        :style="{ backgroundColor: getState(channel) ? '#00c800' : '#505050' }"
      />
      <span class="led-label text-caption">
        {{ channel.channelName || `Ch ${channel.channelNumber}` }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { usePreview } from 'src/composables/usePreview.js'

const preview = usePreview()

const channels = computed(() => preview.previewChannels)

function getState(channel) {
  if (!channel.samples || channel.samples.length === 0) return false
  return channel.samples[channel.samples.length - 1] === 1
}
</script>

<style scoped>
.preview-led-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  background: rgb(32, 32, 32);
  border-bottom: 1px solid rgb(60, 60, 60);
  overflow-x: auto;
  min-height: 30px;
}

.led-item {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.led-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
  transition: background-color 0.1s;
}

.led-label {
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
  font-size: 11px;
}
</style>

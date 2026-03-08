<template>
  <div class="channel-labels">
    <div
      v-for="channel in cap.capturedChannels"
      :key="channel.channelNumber"
      class="channel-label-row"
      :class="{ 'channel-hidden': channel.hidden }"
      :style="{ height: channelHeight + 'px' }"
    >
      <div class="channel-color-dot" :style="{ backgroundColor: cap.getChannelColor(channel.channelNumber) }" />
      <span class="channel-name text-caption">
        {{ channel.channelName || `Ch ${channel.channelNumber}` }}
      </span>
      <q-space />
      <q-btn
        flat
        dense
        round
        size="xs"
        :icon="channel.hidden ? 'visibility_off' : 'visibility'"
        :color="channel.hidden ? 'grey-7' : 'grey-4'"
        @click="cap.toggleChannelVisibility(channel.channelNumber)"
      />
    </div>
  </div>
</template>

<script setup>
import { useCapture } from 'src/composables/useCapture.js'

defineProps({
  channelHeight: {
    type: Number,
    required: true,
  },
})

const cap = useCapture()
</script>

<style scoped>
.channel-labels {
  background: rgb(28, 28, 28);
  border-right: 1px solid rgb(60, 60, 60);
}

.channel-label-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-bottom: 1px solid rgb(40, 40, 40);
}

.channel-label-row:nth-child(odd) {
  background: rgb(36, 36, 36);
}

.channel-label-row:nth-child(even) {
  background: rgb(28, 28, 28);
}

.channel-hidden {
  opacity: 0.4;
}

.channel-color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.channel-name {
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

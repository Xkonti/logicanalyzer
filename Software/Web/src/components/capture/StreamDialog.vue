<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 600px; max-width: 700px" class="bg-dark text-white">
      <q-card-section>
        <div class="text-h6">Realtime View</div>
      </q-card-section>

      <q-card-section class="q-pt-none scroll" style="max-height: 60vh">
        <div class="column q-gutter-y-md">
          <q-input
            v-model.number="localFrequency"
            label="Sampling Frequency (Hz)"
            type="number"
            :min="3000"
            :max="10000000"
            dense
            outlined
            dark
            :hint="frequencyHint"
          />

          <q-select
            v-model="localChunkSize"
            :options="chunkSizeOptions"
            label="Chunk Size (samples)"
            dense
            outlined
            dark
            emit-value
            map-options
            :hint="chunkSizeHint"
          />

          <q-input
            v-model.number="localMaxSamples"
            label="Max Display Samples"
            type="number"
            :min="1000"
            :max="500000"
            dense
            outlined
            dark
          />
        </div>

        <q-separator class="q-my-md" />

        <div class="text-subtitle2 q-mb-xs">Channels</div>
        <div v-if="channelConfig.selectedChannels.length > 0" class="text-caption text-grey q-mb-xs">
          {{ channelConfig.selectedChannels.length }} selected
        </div>

        <ChannelSelector
          :available-count="cap.channelCount || 24"
          :selected-channels="channelConfig.selectedChannels"
          :channel-names="channelConfig.channelNames"
          @toggle="channelConfig.toggleChannel($event)"
          @select-range="(start, end, enabled) => channelConfig.selectRange(start, end, enabled)"
          @update:name="(ch, name) => channelConfig.setName(ch, name)"
        />

        <q-banner v-if="!hasChannels" dense class="bg-negative text-white q-mt-sm">
          No channels selected. Select at least one channel above.
        </q-banner>

        <q-banner
          v-if="hasChannels && isOverRecommended"
          dense
          class="bg-warning text-white q-mt-sm"
          rounded
        >
          Frequency exceeds recommended {{ formatFreq(recommendedLimit) }}
          for {{ channelConfig.selectedChannels.length }}ch — data dropouts may occur.
        </q-banner>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" color="grey-4" no-caps v-close-popup />
        <q-btn
          flat
          label="Start Realtime"
          color="positive"
          no-caps
          :disable="!hasChannels || !isValid"
          @click="onStart"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useStream } from 'src/composables/useStream.js'
import { useCapture } from 'src/composables/useCapture.js'
import { useChannelConfigStore } from 'src/stores/channel-config.js'
import { STREAM_RATE_LIMITS } from 'src/stores/stream.js'
import ChannelSelector from 'src/components/shared/ChannelSelector.vue'

const CHUNK_SIZES = [32, 64, 128, 256, 512, 1024]
const TARGET_FPS = 5

defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const stream = useStream()
const cap = useCapture()
const channelConfig = useChannelConfigStore()

const localFrequency = ref(stream.streamFrequency)
const localChunkSize = ref(stream.streamChunkSize)
const localMaxSamples = ref(stream.maxDisplaySamples)

const hasChannels = computed(() => channelConfig.selectedChannels.length > 0)

const isValid = computed(() => {
  return localFrequency.value >= 3000 && localMaxSamples.value >= 1000
})

const chunkSizeOptions = CHUNK_SIZES.map((size) => ({
  label: `${size} samples`,
  value: size,
}))

const recommendedChunkSize = computed(() => {
  const freq = localFrequency.value
  if (freq < 3000) return 32
  const maxChunk = Math.floor(freq / TARGET_FPS)
  // Find largest valid chunk size <= maxChunk
  for (let i = CHUNK_SIZES.length - 1; i >= 0; i--) {
    if (CHUNK_SIZES[i] <= maxChunk) return CHUNK_SIZES[i]
  }
  return 32
})

const chunkSizeHint = computed(() => {
  const freq = localFrequency.value
  if (freq < 3000) return ''
  const fps = (freq / localChunkSize.value).toFixed(1)
  return `~${fps} updates/sec (recommended: ${recommendedChunkSize.value} for ≥${TARGET_FPS} fps)`
})

const recommendedLimit = computed(() => {
  const count = channelConfig.selectedChannels.length
  return STREAM_RATE_LIMITS[count] ?? STREAM_RATE_LIMITS[24]
})

const isOverRecommended = computed(() => {
  return localFrequency.value > recommendedLimit.value
})

const frequencyHint = computed(() => {
  const freq = localFrequency.value
  if (freq < 3000) return 'Minimum: 3,000 Hz (PIO hardware limit)'
  return `Recommended max: ${formatFreq(recommendedLimit.value)} for ${channelConfig.selectedChannels.length}ch`
})

function formatFreq(hz) {
  if (hz >= 1000000) return `${(hz / 1000000).toFixed(1)} MHz`
  if (hz >= 1000) return `${(hz / 1000).toFixed(0)} kHz`
  return `${hz} Hz`
}

function onStart() {
  stream.streamFrequency = localFrequency.value
  stream.streamChunkSize = localChunkSize.value
  stream.maxDisplaySamples = localMaxSamples.value
  stream.startStream()
  emit('update:modelValue', false)
}
</script>

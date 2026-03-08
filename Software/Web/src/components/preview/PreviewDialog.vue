<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 600px; max-width: 700px" class="bg-dark text-white">
      <q-card-section>
        <div class="text-h6">Realtime Preview</div>
      </q-card-section>

      <q-card-section class="q-pt-none scroll" style="max-height: 60vh">
        <div class="column q-gutter-y-md">
          <q-input
            v-model.number="localFrequency"
            label="Probing Frequency (Hz)"
            type="number"
            :min="1"
            :max="960"
            dense
            outlined
            dark
            :hint="frequencyHint"
          />

          <q-input
            v-model.number="localMaxSamples"
            label="Max Display Samples"
            type="number"
            :min="100"
            :max="100000"
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
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" color="grey-4" no-caps v-close-popup />
        <q-btn
          flat
          label="Start Preview"
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
import { usePreview } from 'src/composables/usePreview.js'
import { useCapture } from 'src/composables/useCapture.js'
import { useChannelConfigStore } from 'src/stores/channel-config.js'
import ChannelSelector from 'src/components/shared/ChannelSelector.vue'

defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'start'])

const preview = usePreview()
const cap = useCapture()
const channelConfig = useChannelConfigStore()

const localFrequency = ref(preview.probingFrequency)
const localMaxSamples = ref(preview.maxDisplaySamples)

const hasChannels = computed(() => channelConfig.selectedChannels.length > 0)

const isValid = computed(() => {
  return localFrequency.value >= 1 && localFrequency.value <= 960 && localMaxSamples.value >= 100
})

const frequencyHint = computed(() => {
  const freq = localFrequency.value
  if (freq < 1) return ''
  let intervalsPerSecond = Math.min(60, freq)
  let samplesPerInterval = Math.max(1, Math.min(16, Math.ceil(freq / intervalsPerSecond)))
  while (intervalsPerSecond * samplesPerInterval < freq && intervalsPerSecond < 60) {
    intervalsPerSecond++
  }
  const effective = intervalsPerSecond * samplesPerInterval
  return `${intervalsPerSecond} intervals/s x ${samplesPerInterval} samples = ${effective} samples/s`
})

function onStart() {
  preview.probingFrequency = localFrequency.value
  preview.maxDisplaySamples = localMaxSamples.value
  emit('start')
  emit('update:modelValue', false)
}
</script>

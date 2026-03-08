<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 360px" class="bg-dark text-white">
      <q-card-section>
        <div class="text-h6">Realtime Preview</div>
      </q-card-section>

      <q-card-section class="q-pt-none column q-gutter-y-md">
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

        <div class="text-caption text-grey-5">
          Channels: {{ channelSummary }}
        </div>

        <q-banner v-if="!hasChannels" dense class="bg-negative text-white">
          No channels selected. Configure channels in the capture panel first.
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

defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'start'])

const preview = usePreview()
const cap = useCapture()

const localFrequency = ref(preview.probingFrequency)
const localMaxSamples = ref(preview.maxDisplaySamples)

const hasChannels = computed(() => cap.channels.length > 0)

const isValid = computed(() => {
  return localFrequency.value >= 1 && localFrequency.value <= 960 && localMaxSamples.value >= 100
})

const channelSummary = computed(() => {
  const channels = cap.channels
  if (channels.length === 0) return 'None'
  const nums = channels.map((ch) => ch.channelNumber)
  return `${channels.length} channels (${nums.join(', ')})`
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

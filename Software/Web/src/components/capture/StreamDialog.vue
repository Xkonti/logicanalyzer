<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 400px">
      <q-card-section>
        <div class="text-h6">Stream Capture</div>
      </q-card-section>

      <q-card-section>
        <q-input
          v-model.number="stream.streamFrequency"
          label="Sampling Frequency (Hz)"
          type="number"
          :min="1000"
          :max="10000000"
          outlined
          dense
        >
          <template #append>
            <q-badge :color="stream.isOverRecommended ? 'warning' : 'positive'" text-color="white">
              {{ formatFreq(stream.streamFrequency) }}
            </q-badge>
          </template>
        </q-input>

        <div class="q-mt-sm text-caption">
          Recommended max: {{ formatFreq(stream.recommendedFrequency) }}
          for {{ channelCount }} channel{{ channelCount !== 1 ? 's' : '' }}
        </div>

        <q-banner v-if="stream.isOverRecommended" class="q-mt-sm bg-warning text-white" dense rounded>
          Frequency exceeds recommended limit. Data dropouts may occur.
        </q-banner>

        <q-input
          v-model.number="stream.maxDisplaySamples"
          label="Max Display Samples"
          type="number"
          :min="1000"
          :max="500000"
          outlined
          dense
          class="q-mt-md"
        />
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" v-close-popup />
        <q-btn
          color="primary"
          label="Start Stream"
          :disable="!stream.canStartStream"
          @click="onStart"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useStream } from 'src/composables/useStream.js'
import { useCaptureStore } from 'src/stores/capture.js'

defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])

const stream = useStream()
const capture = useCaptureStore()

const channelCount = computed(() => capture.channels.length)

function formatFreq(hz) {
  if (hz >= 1000000) return `${(hz / 1000000).toFixed(1)} MHz`
  if (hz >= 1000) return `${(hz / 1000).toFixed(0)} kHz`
  return `${hz} Hz`
}

function onStart() {
  stream.startStream()
  emit('update:modelValue', false)
}
</script>

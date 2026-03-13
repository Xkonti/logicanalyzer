<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 600px; max-width: 700px" class="bg-dark text-white">
      <q-card-section>
        <div class="text-h6">Capture Settings</div>
      </q-card-section>

      <q-card-section class="q-pt-none scroll" style="max-height: 60vh">
        <!-- Sampling -->
        <div class="text-subtitle2 q-mb-sm">Sampling</div>
        <div class="column q-gutter-y-sm">
          <q-input
            v-model.number="cap.frequency"
            type="number"
            label="Frequency (Hz)"
            :disable="cap.isBlastMode"
            :hint="frequencyHint"
            dense
            outlined
            dark
          />
          <q-input
            v-model.number="cap.preTriggerSamples"
            type="number"
            label="Pre-trigger Samples"
            :disable="cap.isBlastMode"
            :hint="preSamplesHint"
            dense
            outlined
            dark
          />
          <q-input
            v-model.number="cap.postTriggerSamples"
            type="number"
            label="Post-trigger Samples"
            :hint="postSamplesHint"
            dense
            outlined
            dark
          />
        </div>

        <div v-if="cap.channels.length > 0" class="q-mt-sm">
          <span class="text-caption text-grey">
            Max total: {{ cap.currentLimits?.maxTotalSamples?.toLocaleString() ?? '---' }}
          </span>
        </div>

        <q-separator class="q-my-md" />

        <!-- Trigger -->
        <div class="text-subtitle2 q-mb-sm">Trigger</div>
        <TriggerConfig />

        <q-separator class="q-my-md" />

        <!-- Channels -->
        <div class="text-subtitle2 q-mb-xs">Channels</div>
        <div v-if="cap.channels.length > 0" class="row items-center q-gutter-x-sm q-mb-xs">
          <q-badge outline color="primary" :label="cap.captureModeLabel" />
          <span class="text-caption text-grey">
            {{ cap.channels.length }} selected
          </span>
        </div>

        <ChannelSelector
          :available-count="cap.channelCount || 24"
          :selected-channels="channelConfig.selectedChannels"
          :channel-names="channelConfig.channelNames"
          @toggle="channelConfig.toggleChannel($event)"
          @select-range="(start, end, enabled) => channelConfig.selectRange(start, end, enabled)"
          @update:name="(ch, name) => channelConfig.setName(ch, name)"
        />

        <!-- Validation warning -->
        <q-banner
          v-if="!cap.settingsValid && cap.channels.length > 0"
          dense
          class="bg-negative text-white rounded-borders q-mt-md"
        >
          <template v-slot:avatar>
            <q-icon name="error" />
          </template>
          Settings invalid. Check frequency and sample limits.
        </q-banner>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancel" color="grey-4" no-caps v-close-popup />
        <q-btn
          flat
          label="Start Capture"
          color="positive"
          no-caps
          :disable="!cap.canCapture"
          @click="onStart"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useCapture } from 'src/composables/useCapture.js'
import { useChannelConfigStore } from 'src/stores/channel-config.js'
import ChannelSelector from 'src/components/shared/ChannelSelector.vue'
import TriggerConfig from './TriggerConfig.vue'

defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const cap = useCapture()
const channelConfig = useChannelConfigStore()

const frequencyHint = computed(() => {
  if (!cap.isConnected) return ''
  if (cap.isBlastMode) return `Locked to ${cap.blastFrequency.toLocaleString()} Hz`
  return `Range: ${cap.minFrequency.toLocaleString()} – ${cap.maxFrequency.toLocaleString()} Hz`
})

const preSamplesHint = computed(() => {
  if (!cap.currentLimits) return ''
  if (cap.isBlastMode) return 'Forced to 0 in blast mode'
  return `Range: ${cap.currentLimits.minPreSamples.toLocaleString()} – ${cap.currentLimits.maxPreSamples.toLocaleString()}`
})

const postSamplesHint = computed(() => {
  if (!cap.currentLimits) return ''
  return `Range: ${cap.currentLimits.minPostSamples.toLocaleString()} – ${cap.currentLimits.maxPostSamples.toLocaleString()}`
})

function onStart() {
  cap.startCapture()
  emit('update:modelValue', false)
}
</script>

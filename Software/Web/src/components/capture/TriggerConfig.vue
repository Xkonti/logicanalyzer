<template>
  <div>
    <!-- Trigger type: Edge vs Pattern -->
    <q-btn-toggle
      :model-value="triggerCategory"
      :options="[
        { label: 'Edge', value: 'edge' },
        { label: 'Pattern', value: 'pattern' },
      ]"
      no-caps
      dense
      spread
      toggle-color="primary"
      class="q-mb-sm"
      @update:model-value="onCategoryChange"
    />

    <!-- EDGE / BLAST mode -->
    <template v-if="triggerCategory === 'edge'">
      <div class="text-caption text-grey q-mb-xs">Trigger Channel</div>
      <div class="row wrap q-gutter-xs q-mb-sm">
        <q-btn
          v-for="ch in availableTriggerChannels"
          :key="ch"
          :label="String(ch + 1)"
          :color="cap.triggerChannel === ch ? 'primary' : 'grey-8'"
          dense
          outline
          @click="cap.triggerChannel = ch"
        />
      </div>

      <q-checkbox v-model="cap.triggerInverted" label="Negative edge" dense class="q-mb-xs" />

      <q-checkbox v-model="blastMode" label="Blast mode" dense class="q-mb-xs" />

      <q-checkbox
        v-model="burstEnabled"
        label="Burst mode"
        :disable="cap.isBlastMode"
        dense
        class="q-mb-xs"
      />

      <template v-if="burstEnabled">
        <q-input
          v-model.number="burstCount"
          type="number"
          label="Burst count"
          :min="2"
          :max="65534"
          dense
          outlined
          class="q-ml-lg q-mt-xs q-mb-xs"
        />
        <q-checkbox
          v-model="cap.measureBursts"
          label="Measure delays"
          :disable="burstCount > 254"
          dense
          class="q-ml-lg"
        />
      </template>
    </template>

    <!-- PATTERN mode (Complex / Fast) -->
    <template v-if="triggerCategory === 'pattern'">
      <q-input
        v-model.number="patternBase"
        type="number"
        label="First channel (1-based)"
        :min="1"
        :max="16"
        dense
        outlined
        class="q-mb-sm"
      />

      <q-input
        v-model="patternString"
        label="Pattern (binary)"
        :maxlength="cap.isFastPattern ? 5 : 16"
        :rules="[patternRule]"
        dense
        outlined
        class="q-mb-sm"
      />

      <q-checkbox v-model="fastPattern" label="Fast pattern (max 5 bits)" dense />
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useCapture } from 'src/composables/useCapture.js'
import { useChannelConfigStore } from 'src/stores/channel-config.js'
import { TRIGGER_EDGE, TRIGGER_COMPLEX, TRIGGER_FAST, TRIGGER_BLAST } from 'src/core/protocol/commands.js'

const cap = useCapture()
const channelConfig = useChannelConfigStore()

const lastBurstCount = ref(2)

const triggerCategory = computed(() => {
  if (cap.triggerType === TRIGGER_COMPLEX || cap.triggerType === TRIGGER_FAST) return 'pattern'
  return 'edge'
})

function onCategoryChange(val) {
  if (val === 'pattern') {
    cap.triggerType = TRIGGER_COMPLEX
  } else {
    cap.triggerType = TRIGGER_EDGE
  }
}

const availableTriggerChannels = computed(() =>
  [...channelConfig.selectedChannels].sort((a, b) => a - b),
)

// Blast mode computed get/set
const blastMode = computed({
  get: () => cap.triggerType === TRIGGER_BLAST,
  set: (val) => {
    if (val) {
      cap.triggerType = TRIGGER_BLAST
      if (cap.blastFrequency) cap.frequency = cap.blastFrequency
      cap.preTriggerSamples = 0
      cap.loopCount = 0
      cap.measureBursts = false
    } else {
      cap.triggerType = TRIGGER_EDGE
    }
  },
})

// Burst mode
const burstEnabled = computed({
  get: () => cap.loopCount > 0,
  set: (val) => {
    if (val) {
      cap.loopCount = lastBurstCount.value - 1
    } else {
      lastBurstCount.value = cap.loopCount + 1
      cap.loopCount = 0
      cap.measureBursts = false
    }
  },
})

const burstCount = computed({
  get: () => cap.loopCount + 1,
  set: (val) => {
    const clamped = Math.max(2, Math.min(65534, val || 2))
    cap.loopCount = clamped - 1
    lastBurstCount.value = clamped
  },
})

// Fast pattern toggle
const fastPattern = computed({
  get: () => cap.triggerType === TRIGGER_FAST,
  set: (val) => {
    cap.triggerType = val ? TRIGGER_FAST : TRIGGER_COMPLEX
  },
})

// Pattern base channel (1-based display)
const patternBase = computed({
  get: () => cap.triggerChannel + 1,
  set: (val) => {
    cap.triggerChannel = Math.max(0, Math.min(15, (val || 1) - 1))
  },
})

// Pattern string <-> integer conversion (LSB-first, matching C# CaptureDialog)
const patternString = computed({
  get: () => {
    let str = ''
    for (let i = 0; i < cap.triggerBitCount; i++) {
      str += (cap.triggerPattern >> i) & 1 ? '1' : '0'
    }
    return str || '0'
  },
  set: (val) => {
    const clean = (val || '').replace(/[^01]/g, '')
    if (clean.length === 0) return
    let pattern = 0
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '1') pattern |= 1 << i
    }
    cap.triggerBitCount = clean.length
    cap.triggerPattern = pattern
  },
})

function patternRule(val) {
  return /^[01]+$/.test(val) || 'Only 0 and 1 allowed'
}
</script>

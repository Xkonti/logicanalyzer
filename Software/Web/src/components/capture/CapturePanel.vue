<template>
  <q-scroll-area style="height: calc(100vh - 50px)">
    <q-list padding>
      <!-- Capture Settings -->
      <q-item-label header>Capture Settings</q-item-label>

      <q-item dense>
        <q-item-section>
          <q-input
            v-model.number="cap.frequency"
            type="number"
            label="Frequency (Hz)"
            :disable="cap.isBlastMode"
            :hint="frequencyHint"
            dense
            outlined
          />
        </q-item-section>
      </q-item>

      <q-item dense>
        <q-item-section>
          <q-input
            v-model.number="cap.preTriggerSamples"
            type="number"
            label="Pre-trigger Samples"
            :disable="cap.isBlastMode"
            :hint="preSamplesHint"
            dense
            outlined
          />
        </q-item-section>
      </q-item>

      <q-item dense>
        <q-item-section>
          <q-input
            v-model.number="cap.postTriggerSamples"
            type="number"
            label="Post-trigger Samples"
            :hint="postSamplesHint"
            dense
            outlined
          />
        </q-item-section>
      </q-item>

      <q-item v-if="cap.channels.length > 0" dense>
        <q-item-section>
          <div class="row items-center q-gutter-x-sm">
            <q-badge outline color="primary" :label="cap.captureModeLabel" />
            <span class="text-caption text-grey">
              Max total: {{ cap.currentLimits?.maxTotalSamples?.toLocaleString() ?? '---' }}
            </span>
          </div>
        </q-item-section>
      </q-item>

      <q-separator class="q-my-sm" />

      <!-- Channels -->
      <q-item-label header>
        Channels
        <q-badge v-if="cap.channels.length > 0" color="primary" class="q-ml-sm">
          {{ cap.channels.length }}
        </q-badge>
      </q-item-label>

      <template v-for="group in channelGroups" :key="group.start">
        <q-item dense>
          <q-item-section>
            <div class="text-caption text-grey">
              {{ group.start + 1 }}&ndash;{{ group.end + 1 }}
            </div>
          </q-item-section>
          <q-item-section side>
            <div class="row q-gutter-x-xs">
              <q-btn
                flat
                dense
                size="xs"
                label="All"
                @click="selectRange(group.start, group.end, true)"
              />
              <q-btn
                flat
                dense
                size="xs"
                label="None"
                @click="selectRange(group.start, group.end, false)"
              />
            </div>
          </q-item-section>
        </q-item>

        <q-item
          v-for="ch in group.channels"
          :key="ch"
          dense
          clickable
          @click="cap.toggleChannel(ch, channelNames[ch])"
        >
          <q-item-section avatar style="min-width: 36px">
            <q-checkbox :model-value="isSelected(ch)" dense @click.stop @update:model-value="cap.toggleChannel(ch, channelNames[ch])" />
          </q-item-section>
          <q-item-section avatar style="min-width: 24px">
            <div
              class="rounded-borders"
              :style="{ backgroundColor: cap.getChannelColor(ch), width: '14px', height: '14px' }"
            />
          </q-item-section>
          <q-item-section side style="min-width: 24px">
            <span class="text-caption">{{ ch + 1 }}</span>
          </q-item-section>
          <q-item-section>
            <q-input
              v-model="channelNames[ch]"
              dense
              borderless
              placeholder="Name"
              input-class="text-caption"
              @click.stop
            />
          </q-item-section>
        </q-item>
      </template>

      <q-separator class="q-my-sm" />

      <!-- Trigger -->
      <q-item-label header>Trigger</q-item-label>
      <q-item dense>
        <q-item-section>
          <TriggerConfig />
        </q-item-section>
      </q-item>

      <!-- Validation warning -->
      <q-item v-if="!cap.settingsValid && cap.channels.length > 0" dense>
        <q-item-section>
          <q-banner dense class="bg-negative text-white rounded-borders">
            <template v-slot:avatar>
              <q-icon name="error" />
            </template>
            Settings invalid. Check frequency and sample limits.
          </q-banner>
        </q-item-section>
      </q-item>
    </q-list>
  </q-scroll-area>
</template>

<script setup>
import { reactive, computed, watch } from 'vue'
import { useCapture } from 'src/composables/useCapture.js'
import { useSettingsStore } from 'src/stores/settings.js'
import TriggerConfig from './TriggerConfig.vue'

const cap = useCapture()
const settings = useSettingsStore()

// Channel names — local reactive array synced from settings store
const channelNames = reactive([...settings.defaultChannelNames])

// Sync name changes back to settings
watch(channelNames, (names) => {
  settings.defaultChannelNames = [...names]
})

// Channel groups — rows of 8, filtered to available channels
const maxChannels = computed(() => cap.channelCount || 24)
const channelGroups = computed(() => {
  const groups = []
  for (let start = 0; start < maxChannels.value; start += 8) {
    const end = Math.min(start + 7, maxChannels.value - 1)
    const channels = []
    for (let i = start; i <= end; i++) channels.push(i)
    groups.push({ start, end, channels })
  }
  return groups
})

function isSelected(num) {
  return cap.channels.some((ch) => ch.channelNumber === num)
}

function selectRange(start, end, enabled) {
  for (let i = start; i <= end; i++) {
    const exists = isSelected(i)
    if (enabled && !exists) cap.addChannel(i, channelNames[i])
    if (!enabled && exists) cap.removeChannel(i)
  }
}

// Limits hints
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
</script>

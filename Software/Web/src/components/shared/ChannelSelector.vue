<template>
  <div>
    <template v-for="group in channelGroups" :key="group.start">
      <div class="row items-center q-mt-sm q-mb-xs">
        <span class="text-caption text-grey">{{ group.start + 1 }}&ndash;{{ group.end + 1 }}</span>
        <q-space />
        <q-btn
          flat
          dense
          label="All"
          no-caps
          @click="$emit('select-range', group.start, group.end, true)"
        />
        <q-btn
          flat
          dense
          label="None"
          no-caps
          @click="$emit('select-range', group.start, group.end, false)"
        />
      </div>

      <div class="row">
        <div v-for="ch in group.channels" :key="ch" class="col-3 q-pb-xs">
          <q-checkbox
            :model-value="selectedSet.has(ch)"
            :label="String(ch + 1)"
            dense
            @update:model-value="$emit('toggle', ch)"
          />
          <q-input
            :model-value="channelNames[ch] || ''"
            dense
            borderless
            placeholder="Label..."
            input-class="text-caption"
            class="q-pl-md"
            @update:model-value="$emit('update:name', ch, $event)"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  availableCount: {
    type: Number,
    default: 24,
  },
  selectedChannels: {
    type: Array,
    default: () => [],
  },
  channelNames: {
    type: Array,
    default: () => Array(24).fill(''),
  },
})

defineEmits(['toggle', 'select-range', 'update:name'])

const selectedSet = computed(() => new Set(props.selectedChannels))

const channelGroups = computed(() => {
  const groups = []
  for (let start = 0; start < props.availableCount; start += 8) {
    const end = Math.min(start + 7, props.availableCount - 1)
    const channels = []
    for (let i = start; i <= end; i++) channels.push(i)
    groups.push({ start, end, channels })
  }
  return groups
})
</script>

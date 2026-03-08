<template>
  <div class="row items-center no-wrap q-gutter-x-sm">
    <q-btn
      :icon="drawerOpen ? 'chevron_right' : 'tune'"
      flat
      dense
      round
      :disable="!cap.isConnected"
      title="Capture settings"
      @click="$emit('toggle-drawer')"
    />

    <q-btn
      v-if="!cap.isCapturing"
      color="positive"
      icon="play_arrow"
      label="Capture"
      :disable="!cap.canCapture"
      no-caps
      dense
      @click="cap.startCapture()"
    />

    <q-btn
      v-if="cap.isCapturing"
      color="negative"
      icon="stop"
      label="Stop"
      no-caps
      dense
      @click="cap.stopCapture()"
    />

    <q-btn
      v-if="cap.hasCapture && !cap.isCapturing"
      color="info"
      icon="replay"
      label="Repeat"
      :disable="!cap.canCapture"
      no-caps
      dense
      @click="cap.repeatCapture()"
    />

    <q-chip
      v-if="cap.captureError"
      color="negative"
      text-color="white"
      icon="error"
      dense
      removable
      @remove="cap.clearError()"
    >
      {{ cap.captureError }}
    </q-chip>
  </div>
</template>

<script setup>
import { useCapture } from 'src/composables/useCapture.js'

defineProps({
  drawerOpen: { type: Boolean, default: false },
})

defineEmits(['toggle-drawer'])

const cap = useCapture()
</script>

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

    <q-separator vertical inset class="q-mx-xs" dark />

    <q-btn
      v-if="!preview.isPreviewing"
      color="purple"
      icon="monitor_heart"
      label="Realtime"
      :disable="!preview.canStartPreview"
      no-caps
      dense
      @click="showPreviewDialog = true"
    />

    <q-btn
      v-if="preview.isPreviewing"
      color="negative"
      icon="stop"
      label="Stop Preview"
      no-caps
      dense
      @click="preview.stopPreview()"
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

    <q-chip
      v-if="preview.previewError"
      color="negative"
      text-color="white"
      icon="error"
      dense
      removable
      @remove="preview.clearError()"
    >
      {{ preview.previewError }}
    </q-chip>

    <PreviewDialog
      v-model="showPreviewDialog"
      @start="preview.startPreview()"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useCapture } from 'src/composables/useCapture.js'
import { usePreview } from 'src/composables/usePreview.js'
import PreviewDialog from 'src/components/preview/PreviewDialog.vue'

defineProps({
  drawerOpen: { type: Boolean, default: false },
})

defineEmits(['toggle-drawer'])

const cap = useCapture()
const preview = usePreview()
const showPreviewDialog = ref(false)
</script>

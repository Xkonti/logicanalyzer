<template>
  <div class="row items-center no-wrap q-gutter-x-sm">
    <q-btn
      v-if="!cap.isCapturing"
      color="positive"
      icon="play_arrow"
      label="Capture"
      :disable="!cap.isConnected || cap.isCapturing || stream.isStreaming"
      no-caps
      dense
      @click="showCaptureDialog = true"
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
      v-if="!stream.isStreaming"
      color="purple"
      icon="monitor_heart"
      label="Realtime"
      :disable="!stream.canStartStream"
      no-caps
      dense
      @click="showStreamDialog = true"
    />

    <q-btn
      v-if="stream.isStreaming"
      color="negative"
      icon="stop"
      label="Stop Realtime"
      no-caps
      dense
      @click="stream.stopStream()"
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
      v-if="stream.streamError"
      color="negative"
      text-color="white"
      icon="error"
      dense
      removable
      @remove="stream.clearError()"
    >
      {{ stream.streamError }}
    </q-chip>

    <q-chip
      v-if="stream.streamWarning"
      color="warning"
      text-color="white"
      icon="warning"
      dense
      removable
      @remove="stream.clearWarning()"
    >
      {{ stream.streamWarning }}
    </q-chip>

    <CaptureDialog v-model="showCaptureDialog" />

    <StreamDialog v-model="showStreamDialog" />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useCapture } from 'src/composables/useCapture.js'
import { useStream } from 'src/composables/useStream.js'
import CaptureDialog from 'src/components/capture/CaptureDialog.vue'
import StreamDialog from 'src/components/capture/StreamDialog.vue'

const cap = useCapture()
const stream = useStream()
const showCaptureDialog = ref(false)
const showStreamDialog = ref(false)
</script>

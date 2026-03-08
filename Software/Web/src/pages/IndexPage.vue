<template>
  <q-page class="column">
    <q-banner
      v-if="!device.isWebSerialAvailable"
      class="bg-warning text-dark"
      dense
      inline-actions
    >
      <template v-slot:avatar>
        <q-icon name="warning" />
      </template>
      Web Serial API is not available in this browser. Use Chrome or Edge to connect to the logic
      analyzer hardware.
    </q-banner>

    <div v-if="!cap.hasCapture" class="col column flex-center text-grey-6">
      <q-icon name="insights" size="64px" class="q-mb-md" />
      <div class="text-h6">No capture loaded</div>
      <div class="text-body2 q-mt-sm">
        Connect a device and start a capture, or open a .lac file
      </div>
    </div>

    <WaveformViewer v-else class="col" />
  </q-page>
</template>

<script setup>
import { useDevice } from 'src/composables/useDevice.js'
import { useCapture } from 'src/composables/useCapture.js'
import WaveformViewer from 'src/components/viewer/WaveformViewer.vue'

const device = useDevice()
const cap = useCapture()
</script>

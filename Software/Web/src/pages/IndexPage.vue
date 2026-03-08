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

    <div v-else class="col column flex-center">
      <q-card flat bordered class="q-pa-md" style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">
            <q-icon name="check_circle" color="positive" class="q-mr-sm" />
            Capture Complete
          </div>
        </q-card-section>
        <q-card-section>
          <q-list dense>
            <q-item>
              <q-item-section>Channels</q-item-section>
              <q-item-section side>{{ cap.capturedChannels.length }}</q-item-section>
            </q-item>
            <q-item>
              <q-item-section>Total Samples</q-item-section>
              <q-item-section side>{{ cap.totalSamples.toLocaleString() }}</q-item-section>
            </q-item>
            <q-item>
              <q-item-section>Frequency</q-item-section>
              <q-item-section side>{{ formatFrequency(cap.frequency) }}</q-item-section>
            </q-item>
            <q-item>
              <q-item-section>Capture Mode</q-item-section>
              <q-item-section side>
                <q-badge outline :label="cap.captureModeLabel" />
              </q-item-section>
            </q-item>
            <q-item v-if="cap.bursts">
              <q-item-section>Bursts</q-item-section>
              <q-item-section side>{{ cap.bursts.length }}</q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
        <q-card-actions align="center">
          <q-btn flat color="negative" label="Clear" icon="delete" no-caps @click="cap.clearCapture()" />
        </q-card-actions>
      </q-card>
    </div>
  </q-page>
</template>

<script setup>
import { useDevice } from 'src/composables/useDevice.js'
import { useCapture } from 'src/composables/useCapture.js'

const device = useDevice()
const cap = useCapture()

function formatFrequency(hz) {
  if (hz >= 1_000_000_000) return `${(hz / 1_000_000_000).toFixed(hz % 1_000_000_000 ? 1 : 0)} GHz`
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(hz % 1_000_000 ? 1 : 0)} MHz`
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(hz % 1_000 ? 1 : 0)} kHz`
  return `${hz} Hz`
}
</script>

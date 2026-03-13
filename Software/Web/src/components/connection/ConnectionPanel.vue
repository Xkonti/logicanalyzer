<template>
  <div class="connection-panel row items-center no-wrap q-gutter-x-sm">
    <q-chip
      v-if="!device.isWebSerialAvailable"
      color="warning"
      text-color="dark"
      icon="warning"
      dense
    >
      Web Serial unavailable
    </q-chip>

    <q-btn
      v-if="!device.isConnected"
      :loading="device.connecting"
      :disable="!device.isWebSerialAvailable"
      color="positive"
      label="Connect"
      icon="usb"
      no-caps
      dense
      @click="device.connect()"
    />

    <template v-else>
      <q-chip color="positive" text-color="white" icon="check_circle" clickable dense>
        {{ device.deviceVersion }}
        <q-menu anchor="bottom middle" self="top middle">
          <q-card flat bordered class="q-pa-sm">
            <q-list dense>
              <q-item>
                <q-item-section>Channels</q-item-section>
                <q-item-section side>{{ device.channelCount }}</q-item-section>
              </q-item>
              <q-item>
                <q-item-section>Max Frequency</q-item-section>
                <q-item-section side>{{ formatFrequency(device.maxFrequency) }}</q-item-section>
              </q-item>
              <q-item>
                <q-item-section>Buffer Size</q-item-section>
                <q-item-section side>{{ formatBytes(device.bufferSize) }}</q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </q-menu>
      </q-chip>

      <q-btn
        color="negative"
        label="Disconnect"
        icon="usb_off"
        no-caps
        dense
        @click="device.disconnect()"
      />
    </template>

    <q-chip
      v-if="device.error"
      color="negative"
      text-color="white"
      icon="error"
      removable
      dense
      @remove="device.clearError()"
    >
      {{ device.error }}
    </q-chip>
  </div>
</template>

<script setup>
import { useDevice } from 'src/composables/useDevice.js'

const device = useDevice()

function formatFrequency(hz) {
  if (hz >= 1_000_000_000) return `${(hz / 1_000_000_000).toFixed(hz % 1_000_000_000 ? 1 : 0)} GHz`
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(hz % 1_000_000 ? 1 : 0)} MHz`
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(hz % 1_000 ? 1 : 0)} kHz`
  return `${hz} Hz`
}

function formatBytes(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(bytes % 1_048_576 ? 1 : 0)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(bytes % 1_024 ? 1 : 0)} KB`
  return `${bytes} B`
}
</script>

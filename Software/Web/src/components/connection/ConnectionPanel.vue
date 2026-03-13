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
      <q-chip color="positive" text-color="white" icon="check_circle" dense>
        {{ device.deviceVersion }}
      </q-chip>

      <q-btn flat round dense icon="settings" color="grey-4" @click="showDeviceDialog = true">
        <q-tooltip>Device Info & Settings</q-tooltip>
      </q-btn>

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

    <DeviceInfoDialog v-model="showDeviceDialog" />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useDevice } from 'src/composables/useDevice.js'
import DeviceInfoDialog from './DeviceInfoDialog.vue'

const device = useDevice()
const showDeviceDialog = ref(false)
</script>

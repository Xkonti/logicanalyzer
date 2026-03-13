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

    <template v-if="!device.isConnected">
      <q-btn
        :loading="device.connecting"
        :disable="!device.isWebSerialAvailable"
        color="positive"
        label="USB"
        icon="usb"
        no-caps
        dense
        @click="device.connect()"
      >
        <q-tooltip>Connect via USB</q-tooltip>
      </q-btn>

      <q-btn
        :loading="device.connecting"
        color="positive"
        label="WiFi"
        icon="wifi"
        no-caps
        dense
        @click="showWiFiDialog = true"
      >
        <q-tooltip>Connect via WiFi</q-tooltip>
      </q-btn>
    </template>

    <template v-else>
      <q-chip color="positive" text-color="white" icon="check_circle" dense>
        {{ device.deviceVersion }}
        <q-badge
          :label="device.transportType === 'websocket' ? 'WiFi' : 'USB'"
          color="white"
          text-color="positive"
          class="q-ml-xs"
        />
      </q-chip>

      <q-btn flat round dense icon="settings" color="grey-4" @click="showDeviceDialog = true">
        <q-tooltip>Device Info & Settings</q-tooltip>
      </q-btn>

      <q-btn
        color="negative"
        label="Disconnect"
        :icon="device.transportType === 'websocket' ? 'wifi_off' : 'usb_off'"
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
    <WiFiConnectDialog
      v-model="showWiFiDialog"
      :connecting="device.connecting"
      @connect="onWiFiConnect"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useDevice } from 'src/composables/useDevice.js'
import DeviceInfoDialog from './DeviceInfoDialog.vue'
import WiFiConnectDialog from './WiFiConnectDialog.vue'

const device = useDevice()
const showDeviceDialog = ref(false)
const showWiFiDialog = ref(false)

async function onWiFiConnect({ host, port }) {
  await device.connectWiFi(host, port)
  if (device.isConnected) {
    showWiFiDialog.value = false
  }
}
</script>

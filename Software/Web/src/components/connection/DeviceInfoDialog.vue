<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 500px; max-width: 600px" class="bg-dark text-white">
      <q-card-section class="q-pb-none">
        <div class="text-h6">Device Info & Settings</div>
      </q-card-section>

      <q-card-section class="q-pt-sm scroll" style="max-height: 70vh">
        <!-- Device Info — compact grid -->
        <div class="text-subtitle2 q-mb-xs">Device</div>
        <div class="row q-col-gutter-x-md q-col-gutter-y-xs q-mb-sm">
          <div class="col-6" v-for="item in infoItems" :key="item.label">
            <span class="text-grey-6 text-caption">{{ item.label }}</span>
            <div>{{ item.value }}</div>
          </div>
        </div>

        <!-- Capture Mode Limits -->
        <div class="text-subtitle2 q-mb-xs">Capture Limits</div>
        <q-markup-table dense flat class="bg-dark text-white q-mb-sm">
          <thead>
            <tr>
              <th class="text-left">Mode</th>
              <th class="text-right">Min Pre</th>
              <th class="text-right">Max Pre</th>
              <th class="text-right">Min Post</th>
              <th class="text-right">Max Post</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in limitsRows" :key="row.label">
              <td>{{ row.label }}</td>
              <td class="text-right">{{ row.minPre }}</td>
              <td class="text-right">{{ row.maxPre }}</td>
              <td class="text-right">{{ row.minPost }}</td>
              <td class="text-right">{{ row.maxPost }}</td>
            </tr>
          </tbody>
        </q-markup-table>

        <!-- Network Settings -->
        <q-separator dark class="q-mb-sm" />
        <div class="text-subtitle2 q-mb-none">Network Settings</div>
        <div class="text-caption text-grey-6 q-mb-xs">
          Password is write-only — the device does not report it.
        </div>
        <div class="row q-col-gutter-x-md q-mb-xs" v-if="info">
          <div class="col-6">
            <span class="text-grey-6 text-caption">Current SSID</span>
            <div>{{ info.ssid || '(not set)' }}</div>
          </div>
          <div class="col-6">
            <span class="text-grey-6 text-caption">Current Hostname</span>
            <div>{{ info.hostname || '(not set)' }}</div>
          </div>
        </div>
        <div class="column q-gutter-y-xs">
          <q-input
            v-model="form.ssid"
            label="WiFi SSID"
            maxlength="32"
            :rules="[ssidRule]"
            hide-bottom-space
            dense
            outlined
            dark
          />
          <q-input
            v-model="form.password"
            label="WiFi Password (leave empty to keep existing)"
            type="password"
            maxlength="63"
            :rules="[passwordRule]"
            hide-bottom-space
            dense
            outlined
            dark
          />
          <div class="row q-col-gutter-x-sm">
            <div class="col">
              <q-input
                v-model="form.ipAddress"
                label="IP Address"
                maxlength="15"
                :rules="[ipRule]"
                hide-bottom-space
                dense
                outlined
                dark
              />
            </div>
            <div class="col-4">
              <q-input
                v-model.number="form.port"
                label="Port"
                type="number"
                :rules="[portRule]"
                hide-bottom-space
                dense
                outlined
                dark
              />
            </div>
          </div>
          <q-input
            v-model="form.hostname"
            label="Hostname (optional)"
            maxlength="32"
            :rules="[hostnameRule]"
            hide-bottom-space
            dense
            outlined
            dark
          />
          <q-btn
            label="Save Network Settings"
            color="positive"
            no-caps
            dense
            :loading="saving"
            :disable="!formValid"
            @click="onSave"
          />
          <q-banner
            v-if="saveResult === 'success'"
            dense
            class="bg-positive text-white q-py-xs"
          >
            Network settings saved successfully.
          </q-banner>
          <q-banner v-if="saveResult === 'error'" dense class="bg-negative text-white q-py-xs">
            Failed to save. {{ device.error }}
          </q-banner>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-pt-none">
        <q-btn flat label="Close" color="grey-4" no-caps v-close-popup />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useDevice } from 'src/composables/useDevice.js'

defineProps({
  modelValue: Boolean,
})
defineEmits(['update:modelValue'])

const device = useDevice()

// --- Formatters ---

function formatFrequency(hz) {
  if (hz >= 1_000_000_000)
    return `${(hz / 1_000_000_000).toFixed(hz % 1_000_000_000 ? 1 : 0)} GHz`
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(hz % 1_000_000 ? 1 : 0)} MHz`
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(hz % 1_000 ? 1 : 0)} kHz`
  return `${hz} Hz`
}

function formatBytes(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(bytes % 1_048_576 ? 1 : 0)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(bytes % 1_024 ? 1 : 0)} KB`
  return `${bytes} B`
}

// --- Device Info ---

const info = computed(() => device.deviceInfo)

const infoItems = computed(() => {
  if (!info.value) return []
  const maxFreq = info.value.maxFrequency
  return [
    { label: 'Version', value: info.value.name },
    { label: 'Channels', value: info.value.channels },
    { label: 'Max Frequency', value: formatFrequency(maxFreq) },
    { label: 'Blast Frequency', value: formatFrequency(info.value.blastFrequency) },
    { label: 'Min Frequency', value: formatFrequency(Math.floor((maxFreq * 2) / 65535)) },
    { label: 'Buffer Size', value: formatBytes(info.value.bufferSize) },
  ]
})

const modeLabels = ['8 Channel', '16 Channel', '24 Channel']

const limitsRows = computed(() => {
  if (!info.value?.modeLimits) return []
  return info.value.modeLimits.map((limits, i) => ({
    label: modeLabels[i],
    minPre: limits.minPreSamples.toLocaleString(),
    maxPre: limits.maxPreSamples.toLocaleString(),
    minPost: limits.minPostSamples.toLocaleString(),
    maxPost: limits.maxPostSamples.toLocaleString(),
  }))
})

// --- Network Settings Form ---

const form = reactive({
  ssid: '',
  password: '',
  ipAddress: '192.168.4.1',
  port: 4045,
  hostname: '',
})

const ssidRule = (val) => (val && val.length > 0 && val.length <= 32) || 'Required, max 32 chars'
const passwordRule = (val) => !val || val.length <= 63 || 'Max 63 chars'
const ipRule = (val) => /^(\d{1,3}\.){3}\d{1,3}$/.test(val) || 'Must be a valid IPv4 address'
const portRule = (val) =>
  (Number.isInteger(Number(val)) && val >= 1 && val <= 65535) || 'Must be 1-65535'
const hostnameRule = (val) => !val || val.length <= 32 || 'Max 32 chars'

const formValid = computed(() => {
  return (
    ssidRule(form.ssid) === true &&
    passwordRule(form.password) === true &&
    ipRule(form.ipAddress) === true &&
    portRule(form.port) === true &&
    hostnameRule(form.hostname) === true
  )
})

const saving = ref(false)
const saveResult = ref(null)

// Reset form and pre-fill with device values when a new device connects
watch(
  () => device.isConnected,
  (connected) => {
    if (connected) {
      const di = device.deviceInfo
      form.ssid = di?.ssid || ''
      form.password = ''
      form.ipAddress = '192.168.4.1'
      form.port = 4045
      form.hostname = di?.hostname || ''
      saveResult.value = null
    }
  },
)

async function onSave() {
  saving.value = true
  saveResult.value = null
  const success = await device.sendNetworkConfig({
    ssid: form.ssid,
    password: form.password,
    ipAddress: form.ipAddress,
    port: form.port,
    hostname: form.hostname || '',
  })
  saveResult.value = success ? 'success' : 'error'
  saving.value = false
}
</script>

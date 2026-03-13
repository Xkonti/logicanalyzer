<template>
  <q-dialog :model-value="modelValue" @update:model-value="onDialogUpdate">
    <q-card style="min-width: 360px" class="bg-dark text-white">
      <q-card-section class="q-pb-none">
        <div class="text-h6">Connect via WiFi</div>
      </q-card-section>

      <q-card-section class="q-pt-sm">
        <div class="column q-gutter-y-xs">
          <div class="row q-col-gutter-x-sm">
            <div class="col">
              <q-input
                v-model="host"
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
                v-model.number="port"
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
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-pt-none">
        <q-btn flat label="Cancel" color="grey-4" no-caps v-close-popup />
        <q-btn
          label="Connect"
          color="positive"
          icon="wifi"
          no-caps
          :loading="connecting"
          :disable="!formValid"
          @click="onConnect"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useLocalStorage } from '@vueuse/core'

defineProps({
  modelValue: Boolean,
  connecting: Boolean,
})
const emit = defineEmits(['update:modelValue', 'connect'])

const host = useLocalStorage('la-wifi-host', '192.168.4.1')
const port = useLocalStorage('la-wifi-port', 4045)

const ipRule = (val) => /^(\d{1,3}\.){3}\d{1,3}$/.test(val) || 'Must be a valid IPv4 address'
const portRule = (val) =>
  (Number.isInteger(Number(val)) && val >= 1 && val <= 65535) || 'Must be 1-65535'

const formValid = computed(() => ipRule(host.value) === true && portRule(port.value) === true)

function onDialogUpdate(val) {
  emit('update:modelValue', val)
}

function onConnect() {
  emit('connect', { host: host.value, port: port.value })
}
</script>

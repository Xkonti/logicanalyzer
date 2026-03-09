<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 750px; max-width: 1000px">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Compression Benchmark</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section>
        <div class="row items-center q-gutter-sm q-mb-md">
          <q-btn
            label="Run Benchmark"
            color="primary"
            icon="science"
            :loading="store.running"
            :disable="!canRun"
            no-caps
            @click="store.runTest()"
          />
          <q-btn
            v-if="store.results.length > 0"
            label="Clear"
            flat
            icon="delete"
            no-caps
            @click="store.clearResults()"
          />

          <q-space />

          <q-chip v-if="store.results.length > 0" color="positive" text-color="white" dense>
            {{ store.passCount }} pass
          </q-chip>
          <q-chip v-if="store.failCount > 0" color="negative" text-color="white" dense>
            {{ store.failCount }} fail
          </q-chip>
        </div>

        <q-linear-progress
          v-if="store.running"
          :value="store.progress / store.testCount"
          class="q-mb-md"
          color="primary"
          track-color="grey-3"
        />

        <q-chip
          v-if="store.error"
          color="negative"
          text-color="white"
          icon="error"
          dense
          class="q-mb-md"
        >
          {{ store.error }}
        </q-chip>

        <!-- Results with streaming analysis -->
        <template v-if="store.results.length > 0">
          <div class="text-caption q-mb-xs">
            I2C 100 kHz on all channels (SCL/SDA pairs), 250 kHz sampling, 512-sample
            chunks, {{ store.results[0]?.iterations || '?' }}× averaged. USB ~1 MB/s, WiFi
            ~2 MB/s.
          </div>
          <q-input
            :model-value="resultsText"
            type="textarea"
            readonly
            outlined
            dense
            :rows="Math.min(store.results.length + 1, 26)"
            input-style="font-family: monospace; font-size: 12px; white-space: pre"
          />
        </template>

        <!-- Failures detail -->
        <template v-if="failedResults.length > 0">
          <div class="text-subtitle2 q-mt-md q-mb-xs text-negative">Failed Tests</div>
          <q-input
            :model-value="failuresText"
            type="textarea"
            readonly
            outlined
            dense
            :rows="Math.min(failedResults.length + 1, 10)"
            input-style="font-family: monospace; font-size: 12px; white-space: pre"
          />
        </template>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useCompressTestStore } from 'src/stores/compress-test.js'
import { useDeviceStore } from 'src/stores/device.js'

defineProps({ modelValue: Boolean })
defineEmits(['update:modelValue'])

const store = useCompressTestStore()
const device = useDeviceStore()

const canRun = computed(
  () => device.connected && !device.capturing && !device.previewing && !store.running,
)

const USB_BW = 1.0 // bytes/µs = 1 MB/s
const WIFI_BW = 2.0

function formatRate(hz) {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`
  return `${hz} Hz`
}

const resultsText = computed(() => {
  const header =
    'Ch  Compress   Comp(B)  Raw(B)  Ratio  USB Rate     WiFi Rate    Bottleneck  OK'
  const lines = store.results.map((r) => {
    const ch = String(r.numChannels).padStart(2)
    const compress = `${r.compressUs} us`.padStart(9)
    const comp = String(r.compressedSize).padStart(7)
    const raw = String(r.rawInputSize).padStart(6)
    const ratio = r.ratio.padStart(6)

    const usbTransferUs = r.compressedSize / USB_BW
    const wifiTransferUs = r.compressedSize / WIFI_BW
    const usbBottleneckUs = Math.max(r.compressUs, usbTransferUs)
    const wifiBottleneckUs = Math.max(r.compressUs, wifiTransferUs)
    const usbRate = Math.round((r.chunkSamples / usbBottleneckUs) * 1e6)
    const wifiRate = Math.round((r.chunkSamples / wifiBottleneckUs) * 1e6)
    const bottleneck = r.compressUs > usbTransferUs ? 'CPU' : 'USB'

    const usb = formatRate(usbRate).padStart(11)
    const wifi = formatRate(wifiRate).padStart(12)
    const bneck = bottleneck.padStart(10)
    const ok = r.pass ? 'PASS' : 'FAIL'
    return `${ch}  ${compress}  ${comp}  ${raw}  ${ratio}  ${usb}  ${wifi}  ${bneck}  ${ok}`
  })
  return [header, ...lines].join('\n')
})

const failedResults = computed(() => store.results.filter((r) => !r.pass))

const failuresText = computed(() => {
  const lines = failedResults.value.map((r) => {
    return `ch${r.numChannels}: ${r.mismatchInfo}`
  })
  return lines.join('\n')
})
</script>

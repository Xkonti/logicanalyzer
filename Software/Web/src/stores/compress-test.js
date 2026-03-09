import { ref, shallowRef, computed } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'
import { useDeviceStore } from './device.js'

/** USB Full-Speed CDC practical throughput in bytes/µs (= MB/s) */
const USB_BW = 1.0
/** WiFi (CYW43) conservative throughput in bytes/µs */
const WIFI_BW = 2.0

export const useCompressTestStore = defineStore('compress-test', () => {
  const running = ref(false)
  const progress = ref(0)
  const testCount = ref(24)
  const results = shallowRef([])
  const error = ref(null)

  const passCount = computed(() => results.value.filter((r) => r.pass).length)
  const failCount = computed(() => results.value.filter((r) => !r.pass).length)

  /**
   * Per-(channelCount, chunkSize) streaming rate analysis.
   * Uses worst-case timing/size across all patterns for each combination.
   */
  const analysis = computed(() => {
    if (!results.value.length) return []

    const groups = new Map()
    for (const r of results.value) {
      if (!r.pass) continue
      const key = `${r.numChannels}-${r.chunkSamples}`
      if (!groups.has(key)) {
        groups.set(key, {
          numChannels: r.numChannels,
          chunkSamples: r.chunkSamples,
          maxCompressUs: 0,
          maxCompressedSize: 0,
        })
      }
      const g = groups.get(key)
      g.maxCompressUs = Math.max(g.maxCompressUs, r.compressUs)
      g.maxCompressedSize = Math.max(g.maxCompressedSize, r.compressedSize)
    }

    return Array.from(groups.values())
      .map((g) => {
        const usbTransferUs = g.maxCompressedSize / USB_BW
        const wifiTransferUs = g.maxCompressedSize / WIFI_BW
        const usbBottleneckUs = Math.max(g.maxCompressUs, usbTransferUs)
        const wifiBottleneckUs = Math.max(g.maxCompressUs, wifiTransferUs)
        return {
          numChannels: g.numChannels,
          chunkSamples: g.chunkSamples,
          compressUs: g.maxCompressUs,
          compressedSize: g.maxCompressedSize,
          usbRate: Math.round((g.chunkSamples / usbBottleneckUs) * 1e6),
          wifiRate: Math.round((g.chunkSamples / wifiBottleneckUs) * 1e6),
          usbBottleneck: g.maxCompressUs > usbTransferUs ? 'CPU' : 'USB',
          wifiBottleneck: g.maxCompressUs > wifiTransferUs ? 'CPU' : 'WiFi',
        }
      })
      .sort((a, b) => a.numChannels - b.numChannels || a.chunkSamples - b.chunkSamples)
  })

  async function runTest() {
    const device = useDeviceStore()
    if (!device.driver || running.value) return

    running.value = true
    progress.value = 0
    results.value = []
    error.value = null

    try {
      const res = await device.driver.runCompressionTest((p, total) => {
        if (total) testCount.value = total
        progress.value = p
      })
      results.value = res
    } catch (err) {
      error.value = err?.message ?? String(err)
    } finally {
      running.value = false
    }
  }

  function clearResults() {
    results.value = []
    error.value = null
    progress.value = 0
  }

  return {
    running,
    progress,
    testCount,
    results,
    error,
    passCount,
    failCount,
    analysis,
    runTest,
    clearResults,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCompressTestStore, import.meta.hot))
}

import { ref, watch } from 'vue'
import { defineStore, acceptHMRUpdate } from 'pinia'

const STORAGE_KEY = 'logicanalyzer-settings'

const DEFAULTS = {
  defaultFrequency: 1000000,
  defaultPreSamples: 100,
  defaultPostSamples: 1000,
  defaultChannelNames: Array(24).fill(''),
  autoReconnect: false,
  theme: 'dark',
}

export const useSettingsStore = defineStore('settings', () => {
  const defaultFrequency = ref(DEFAULTS.defaultFrequency)
  const defaultPreSamples = ref(DEFAULTS.defaultPreSamples)
  const defaultPostSamples = ref(DEFAULTS.defaultPostSamples)
  const defaultChannelNames = ref([...DEFAULTS.defaultChannelNames])
  const autoReconnect = ref(DEFAULTS.autoReconnect)
  const theme = ref(DEFAULTS.theme)

  // Load from localStorage eagerly on store creation
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw)
      if (typeof data.defaultFrequency === 'number') defaultFrequency.value = data.defaultFrequency
      if (typeof data.defaultPreSamples === 'number')
        defaultPreSamples.value = data.defaultPreSamples
      if (typeof data.defaultPostSamples === 'number')
        defaultPostSamples.value = data.defaultPostSamples
      if (Array.isArray(data.defaultChannelNames))
        defaultChannelNames.value = data.defaultChannelNames
      if (typeof data.autoReconnect === 'boolean') autoReconnect.value = data.autoReconnect
      if (typeof data.theme === 'string') theme.value = data.theme
    }
  } catch {
    // keep defaults on malformed data
  }

  // Auto-persist on any change
  watch(
    () => ({
      defaultFrequency: defaultFrequency.value,
      defaultPreSamples: defaultPreSamples.value,
      defaultPostSamples: defaultPostSamples.value,
      defaultChannelNames: [...defaultChannelNames.value],
      autoReconnect: autoReconnect.value,
      theme: theme.value,
    }),
    (val) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    },
    { deep: true },
  )

  async function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = JSON.parse(raw)
      if (typeof data.defaultFrequency === 'number') defaultFrequency.value = data.defaultFrequency
      if (typeof data.defaultPreSamples === 'number')
        defaultPreSamples.value = data.defaultPreSamples
      if (typeof data.defaultPostSamples === 'number')
        defaultPostSamples.value = data.defaultPostSamples
      if (Array.isArray(data.defaultChannelNames))
        defaultChannelNames.value = data.defaultChannelNames
      if (typeof data.autoReconnect === 'boolean') autoReconnect.value = data.autoReconnect
      if (typeof data.theme === 'string') theme.value = data.theme
    } catch {
      // keep current values
    }
  }

  async function save() {
    const data = {
      defaultFrequency: defaultFrequency.value,
      defaultPreSamples: defaultPreSamples.value,
      defaultPostSamples: defaultPostSamples.value,
      defaultChannelNames: [...defaultChannelNames.value],
      autoReconnect: autoReconnect.value,
      theme: theme.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }

  async function update(key, value) {
    const refs = {
      defaultFrequency,
      defaultPreSamples,
      defaultPostSamples,
      defaultChannelNames,
      autoReconnect,
      theme,
    }
    if (key in refs) {
      refs[key].value = value
    }
  }

  async function resetToDefaults() {
    defaultFrequency.value = DEFAULTS.defaultFrequency
    defaultPreSamples.value = DEFAULTS.defaultPreSamples
    defaultPostSamples.value = DEFAULTS.defaultPostSamples
    defaultChannelNames.value = [...DEFAULTS.defaultChannelNames]
    autoReconnect.value = DEFAULTS.autoReconnect
    theme.value = DEFAULTS.theme
  }

  return {
    defaultFrequency,
    defaultPreSamples,
    defaultPostSamples,
    defaultChannelNames,
    autoReconnect,
    theme,
    load,
    save,
    update,
    resetToDefaults,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
}

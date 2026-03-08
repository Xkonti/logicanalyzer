import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'

export const useSettingsStore = defineStore('settings', () => {
  const autoReconnect = useLocalStorage('la-auto-reconnect', false)
  const theme = useLocalStorage('la-theme', 'dark')

  function resetToDefaults() {
    autoReconnect.value = false
    theme.value = 'dark'
  }

  return {
    autoReconnect,
    theme,
    resetToDefaults,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
}

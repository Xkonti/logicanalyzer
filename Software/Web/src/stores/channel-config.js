import { defineStore, acceptHMRUpdate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'

export const useChannelConfigStore = defineStore('channelConfig', () => {
  const selectedChannels = useLocalStorage('la-selected-channels', [])
  const channelNames = useLocalStorage('la-channel-names', Array(24).fill(''))

  function isSelected(num) {
    return selectedChannels.value.includes(num)
  }

  function toggleChannel(num) {
    const idx = selectedChannels.value.indexOf(num)
    if (idx >= 0) {
      selectedChannels.value = selectedChannels.value.filter((n) => n !== num)
    } else {
      selectedChannels.value = [...selectedChannels.value, num].sort((a, b) => a - b)
    }
  }

  function selectRange(start, end, enabled) {
    if (enabled) {
      const existing = new Set(selectedChannels.value)
      for (let i = start; i <= end; i++) existing.add(i)
      selectedChannels.value = [...existing].sort((a, b) => a - b)
    } else {
      const toRemove = new Set()
      for (let i = start; i <= end; i++) toRemove.add(i)
      selectedChannels.value = selectedChannels.value.filter((n) => !toRemove.has(n))
    }
  }

  function setName(num, name) {
    const names = [...channelNames.value]
    names[num] = name
    channelNames.value = names
  }

  function setSelectedChannels(nums) {
    selectedChannels.value = [...nums].sort((a, b) => a - b)
  }

  return {
    selectedChannels,
    channelNames,
    isSelected,
    toggleChannel,
    selectRange,
    setName,
    setSelectedChannels,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChannelConfigStore, import.meta.hot))
}

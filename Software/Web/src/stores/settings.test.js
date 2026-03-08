import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore } from './settings.js'
import { nextTick } from 'vue'

function createMockLocalStorage(initial = {}) {
  const store = { ...initial }
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => {
      store[key] = value
    }),
    removeItem: vi.fn((key) => {
      delete store[key]
    }),
  }
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMockLocalStorage())
    setActivePinia(createPinia())
  })

  it('has correct default values', () => {
    const settings = useSettingsStore()
    expect(settings.defaultFrequency).toBe(1000000)
    expect(settings.defaultPreSamples).toBe(100)
    expect(settings.defaultPostSamples).toBe(1000)
    expect(settings.defaultChannelNames).toHaveLength(24)
    expect(settings.defaultChannelNames.every((n) => n === '')).toBe(true)
    expect(settings.autoReconnect).toBe(false)
    expect(settings.theme).toBe('dark')
  })

  it('loads from localStorage on creation', () => {
    const data = {
      defaultFrequency: 5000000,
      defaultPreSamples: 200,
      theme: 'light',
    }
    vi.stubGlobal(
      'localStorage',
      createMockLocalStorage({
        'logicanalyzer-settings': JSON.stringify(data),
      }),
    )
    setActivePinia(createPinia())

    const settings = useSettingsStore()
    expect(settings.defaultFrequency).toBe(5000000)
    expect(settings.defaultPreSamples).toBe(200)
    expect(settings.theme).toBe('light')
    // Non-specified keys keep defaults
    expect(settings.defaultPostSamples).toBe(1000)
    expect(settings.autoReconnect).toBe(false)
  })

  it('keeps defaults on malformed JSON', () => {
    vi.stubGlobal(
      'localStorage',
      createMockLocalStorage({
        'logicanalyzer-settings': '{invalid json',
      }),
    )
    setActivePinia(createPinia())

    const settings = useSettingsStore()
    expect(settings.defaultFrequency).toBe(1000000)
  })

  it('keeps defaults when key is missing', () => {
    vi.stubGlobal('localStorage', createMockLocalStorage())
    setActivePinia(createPinia())

    const settings = useSettingsStore()
    expect(settings.defaultFrequency).toBe(1000000)
  })

  it('saves to localStorage', async () => {
    const settings = useSettingsStore()
    await settings.save()

    expect(localStorage.setItem).toHaveBeenCalledWith('logicanalyzer-settings', expect.any(String))
    const saved = JSON.parse(localStorage.setItem.mock.calls[0][1])
    expect(saved.defaultFrequency).toBe(1000000)
  })

  it('updates a single key', async () => {
    const settings = useSettingsStore()
    await settings.update('defaultFrequency', 2000000)
    expect(settings.defaultFrequency).toBe(2000000)
  })

  it('ignores unknown keys in update', async () => {
    const settings = useSettingsStore()
    await settings.update('unknownKey', 42)
    // No crash, no effect
    expect(settings.defaultFrequency).toBe(1000000)
  })

  it('resets to defaults', async () => {
    const settings = useSettingsStore()
    settings.defaultFrequency = 5000000
    settings.theme = 'light'

    await settings.resetToDefaults()
    expect(settings.defaultFrequency).toBe(1000000)
    expect(settings.theme).toBe('dark')
  })

  it('auto-persists on change', async () => {
    const settings = useSettingsStore()
    settings.defaultFrequency = 9999999

    await nextTick()

    expect(localStorage.setItem).toHaveBeenCalled()
    const lastCall = localStorage.setItem.mock.calls.at(-1)
    expect(lastCall[0]).toBe('logicanalyzer-settings')
    const saved = JSON.parse(lastCall[1])
    expect(saved.defaultFrequency).toBe(9999999)
  })

  it('load() refreshes from localStorage', async () => {
    const settings = useSettingsStore()
    expect(settings.theme).toBe('dark')

    // Simulate external change
    localStorage.getItem.mockReturnValue(JSON.stringify({ theme: 'light' }))

    await settings.load()
    expect(settings.theme).toBe('light')
  })
})

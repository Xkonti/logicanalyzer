import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore } from './settings.js'

function createMockStorage() {
  const store = {}
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => {
      store[key] = value
    }),
    removeItem: vi.fn((key) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      for (const key of Object.keys(store)) delete store[key]
    }),
    get length() {
      return Object.keys(store).length
    },
    key: vi.fn((i) => Object.keys(store)[i] ?? null),
  }
}

describe('useSettingsStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMockStorage())
    setActivePinia(createPinia())
  })

  it('has correct default values', () => {
    const settings = useSettingsStore()
    expect(settings.autoReconnect).toBe(false)
    expect(settings.theme).toBe('dark')
  })

  it('autoReconnect is writable', () => {
    const settings = useSettingsStore()
    settings.autoReconnect = true
    expect(settings.autoReconnect).toBe(true)
  })

  it('theme is writable', () => {
    const settings = useSettingsStore()
    settings.theme = 'light'
    expect(settings.theme).toBe('light')
  })

  it('resets to defaults', () => {
    const settings = useSettingsStore()
    settings.autoReconnect = true
    settings.theme = 'light'

    settings.resetToDefaults()
    expect(settings.autoReconnect).toBe(false)
    expect(settings.theme).toBe('dark')
  })
})

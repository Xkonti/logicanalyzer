import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#q-app/wrappers', () => ({
  defineBoot: (fn) => fn,
}))

vi.mock('quasar', () => ({
  Notify: { create: vi.fn() },
}))

describe('webserial boot', () => {
  let originalNavigator

  beforeEach(() => {
    originalNavigator = globalThis.navigator
    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    })
  })

  it('sets webSerialAvailable to true when navigator.serial exists', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { serial: {} },
      writable: true,
      configurable: true,
    })

    const { webSerialAvailable } = await import('./webserial.js')
    expect(webSerialAvailable.value).toBe(true)
  })

  it('sets webSerialAvailable to false when navigator.serial is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
    })

    const { webSerialAvailable } = await import('./webserial.js')
    expect(webSerialAvailable.value).toBe(false)
  })
})

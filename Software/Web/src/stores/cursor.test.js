import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCursorStore } from './cursor.js'

describe('useCursorStore', () => {
  let store

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useCursorStore()
  })

  it('starts with null cursor', () => {
    expect(store.cursorSample).toBeNull()
    expect(store.cursorX).toBeNull()
    expect(store.rawX).toBeNull()
  })

  it('setCursor sets sample, x, and rawX', () => {
    store.setCursor(42, 300.5, 305)
    expect(store.cursorSample).toBe(42)
    expect(store.cursorX).toBe(300.5)
    expect(store.rawX).toBe(305)
  })

  it('clearCursor resets all to null', () => {
    store.setCursor(42, 300.5, 305)
    store.clearCursor()
    expect(store.cursorSample).toBeNull()
    expect(store.cursorX).toBeNull()
    expect(store.rawX).toBeNull()
  })

  it('setCursor overwrites previous values', () => {
    store.setCursor(10, 100, 105)
    store.setCursor(20, 200, 210)
    expect(store.cursorSample).toBe(20)
    expect(store.cursorX).toBe(200)
    expect(store.rawX).toBe(210)
  })
})

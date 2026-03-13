import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InputManager, BINDINGS, isTyping } from './input-manager.js'

// ── isTyping ──────────────────────────────────────────────────────────────────

describe('isTyping', () => {
  it('returns true for INPUT elements', () => {
    expect(isTyping({ target: { tagName: 'INPUT' } })).toBe(true)
  })

  it('returns true for TEXTAREA elements', () => {
    expect(isTyping({ target: { tagName: 'TEXTAREA' } })).toBe(true)
  })

  it('returns true for SELECT elements', () => {
    expect(isTyping({ target: { tagName: 'SELECT' } })).toBe(true)
  })

  it('returns true for contentEditable elements', () => {
    expect(isTyping({ target: { tagName: 'DIV', isContentEditable: true } })).toBe(true)
  })

  it('returns false for non-input elements', () => {
    expect(isTyping({ target: { tagName: 'CANVAS' } })).toBe(false)
    expect(isTyping({ target: { tagName: 'DIV' } })).toBe(false)
  })

  it('returns false when target is null', () => {
    expect(isTyping({ target: null })).toBe(false)
  })
})

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockElement() {
  const listeners = new Map()
  return {
    addEventListener: vi.fn((event, handler, options) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ handler, options })
    }),
    removeEventListener: vi.fn((event, handler) => {
      const list = listeners.get(event)
      if (list) {
        const idx = list.findIndex((l) => l.handler === handler)
        if (idx >= 0) list.splice(idx, 1)
      }
    }),
    _listeners: listeners,
    _fire(event, eventObj) {
      const list = listeners.get(event) || []
      for (const { handler } of list) handler(eventObj)
    },
  }
}

function createWheelEvent(overrides = {}) {
  return {
    type: 'wheel',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    deltaY: -100,
    offsetX: 400,
    offsetY: 200,
    preventDefault: vi.fn(),
    ...overrides,
  }
}

function createKeyEvent(key, overrides = {}) {
  return {
    type: 'keydown',
    key,
    target: { tagName: 'CANVAS' },
    preventDefault: vi.fn(),
    ...overrides,
  }
}

function createMouseEvent(type, overrides = {}) {
  return {
    type,
    offsetX: 400,
    offsetY: 200,
    preventDefault: vi.fn(),
    ...overrides,
  }
}

// ── InputManager ──────────────────────────────────────────────────────────────

describe('InputManager', () => {
  let mgr, canvas, win

  beforeEach(() => {
    mgr = new InputManager()
    canvas = createMockElement()
    win = createMockElement()
  })

  describe('bind / unbind', () => {
    it('attaches listeners to the element', () => {
      mgr.bind(canvas, 'canvas')
      // Should have listeners for wheel, mousemove, mouseleave
      expect(canvas.addEventListener).toHaveBeenCalled()
      const events = canvas.addEventListener.mock.calls.map((c) => c[0])
      expect(events).toContain('wheel')
      expect(events).toContain('mousemove')
      expect(events).toContain('mouseleave')
    })

    it('attaches window listeners for keydown', () => {
      mgr.bind(win, 'window')
      const events = win.addEventListener.mock.calls.map((c) => c[0])
      expect(events).toContain('keydown')
    })

    it('removes listeners on unbind', () => {
      mgr.bind(canvas, 'canvas')
      const addCount = canvas.addEventListener.mock.calls.length
      mgr.unbind('canvas')
      expect(canvas.removeEventListener).toHaveBeenCalledTimes(addCount)
    })

    it('unbind is idempotent for unknown scope', () => {
      expect(() => mgr.unbind('nonexistent')).not.toThrow()
    })

    it('re-binding a scope unbinds the old one first', () => {
      mgr.bind(canvas, 'canvas')
      const firstAddCount = canvas.addEventListener.mock.calls.length
      mgr.bind(canvas, 'canvas')
      expect(canvas.removeEventListener).toHaveBeenCalledTimes(firstAddCount)
    })
  })

  describe('action dispatch', () => {
    it('dispatches zoom action on Shift+Wheel', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(canvas, 'canvas')

      const event = createWheelEvent({ shiftKey: true, deltaY: -100, offsetX: 300 })
      canvas._fire('wheel', event)

      expect(handler).toHaveBeenCalledWith({ offsetX: 300, delta: 100 })
      expect(event.preventDefault).toHaveBeenCalled()
    })

    it('dispatches zoom action on Ctrl+Wheel', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(canvas, 'canvas')

      const event = createWheelEvent({ ctrlKey: true, deltaY: 50, offsetX: 200 })
      canvas._fire('wheel', event)

      expect(handler).toHaveBeenCalledWith({ offsetX: 200, delta: -50 })
      expect(event.preventDefault).toHaveBeenCalled()
    })

    it('does NOT dispatch on bare wheel (no modifiers)', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(canvas, 'canvas')

      const event = createWheelEvent({ shiftKey: false, ctrlKey: false, metaKey: false })
      canvas._fire('wheel', event)

      expect(handler).not.toHaveBeenCalled()
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('dispatches cursor-move on mousemove', () => {
      const handler = vi.fn()
      mgr.on('cursor-move', handler)
      mgr.bind(canvas, 'canvas')

      const event = createMouseEvent('mousemove', { offsetX: 150, offsetY: 75 })
      canvas._fire('mousemove', event)

      expect(handler).toHaveBeenCalledWith({ offsetX: 150, offsetY: 75 })
    })

    it('dispatches cursor-leave on mouseleave', () => {
      const handler = vi.fn()
      mgr.on('cursor-leave', handler)
      mgr.bind(canvas, 'canvas')

      const event = createMouseEvent('mouseleave')
      canvas._fire('mouseleave', event)

      expect(handler).toHaveBeenCalledWith({})
    })

    it('dispatches zoom on + key', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(win, 'window')

      const event = createKeyEvent('+')
      win._fire('keydown', event)

      expect(handler).toHaveBeenCalledWith({ delta: 1 })
      expect(event.preventDefault).toHaveBeenCalled()
    })

    it('dispatches zoom on = key', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(win, 'window')

      const event = createKeyEvent('=')
      win._fire('keydown', event)

      expect(handler).toHaveBeenCalledWith({ delta: 1 })
    })

    it('dispatches zoom on - key', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(win, 'window')

      const event = createKeyEvent('-')
      win._fire('keydown', event)

      expect(handler).toHaveBeenCalledWith({ delta: -1 })
      expect(event.preventDefault).toHaveBeenCalled()
    })

    it('does NOT dispatch keyboard zoom when typing in an input', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(win, 'window')

      const event = createKeyEvent('+', { target: { tagName: 'INPUT' } })
      win._fire('keydown', event)

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('first match wins', () => {
    it('Shift+Ctrl+Wheel matches Shift binding first', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(canvas, 'canvas')

      // Both shiftKey and ctrlKey set — Shift binding is first in the array
      const event = createWheelEvent({ shiftKey: true, ctrlKey: true })
      canvas._fire('wheel', event)

      // Should fire exactly once (not twice)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('multiple handlers', () => {
    it('calls all handlers for the same action', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      mgr.on('zoom', h1)
      mgr.on('zoom', h2)
      mgr.bind(canvas, 'canvas')

      canvas._fire('wheel', createWheelEvent({ shiftKey: true }))

      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
    })
  })

  describe('off', () => {
    it('unregisters a handler', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.off('zoom', handler)
      mgr.bind(canvas, 'canvas')

      canvas._fire('wheel', createWheelEvent({ shiftKey: true }))

      expect(handler).not.toHaveBeenCalled()
    })

    it('off on unknown action does not throw', () => {
      expect(() => mgr.off('nonexistent', vi.fn())).not.toThrow()
    })
  })

  describe('dispose', () => {
    it('removes all listeners and clears handlers', () => {
      const handler = vi.fn()
      mgr.on('zoom', handler)
      mgr.bind(canvas, 'canvas')
      mgr.bind(win, 'window')

      mgr.dispose()

      expect(canvas.removeEventListener).toHaveBeenCalled()
      expect(win.removeEventListener).toHaveBeenCalled()

      // Firing events after dispose should not call handlers
      canvas._fire('wheel', createWheelEvent({ shiftKey: true }))
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('custom bindings', () => {
    it('works with a custom binding table', () => {
      const customBindings = [
        {
          event: 'click',
          scope: 'canvas',
          match: () => true,
          action: 'place-marker',
          payload: (e) => ({ x: e.offsetX }),
          preventDefault: false,
        },
      ]
      const customMgr = new InputManager(customBindings)
      const handler = vi.fn()
      customMgr.on('place-marker', handler)
      customMgr.bind(canvas, 'canvas')

      canvas._fire('click', { offsetX: 42, preventDefault: vi.fn() })

      expect(handler).toHaveBeenCalledWith({ x: 42 })
      customMgr.dispose()
    })
  })
})

// ── BINDINGS table sanity ─────────────────────────────────────────────────────

describe('BINDINGS', () => {
  it('every binding has required fields', () => {
    for (const b of BINDINGS) {
      expect(b).toHaveProperty('event')
      expect(b).toHaveProperty('scope')
      expect(b).toHaveProperty('match')
      expect(b).toHaveProperty('action')
      expect(b).toHaveProperty('payload')
      expect(typeof b.match).toBe('function')
      expect(typeof b.payload).toBe('function')
      expect(typeof b.preventDefault).toBe('boolean')
    }
  })

  it('has canvas and window scopes', () => {
    const scopes = new Set(BINDINGS.map((b) => b.scope))
    expect(scopes.has('canvas')).toBe(true)
    expect(scopes.has('window')).toBe(true)
  })
})

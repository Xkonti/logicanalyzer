/**
 * Framework-agnostic input manager for the waveform viewer.
 *
 * Maps DOM events to semantic actions via a declarative binding table.
 * Adding a new input means adding one entry to the BINDINGS array —
 * no new listeners, no new classes.
 *
 * Pure JS — no Vue/Quasar/Pinia imports.
 */

/**
 * Returns true if the event target is a text input element.
 * Used to suppress keyboard shortcuts while the user is typing.
 * @param {Event} e
 * @returns {boolean}
 */
export function isTyping(e) {
  const tag = e.target?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return e.target?.isContentEditable === true
}

/**
 * Default binding table — maps DOM events + modifiers to semantic actions.
 *
 * Fields:
 * - event:          DOM event name
 * - scope:          which bind() scope this targets ('canvas', 'window', etc.)
 * - match(e):       predicate — does this binding apply to the event?
 * - action:         semantic action name dispatched to on() handlers
 * - payload(e):     extracts a plain payload object from the DOM event
 * - preventDefault: whether to call e.preventDefault() when matched
 * - options:        addEventListener options (e.g. { passive: false })
 *
 * Array order = priority. First matching binding wins for a given event.
 */
export const BINDINGS = [
  // Shift+Wheel → zoom (primary zoom gesture)
  {
    event: 'wheel',
    scope: 'canvas',
    match: (e) => e.shiftKey && !e.ctrlKey && !e.metaKey,
    action: 'zoom',
    payload: (e) => ({ offsetX: e.offsetX, delta: -e.deltaY }),
    preventDefault: true,
    options: { passive: false },
  },

  // Ctrl/Cmd+Wheel → zoom (pinch-to-zoom on trackpads)
  {
    event: 'wheel',
    scope: 'canvas',
    match: (e) => e.ctrlKey || e.metaKey,
    action: 'zoom',
    payload: (e) => ({ offsetX: e.offsetX, delta: -e.deltaY }),
    preventDefault: true,
    options: { passive: false },
  },

  // Mouse move → cursor tracking
  {
    event: 'mousemove',
    scope: 'canvas',
    match: () => true,
    action: 'cursor-move',
    payload: (e) => ({ offsetX: e.offsetX, offsetY: e.offsetY }),
    preventDefault: false,
  },

  // Mouse leave → hide cursor
  {
    event: 'mouseleave',
    scope: 'canvas',
    match: () => true,
    action: 'cursor-leave',
    payload: () => ({}),
    preventDefault: false,
  },

  // +/= key → zoom in
  {
    event: 'keydown',
    scope: 'window',
    match: (e) => (e.key === '+' || e.key === '=') && !isTyping(e),
    action: 'zoom',
    payload: () => ({ delta: 1 }),
    preventDefault: true,
  },

  // - key → zoom out
  {
    event: 'keydown',
    scope: 'window',
    match: (e) => e.key === '-' && !isTyping(e),
    action: 'zoom',
    payload: () => ({ delta: -1 }),
    preventDefault: true,
  },
]

export class InputManager {
  constructor(bindings = BINDINGS) {
    this._bindings = bindings
    /** @type {Map<string, { element: EventTarget, listeners: Array<{ event: string, handler: Function, options?: object }> }>} */
    this._scopes = new Map()
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map()
  }

  /**
   * Attach DOM listeners for all bindings targeting the given scope.
   * @param {EventTarget} element - DOM element or window
   * @param {string} scope - Scope name (must match binding.scope)
   */
  bind(element, scope) {
    if (this._scopes.has(scope)) {
      this.unbind(scope)
    }

    // Group bindings by event name for this scope
    const eventGroups = new Map()
    for (const binding of this._bindings) {
      if (binding.scope !== scope) continue
      if (!eventGroups.has(binding.event)) {
        eventGroups.set(binding.event, [])
      }
      eventGroups.get(binding.event).push(binding)
    }

    const listeners = []

    for (const [eventName, scopeBindings] of eventGroups) {
      // Merge addEventListener options from all bindings for this event
      let options = undefined
      for (const b of scopeBindings) {
        if (b.options) {
          options = { ...options, ...b.options }
        }
      }

      const handler = (e) => {
        for (const binding of scopeBindings) {
          if (binding.match(e)) {
            if (binding.preventDefault) e.preventDefault()
            const payload = binding.payload(e)
            this._dispatch(binding.action, payload)
            return // first match wins
          }
        }
        // No match — event propagates normally
      }

      element.addEventListener(eventName, handler, options)
      listeners.push({ event: eventName, handler, options })
    }

    this._scopes.set(scope, { element, listeners })
  }

  /**
   * Remove all listeners for a scope.
   * @param {string} scope
   */
  unbind(scope) {
    const entry = this._scopes.get(scope)
    if (!entry) return

    for (const { event, handler, options } of entry.listeners) {
      entry.element.removeEventListener(event, handler, options)
    }
    this._scopes.delete(scope)
  }

  /**
   * Register a handler for a semantic action.
   * @param {string} action
   * @param {Function} handler
   */
  on(action, handler) {
    if (!this._handlers.has(action)) {
      this._handlers.set(action, new Set())
    }
    this._handlers.get(action).add(handler)
  }

  /**
   * Unregister a handler for a semantic action.
   * @param {string} action
   * @param {Function} handler
   */
  off(action, handler) {
    const set = this._handlers.get(action)
    if (set) set.delete(handler)
  }

  /**
   * Dispatch a semantic action to all registered handlers.
   * @param {string} action
   * @param {object} payload
   */
  _dispatch(action, payload) {
    const set = this._handlers.get(action)
    if (!set) return
    for (const handler of set) {
      handler(payload)
    }
  }

  /** Remove all listeners and handlers. */
  dispose() {
    for (const scope of [...this._scopes.keys()]) {
      this.unbind(scope)
    }
    this._handlers.clear()
  }
}

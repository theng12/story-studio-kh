/**
 * Tests for `useFocusTrap` — the shared modal accessibility primitive.
 *
 * Every dialog in the app (ConfirmDialog, generator confirmation, Modal)
 * runs through this. If it breaks, keyboard users get trapped outside
 * modals or can Tab past them into the page underneath — classic
 * accessibility footgun.
 *
 * Runs under happy-dom (registered by __tests__/setup.ts). The composable
 * uses Vue `watch` which schedules through the reactivity system; we
 * `await nextTick()` at each state transition so the watcher gets its turn.
 *
 * Invariants covered:
 *   1. Activating the trap focuses the first focusable element inside.
 *   2. Escape fires the onEscape callback.
 *   3. Tab wraps from last focusable back to first.
 *   4. Shift+Tab wraps from first focusable back to last.
 *   5. Deactivating the trap restores focus to the previously-focused element.
 *   6. Non-Tab / non-Escape keys pass through untouched.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ref, nextTick } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'

function setupContainer(): HTMLElement {
  // A container with three focusable children — enough to exercise wrap in
  // both directions. Each button's textContent doubles as an assertable id.
  document.body.innerHTML = ''
  const outsideTrigger = document.createElement('button')
  outsideTrigger.id = 'outside'
  outsideTrigger.textContent = 'outside'
  document.body.appendChild(outsideTrigger)
  outsideTrigger.focus()

  const container = document.createElement('div')
  container.innerHTML = `
    <button id="first">first</button>
    <input id="middle" />
    <button id="last">last</button>
  `
  document.body.appendChild(container)
  return container
}

function dispatchKey(key: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  document.dispatchEvent(ev)
  return ev
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('useFocusTrap', () => {
  test('activating the trap focuses the first focusable child', async () => {
    const container = setupContainer()
    const containerRef = ref<HTMLElement | null>(container)
    const active = ref(false)
    useFocusTrap(containerRef, active)

    active.value = true
    await nextTick()
    // The trap focuses on a microtask via nextTick; give it one more tick.
    await new Promise<void>((r) => setTimeout(r, 0))

    assert.equal((document.activeElement as HTMLElement)?.id, 'first',
      'first focusable child should receive focus when trap activates')
  })

  test('Escape fires the onEscape callback while the trap is active', async () => {
    const container = setupContainer()
    const containerRef = ref<HTMLElement | null>(container)
    const active = ref(false)
    let escCount = 0
    useFocusTrap(containerRef, active, () => { escCount++ })

    active.value = true
    await nextTick()

    dispatchKey('Escape')
    assert.equal(escCount, 1, 'Escape must invoke the onEscape handler exactly once')

    // Deactivate — further Escape keys must be ignored.
    active.value = false
    await nextTick()
    dispatchKey('Escape')
    assert.equal(escCount, 1, 'Escape after deactivation is ignored')
  })

  test('Tab wraps from the last focusable to the first', async () => {
    const container = setupContainer()
    const containerRef = ref<HTMLElement | null>(container)
    const active = ref(false)
    useFocusTrap(containerRef, active)

    active.value = true
    await nextTick()

    // Manually focus the last element, then Tab — should wrap to first.
    const lastBtn = container.querySelector<HTMLElement>('#last')!
    lastBtn.focus()
    assert.equal((document.activeElement as HTMLElement)?.id, 'last')

    const ev = dispatchKey('Tab')
    assert.equal(ev.defaultPrevented, true, 'trap should preventDefault on the wrap')
    assert.equal((document.activeElement as HTMLElement)?.id, 'first',
      'Tab on the last focusable must wrap to the first')
  })

  test('Shift+Tab wraps from the first focusable to the last', async () => {
    const container = setupContainer()
    const containerRef = ref<HTMLElement | null>(container)
    const active = ref(false)
    useFocusTrap(containerRef, active)

    active.value = true
    await nextTick()

    const firstBtn = container.querySelector<HTMLElement>('#first')!
    firstBtn.focus()
    assert.equal((document.activeElement as HTMLElement)?.id, 'first')

    const ev = dispatchKey('Tab', { shiftKey: true })
    assert.equal(ev.defaultPrevented, true)
    assert.equal((document.activeElement as HTMLElement)?.id, 'last',
      'Shift+Tab on the first focusable must wrap to the last')
  })

  test('deactivating the trap restores focus to the previously-focused element', async () => {
    const container = setupContainer()
    const outside = document.querySelector<HTMLElement>('#outside')!
    assert.equal((document.activeElement as HTMLElement)?.id, 'outside',
      'setupContainer starts with focus on the outside trigger')

    const containerRef = ref<HTMLElement | null>(container)
    const active = ref(false)
    useFocusTrap(containerRef, active)

    active.value = true
    await nextTick()
    await new Promise<void>((r) => setTimeout(r, 0))
    assert.equal((document.activeElement as HTMLElement)?.id, 'first',
      'focus moves into the trap on activation')

    active.value = false
    await nextTick()
    assert.equal((document.activeElement as HTMLElement)?.id, 'outside',
      'focus returns to the triggering element when the trap deactivates')
  })

  test('non-Tab / non-Escape keys are not intercepted', async () => {
    const container = setupContainer()
    const containerRef = ref<HTMLElement | null>(container)
    const active = ref(false)
    let escCount = 0
    useFocusTrap(containerRef, active, () => { escCount++ })

    active.value = true
    await nextTick()

    // An arbitrary letter key must pass through — no focus change, no escape
    // callback, no preventDefault.
    ;(container.querySelector<HTMLElement>('#first'))!.focus()
    const ev = dispatchKey('a')
    assert.equal(ev.defaultPrevented, false, 'non-trap keys must not be preventDefault()ed')
    assert.equal((document.activeElement as HTMLElement)?.id, 'first',
      'typing a letter should not move focus')
    assert.equal(escCount, 0)
  })
})

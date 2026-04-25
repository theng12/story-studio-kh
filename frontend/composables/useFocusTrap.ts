/**
 * Focus trap for modals. Keeps keyboard focus inside the modal container
 * while it's open. Listens for Escape to fire onEscape. Restores focus to
 * the previously-focused element when trap is released.
 *
 * Usage:
 *   const modalRef = ref<HTMLElement | null>(null)
 *   const visible = ref(false)
 *   useFocusTrap(modalRef, visible, () => { visible.value = false })
 */

// Explicit Vue imports so this module is usable from plain node:test (no
// Nuxt auto-import context). Nuxt's auto-imports remain additive inside
// .vue files.
import { watch, nextTick, onBeforeUnmount, type Ref } from 'vue'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  onEscape?: () => void,
) {
  let previouslyFocused: Element | null = null

  function getFocusable(): HTMLElement[] {
    const el = containerRef.value
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(e => !e.hasAttribute('disabled') && e.offsetParent !== null)
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (!active.value) return

    if (ev.key === 'Escape') {
      ev.preventDefault()
      onEscape?.()
      return
    }

    if (ev.key !== 'Tab') return
    const focusable = getFocusable()
    if (focusable.length === 0) {
      ev.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    const current = document.activeElement as HTMLElement | null

    if (ev.shiftKey && current === first) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && current === last) {
      ev.preventDefault()
      first.focus()
    }
  }

  watch(active, (isActive) => {
    if (typeof document === 'undefined') return
    if (isActive) {
      previouslyFocused = document.activeElement
      // Focus the first focusable element on next tick (after modal renders)
      nextTick(() => {
        const focusable = getFocusable()
        focusable[0]?.focus()
      })
      document.addEventListener('keydown', onKeyDown)
    } else {
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the element that opened the modal
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
      previouslyFocused = null
    }
  }, { immediate: true })

  onBeforeUnmount(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onKeyDown)
    }
  })
}

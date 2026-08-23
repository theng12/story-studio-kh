import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Close a native <details> menu when you click away from it, or press Escape.
 *
 * A `<details>/<summary>` dropdown does NOT close on an outside click — that is
 * the element's specified behaviour, not a bug in it. Every other menu on the
 * platform does, so a menu built this way reads as stuck: the owner's words,
 * "i can't click off for dismiss. it's needs me to click More again to
 * dismiss. annoying."
 *
 * Deliberately document-level and selector-based rather than a ref per menu:
 * the same markup appears in more than one component, and a fix that has to be
 * remembered at each call site is a fix that will be missed at the next one.
 * Any <details> matching `selector` that does not contain the pointer target is
 * closed.
 */
export function useDismissableDetails(selector = 'details.preset-more'): void {
  function closeOthers(target: EventTarget | null): void {
    const node = target instanceof Node ? target : null
    for (const element of Array.from(document.querySelectorAll<HTMLDetailsElement>(selector))) {
      if (!element.open) continue
      if (node && element.contains(node)) continue
      element.open = false
    }
  }

  function onPointerDown(event: PointerEvent): void {
    closeOthers(event.target)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // Escape closes the menu wherever the focus is, which is what a keyboard
    // user expects and what makes this reachable without a mouse at all.
    closeOthers(null)
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown)
  })
}

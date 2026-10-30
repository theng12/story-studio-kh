/**
 * A remembered Cards / List choice.
 *
 * The owner's standing rule, 2026-10-30: "everything that can be a visual
 * option, must be a visual option." A view switch is only useful if it stays
 * where the customer put it, so the choice is stored per page and restored
 * before the grid renders. It is a preference, never data: if storage is
 * unavailable (private mode, a locked profile) the page simply opens in the
 * fallback view.
 */
import { ref, watch, type Ref } from 'vue'

export type ViewMode = 'cards' | 'list'

export function useViewMode(storageKey: string, fallback: ViewMode = 'cards'): Ref<ViewMode> {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(storageKey)
  } catch {
    // Private mode or a locked profile: the fallback view is correct, not an error.
  }
  const mode = ref<ViewMode>(stored === 'list' || stored === 'cards' ? stored : fallback)
  watch(mode, value => {
    try {
      localStorage.setItem(storageKey, value)
    } catch {
      // A remembered choice that cannot be saved must not break the page.
    }
  })
  return mode
}

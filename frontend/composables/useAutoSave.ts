/**
 * Debounced auto-save helper.
 *
 * Usage:
 *   const { state, scheduleSave, flush } = useAutoSave({
 *     debounceMs: 400,
 *     save: async () => { await api.put(...) },
 *   })
 *
 * - Call scheduleSave() whenever a watched value changes; it coalesces rapid
 *   calls into one save after the debounce window.
 * - state is reactive: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
 * - savedAt is the timestamp of the last successful save (for "Saved just now" text).
 *
 * Flush-on-unload: when invoked from a component setup() scope, registers
 * `beforeunload` and `visibilitychange → hidden` listeners that fire any
 * pending debounced save before the window dies. This is what stops a
 * cmd-Q within the debounce window from silently dropping the last edit.
 * Listeners are torn down on scope dispose.
 */

// Explicit Vue imports so this module is usable from plain node:test (no
// Nuxt auto-import context). Nuxt's auto-imports remain additive inside
// .vue files. `getCurrentScope`/`onScopeDispose` are no-ops outside an
// effect scope, so the test environment is unaffected.
import { ref, onScopeDispose, getCurrentScope } from 'vue'

export type AutoSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface UseAutoSaveOptions {
  debounceMs?: number
  save: () => Promise<void>
  onError?: (err: unknown) => void
}

export function useAutoSave(opts: UseAutoSaveOptions) {
  const state = ref<AutoSaveState>('idle')
  const savedAt = ref<number | null>(null)
  const errorMessage = ref('')
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false

  async function doSave() {
    if (pending) return // coalesce
    pending = true
    state.value = 'saving'
    errorMessage.value = ''
    try {
      await opts.save()
      state.value = 'saved'
      savedAt.value = Date.now()
    } catch (e: any) {
      state.value = 'error'
      errorMessage.value = e?.data?.detail || e?.message || 'Save failed'
      opts.onError?.(e)
    } finally {
      pending = false
    }
  }

  function scheduleSave() {
    state.value = 'dirty'
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; doSave() }, opts.debounceMs ?? 400)
  }

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    await doSave()
  }

  function reset() {
    state.value = 'idle'
    savedAt.value = null
    errorMessage.value = ''
  }

  // Flush-on-unload. Best-effort: beforeunload is synchronous, so we kick
  // off the save without awaiting and let the in-flight request finish if
  // the OS/network can. Don't preventDefault / don't set returnValue —
  // that would trigger Electron's "are you sure?" dialog. Skipped entirely
  // outside a browser scope (SSR, node:test).
  if (typeof window !== 'undefined' && getCurrentScope()) {
    const flushPending = () => {
      if (timer) {
        clearTimeout(timer); timer = null
        doSave().catch(err => {
          try { console.warn('[useAutoSave] flush-on-unload failed', err) } catch {}
        })
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPending()
    }
    window.addEventListener('beforeunload', flushPending)
    document.addEventListener('visibilitychange', onVisibility)
    onScopeDispose(() => {
      window.removeEventListener('beforeunload', flushPending)
      document.removeEventListener('visibilitychange', onVisibility)
    })
  }

  return { state, savedAt, errorMessage, scheduleSave, flush, reset }
}

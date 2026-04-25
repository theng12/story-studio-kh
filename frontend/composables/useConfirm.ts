/**
 * In-app confirmation dialog — promise-based, themed, focus-trapped.
 *
 * Use this (not `window.confirm`) for every destructive action. In Electron
 * the native `confirm()` dialog blocks the renderer thread, ignores the app
 * theme, and has no keyboard focus trap. This composable pairs with
 * `ConfirmDialog.vue` (mounted globally in `app.vue`) to render a custom
 * modal and resolve a boolean when the user chooses.
 *
 * Usage:
 *   const { ask } = useConfirm()
 *   if (!await ask({
 *     title: 'Delete project?',
 *     message: `"${project.name}" and all its episodes will be removed.`,
 *     confirmLabel: 'Delete',
 *     danger: true,
 *   })) return
 */

// Explicit imports so this module is usable from plain node:test (no Nuxt
// auto-import context). Nuxt's auto-imports remain additive inside .vue
// components — they still resolve `reactive` and `readonly` without this line.
import { reactive, readonly } from 'vue'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red styling + "are you sure" tone. Use for irreversible actions. */
  danger?: boolean
  /**
   * When set, renders a "don't ask again" checkbox. The composable itself
   * does not persist the choice — callers (typically the `useConfirmSkip`
   * wrapper) read `consumeRemember()` after the promise resolves and wire
   * it into `config.confirmation_preferences`. Kept purely presentational
   * here so the core state machine stays trivial to test.
   */
  remember?: { label?: string }
}

interface ConfirmState {
  visible: boolean
  options: ConfirmOptions
  rememberChecked: boolean
  resolve: ((value: boolean) => void) | null
}

// Singleton — only one confirm dialog can be open at a time. If a second
// `ask()` lands while one is already open, the prior one is auto-rejected
// (treated as Cancel) to keep the state machine simple.
const state = reactive<ConfirmState>({
  visible: false,
  options: { title: '' },
  rememberChecked: false,
  resolve: null,
})

// Snapshot of `rememberChecked` at the moment confirm()/cancel() fires.
// `confirm()` clears `state.rememberChecked` so the checkbox doesn't leak
// into the next dialog — without this latch, the wrapper composable would
// read `false` every time. `consumeRemember()` returns the snapshot once
// and resets it, so repeat reads can't double-persist.
let lastRemember = false

export function useConfirm() {
  function ask(opts: ConfirmOptions): Promise<boolean> {
    // If a dialog is already open, resolve the previous promise to `false`
    // before repurposing the state for the new request.
    if (state.resolve) {
      state.resolve(false)
      state.resolve = null
    }
    state.options = {
      confirmLabel: opts.danger ? 'Delete' : 'Confirm',
      cancelLabel: 'Cancel',
      ...opts,
    }
    state.rememberChecked = false
    state.visible = true
    return new Promise<boolean>((resolve) => {
      state.resolve = resolve
    })
  }

  function confirm() {
    lastRemember = state.rememberChecked
    state.visible = false
    state.resolve?.(true)
    state.resolve = null
    state.rememberChecked = false
  }

  function cancel() {
    lastRemember = false
    state.visible = false
    state.resolve?.(false)
    state.resolve = null
    state.rememberChecked = false
  }

  function toggleRemember() {
    state.rememberChecked = !state.rememberChecked
  }

  /** One-shot read of the checkbox state from the most recently resolved
   *  dialog. Returns `false` after the first read, so repeat calls can't
   *  double-persist. Only meaningful when called synchronously after an
   *  `await ask(...)` — by the next dialog, it's already been consumed. */
  function consumeRemember(): boolean {
    const v = lastRemember
    lastRemember = false
    return v
  }

  return {
    state: readonly(state) as ConfirmState,
    ask,
    confirm,
    cancel,
    toggleRemember,
    consumeRemember,
  }
}

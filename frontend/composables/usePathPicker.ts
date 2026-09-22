/**
 * Branching path picker — same callsite shape regardless of mode.
 *
 *   const path = await pickFolder({ title: 'Choose project root' })
 *   const path = await pickFile({ extensions: ['.json'] })
 *   const paths = await pickFiles({ extensions: ['.png', '.jpg'] })
 *
 * In default (Electron) mode, each call POSTs to the existing
 * /system/pick-folder, /system/pick-file, /system/pick-files routes which
 * spawn the native macOS dialog.
 *
 * In server mode (browser, no native dialog), the call shows the
 * <FileBrowserModal> singleton mounted in app.vue and resolves with the
 * user's pick. Callers can't tell the difference.
 *
 * The modal is driven by a small reactive store in this file. Only one
 * picker is active at a time (the most recent open call cancels older
 * ones, returning null to their resolvers).
 */

import { reactive } from 'vue'
import { isServerMode } from './useServerMode'

export type PickerMode = 'dir' | 'file' | 'files'

export interface PickerOptions {
  title?: string
  initial_path?: string
  /** Restrict the file list to these extensions (with or without leading dot). */
  extensions?: string[]
  /** Override the Confirm button label. */
  button_label?: string
}

interface PickerState {
  isOpen: boolean
  mode: PickerMode
  options: PickerOptions
  /** Resolves when the modal closes. `null` for cancel; otherwise the picked path(s). */
  resolve: ((value: any) => void) | null
}

const _state = reactive<PickerState>({
  isOpen: false,
  mode: 'dir',
  options: {},
  resolve: null,
})

export function usePickerState() {
  return _state
}

/**
 * Open the modal in `mode` and await the user's selection.
 * Returns `null` on cancel (folder/file mode), `[]` on cancel (files mode).
 */
function openModal<T>(mode: PickerMode, options: PickerOptions): Promise<T> {
  // If a previous picker is still open, cancel it before stealing the slot.
  if (_state.resolve) {
    try { _state.resolve(mode === 'files' ? [] : null) } catch { /* swallow */ }
    _state.resolve = null
  }
  return new Promise<T>((resolve) => {
    _state.mode = mode
    _state.options = options
    _state.resolve = resolve as (v: any) => void
    _state.isOpen = true
  })
}

/**
 * Resolve the active picker with a value and close the modal. Called by
 * FileBrowserModal's Cancel + Confirm handlers.
 */
export function resolvePicker(value: any): void {
  const r = _state.resolve
  _state.resolve = null
  _state.isOpen = false
  if (r) r(value)
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function pickFolder(opts: PickerOptions = {}): Promise<string | null> {
  if (isServerMode()) {
    return openModal<string | null>('dir', opts)
  }
  const r = await $fetch('/api/system/pick-folder', {
    method: 'POST',
    body: {
      title: opts.title,
      buttonLabel: opts.button_label,
      defaultPath: opts.initial_path,
    },
  }) as { path: string | null }
  return r.path
}

export async function pickFile(opts: PickerOptions = {}): Promise<string | null> {
  if (isServerMode()) {
    return openModal<string | null>('file', opts)
  }
  const filters = opts.extensions?.length
    ? [{ name: 'Allowed', extensions: opts.extensions.map(e => e.startsWith('.') ? e.slice(1) : e) }]
    : undefined
  const r = await $fetch('/api/system/pick-file', {
    method: 'POST',
    body: { title: opts.title, buttonLabel: opts.button_label, filters },
  }) as { path: string | null }
  return r.path
}

export async function pickFiles(opts: PickerOptions = {}): Promise<string[]> {
  if (isServerMode()) {
    return openModal<string[]>('files', opts)
  }
  const filters = opts.extensions?.length
    ? [{ name: 'Allowed', extensions: opts.extensions.map(e => e.startsWith('.') ? e.slice(1) : e) }]
    : undefined
  const r = await $fetch('/api/system/pick-files', {
    method: 'POST',
    body: { title: opts.title, buttonLabel: opts.button_label, filters },
  }) as { paths: string[] }
  return r.paths || []
}

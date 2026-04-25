/**
 * Toast notification composable.
 * Also translates common raw API/network errors into friendlier user messages.
 *
 * Supports two shapes:
 *   - Fire-and-forget: `success`, `error`, `info` — show a timed toast.
 *   - Undoable: `successUndoable({...})` — Gmail-style optimistic toast with
 *     an inline Undo button. The destructive backend call is deferred until
 *     the toast times out, so Undo is just "don't do it". See the helper
 *     for the recommended call pattern.
 */

// Explicit imports so this module is usable from plain node:test (no Nuxt
// auto-import context). Nuxt's auto-imports remain additive inside .vue
// components — they still resolve `ref` and `readonly` without this line,
// just like before.
import { ref, readonly } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
  /** Bound when the toast carries an Undo affordance. Closes the toast too. */
  onUndo?: () => void | Promise<void>
  /**
   * Generic inline action button (e.g. "Reload", "Retry"). Separate from
   * `onUndo` so the undo-specific Cmd+Z hotkey only fires for literal
   * undo — actions with other semantics aren't keyboard-reachable but
   * they stay clearly labelled in the toast itself.
   */
  action?: { label: string; onClick: () => void | Promise<void> }
}

const toasts = ref<Toast[]>([])
let nextId = 0

export interface UndoableOptions {
  message: string
  /**
   * Called if the user clicks Undo. Typical responsibility: restore any
   * optimistic UI state the caller mutated before showing the toast. The
   * destructive backend call should NOT have happened yet — defer it to
   * `onTimeout` so Undo truly means "do nothing".
   */
  onUndo: () => void | Promise<void>
  /**
   * Called when the toast expires without the user clicking Undo. This is
   * where the real destructive backend call belongs. Errors thrown from
   * here should restore UI state and surface a human message — the toast
   * is already gone by the time it runs.
   */
  onTimeout?: () => void | Promise<void>
  /** Undo window in ms. Default 5s — long enough to notice, short enough
   *  that abandoned tabs don't hoard deletions forever. */
  duration?: number
}

/**
 * Map raw backend/API errors to user-friendly versions.
 * Returns the input unchanged if no translation applies.
 */
function humanizeError(raw: string): string {
  if (!raw) return 'Something went wrong. Please try again.'
  const s = String(raw)

  // Network / connectivity
  if (/network|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(s)) {
    return "Can't reach the server. Check your internet connection and try again."
  }

  // Missing API keys (backend's standard message format)
  if (/No (OpenAI|Anthropic|kie\.ai|fal\.ai) API key configured/i.test(s)) {
    const match = s.match(/No (OpenAI|Anthropic|kie\.ai|fal\.ai) API key/i)
    const provider = match ? match[1] : 'API'
    return `${provider} API key missing. Add one in Settings → API Keys.`
  }

  // Auth errors
  if (/401|invalid.*api[ _]?key|unauthori[sz]ed|invalid x-api-key|Incorrect API key/i.test(s)) {
    return 'API key is invalid or expired. Check it in Settings → API Keys.'
  }

  // Rate limits
  if (/429|rate[ _]?limit|quota|too many requests/i.test(s)) {
    return 'API rate limit hit. Wait a minute and try again, or upgrade your plan.'
  }

  // Overloaded / server errors
  if (/overloaded|503|service unavailable/i.test(s)) {
    return 'The AI service is overloaded. Try again in a few minutes.'
  }
  if (/5\d\d|server_error|internal server/i.test(s) && !/4\d\d/.test(s)) {
    return 'Server error. Try again shortly. If it persists, check the Jobs tab for details.'
  }

  // Insufficient credits
  if (/insufficient|not enough credit|balance too low/i.test(s)) {
    return 'Not enough credits on your account. Top up or switch to a cheaper model.'
  }

  // Duplicate / already queued
  if (/already queued|already running|409/i.test(s)) {
    return 'This job is already running or queued. Check the Jobs tab.'
  }

  // FFmpeg
  if (/FFmpeg not found|ffmpeg.*not.*installed/i.test(s)) {
    return 'FFmpeg is required but not found. Install it in Settings → FFmpeg.'
  }

  // Disk space
  if (/ENOSPC|no space left/i.test(s)) {
    return 'Out of disk space. Free up storage and try again.'
  }

  // Default: pass through (already readable)
  return s
}

export function useToast() {
  function show(message: string, type: Toast['type'] = 'info', duration = 5000) {
    const id = nextId++
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }

  function success(message: string) { show(message, 'success') }
  function error(message: string) { show(humanizeError(message), 'error', 7000) }
  function info(message: string) { show(message, 'info') }

  /**
   * Toast with a named action button. The toast stays open until the user
   * clicks the action, clicks the background toast (no auto-dismiss), or
   * the caller removes it manually via `dismiss(id)`. Useful for async
   * state we want the user to acknowledge — "Project updated on another
   * device → [Reload]" — without stealing modal focus.
   */
  function showAction(
    message: string,
    actionLabel: string,
    onClick: () => void | Promise<void>,
    type: Toast['type'] = 'info',
  ): number {
    const id = nextId++
    const wrapped = async () => {
      try { await onClick() } finally { dismiss(id) }
    }
    toasts.value.push({ id, message, type, action: { label: actionLabel, onClick: wrapped } })
    return id
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  /**
   * Undoable toast — the Gmail pattern.
   *
   * Caller flow:
   *   1. Mutate the local UI optimistically (remove the row, etc.).
   *   2. Call successUndoable({ message, onUndo, onTimeout }).
   *   3. onUndo: restore local UI. Called only if the user clicks Undo.
   *   4. onTimeout: do the actual backend destructive call. Called when the
   *      toast expires. If it throws, restore UI and surface an error toast.
   *
   * We intentionally debounce the backend call by `duration` ms so Undo
   * is cost-free: nothing to un-delete if we never deleted.
   */
  function successUndoable(opts: UndoableOptions): void {
    const id = nextId++
    const duration = opts.duration ?? 5000
    let resolved = false

    const timer = setTimeout(async () => {
      if (resolved) return
      resolved = true
      toasts.value = toasts.value.filter(t => t.id !== id)
      try {
        await opts.onTimeout?.()
      } catch (e: any) {
        // Failure mode: the user abandoned the toast trusting the delete
        // would complete, but the backend rejected. Restore UI via onUndo
        // and tell the user what happened.
        try { await opts.onUndo() } catch { /* already broken; best-effort */ }
        show(humanizeError(e?.data?.detail || e?.message || 'Action failed'), 'error', 7000)
      }
    }, duration)

    const undo = async () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      toasts.value = toasts.value.filter(t => t.id !== id)
      try { await opts.onUndo() } catch { /* caller's UI is their problem */ }
    }

    toasts.value.push({ id, type: 'success', message: opts.message, onUndo: undo })
  }

  return { toasts: readonly(toasts), show, success, error, info, showAction, dismiss, successUndoable, humanizeError }
}

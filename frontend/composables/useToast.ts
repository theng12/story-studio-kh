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
import { currentGatewayUrl } from './useNetworkStatus.js'
import { customerSafeJobText } from '../utils/job-presentation.js'

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
  /** The original message when `message` is a friendlier rewrite; shown as the toast tooltip. */
  raw?: string
}

const toasts = ref<Toast[]>([])
let nextId = 0

/**
 * At most this many toasts show at once; the rest collapse into "+N more",
 * which opens the bell. Eleven failure toasts once stacked over the whole
 * Jobs page (owner, 2026-10-03). The bell keeps every job record, so a toast
 * is only ever a heads-up and may always be closed or expire.
 */
export const TOAST_VISIBLE_LIMIT = 3
/** Action toasts ("Open job") used to stay until clicked; now they expire too. */
export const ACTION_TOAST_MS = 8000

/** The newest `limit` toasts to show, and how many older ones are folded away. */
export function splitToasts<T>(list: readonly T[], limit = TOAST_VISIBLE_LIMIT): { visible: T[]; hidden: number } {
  const hidden = Math.max(0, list.length - limit)
  return { visible: list.slice(hidden), hidden }
}

// v1.0.124+ — Dedupe identical error messages within a short window.
// Polling loops + watchers that hit a 404 every tick were generating a
// constant stream of identical toasts (the symptom that surfaced this
// fix was a "Project not found" toast firing every 5 seconds on the
// B-Roll picker page). The dedupe is keyed on the FINAL message string
// (post-humanizeError) so two callers that surface the same underlying
// problem still collapse to one toast.
const _recentErrorAt = new Map<string, number>()
const ERROR_DEDUPE_WINDOW_MS = 3000

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

// A bare `401` / `5\d\d` also matches EP0401, 1536x1024 and "4096 bytes", so a status
// only counts when it follows HTTP / "status" / "error".
const httpStatus = (codes: string) =>
  new RegExp(`(?:\\bHTTP[ /]?(?:\\d\\.\\d )?|\\bstatus(?: code)?[ :=]*|\\berror[ :=]+)(?:${codes})\\b`, 'i')
const HTTP_401 = httpStatus('401')
const HTTP_429 = httpStatus('429')
const HTTP_503 = httpStatus('503')
const HTTP_5XX = httpStatus('5\\d\\d')
const HTTP_409 = httpStatus('409')

/**
 * Map raw backend/API errors to user-friendly versions.
 * Returns the input unchanged if no translation applies.
 */
function humanizeError(raw: string): string {
  if (!raw) return 'Something went wrong. Please try again.'
  const s = String(raw)

  // Network / connectivity. Name the address this app actually tried — a stale address and a
  // stopped Gateway read the same without it (owner, 2026-11-13).
  if (/network|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(s)) {
    const address = currentGatewayUrl()
    return address
      ? `Gateway not reachable at ${address} — is the Gateway app running on that Mac?`
      : 'Gateway not reachable — is the Gateway app running?'
  }

  // Missing API key (backend's standard message format).
  //
  // This used to capture a vendor name out of the message and repeat it back
  // to the customer. That branch was dead twice over: the four vendors it
  // matched were upstream routing identities the customer must never see, and
  // since the GenStudio-only migration no backend string names any of them —
  // every generation travels over one gateway and `hasAnyTextProviderKey()`
  // checks one key. So it now matches the messages the backend actually emits
  // and states the one true thing: the missing connection key is the Gateway API Key.
  if (/\bNo\b[^.]{0,40}\bAPI key configured\b/i.test(s)) {
    return 'Gateway API Key missing. Add it in Settings → This Mac.'
  }

  // Auth errors
  if (HTTP_401.test(s) || /invalid.*api[ _]?key|unauthori[sz]ed|invalid x-api-key|Incorrect API key/i.test(s)) {
    return 'Gateway API Key is invalid or expired. Check it in Settings → This Mac.'
  }

  // Rate limits
  if (HTTP_429.test(s) || /rate[ _]?limit|quota|too many requests/i.test(s)) {
    return 'API rate limit hit. Wait a minute and try again, or upgrade your plan.'
  }

  // Overloaded / server errors
  if (HTTP_503.test(s) || /overloaded|service unavailable/i.test(s)) {
    return 'The AI service is overloaded. Try again in a few minutes.'
  }
  if (HTTP_5XX.test(s) || /server_error|internal server/i.test(s)) {
    return 'Server error. Try again shortly. If it persists, check the Jobs tab for details.'
  }

  // Insufficient credits
  if (/insufficient|not enough credit|balance too low/i.test(s)) {
    return 'Not enough credits on your account. Top up or switch to a cheaper model.'
  }

  // Duplicate / already queued
  if (HTTP_409.test(s) || /already queued|already running/i.test(s)) {
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
  function show(message: string, type: Toast['type'] = 'info', duration = 5000, raw?: string) {
    const id = nextId++
    toasts.value.push({ id, message: customerSafeJobText(message), type, raw })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }

  function success(message: string) { show(message, 'success') }
  function error(message: string) {
    // v1.0.125+ — Slug-race sentinel from useApi. Surfaces when a caller
    // built a URL like `/projects/${slug}/...` before route.params.slug
    // had resolved — useApi short-circuits these BEFORE fetching and
    // throws an error whose message is the sentinel. Common patterns
    // (`e?.data?.detail || e?.message || 'fallback'`) all carry the
    // sentinel through to here, so a substring check catches every
    // shape. Silent return — these are never user-actionable.
    if (typeof message === 'string' && message.includes('__slug_race__')) return
    const final = humanizeError(message)
    // v1.0.124+ — Dedupe + diagnostic. Same error within 3s short-circuits.
    // Stack trace logged so dev-tools can identify any mystery toast source
    // (the original use case: a "Project not found" toast was firing every
    // 5s on the broll page from an unknown caller — static grep couldn't
    // find the call site, so the trace is the fast path forward).
    const now = Date.now()
    const last = _recentErrorAt.get(final) ?? 0
    if (now - last < ERROR_DEDUPE_WINDOW_MS) {
      // Keep the dev signal even on dedupe — the user might be debugging
      // a fast-firing loop and wants to see how often it actually triggers.
      // eslint-disable-next-line no-console
      console.warn('[useToast.error] (deduped)', final)
      return
    }
    _recentErrorAt.set(final, now)
    // Prune old entries occasionally so the map doesn't grow unbounded
    // across long sessions.
    if (_recentErrorAt.size > 50) {
      for (const [k, ts] of _recentErrorAt) {
        if (now - ts > ERROR_DEDUPE_WINDOW_MS * 5) _recentErrorAt.delete(k)
      }
    }
    // eslint-disable-next-line no-console
    console.warn('[useToast.error]', final, '\n', new Error('toast trace').stack)
    show(final, 'error', 7000, final !== message ? message : undefined)
  }
  function info(message: string) { show(message, 'info') }

  /**
   * Toast with a named action button ("Open job", "View jobs"). Closes on the
   * action, on its ✕, or after `duration` ms — the record it points at lives
   * on in the bell / Jobs page, so the toast never has to wait for a click.
   */
  function showAction(
    message: string,
    actionLabel: string,
    onClick: () => void | Promise<void>,
    type: Toast['type'] = 'info',
    duration = ACTION_TOAST_MS,
  ): number {
    const id = nextId++
    const wrapped = async () => {
      try { await onClick() } finally { dismiss(id) }
    }
    toasts.value.push({ id, message: customerSafeJobText(message), type, action: { label: actionLabel, onClick: wrapped } })
    setTimeout(() => dismiss(id), duration)
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
        const raw = e?.data?.detail || e?.message || 'Action failed'
        show(humanizeError(raw), 'error', 7000, raw)
      }
    }, duration)

    const undo = async () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      toasts.value = toasts.value.filter(t => t.id !== id)
      try { await opts.onUndo() } catch { /* caller's UI is their problem */ }
    }

    toasts.value.push({ id, type: 'success', message: customerSafeJobText(opts.message), onUndo: undo })
  }

  return { toasts: readonly(toasts), show, success, error, info, showAction, dismiss, successUndoable, humanizeError }
}

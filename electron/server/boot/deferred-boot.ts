/**
 * Deferred boot work (1.4.402, owner-approved startup deferral).
 *
 * The boot recovery sweep and the background catalogue warmups used to start
 * while the window was still loading. They are now registered here at boot
 * and started only when the main process signals the window's first paint
 * (`did-finish-load`) — or, in standalone server mode which has no window,
 * one macrotask after the listen callback returns. Nothing is skipped: every
 * item logs one line when it is scheduled and one when it actually runs, with
 * the item name and how long the defer was. The defer itself is signal-driven;
 * there is no timer or sleep in the wait.
 */
import { logLine } from '../services/logger.js'

export type DeferredBootItem = {
  name: string
  run: () => Promise<unknown>
}

const pending: Array<DeferredBootItem & { registeredAt: number }> = []
let startedAt: number | null = null

export function registerDeferredBootWork(item: DeferredBootItem): void {
  logLine('info', 'deferred boot work scheduled', { item: item.name })
  const entry = { ...item, registeredAt: Date.now() }
  if (startedAt !== null) {
    // First paint already happened (dev loadURL resolves after the event
    // fires): run now rather than never.
    startItem(entry, 'first paint already passed')
    return
  }
  pending.push(entry)
}

export function signalBootFirstPaint(trigger: string): void {
  if (startedAt !== null) return
  startedAt = Date.now()
  const waiting = pending.splice(0)
  if (waiting.length === 0) {
    logLine('info', 'deferred boot work: nothing waiting at first paint', { trigger })
    return
  }
  for (const entry of waiting) startItem(entry, trigger)
}

function startItem(entry: DeferredBootItem & { registeredAt: number }, trigger: string): void {
  const deferMs = (startedAt ?? Date.now()) - entry.registeredAt
  logLine('info', 'deferred boot work starting after first paint', {
    item: entry.name, defer_ms: deferMs, trigger,
  })
  // Each item keeps its own error handling; this backstop only turns an
  // escaping failure into a log line instead of an unhandled rejection.
  void entry.run().catch(error => logLine('error', 'deferred boot work failed', {
    item: entry.name, error: String((error as Error)?.message || error),
  }))
}

/** Test-only: reset the seam between focused tests (see updater's _setToolRunnerForTesting). */
export function _resetDeferredBootWorkForTesting(): void {
  pending.length = 0
  startedAt = null
}

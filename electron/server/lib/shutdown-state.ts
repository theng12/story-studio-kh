/**
 * Shutdown is a bounded state, not an open-ended one.
 *
 * Production (angkor, 2026-11-19) sampled a frozen app whose main thread sat in
 * `_handleAEQuit -> _terminateFromSender:askIfShouldTerminate:saveWindows:` — an Apple Event quit that
 * never finished. That one fact explains every symptom: SIGTERM ignored (the same terminate path),
 * the updater's "the app did not quit", and a maintenance hold that never answered while the app was
 * mid-quit.
 *
 * So shutdown never waits without a ceiling. This module records that a shutdown has begun, answers
 * the maintenance hold immediately with a plain sentence while it runs, and ends the process at its
 * own deadline — naming what was still in flight so the next start can follow it.
 */

export interface ShutdownSnapshot {
  beganAt: number
  inFlight: string[]
}

let state: ShutdownSnapshot | null = null
let deadlineTimer: (() => void) | null = null

export function beginShutdown(inFlight: string[]): ShutdownSnapshot {
  if (state) return state
  state = { beganAt: Date.now(), inFlight: [...inFlight] }
  return state
}

export function isShuttingDown(): boolean {
  return state !== null
}

/** Plain words for anything that asks while the app is quitting. */
export function shutdownSentence(): string {
  return 'Story is quitting; the update installs after it exits.'
}

export function shutdownSnapshot(): ShutdownSnapshot | null {
  return state
}

/** The owner cancelled the quit: nothing is shutting down and no deadline stands. */
export function cancelShutdown(): void {
  deadlineTimer?.()
  deadlineTimer = null
  state = null
}

/** Test-only: forget the state between cases. */
export function _resetShutdownStateForTests(): void {
  deadlineTimer?.()
  deadlineTimer = null
  state = null
}

/**
 * The hard ceiling on a quit. `exit` must not go through Electron's graceful quit: the native
 * terminate path is what hung, so the deadline calls the process-exit function directly.
 *
 * Injected so a test crosses it in milliseconds; `schedule` returns a cancel function.
 */
export function armShutdownDeadline(options: {
  deadlineMs: number
  exit: (code: number) => void
  log: (message: string, meta?: Record<string, unknown>) => void
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
}): () => void {
  const { deadlineMs, exit, log } = options
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return () => clearTimeout(timer)
  })
  const cancel = schedule(() => {
    const snapshot = state
    const waitedS = snapshot ? Math.round((now() - snapshot.beganAt) / 1000) : Math.round(deadlineMs / 1000)
    const ids = snapshot?.inFlight?.length ? snapshot.inFlight.join(', ') : 'nothing'
    log(`Story did not finish quitting within ${waitedS} s; still in flight: ${ids}. Exiting now so the next start can follow them.`, {
      in_flight: snapshot?.inFlight ?? [],
      waited_s: waitedS,
    })
    exit(1)
  }, deadlineMs)
  deadlineTimer = cancel
  return cancel
}

/**
 * Visibility for shared waits.
 *
 * A caller that queues behind a shared resource — a per-path lock, an
 * in-flight settings read — used to do so silently: no log, no surface, no
 * way to tell a busy moment from a wait that never ends. This module
 * registers those waits, says ONE line when one crosses `stall_log_seconds`,
 * and keeps them readable through `currentWaits()` (the health surface) and
 * `describeRequestHold()` (the request deadline). It observes waits; it never
 * cancels, times out or resolves one.
 *
 * The threshold is held in memory and handed in by `server-timeouts.ts`, which owns
 * the setting read. This module deliberately imports nothing from services/: a lock
 * primitive that pulled the settings store in would drag job-queue and every
 * content-pack loader into anything importing `atomic-store` — including the
 * frontend's type program, through models/types.ts.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The line goes to whatever reporter boot installs (the app's own log). A default
 * keeps the watcher usable on its own, and — more importantly — keeps `services/`
 * out of this module's import graph: `logger` reaches project-manager, and through
 * it the content packs, which the frontend's type program would inherit via
 * models/types.ts -> task-manifest -> atomic-store.
 */
type StallReporter = (level: 'warn', message: string, meta?: Record<string, unknown>) => void
let report: StallReporter = (level, message, meta) => console[level](message, meta ?? '')
export function setStallReporter(fn: StallReporter | null): void {
  report = fn ?? ((level, message, meta) => console[level](message, meta ?? ''))
}

export const STALL_LOG_SECONDS_KEY = 'stall_log_seconds'
export const STALL_LOG_SECONDS_DEFAULT = 10
export const STALL_LOG_SECONDS_MIN = 1
export const STALL_LOG_SECONDS_MAX = 86_400

interface StallWait {
  key: string
  operation: string
  label?: string
  startedAt: number
  holderStartedAtMs?: number
  refs: number
  logged: boolean
  active: boolean
  cancelTimer?: () => void
}

export interface CurrentWait {
  operation: string
  label: string | null
  waited_ms: number
}

const waits = new Map<string, StallWait>()
// Which waits belong to THIS request, so the deadline can name them.
const requestScope = new AsyncLocalStorage<StallWait[]>()

function clampSeconds(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

let cachedStallMs = STALL_LOG_SECONDS_DEFAULT * 1_000

/** The setting's value, handed in by the module that reads settings (boot + on write). */
export function setStallLogSeconds(raw: unknown): void {
  cachedStallMs = clampSeconds(raw, STALL_LOG_SECONDS_DEFAULT, STALL_LOG_SECONDS_MIN, STALL_LOG_SECONDS_MAX) * 1_000
}

/** Test hook: the current threshold in ms. */
export function stallLogMs(): number { return cachedStallMs }

// Injectable clock so a test crosses the threshold in milliseconds.
const defaultNow = (): number => Date.now()
const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return () => clearTimeout(timer)
}
let nowMs = defaultNow
let scheduleFn = defaultSchedule

export function _setStallWatchClockForTests(clock: {
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
} | null): void {
  nowMs = clock?.now ?? defaultNow
  scheduleFn = clock?.schedule ?? defaultSchedule
}

function fireStallLog(entry: StallWait): void {
  if (entry.logged || !entry.active) return
  entry.logged = true
  const waitedS = Math.round(Math.max(0, nowMs() - entry.startedAt) / 1000)
  const holder = entry.holderStartedAtMs === undefined
    ? ''
    : `; holder running ${Math.round(Math.max(0, nowMs() - entry.holderStartedAtMs) / 1000)} s`
  // Observed only: what is waiting, on what, for how long — never why.
  report('warn', `request ${entry.label ? `${entry.label} ` : ''}has been waiting ${waitedS} s on ${entry.operation}${holder}`, {
    operation: entry.operation,
    label: entry.label ?? null,
    waited_s: waitedS,
  })
}

/**
 * Register a wait on `operation` (what is holding things up). Concurrent
 * callers on the same operation+label share ONE entry and ONE log line.
 * `holderStartedAtMs` adds the holder's own age to the line where known.
 */
export function watchWait(operation: string, label?: string, holderStartedAtMs?: number): { done(): void } {
  const key = `${operation} ${label ?? ''}`
  const existing = waits.get(key)
  let entry: StallWait
  if (existing) {
    entry = existing
    if (entry.holderStartedAtMs === undefined && holderStartedAtMs !== undefined) {
      entry.holderStartedAtMs = holderStartedAtMs
    }
  } else {
    entry = { key, operation, label, startedAt: nowMs(), holderStartedAtMs, refs: 0, logged: false, active: true }
    waits.set(key, entry)
    const created = entry
    created.cancelTimer = scheduleFn(() => fireStallLog(created), Math.max(1, cachedStallMs))
  }
  entry.refs += 1
  requestScope.getStore()?.push(entry)
  let released = false
  return {
    done() {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs <= 0) {
        entry.active = false
        entry.cancelTimer?.()
        entry.cancelTimer = undefined
        waits.delete(key)
      }
    },
  }
}

/** Every live wait, oldest first — in memory only, so health cannot slow down. */
export function currentWaits(): CurrentWait[] {
  const now = nowMs()
  return [...waits.values()]
    .map(entry => ({ operation: entry.operation, label: entry.label ?? null, waited_ms: Math.max(0, now - entry.startedAt) }))
    .sort((a, b) => b.waited_ms - a.waited_ms)
}

function formatWait(wait: CurrentWait): string {
  return `${wait.operation}${wait.label ? ` (${wait.label})` : ''} — ${(wait.waited_ms / 1000).toFixed(1)} s`
}

/** Run `fn` with an empty wait scope; waits registered inside it are THIS request's. */
export function runWithWaitScope<T>(fn: () => T): T {
  return requestScope.run([], fn)
}

/**
 * What this request is still waiting on: its own joined waits first, else the
 * route plus the slowest shared wait. Names what was observed, never a cause.
 */
export function describeRequestHold(path: string): string {
  const mine = new Map<string, CurrentWait>()
  for (const entry of requestScope.getStore() ?? []) {
    if (!entry.active || mine.has(entry.key)) continue
    mine.set(entry.key, {
      operation: entry.operation,
      label: entry.label ?? null,
      waited_ms: Math.max(0, nowMs() - entry.startedAt),
    })
  }
  if (mine.size) return [...mine.values()].map(formatWait).join('; ')
  const slowest = currentWaits()[0]
  return slowest
    ? `${path} · slowest shared wait: ${formatWait(slowest)}`
    : `${path} · no shared wait recorded`
}

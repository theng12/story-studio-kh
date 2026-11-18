/**
 * The watchdog that runs when the main thread cannot.
 *
 * Production sampled a frozen Story: 6,790 of 6,790 main-thread samples sat in
 * `_handleAEQuit -> _terminateFromSender:…`, a synchronous block. Every timer on
 * that thread — including `wedge-recovery.ts` and the shutdown deadline — was
 * dead for as long as the block lasted, which is exactly when a watchdog is
 * needed. So the main loop does not run the check any more; it only PUBLISHES:
 *
 *   - a beat into a `SharedArrayBuffer` every ~500 ms, and
 *   - when it changes, a small `wedge-state.json` beside the logs.
 *
 * This worker thread reads both from disk/shared memory, never through the main
 * loop. Past `wedge_exit_seconds` of silence it writes the incident file from
 * its own thread (the one capture path, `wedge-capture.ts`) and SIGKILLs the
 * process itself. It never posts a message back asking the main loop to quit:
 * that loop is the thing that is stuck.
 *
 * What it cannot see, it says it cannot see. Live waits and queue rows live in
 * the blocked thread's memory, so the capture records the last state the loop
 * managed to write and states the limitation in plain words. Nothing is invented.
 *
 * Imports here stay Node-only (plus the capture and its logger imports): a
 * worker thread must never load Electron's main-process module.
 */

import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { captureWedgeEvidence, type WedgeEvidence } from './wedge-capture.js'

/** Written by the main loop while it is alive; read here from disk. */
export const WEDGE_STATE_FILE = 'wedge-state.json'
export const WEDGE_CHECK_MS_DEFAULT = 2_000
/** SIGKILL is a signal to our own pid; the blocked thread never gets a vote. */
export const WEDGE_WORKER_EXIT_PATH = 'hard-exit via SIGKILL from the off-thread watchdog (process.kill(process.pid, "SIGKILL"))'

export interface WedgeWorkerData {
  /** The main loop's beat, shared rather than copied. */
  heartbeat: SharedArrayBuffer
  logDir: string
  exitSeconds: number
  /** Setting `wedge_recovery_enabled`; false silences this watchdog too. */
  enabled?: boolean
  checkMs?: number
}

export interface WedgeStateSnapshot {
  written_at?: number
  shutting_down?: boolean
  running_job_ids?: string[]
  stage?: string
}

export interface WedgeWorkerDeps {
  now?: () => number
  readState?: () => { text: string; ageMs: number | null; parsed: WedgeStateSnapshot | null }
  capture?: (evidence: WedgeEvidence) => Promise<string>
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * The whole rule, pure so it can be pinned without a clock or a process:
 * fire on a heartbeat older than the bound, unless the main loop's own state
 * file says a bounded shutdown is under way and that file is still younger
 * than the same bound (a normal quit, not a wedge).
 */
export function shouldFireWedge(input: {
  ageMs: number
  boundMs: number
  snapshot: WedgeStateSnapshot | null
  now: number
}): boolean {
  if (input.ageMs < input.boundMs) return false
  const snapshot = input.snapshot
  if (
    snapshot?.shutting_down === true &&
    typeof snapshot.written_at === 'number' &&
    input.now - snapshot.written_at < input.boundMs
  ) return false
  return true
}

function readStateFile(logDir: string, now: number): { text: string; ageMs: number | null; parsed: WedgeStateSnapshot | null } {
  const file = path.join(logDir, WEDGE_STATE_FILE)
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    let parsed: WedgeStateSnapshot | null = null
    try { parsed = JSON.parse(text) as WedgeStateSnapshot } catch { /* a half-written file is no state */ }
    const writtenAt = typeof parsed?.written_at === 'number' ? parsed.written_at : null
    return { text, ageMs: writtenAt === null ? null : Math.max(0, now - writtenAt), parsed }
  } catch (error) {
    return { text: `(no state snapshot could be read from ${file}: ${String(error)})`, ageMs: null, parsed: null }
  }
}

let fired = false

/** Test-only: allow a later case in the same process to fire again. */
export function _resetWedgeWatchWorkerForTests(): void {
  fired = false
}

/**
 * One check. Returns true when it fired. The interval stops at the `fired`
 * flag, so a bound is crossed once — never twice, never after the capture.
 */
export async function checkWedgeFromWorker(data: WedgeWorkerData, deps: WedgeWorkerDeps = {}): Promise<boolean> {
  if (data.enabled === false || fired) return false
  const now = deps.now ?? Date.now
  const beat = Number(Atomics.load(new BigInt64Array(data.heartbeat), 0))
  // A zero beat is "not started yet", not "silent for 56 years".
  if (beat === 0) return false

  const boundMs = Math.max(1, data.exitSeconds * 1_000)
  const ageMs = Math.max(0, now() - beat)
  const session = (deps.readState ?? (() => readStateFile(data.logDir, now())))()
  if (!shouldFireWedge({ ageMs, boundMs, snapshot: session.parsed, now: now() })) return false

  fired = true
  const boundSeconds = Math.round(boundMs / 1_000)
  const evidence: WedgeEvidence = {
    reason: `Story is wedged: the main loop has not published a heartbeat for ${Math.round(ageMs / 1_000)} s `
      + `(bound ${boundSeconds} s), and the main thread that should beat is blocked.`,
    waits: [],
    inFlight: [],
    stage: 'off-thread watchdog: the main thread is blocked',
    boundSeconds,
    mainThreadBlockedMs: ageMs,
    stateSnapshot: { text: session.text, ageMs: session.ageMs },
    exitPath: WEDGE_WORKER_EXIT_PATH,
  }
  const capture = deps.capture ?? ((e: WedgeEvidence) => captureWedgeEvidence(e, { logDir: data.logDir }))
  try {
    await capture(evidence)
  } catch (error) {
    // The process is dying either way; say the capture failed instead of pretending it exists.
    console.error('[wedge-watch] the incident capture failed; ending the wedged process anyway:', String(error))
  }
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  kill(process.pid, 'SIGKILL')
  return true
}

/** Start the periodic check. Returns a stop function (used by tests). */
export function startWedgeWatchWorker(data: WedgeWorkerData, deps: WedgeWorkerDeps = {}): () => void {
  const timer = setInterval(() => { void checkWedgeFromWorker(data, deps) }, Math.max(10, data.checkMs ?? WEDGE_CHECK_MS_DEFAULT))
  timer.unref()
  // The bound and the on/off switch follow the settings while the loop can still send them.
  const onMessage = (message: unknown) => {
    const next = message as { exitSeconds?: unknown; enabled?: unknown } | null
    const exitSeconds = Math.floor(Number(next?.exitSeconds))
    if (Number.isFinite(exitSeconds) && exitSeconds > 0) data.exitSeconds = exitSeconds
    if (typeof next?.enabled === 'boolean') data.enabled = next.enabled
  }
  parentPort?.on('message', onMessage)
  return () => {
    clearInterval(timer)
    parentPort?.off('message', onMessage)
  }
}

let started = false
/** Entry point for the worker thread, and for a test fixture that stubs the commands first. */
export function runWedgeWatch(): void {
  if (started || isMainThread || !parentPort) return
  started = true
  startWedgeWatchWorker(workerData as WedgeWorkerData)
}

runWedgeWatch()

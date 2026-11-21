/**
 * End a wedge instead of only naming it.
 *
 * Nothing supervises Story — the updater only installs — so a freeze stayed a
 * freeze until a human restarted. This check asks the stall watcher for the
 * oldest live wait; past `wedge_exit_seconds` it runs, in order:
 *
 *   1. capture evidence to one file beside the logs (`wedge-capture.ts`);
 *   2. stop taking new work (`takeUpdateHold(0, 300)` — the in-memory, expiring
 *      hold, never the owner's durable Pause: this process is about to die, and
 *      a durable latch it left behind is exactly what made angkor boot taking no
 *      work and saying nothing);
 *   3. park in-flight rows through the queue's stall pause, or name the rows
 *      that refused it (type + id) rather than claiming them parked;
 *   4. write ONE plain sentence saying what waited, how long, and the bound
 *      it crossed — observed only, never a cause;
 *   5. end the process outright through the injected `quit()` (main.ts wires
 *      it to `app.exit(1)`). A graceful quit is what was stuck in Production:
 *      SIGTERM was ignored for 6 s and SIGKILL was needed, so only a hard exit
 *      is guaranteed to return the login item promptly.
 *
 * LIMIT, stated plainly: this watcher runs inside the process and fires on a
 * timer. It needs a live event loop. If the loop itself is ever blocked, none
 * of this runs — no pause, no capture, no exit — and nothing inside the
 * process can help; an out-of-process check (launchd noticing a silent app)
 * would be a separate change.
 *
 * Every step's failure is logged and never stops the next: under a wedge the
 * disk itself may be the step that hangs, so each step gets its own ceiling.
 * No line here claims a resume that did not happen.
 */

import { currentWaits } from '../lib/stall-watch.js'
import { captureWedgeEvidence, type WedgeEvidence } from './wedge-capture.js'
import { getAppSetting, onAppSettingWritten } from './app-settings.js'
import { logLine } from './logger.js'
import { activeJobsOfType, findJobs, pauseJobForStall, takeUpdateHold } from './job-queue.js'
import { JOB_TYPES } from '../models/types.js'

export const WEDGE_EXIT_SECONDS_KEY = 'wedge_exit_seconds'
export const WEDGE_EXIT_SECONDS_DEFAULT = 180
export const WEDGE_EXIT_SECONDS_MIN = 60
export const WEDGE_EXIT_SECONDS_MAX = 86_400
export const WEDGE_RECOVERY_ENABLED_KEY = 'wedge_recovery_enabled'

interface WedgeSettings {
  enabled: boolean
  exitSeconds: number
}

let cachedSettings: WedgeSettings = { enabled: true, exitSeconds: WEDGE_EXIT_SECONDS_DEFAULT }
let settingsWired = false
let recoveryFired = false

async function loadWedgeSettings(): Promise<void> {
  const rawExit = await getAppSetting(WEDGE_EXIT_SECONDS_KEY)
  const n = Math.floor(Number(rawExit))
  const exitSeconds = Number.isFinite(n) && n >= WEDGE_EXIT_SECONDS_MIN && n <= WEDGE_EXIT_SECONDS_MAX
    ? n
    : WEDGE_EXIT_SECONDS_DEFAULT
  const flag = await getAppSetting(WEDGE_RECOVERY_ENABLED_KEY)
  // An explicit false is the off switch; anything else (unset included) stays on.
  cachedSettings = { enabled: flag !== false, exitSeconds }
}

export interface WedgeRecoveryDeps {
  /** End the process outright — main.ts wires this to `app.exit(1)`. */
  quit: (reason: string) => void
  /** Optional override: write the incident file (tests stub it). */
  capture?: (evidence: WedgeEvidence) => Promise<string>
  pauseQueue?: () => Promise<void>
  parkRunning?: () => Promise<void>
  readSettings?: () => WedgeSettings
}

/** Per-step ceiling: under a wedge the disk itself may be the step that hangs. */
const STEP_BUDGET_MS = 10_000
/** The capture has its own, larger ceiling: `sample` alone may run for 15 s. */
const CAPTURE_BUDGET_MS = 20_000

async function runStep<T>(name: string, work: () => Promise<T>, budgetMs = STEP_BUDGET_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish within ${budgetMs} ms`)), budgetMs)
        timer.unref()
      }),
    ])
  } catch (error) {
    logLine('error', `wedge recovery: ${name} failed`, { step: name, error: String(error) })
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Rows in flight right now, from memory — a capture must not wait on the disk. */
function inFlightNow(): string[] {
  const rows: string[] = []
  for (const type of JOB_TYPES) {
    for (const row of activeJobsOfType(type)) {
      if (row.status !== 'running') continue
      rows.push(`${row.type} ${row.project_slug}${row.episode_id ? `/${row.episode_id}` : ''}`)
    }
  }
  return rows
}

/** Rows the queue holds as running, across every scope that has live rows. */
async function parkRunningRows(): Promise<void> {
  const scopes = new Set<string>()
  for (const type of JOB_TYPES) {
    for (const row of activeJobsOfType(type)) scopes.add(row.project_slug)
  }
  const running: Array<{ job_id: string; type: string }> = []
  for (const scope of scopes) {
    // Scopes with live rows are already loaded, so this stays in memory; a
    // scope that is not fails this step, which is logged like any other.
    for (const job of await findJobs(scope, candidate => candidate.status === 'running')) {
      running.push({ job_id: job.job_id, type: job.type })
    }
  }
  for (const row of running) {
    try {
      const parked = await pauseJobForStall(row.job_id, 'Wedge recovery is quitting the app so the next start can follow this row.')
      if (!parked) {
        logLine('warn', `wedge recovery could not park ${row.type} ${row.job_id}; it stays as it is and the next start must reconcile it`, row)
      }
    } catch (error) {
      logLine('error', `wedge recovery failed to park ${row.type} ${row.job_id}`, { ...row, error: String(error) })
    }
  }
}

/** One check of the oldest live wait. Idempotent: the recovery runs once. */
export async function checkWedgeOnce(deps: WedgeRecoveryDeps): Promise<void> {
  const settings = (deps.readSettings ?? (() => cachedSettings))()
  if (!settings.enabled || recoveryFired) return
  const oldest = currentWaits()[0]
  if (!oldest || oldest.waited_ms < settings.exitSeconds * 1_000) return
  recoveryFired = true
  const waitedS = Math.round(oldest.waited_ms / 1_000)
  const describe = `${oldest.operation}${oldest.label ? ` (${oldest.label})` : ''}`
  const reason = `Story is wedged: ${describe} has waited ${waitedS} s (bound ${settings.exitSeconds} s)`

  // Capture first: the process is about to die, and this is the only record
  // of what the event loop still saw. A failed capture never stops the exit.
  const evidenceFile = await runStep('capture evidence', () => (deps.capture ?? captureWedgeEvidence)({
    reason: `${reason}; hard-exiting so the next start can follow the in-flight work.`,
    waits: currentWaits(),
    inFlight: inFlightNow(),
    stage: 'wedge detected, before pause',
    boundSeconds: settings.exitSeconds,
  } satisfies WedgeEvidence), CAPTURE_BUDGET_MS)
  if (evidenceFile) logLine('error', `wedge recovery: evidence written to ${evidenceFile}`)
  // In-memory and expiring, never the owner's durable Pause: this process is about to die, and a
  // durable latch it left behind is exactly what made angkor boot taking no work and saying nothing
  // (2026-11-19). Dispatch resumes on the next start with no manual step.
  await runStep('hold dispatch', deps.pauseQueue ?? (() => takeUpdateHold(0, 300).then(() => undefined)))
  await runStep('park in-flight rows', deps.parkRunning ?? parkRunningRows)
  // One sentence, observed only: what waited, how long, the bound it crossed.
  logLine('error', `${reason}; quitting now so the next start can follow the in-flight work.`)
  try {
    deps.quit('wedge-recovery')
  } catch (error) {
    logLine('error', 'wedge recovery could not end the process', { error: String(error) })
  }
}

export function startWedgeRecovery(deps: WedgeRecoveryDeps): () => void {
  if (!settingsWired) {
    settingsWired = true
    void loadWedgeSettings().catch(() => { /* the defaults stand */ })
    onAppSettingWritten(key => {
      if (key === WEDGE_EXIT_SECONDS_KEY || key === WEDGE_RECOVERY_ENABLED_KEY) {
        void loadWedgeSettings().catch(() => { /* keep the last good value */ })
      }
    })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    // The check runs at a fraction of the bound it enforces.
    const exitMs = Math.max(1_000, Math.round((cachedSettings.exitSeconds * 1_000) / 6))
    timer = setTimeout(() => {
      void checkWedgeOnce(deps).finally(schedule)
    }, exitMs)
    timer.unref()
  }
  schedule()
  return () => {
    if (timer) clearTimeout(timer)
  }
}

/** Test-only: drop the one-shot guard so a later case can fire again. */
export function _resetWedgeRecoveryForTests(): void {
  recoveryFired = false
}

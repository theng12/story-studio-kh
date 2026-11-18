/**
 * End a wedge instead of only naming it.
 *
 * Nothing supervises Story — the updater only installs — so a freeze stayed a
 * freeze until a human restarted. This check asks the stall watcher for the
 * oldest live wait; past `wedge_exit_seconds` it runs, in order:
 *
 *   1. stop taking new work (`setQueuePaused(true)`, the queue's own API);
 *   2. park in-flight rows through the queue's stall pause, or name the rows
 *      that refused it (type + id) rather than claiming them parked;
 *   3. write ONE plain sentence saying what waited, how long, and the bound
 *      it crossed — observed only, never a cause;
 *   4. ask the host to quit cleanly through the injected `quit()` (main.ts
 *      wires it to `app.quit()`), so the login item brings the app back.
 *
 * Every step's failure is logged and never stops the next: under a wedge the
 * disk itself may be the step that hangs, so each step gets its own ceiling.
 * No line here claims a resume that did not happen.
 */

import { currentWaits } from '../lib/stall-watch.js'
import { getAppSetting, onAppSettingWritten } from './app-settings.js'
import { logLine } from './logger.js'
import { activeJobsOfType, findJobs, pauseJobForStall, setQueuePaused } from './job-queue.js'
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
  /** Ask the host to quit cleanly — main.ts wires this to `app.quit()`. */
  quit: (reason: string) => void
  pauseQueue?: () => Promise<void>
  parkRunning?: () => Promise<void>
  readSettings?: () => WedgeSettings
}

/** Per-step ceiling: under a wedge the disk itself may be the step that hangs. */
const STEP_BUDGET_MS = 10_000

async function runStep(name: string, work: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish within ${STEP_BUDGET_MS} ms`)), STEP_BUDGET_MS)
        timer.unref()
      }),
    ])
  } catch (error) {
    logLine('error', `wedge recovery: ${name} failed`, { step: name, error: String(error) })
  } finally {
    if (timer) clearTimeout(timer)
  }
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

  await runStep('pause the queue', deps.pauseQueue ?? (() => setQueuePaused(true)))
  await runStep('park in-flight rows', deps.parkRunning ?? parkRunningRows)
  // One sentence, observed only: what waited, how long, the bound it crossed.
  logLine('error', `Story is wedged: ${describe} has waited ${waitedS} s (bound ${settings.exitSeconds} s); quitting now so the next start can follow the in-flight work.`)
  try {
    deps.quit('wedge-recovery')
  } catch (error) {
    logLine('error', 'wedge recovery could not ask the host to quit', { error: String(error) })
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

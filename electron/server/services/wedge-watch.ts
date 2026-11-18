/**
 * The main-thread half of the off-thread watchdog.
 *
 * Only publishes; never checks. A ~500 ms unref'd interval writes a timestamp
 * into a `SharedArrayBuffer` and, only when it changes, a small
 * `wedge-state.json` into the log directory (in-flight job ids, whether a
 * shutdown is under way, and the last stage the loop reached). There is no disk
 * I/O on a tick that changes nothing.
 *
 * A blocked main thread stops beating — that is the whole signal. The worker
 * (`wedge-watch-worker.ts`) reads the shared beat and the file from its own
 * thread, past `wedge_exit_seconds` writes the incident file and SIGKILLs the
 * process. The existing main-thread `wedge-recovery.ts` and shutdown deadline
 * stay as they are: they handle the cases where the loop is alive.
 *
 * Reuses `wedge_exit_seconds` and `wedge_recovery_enabled` — no second setting.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { isShuttingDown } from '../lib/shutdown-state.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { getAppSetting, onAppSettingWritten } from './app-settings.js'
import { runningJobIdsForShutdown } from './job-queue.js'
import { logLine } from './logger.js'
import {
  WEDGE_EXIT_SECONDS_DEFAULT,
  WEDGE_EXIT_SECONDS_KEY,
  WEDGE_EXIT_SECONDS_MAX,
  WEDGE_EXIT_SECONDS_MIN,
  WEDGE_RECOVERY_ENABLED_KEY,
} from './wedge-recovery.js'
import { WEDGE_STATE_FILE, type WedgeWorkerData } from './wedge-watch-worker.js'

/** How often the main loop publishes. A tick is one array store plus one comparison. */
export const WEDGE_HEARTBEAT_MS = 500

let stage = 'starting'

/** Name the step the main loop has reached; the worker reports the last one it saw. */
export function noteWedgeStage(next: string): void {
  stage = next
}

export interface WedgeWatchOptions {
  logDir: string
  /** Tests inject a fixture worker; the app uses the compiled sibling. */
  workerPath?: string
  /** Injected by tests; omitted, the setting is read (and followed live). */
  exitSeconds?: number
  enabled?: boolean
  checkMs?: number
}

/** The worker script, compiled beside this one in the built app. */
function defaultWorkerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'wedge-watch-worker.js')
}

export async function startWedgeWatch(options: WedgeWatchOptions): Promise<() => void> {
  let enabled = options.enabled
  let exitSeconds = options.exitSeconds
  if (enabled === undefined || exitSeconds === undefined) {
    const [flag, raw] = await Promise.all([
      getAppSetting(WEDGE_RECOVERY_ENABLED_KEY),
      getAppSetting(WEDGE_EXIT_SECONDS_KEY),
    ])
    if (enabled === undefined) enabled = flag !== false
    if (exitSeconds === undefined) {
      const n = Math.floor(Number(raw))
      exitSeconds = Number.isFinite(n) && n >= WEDGE_EXIT_SECONDS_MIN && n <= WEDGE_EXIT_SECONDS_MAX
        ? n
        : WEDGE_EXIT_SECONDS_DEFAULT
    }
  }
  if (!enabled) return () => {}

  const heartbeat = new SharedArrayBuffer(8)
  const view = new BigInt64Array(heartbeat)
  const beat = () => { Atomics.store(view, 0, BigInt(Date.now())) }
  beat()

  const statePath = path.join(options.logDir, WEDGE_STATE_FILE)
  const tmpPath = `${statePath}.tmp`
  let lastKey = ''
  let writing = false
  const publish = () => {
    beat()
    // Only what the worker can act on, and only when it changed: a blocked loop
    // stops both the beat and this file, which is the signal.
    const live = { shutting_down: isShuttingDown(), running_job_ids: runningJobIdsForShutdown(), stage }
    const key = JSON.stringify(live)
    if (key === lastKey || writing) return
    lastKey = key
    writing = true
    assertWriteIsolatedInTests(statePath, 'wedge-watch')
    const body = `${JSON.stringify({ ...live, written_at: Date.now() })}\n`
    void fs.promises.mkdir(options.logDir, { recursive: true })
      .then(() => fs.promises.writeFile(tmpPath, body))
      .then(() => fs.promises.rename(tmpPath, statePath))
      .catch(() => { lastKey = '' })
      .finally(() => { writing = false })
  }
  publish()
  const timer = setInterval(publish, WEDGE_HEARTBEAT_MS)
  timer.unref()

  const worker = new Worker(options.workerPath ?? defaultWorkerPath(), {
    workerData: {
      heartbeat,
      logDir: options.logDir,
      exitSeconds,
      enabled,
      checkMs: options.checkMs,
    } satisfies WedgeWorkerData,
  })
  worker.unref()
  worker.on('error', error => {
    logLine('error', 'the off-thread wedge watchdog is not running; only the main-thread check remains', {
      error: String(error),
    })
  })

  // Keep the bound and the off switch live, like the main-thread check does.
  const unsubscribe = options.exitSeconds === undefined
    ? onAppSettingWritten(key => {
        if (key !== WEDGE_EXIT_SECONDS_KEY && key !== WEDGE_RECOVERY_ENABLED_KEY) return
        void Promise.all([getAppSetting(WEDGE_EXIT_SECONDS_KEY), getAppSetting(WEDGE_RECOVERY_ENABLED_KEY)])
          .then(([raw, flag]) => {
            const n = Math.floor(Number(raw))
            worker.postMessage({
              exitSeconds: Number.isFinite(n) && n >= WEDGE_EXIT_SECONDS_MIN && n <= WEDGE_EXIT_SECONDS_MAX ? n : undefined,
              enabled: flag !== false,
            })
          })
          .catch(() => { /* the last good values stand */ })
      })
    : () => {}

  return () => {
    clearInterval(timer)
    unsubscribe()
    void worker.terminate().catch(() => { /* already gone */ })
  }
}

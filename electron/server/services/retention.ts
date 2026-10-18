/**
 * Automatic retention (owner, 2026-10-18): every generated file ages out by itself.
 *
 *   generated file → Story's unified `_trash` (its own duration) → macOS Trash
 *   after `trash_handoff_days` → the owner's macOS 30-day empty.
 *
 * Two daily jobs, one schedule:
 *   • `handoffOldTrash` (services/trash.ts) hands Story's Trash items older than
 *     `trash_handoff_days` to the Mac's Trash. Skipped with a clear status when
 *     the Mac's Trash is unreachable (a bare node server, a test).
 *   • the EXISTING all-channel cleanup (`cleanup_all` — verified uploaded finals
 *     older than 7 days of production plus unused leftovers) runs through the
 *     exact functions Story → Free up space's button uses, so the selection is
 *     never duplicated here. It never starts while a cleanup already runs.
 *
 * Settings live in app-settings.json beside every other app-level knob. The
 * manual buttons stay; this only adds what happens when nobody clicks.
 */
import { getAppSetting, setAppSettings } from './app-settings.js'
import {
  activeMaintenanceOperation, getLibraryMediaCleanupOperation, startLibraryMediaCleanupPreview,
  startLibraryMediaCleanupRun, type MediaCleanupOperation,
} from './episode-media-cleanup.js'
import { electronTrashItem, handoffOldTrash } from './trash.js'

export const TRASH_HANDOFF_DAYS_KEY = 'trash_handoff_days'
export const AUTO_CLEANUP_KEY = 'auto_cleanup_enabled'
export const RETENTION_STATUS_KEY = 'retention_status'
export const DEFAULT_TRASH_HANDOFF_DAYS = 7
/** The button's own action: its verified-finals rule and leftovers, unchanged. */
export const AUTO_CLEANUP_ACTION = 'cleanup_all'

const DAY_MS = 24 * 60 * 60 * 1000
/** How often the scheduler looks; each job runs at most once per day. */
const TICK_MS = 60 * 60 * 1000

export interface RetentionRunStatus {
  at: string
  status: 'completed' | 'failed' | 'skipped'
  detail: string
  moved?: number
  bytes?: number
}

export interface RetentionStatus {
  last_handoff: RetentionRunStatus | null
  last_auto_cleanup: RetentionRunStatus | null
}

export interface RetentionSettings {
  trash_handoff_days: number
  auto_cleanup_enabled: boolean
  last_handoff: RetentionRunStatus | null
  last_auto_cleanup: RetentionRunStatus | null
}

function readDays(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TRASH_HANDOFF_DAYS
  return Math.min(365, n)
}

function readRunStatus(raw: unknown): RetentionRunStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.at !== 'string' || typeof record.detail !== 'string') return null
  if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'skipped') return null
  return record as unknown as RetentionRunStatus
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  const [days, enabled, status] = await Promise.all([
    getAppSetting(TRASH_HANDOFF_DAYS_KEY),
    getAppSetting(AUTO_CLEANUP_KEY),
    getAppSetting(RETENTION_STATUS_KEY),
  ])
  const runs = status && typeof status === 'object' ? status as Record<string, unknown> : {}
  return {
    trash_handoff_days: readDays(days),
    // On by default: the owner's goal is that nothing needs a click.
    auto_cleanup_enabled: enabled !== false,
    last_handoff: readRunStatus(runs.last_handoff),
    last_auto_cleanup: readRunStatus(runs.last_auto_cleanup),
  }
}

export async function setRetentionSettings(body: Record<string, unknown>): Promise<RetentionSettings> {
  const patch: Record<string, unknown> = {}
  if (body.trash_handoff_days !== undefined) {
    const n = Math.floor(Number(body.trash_handoff_days))
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      throw Object.assign(new Error('Move Trash items to the Mac\'s Trash after a whole number of days between 1 and 365.'), { statusCode: 400, expose: true })
    }
    patch[TRASH_HANDOFF_DAYS_KEY] = n
  }
  if (body.auto_cleanup_enabled !== undefined) {
    if (typeof body.auto_cleanup_enabled !== 'boolean') {
      throw Object.assign(new Error('Automatic cleanup must be on or off.'), { statusCode: 400, expose: true })
    }
    patch[AUTO_CLEANUP_KEY] = body.auto_cleanup_enabled
  }
  if (Object.keys(patch).length) await setAppSettings(patch)
  return getRetentionSettings()
}

async function recordStatus(slot: 'last_handoff' | 'last_auto_cleanup', run: RetentionRunStatus): Promise<void> {
  const current = (await getAppSetting(RETENTION_STATUS_KEY) as RetentionStatus | undefined) || {} as RetentionStatus
  await setAppSettings({ [RETENTION_STATUS_KEY]: { ...current, [slot]: run } })
}

function statusOf(slot: 'last_handoff' | 'last_auto_cleanup', run: RetentionRunStatus): string {
  console.log(`[retention] ${slot}: ${run.status} — ${run.detail}`)
  return run.status
}

/** The shared all-channel cleanup path, exactly as Story → Free up space's button calls it. */
interface AutoCleanupDeps {
  startPreview: (action: unknown) => Promise<{ operation_id: string }>
  getOperation: (id: string) => MediaCleanupOperation | null
  startRun: (input: { preview_id: unknown }) => Promise<{ operation_id: string }>
  active: () => ReturnType<typeof activeMaintenanceOperation>
  wait: (ms: number) => Promise<void>
}

const autoDeps: AutoCleanupDeps = {
  startPreview: startLibraryMediaCleanupPreview,
  getOperation: getLibraryMediaCleanupOperation,
  startRun: startLibraryMediaCleanupRun,
  active: activeMaintenanceOperation,
  wait: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }),
}

export function _setAutoCleanupDepsForTests(next: Partial<AutoCleanupDeps>): () => void {
  const previous = { ...autoDeps }
  Object.assign(autoDeps, next)
  return () => { Object.assign(autoDeps, previous) }
}

const ACTIVE = ['queued', 'running', 'stopping']
/** A preview scan across every channel can take minutes; a run moving finals can take longer. */
const WAIT_LIMIT_MS = 6 * 60 * 60 * 1000

async function waitForOperation(id: string): Promise<MediaCleanupOperation> {
  const started = Date.now()
  for (;;) {
    const operation = autoDeps.getOperation(id)
    if (!operation) throw new Error('The cleanup operation is no longer running, possibly after an app restart.')
    if (!ACTIVE.includes(operation.status)) return operation
    if (Date.now() - started > WAIT_LIMIT_MS) throw new Error('The cleanup did not finish within six hours.')
    await autoDeps.wait(2000)
  }
}

/**
 * Run the owner's `cleanup_all` sweep once: preview first (the same listing the
 * button shows), then its reviewed preview id through the same run endpoint.
 * Nothing eligible means no run. A cleanup already in flight means no start.
 */
export async function runAutomaticCleanup(now = Date.now()): Promise<RetentionRunStatus> {
  const running = autoDeps.active()
  if (running) {
    const run: RetentionRunStatus = { at: new Date(now).toISOString(), status: 'skipped', detail: `A cleanup is already running (${running.kind}, ${running.status}); nothing else was started.` }
    await recordStatus('last_auto_cleanup', run)
    return run
  }
  let run: RetentionRunStatus
  try {
    const previewStart = await autoDeps.startPreview(AUTO_CLEANUP_ACTION)
    const previewOperation = await waitForOperation(previewStart.operation_id)
    const preview = previewOperation.library_preview
    if (previewOperation.status !== 'completed' || !preview) {
      run = { at: new Date(now).toISOString(), status: 'failed', detail: previewOperation.error || `The file review ended ${previewOperation.status}.` }
    } else if (!preview.files.length && !(preview.leftovers?.count || 0)) {
      // The button would offer nothing to do; do not start an empty run.
      run = { at: new Date(now).toISOString(), status: 'completed', detail: 'Nothing to clean up: no eligible uploaded finals and no unused leftovers.' }
    } else {
      const runStart = await autoDeps.startRun({ preview_id: preview.preview_id })
      const finished = await waitForOperation(runStart.operation_id)
      const result = finished.result
      const moved = (result?.removed_count || 0) + (result?.leftovers_moved || 0)
      const left = (result?.skipped_count || 0) + (result?.failed_count || 0) + (result?.leftovers_left || 0)
      run = {
        at: new Date(now).toISOString(),
        status: finished.status === 'failed' ? 'failed' : 'completed',
        detail: finished.status === 'failed'
          ? finished.error || 'The cleanup could not finish; anything not checked stayed where it was.'
          : `Moved ${moved} item${moved === 1 ? '' : 's'} to Story's Trash${left ? `; ${left} could not be confirmed and stayed` : ''}.`,
        moved,
        bytes: (result?.bytes_moved || 0) + (result?.leftovers_bytes_moved || 0),
      }
    }
  } catch (error: any) {
    run = { at: new Date(now).toISOString(), status: 'failed', detail: `The automatic cleanup did not run: ${error?.message || error}` }
  }
  await recordStatus('last_auto_cleanup', run)
  return run
}

async function due(last: RetentionRunStatus | null, memory: number, now: number, retrySkipped = false): Promise<boolean> {
  // A skip is not a run: the cleanup retries on the next hour rather than losing the day
  // because the owner (or a previous run) happened to hold the cleanup lock at tick time.
  const persisted = last && (!retrySkipped || last.status !== 'skipped') ? Date.parse(last.at) : NaN
  return now - Math.max(memory, Number.isFinite(persisted) ? persisted : 0) >= DAY_MS
}

let lastHandoffAttempt = 0
let lastCleanupAttempt = 0
let ticking = false

/**
 * One scheduler tick: the Trash handoff, then the automatic cleanup, each at
 * most once per day. Returns what each decided, for tests and the log.
 */
export async function retentionTick(now = Date.now()): Promise<{ handoff: string; cleanup: string }> {
  if (ticking) return { handoff: 'busy', cleanup: 'busy' }
  ticking = true
  try {
    const settings = await getRetentionSettings()
    let handoff = 'recent'
    if (await due(settings.last_handoff, lastHandoffAttempt, now)) {
      lastHandoffAttempt = now
      const trashItem = await electronTrashItem()
      let run: RetentionRunStatus
      if (!trashItem) {
        run = { at: new Date(now).toISOString(), status: 'skipped', detail: 'The Mac\'s Trash is only reachable while Story Studio runs as the app on the Mac; nothing was moved.' }
      } else {
        try {
          const result = await handoffOldTrash({ olderThanDays: settings.trash_handoff_days, now }, trashItem)
          run = {
            at: new Date(now).toISOString(), status: 'completed', moved: result.moved, bytes: result.bytes,
            detail: result.moved
              ? `Moved ${result.moved} item${result.moved === 1 ? '' : 's'} to the Mac's Trash${result.errors.length ? `; ${result.errors.length} stayed here` : ''}.`
              : `Nothing waited ${settings.trash_handoff_days} days; nothing was moved.`,
          }
        } catch (error: any) {
          run = { at: new Date(now).toISOString(), status: 'failed', detail: `The Trash handoff did not run: ${error?.message || error}` }
        }
      }
      await recordStatus('last_handoff', run)
      handoff = statusOf('last_handoff', run)
    }
    let cleanup = 'recent'
    if (settings.auto_cleanup_enabled && await due(settings.last_auto_cleanup, lastCleanupAttempt, now, true)) {
      lastCleanupAttempt = now
      const run = await runAutomaticCleanup(now)
      if (run.status === 'skipped') lastCleanupAttempt = 0
      cleanup = statusOf('last_auto_cleanup', run)
    } else if (!settings.auto_cleanup_enabled) cleanup = 'off'
    return { handoff, cleanup }
  } finally {
    ticking = false
  }
}

/** Wire the daily retention jobs into the app's existing boot-timer pattern. */
export function startRetentionScheduler(log: (error: unknown) => void): void {
  const tick = () => void retentionTick().catch(log)
  setTimeout(tick, 3 * 60_000).unref?.()
  setInterval(tick, TICK_MS).unref?.()
}

export const _forTesting = {
  reset(): void { lastHandoffAttempt = 0; lastCleanupAttempt = 0; ticking = false },
}

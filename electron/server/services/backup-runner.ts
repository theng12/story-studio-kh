/**
 * The one backup/check/restore task at a time, its settings, and the automatic backup (1.4.287).
 *
 * Same shape as the archive sweep in `routes/library.ts`: the request answers at once and progress
 * is read from `backupStatus()`, because a first backup to a slow drive takes many minutes.
 */

import { existsSync } from 'fs'
import path from 'path'
import { getAllAppSettings, getAppSetting, setAppSetting } from './app-settings.js'
import { getUserDataDir, projectsRoot } from './project-manager.js'
import {
  BACKUP_SETTINGS_KEY, resolveBackupRoot, restoreBackup, runBackup, scanSources, verifyBackup,
  type BackupOptions, type BackupProgress, type BackupResult, type RestoreResult, type VerifyResult,
} from './backup.js'

export interface BackupSettings {
  /** The folder the owner picked, typically on an external drive. '' = not set up. */
  folder: string
  /** Back up daily, and whenever the drive comes back, while Story is idle. */
  auto: boolean
  options: BackupOptions
  last: BackupResult | null
  last_verify: VerifyResult | null
}

const DEFAULTS: BackupSettings = { folder: '', auto: false, options: {}, last: null, last_verify: null }

export async function getBackupSettings(): Promise<BackupSettings> {
  const raw = await getAppSetting(BACKUP_SETTINGS_KEY)
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
}

async function saveBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
  const next = { ...(await getBackupSettings()), ...patch }
  await setAppSetting(BACKUP_SETTINGS_KEY, next)
  return next
}

export async function updateBackupSettings(body: Record<string, unknown>): Promise<BackupSettings> {
  const patch: Partial<BackupSettings> = {}
  if (typeof body.folder === 'string') {
    const folder = body.folder.trim()
    if (folder && !path.isAbsolute(folder)) throw Object.assign(new Error('Choose the backup folder with the button.'), { status: 400, expose: true })
    if (folder) {
      const lib = path.resolve(projectsRoot())
      const abs = path.resolve(folder)
      if (abs === lib || abs.startsWith(lib + path.sep)) {
        throw Object.assign(new Error('Choose a backup folder outside your Library — usually on another drive.'), { status: 400, expose: true })
      }
    }
    patch.folder = folder
  }
  if (typeof body.auto === 'boolean') patch.auto = body.auto
  if (body.options && typeof body.options === 'object') {
    const o = body.options as Record<string, unknown>
    patch.options = { final_videos: o.final_videos === true, narration_audio: o.narration_audio === true, all_thumbnails: o.all_thumbnails === true }
  }
  return saveBackupSettings(patch)
}

// ── The task ────────────────────────────────────────────────────────────────

export type TaskKind = 'plan' | 'backup' | 'verify' | 'restore'
interface TaskState {
  running: boolean
  kind: TaskKind | null
  /** 'auto' when the automatic backup started it. */
  origin: 'owner' | 'auto'
  progress: BackupProgress | null
  stop: boolean
  result: unknown
  error: string
  started_at: string
}
const task: TaskState = { running: false, kind: null, origin: 'owner', progress: null, stop: false, result: null, error: '', started_at: '' }

export function backupStatus() {
  return {
    running: task.running, kind: task.kind, origin: task.origin, progress: task.progress,
    stopping: task.running && task.stop, result: task.result, error: task.error, started_at: task.started_at,
  }
}

export function stopBackupTask(): boolean {
  task.stop = true
  return task.running
}

function start(kind: TaskKind, origin: 'owner' | 'auto', work: () => Promise<unknown>): void {
  if (task.running) {
    throw Object.assign(new Error(`A ${task.kind === 'plan' ? 'size check' : task.kind} is already running. Wait for it to finish, or stop it.`), { status: 409, expose: true })
  }
  Object.assign(task, { running: true, kind, origin, progress: null, stop: false, result: null, error: '', started_at: new Date().toISOString() })
  void (async () => {
    try {
      task.result = await work()
    } catch (e: any) {
      task.error = e?.message || String(e)
    } finally {
      task.running = false
    }
  })()
}

async function storyVersion(): Promise<string> {
  try {
    const { resolveStoryStudioVersion } = await import('../lib/app-version.js')
    return await resolveStoryStudioVersion()
  } catch { return 'unknown' }
}

const sources = () => ({ dataDir: getUserDataDir(), libraryRoot: projectsRoot(), shouldStop: () => task.stop })

/** What a backup would hold, by category and channel, without copying anything. */
export function startPlan(): void {
  start('plan', 'owner', async () => {
    const scan = await scanSources({
      ...sources(),
      onProgress: (done, current) => { task.progress = { stage: 'scanning', done, total: 0, bytes_done: 0, bytes_total: 0, current } },
    })
    const settings = await getBackupSettings()
    let folder_free_bytes: number | null = null
    if (settings.folder && existsSync(settings.folder)) {
      const { measureFreeBytes } = await import('./storage-audit.js')
      folder_free_bytes = await measureFreeBytes(settings.folder)
    }
    return {
      sizes: scan.sizes,
      channel_sizes: scan.channel_sizes,
      channels: scan.channels,
      files: scan.files.length,
      skipped_folders: scan.skipped_folders,
      unreadable: scan.unreadable,
      folder_free_bytes,
      cancelled: task.stop,
    }
  })
}

export function startBackup(origin: 'owner' | 'auto' = 'owner'): Promise<void> {
  return (async () => {
    const settings = await getBackupSettings()
    if (!settings.folder) throw Object.assign(new Error('Choose a backup folder first.'), { status: 400, expose: true })
    const appSettings = await getAllAppSettings()
    const version = await storyVersion()
    start('backup', origin, async () => {
      const result = await runBackup({
        ...sources(),
        destination: settings.folder,
        options: settings.options,
        storyVersion: version,
        appSettings,
        onCopyProgress: p => { task.progress = p },
      })
      await saveBackupSettings({ last: result })
      return result
    })
  })()
}

export function startVerify(): Promise<void> {
  return (async () => {
    const settings = await getBackupSettings()
    if (!settings.folder) throw Object.assign(new Error('Choose a backup folder first.'), { status: 400, expose: true })
    start('verify', 'owner', async () => {
      const result = await verifyBackup(settings.folder, { shouldStop: () => task.stop, onProgress: p => { task.progress = p } })
      await saveBackupSettings({ last_verify: result })
      return result
    })
  })()
}

export interface StartRestoreInput {
  source: string
  target: string
  channels: Array<{ slug: string; replace?: boolean }>
  app: boolean
  /** Point Story at `target` once the restore is done (first run, or a new Library from Settings). */
  use_as_library: boolean
}

export function startRestore(input: StartRestoreInput): void {
  start('restore', 'owner', async () => {
    const result: RestoreResult & { library_switched?: boolean } = await restoreBackup({
      source: input.source,
      target: input.target,
      channels: input.channels,
      app: input.app,
      dataDir: getUserDataDir(),
      currentSettings: await getAllAppSettings(),
      writeSetting: (key, value) => setAppSetting(key, value),
      shouldStop: () => task.stop,
      onProgress: p => { task.progress = p },
    })
    if (input.use_as_library && !result.interrupted) {
      const { setLibraryRoot } = await import('./library.js')
      await setLibraryRoot(input.target)
      result.library_switched = true
    }
    return result
  })
}

// ── Automatic backup ────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
/** After an automatic attempt that did not finish, wait this long before the next (unless the drive comes back). */
const RETRY_MS = 60 * 60 * 1000
let driveWasPresent: boolean | null = null
let lastAutoAttempt = 0

/**
 * One tick: back up when automatic backup is on, the drive is plugged in, nothing is running in
 * the job queue, and either a day has passed since the last finished backup or the drive has
 * just come back. Returns why it did or did not start, for tests and the log.
 */
export async function autoBackupTick(now = Date.now()): Promise<string> {
  const settings = await getBackupSettings()
  if (!settings.auto || !settings.folder) return 'off'
  const present = existsSync(settings.folder)
  const replugged = present && driveWasPresent === false
  driveWasPresent = present
  if (!present) return 'drive-absent'
  if (task.running) return 'busy'
  const { getQueueStats } = await import('./job-queue.js')
  const q = getQueueStats()
  if (q.running > 0 || q.queued > 0) return 'queue-busy'
  const lastFinished = settings.last?.complete ? Date.parse(settings.last.finished_at) : 0
  if (!replugged && now - lastFinished < DAY_MS) return 'recent'
  if (!replugged && now - lastAutoAttempt < RETRY_MS) return 'retry-later'
  lastAutoAttempt = now
  await startBackup('auto')
  return replugged ? 'started-replugged' : 'started-daily'
}

export function startAutoBackupScheduler(log: (e: unknown) => void): void {
  const tick = () => void autoBackupTick().catch(log)
  setTimeout(tick, 3 * 60_000).unref?.()
  setInterval(tick, 5 * 60_000).unref?.()
}

export const _forTesting = {
  reset(): void { Object.assign(task, { running: false, kind: null, stop: false, result: null, error: '', progress: null }); driveWasPresent = null; lastAutoAttempt = 0 },
  root: resolveBackupRoot,
}

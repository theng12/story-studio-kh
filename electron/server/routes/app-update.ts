/**
 * Settings → About: remote updates and Open at Login (`services/app-update.ts`).
 *
 *   GET  /app-update/status          state, settings, pinned key fingerprint, Open at Login
 *   POST /app-update/check           Check Now
 *   POST /app-update/install-now     { immediately? } install the staged release now; immediately skips the wait for running jobs (automatic installs are prompt too; see services/app-update.ts)
 *   PUT  /app-update/settings        { auto_install? }
 *   POST /app-update/trust-new-key   forget the pinned release key (the next check pins the new one)
 *   PUT  /app-update/open-at-login   { enabled }
 */

import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as updater from '../services/app-update.js'
import { getAppSetting, setAppSetting, getGenStudioUrl } from '../services/app-settings.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { acquireQueuePauseOwned, areBootJobsLoaded, getQueuePauseOwner, getQueueStats, initializeQueuePauseState, isQueuePaused, releaseQueuePauseOwned, runningJobsThatWouldNotResume } from '../services/job-queue.js'
import { activeMaintenanceOperation } from '../services/episode-media-cleanup.js'
import { inFlightSubmits } from '../lib/inflight-submits.js'
import { projectsRoot } from '../services/project-manager.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

async function getSettings(): Promise<updater.UpdateSettings> {
  return updater.loadSettingsFrom(getAppSetting)
}

async function saveSettings(patch: Partial<updater.UpdateSettings>): Promise<void> {
  const next: Record<string, unknown> = { ...(await getSettings()), ...patch }
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
  await setAppSetting(updater.APP_UPDATE_SETTINGS_KEY, next)
}

/** Channels = Library folders holding a project.json; cheap enough for a two-minute heartbeat. */
async function channels(): Promise<number | null> {
  const root = projectsRoot()
  const names = await fs.readdir(root).catch(() => null)
  if (!names) return null
  const found = await Promise.all(names.filter(n => !n.startsWith('.') && !n.startsWith('_'))
    .map(n => fs.access(path.join(root, n, 'project.json')).then(() => 1, () => 0)))
  return found.reduce<number>((a, b) => a + b, 0)
}

/** main.ts calls this once the server listens (packaged builds only). */
export async function startStoryUpdater(input: {
  currentVersion: string
  executable: string
  port: number
  quit(): void
}): Promise<void> {
  await initializeQueuePauseState()
  await updater.startAppUpdater({
    currentVersion: input.currentVersion,
    appBundle: path.resolve(input.executable, '..', '..', '..'),
    port: input.port,
    quit: input.quit,
    queue: {
      isPaused: isQueuePaused,
      pauseOwner: getQueuePauseOwner,
      acquirePause: acquireQueuePauseOwned,
      releasePause: releaseQueuePauseOwned,
      running: () => getQueueStats().running,
      summary: () => { const s = getQueueStats(); return { running: s.running, queued: s.queued, paused: s.paused } },
      loaded: areBootJobsLoaded,
      inFlightSubmits,
      wouldNotResume: async () => (await runningJobsThatWouldNotResume()).map(job => job.type),
      // Free up space / Clear Uploaded Videos: not queue jobs, so nothing else would hold an install
      // for them, yet a restart kills them mid-file. `main.ts` wires this the same way it wires the
      // queue, and `episode-media-cleanup` refuses new operations while the drain is claimed.
      maintenance: activeMaintenanceOperation,
    },
    getSettings,
    saveSettings,
    gateway: async () => ({ url: await getGenStudioUrl(), key: await getApiKey('genstudio') }),
    channels,
  })
}

function handle(fn: (req: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      res.json(await fn(req))
    } catch (e: any) {
      res.status(400).json(humanizeBackendError(e, 'Update action failed'))
    }
  }
}

router.get('/app-update/status', handle(() => updater.status()))
router.post('/app-update/check', handle(async () => { await updater.checkNow(true); return updater.status() }))
router.post('/app-update/install-now', handle(async (req) => { await updater.installNow(req.body?.immediately === true); return updater.status() }))
router.put('/app-update/settings', handle(async (req) => {
  const body = req.body || {}
  const patch: Partial<updater.UpdateSettings> = {}
  if (typeof body.auto_install === 'boolean') patch.auto_install = body.auto_install
  await saveSettings(patch)
  await updater.maybeInstall().catch(() => {})
  return updater.status()
}))
router.post('/app-update/trust-new-key', handle(async () => {
  await saveSettings({ trusted_publisher_key: undefined })
  await updater.checkNow(true)
  return updater.status()
}))
router.put('/app-update/open-at-login', handle(async (req) => {
  await updater.setOpenAtLogin(req.body?.enabled === true, process.execPath)
  return updater.status()
}))

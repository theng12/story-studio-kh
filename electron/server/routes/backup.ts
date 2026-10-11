/**
 * Backup and restore — the wire (1.4.287). See `services/backup.ts` for what goes in and why.
 *
 * Reachable before a Library exists (first run offers "Restore from backup"), like `/library`.
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { listVersions, previewRestore, pruneVersions, readManifest, resolveBackupRoot } from '../services/backup.js'
import {
  backupStatus, getBackupSettings, startBackup, startPlan, startRestore, startVerify, stopBackupTask, updateBackupSettings,
} from '../services/backup-runner.js'
import { projectsRoot } from '../services/project-manager.js'

export const router = Router()

function fail(res: any, e: any, fallback: string): void {
  const status = [400, 403, 404, 409].includes(e?.status) ? e.status : 500
  res.status(status).json(humanizeBackendError(e, fallback))
}

/** Settings, whether the drive is plugged in, what the drive's manifest says, and the running task. */
router.get('/backup', async (_req, res) => {
  try {
    const settings = await getBackupSettings()
    const present = !!settings.folder && existsSync(settings.folder)
    const manifest = present ? await readManifest(resolveBackupRoot(settings.folder)) : null
    res.json({
      settings,
      drive_present: present,
      backup_root: settings.folder ? resolveBackupRoot(settings.folder) : '',
      on_drive: manifest
        ? { updated_at: manifest.updated_at, complete: manifest.complete, story_version: manifest.story_version, counts: manifest.counts }
        : null,
      status: backupStatus(),
    })
  } catch (e) {
    fail(res, e, 'Could not read the backup settings')
  }
})

router.put('/backup/settings', async (req, res) => {
  try {
    res.json(await updateBackupSettings(req.body || {}))
  } catch (e) {
    fail(res, e, 'Could not save the backup settings')
  }
})

router.get('/backup/status', (_req, res) => { res.json(backupStatus()) })

router.post('/backup/stop', (_req, res) => { res.json({ stopping: stopBackupTask() }) })

router.post('/backup/plan', (_req, res) => {
  try { startPlan(); res.json({ started: true }) } catch (e) { fail(res, e, 'Could not measure the backup') }
})

router.post('/backup/run', async (_req, res) => {
  try { await startBackup('owner'); res.json({ started: true }) } catch (e) { fail(res, e, 'Could not start the backup') }
})

router.post('/backup/verify', async (_req, res) => {
  try { await startVerify(); res.json({ started: true }) } catch (e) { fail(res, e, 'Could not check the backup') }
})

router.get('/backup/versions', async (_req, res) => {
  try {
    const { folder } = await getBackupSettings()
    if (!folder || !existsSync(folder)) return res.json({ root: '', total_bytes: 0, versions: [] })
    res.json(await listVersions(folder))
  } catch (e) {
    fail(res, e, 'Could not measure older copies on the backup drive')
  }
})

/**
 * Permanently delete older copies on the drive. The owner's own decision, like emptying Trash:
 * the body must say `confirm: true`, and an automation key may never do it.
 */
router.post('/backup/versions/prune', async (req: any, res) => {
  if (req.user?.via === 'automation_key') {
    return res.status(403).json({ detail: 'Automation keys can\'t delete backups — only the owner can, from Settings.' })
  }
  if (req.body?.confirm !== true) return res.status(400).json({ detail: 'Confirm before deleting older copies.' })
  const stamps = Array.isArray(req.body?.stamps) ? req.body.stamps.filter((s: unknown): s is string => typeof s === 'string') : []
  if (!stamps.length) return res.status(400).json({ detail: 'Choose which older copies to delete.' })
  try {
    const { folder } = await getBackupSettings()
    if (!folder || !existsSync(folder)) return res.status(409).json({ detail: 'The backup drive is not plugged in.' })
    res.json(await pruneVersions(folder, stamps))
  } catch (e) {
    fail(res, e, 'Could not delete the older copies')
  }
})

/** What a restore would bring back, read from the drive's manifest. Creates nothing. */
router.post('/backup/restore/preview', async (req, res) => {
  const source = typeof req.body?.source === 'string' ? req.body.source.trim() : ''
  const target = typeof req.body?.target === 'string' && req.body.target.trim() ? req.body.target.trim() : projectsRoot()
  if (!source) return res.status(400).json({ detail: 'Choose the backup folder or drive.' })
  try {
    res.json(await previewRestore(source, target))
  } catch (e) {
    fail(res, e, 'Could not read that backup')
  }
})

router.post('/backup/restore/run', async (req, res) => {
  const b = req.body || {}
  const source = typeof b.source === 'string' ? b.source.trim() : ''
  const target = typeof b.target === 'string' ? b.target.trim() : ''
  const channels = Array.isArray(b.channels)
    ? b.channels.filter((c: any) => c && typeof c.slug === 'string').map((c: any) => ({ slug: c.slug, replace: c.replace === true }))
    : []
  if (!source || !target) return res.status(400).json({ detail: 'Choose the backup and the Library to restore into.' })
  if (!channels.length && b.app !== true) return res.status(400).json({ detail: 'Choose at least one channel to restore.' })
  try {
    if (b.use_as_library === true) {
      const { checkLibraryTarget } = await import('../services/library.js')
      const check = await checkLibraryTarget(target)
      if (!check.ok) return res.status(400).json({ detail: check.reason })
    }
    startRestore({ source, target, channels, app: b.app === true, use_as_library: b.use_as_library === true })
    res.json({ started: true })
  } catch (e) {
    fail(res, e, 'Could not start the restore')
  }
})

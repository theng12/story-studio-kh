/**
 * System routes — thin wrappers over Electron's native shell/dialog.
 * Safe to call from the renderer: no IPC/preload needed because the Express
 * server runs inside the Electron main process.
 *
 *   POST /system/pick-folder         → opens the OS directory picker
 *   POST /system/reveal-folder       → reveals a folder in Finder / Explorer
 *   GET  /system/migrations/pending  → projects still stored in userData
 *   POST /system/migrations/migrate  → move one project to a visible folder
 */

import { Router } from 'express'
import { createRequire } from 'module'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import {
  getProjectsNeedingMigration,
  migrateProjectTo,
} from '../services/migration.js'
import { setQueuePaused, isQueuePaused } from '../services/job-queue.js'
import {
  listNamedRoots,
  setNamedRoot,
  removeNamedRoot,
  isValidRootName,
} from '../services/named-roots.js'
import { resolveAssetPath, toPortablePath, isPortablePath } from '../services/path-resolver.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

const require = createRequire(import.meta.url)

export const router = Router()

/**
 * Returns the Electron module if we're running inside Electron's main
 * process, or `null` otherwise. Guarding on `typeof === 'object'` matters:
 * when the backend is launched as a standalone Node process (e.g. dev
 * `tsx watch server/app.ts`), `require('electron')` doesn't throw — it
 * returns the path to the Electron binary as a STRING, which previously
 * slipped past a truthy `if (!electron)` check and then blew up on the
 * first `electron.dialog.…` access with "Cannot read properties of
 * undefined". Treating the string case as null gives every route a
 * consistent 500 with a readable message instead.
 */
function loadElectron(): any | null {
  try {
    const e = require('electron')
    if (typeof e !== 'object' || e === null) return null
    return e
  } catch { return null }
}

/**
 * Show a native open dialog. Safe to call whether or not a BrowserWindow is
 * focused — on macOS the dialog works app-modally when no window is passed,
 * which avoids the "durationMs:1 status:500" failure we saw in dev when the
 * renderer momentarily lost focus (server logs 2026-04-22 captured 14
 * repeats of this).
 */
async function showOpenDialog(
  electron: any,
  options: any,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  const { BrowserWindow, dialog } = electron
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

router.post('/system/pick-folder', async (_req, res) => {
  const electron = loadElectron()
  if (!electron) return res.status(503).json({ detail: 'Folder picker not available — Electron main process not detected (are you running the server standalone?).' })

  try {
    const result = await showOpenDialog(electron, {
      title: 'Choose where to save this project',
      buttonLabel: 'Save Here',
      properties: ['openDirectory', 'createDirectory'],
    })
    res.json({ path: result.canceled ? null : result.filePaths[0] })
  } catch (e: any) {
    console.warn('[system/pick-folder] dialog failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'Folder picker failed'))
  }
})

/**
 * Pick a single file via native OS dialog.
 * Body: { title?, buttonLabel?, filters?: Array<{ name, extensions: string[] }> }
 * Returns: { path: string | null }  (null if the user cancelled)
 */
router.post('/system/pick-file', async (req, res) => {
  const electron = loadElectron()
  if (!electron) {
    return res.status(503).json({ detail: 'File picker not available — Electron main process not detected (are you running the server standalone?).' })
  }

  const title = typeof req.body?.title === 'string' ? req.body.title : 'Choose a file'
  const buttonLabel = typeof req.body?.buttonLabel === 'string' ? req.body.buttonLabel : 'Select'
  const filters = Array.isArray(req.body?.filters) && req.body.filters.length
    ? req.body.filters
    : [{ name: 'All Files', extensions: ['*'] }]

  try {
    const result = await showOpenDialog(electron, {
      title, buttonLabel, filters,
      properties: ['openFile'],
    })
    res.json({ path: result.canceled ? null : result.filePaths[0] })
  } catch (e: any) {
    console.warn('[system/pick-file] dialog failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'File picker failed'))
  }
})

/**
 * Pick MULTIPLE files via native OS dialog. Used by the asset importer
 * dialog where the user might select 12 scene PNGs in one go.
 * Body: { title?, buttonLabel?, filters?: Array<{ name, extensions: string[] }> }
 * Returns: { paths: string[] }  (empty array if the user cancelled)
 *
 * Why a separate route: in modern Electron the browser-side
 * `<input type="file">` no longer exposes File.path (security/Chromium
 * alignment), so we can't read absolute paths from the renderer's
 * picker. Falling through to the native dialog via IPC is the only
 * reliable way to get absolute paths the importer can copy/move from.
 */
router.post('/system/pick-files', async (req, res) => {
  const electron = loadElectron()
  if (!electron) {
    return res.status(503).json({ detail: 'File picker not available — Electron main process not detected (are you running the server standalone?).' })
  }

  const title = typeof req.body?.title === 'string' ? req.body.title : 'Choose files'
  const buttonLabel = typeof req.body?.buttonLabel === 'string' ? req.body.buttonLabel : 'Select'
  const filters = Array.isArray(req.body?.filters) && req.body.filters.length
    ? req.body.filters
    : [{ name: 'All Files', extensions: ['*'] }]

  try {
    const result = await showOpenDialog(electron, {
      title, buttonLabel, filters,
      properties: ['openFile', 'multiSelections'],
    })
    res.json({ paths: result.canceled ? [] : (result.filePaths || []) })
  } catch (e: any) {
    console.warn('[system/pick-files] dialog failed:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'File picker failed'))
  }
})

router.post('/system/reveal-folder', async (req, res) => {
  const electron = loadElectron()
  if (!electron) return res.status(503).json({ detail: 'Shell not available — Electron main process not detected.' })

  const target = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  if (!target) return res.status(400).json({ detail: 'path required' })

  // Validate before asking the shell to open it — otherwise `openPath`
  // returns an opaque string error that surfaces as a confusing 500. The
  // path can be to a file or directory (shell reveals the containing dir
  // for files); just check it exists.
  const abs = path.isAbsolute(target) ? target : path.resolve(target)
  try {
    await fs.access(abs)
  } catch {
    return res.status(404).json({ detail: `Path does not exist: ${abs}` })
  }

  try {
    const err = await electron.shell.openPath(abs)
    if (err) {
      console.warn('[system/reveal-folder] openPath returned:', err)
      return res.status(500).json({ detail: `Could not open: ${err}` })
    }
    res.json({ ok: true })
  } catch (e: any) {
    console.warn('[system/reveal-folder] threw:', e?.message || e)
    res.status(500).json(humanizeBackendError(e, 'Reveal failed'))
  }
})

// ── Queue pause (network-aware) ────────────────────────────────────────────

router.get('/system/queue/status', (_req, res) => {
  res.json({ paused: isQueuePaused() })
})

router.post('/system/queue/pause', (_req, res) => {
  setQueuePaused(true)
  res.json({ paused: true })
})

router.post('/system/queue/resume', (_req, res) => {
  setQueuePaused(false)
  res.json({ paused: false })
})

// ── Migration ──────────────────────────────────────────────────────────────

router.get('/system/migrations/pending', async (_req, res) => {
  try {
    const pending = await getProjectsNeedingMigration()
    res.json({ projects: pending })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list pending migrations'))
  }
})

router.post('/system/migrations/migrate', async (req, res) => {
  const { slug, new_root } = req.body || {}
  if (!slug || !new_root) return res.status(400).json({ detail: 'slug and new_root required' })
  if (!path.isAbsolute(new_root)) return res.status(400).json({ detail: 'new_root must be an absolute path' })

  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  try {
    const result = await migrateProjectTo(slug, new_root)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Migration failed'))
  }
})

// ── Named roots ────────────────────────────────────────────────────────────
// Per-machine label → absolute path map. Used by the path resolver to expand
// `${NAME}/rel` preset references into concrete paths. Never synced.

router.get('/system/named-roots', (_req, res) => {
  res.json({ roots: listNamedRoots() })
})

router.post('/system/named-roots', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const p = typeof req.body?.path === 'string' ? req.body.path : ''
  if (!name || !p) return res.status(400).json({ detail: 'name and path required' })
  if (!isValidRootName(name)) {
    return res.status(400).json({
      detail: 'Invalid name. Use UPPERCASE letters, digits, and underscores (start with a letter). "PROJECT" is reserved.',
    })
  }
  if (!path.isAbsolute(p)) {
    return res.status(400).json({ detail: 'path must be absolute' })
  }
  try {
    await setNamedRoot(name, p)
    res.json({ ok: true, roots: listNamedRoots() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save named root'))
  }
})

router.delete('/system/named-roots/:name', async (req, res) => {
  try {
    await removeNamedRoot(req.params.name)
    res.json({ ok: true, roots: listNamedRoots() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to remove named root'))
  }
})

/**
 * Debug / preview helper. Accepts `{ path, output_root?, mode? }`.
 *   mode=resolve (default) — expand portable → absolute
 *   mode=portable           — collapse absolute → portable form
 * Returns `{ input, output, is_portable }`.
 */
router.post('/system/resolve-asset-path', (req, res) => {
  const input = typeof req.body?.path === 'string' ? req.body.path : ''
  const outputRoot = typeof req.body?.output_root === 'string' ? req.body.output_root : undefined
  const mode = req.body?.mode === 'portable' ? 'portable' : 'resolve'
  if (!input) return res.status(400).json({ detail: 'path required' })
  try {
    const output = mode === 'portable' ? toPortablePath(input, outputRoot) : resolveAssetPath(input, outputRoot)
    res.json({ input, output, is_portable: isPortablePath(output) })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Resolution failed'))
  }
})

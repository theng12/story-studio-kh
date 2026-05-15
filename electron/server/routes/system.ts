/**
 * System routes — thin wrappers over Electron's native shell/dialog.
 * Safe to call from the renderer: no IPC/preload needed because the Express
 * server runs inside the Electron main process.
 *
 *   POST /system/pick-folder         → opens the OS directory picker
 *   POST /system/reveal-folder       → reveals a folder in Finder / Explorer
 *
 * (Removed in v1.0.14: GET /system/migrations/pending +
 * POST /system/migrations/migrate. The userData-→-visible-folder
 * migration they powered is fully superseded by the v1.0.13 Storage
 * tab "Move projects to…" flow + the per-project Move asset location
 * button + the dashboard recovery banner — all of which understand
 * the iCloud case the legacy migrator misclassified as "hidden".)
 */

import { Router } from 'express'
import { createRequire } from 'module'
import fs from 'fs/promises'
import path from 'path'
import * as pm from '../services/project-manager.js'
import { setQueuePaused, isQueuePaused } from '../services/job-queue.js'
import {
  listNamedRoots,
  setNamedRoot,
  removeNamedRoot,
  isValidRootName,
} from '../services/named-roots.js'
import { resolveAssetPath, toPortablePath, isPortablePath } from '../services/path-resolver.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { isServerMode } from '../lib/server-mode.js'
import { getMachineLabel } from '../services/manifest.js'

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

/**
 * List immediate subfolders of a given parent path. Used by the Ideas
 * Generator's "auto-import subfolders" mode: the user picks a parent dir
 * and we surface every immediate child directory so they can preview /
 * uncheck before kicking off the per-folder import loop.
 *
 * Read-only and shallow (one level) on purpose — recursion would invite
 * surprises (e.g. an `images/` subfolder of an episode being treated as a
 * sibling episode). Hidden dirs (leading dot) are skipped to keep results
 * matched to what the user sees in Finder.
 */
router.post('/system/list-subfolders', async (req, res) => {
  const parent = typeof req.body?.parent === 'string' ? req.body.parent : ''
  if (!parent) {
    return res.status(400).json({ detail: 'parent path required' })
  }
  try {
    const stat = await fs.stat(parent)
    if (!stat.isDirectory()) {
      return res.status(400).json({ detail: 'parent is not a directory' })
    }
    const entries = await fs.readdir(parent, { withFileTypes: true })
    const subfolders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(parent, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json({ subfolders })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list subfolders'))
  }
})

router.post('/system/pick-folder', async (req, res) => {
  const electron = loadElectron()
  if (!electron) return res.status(503).json({ detail: 'Folder picker not available — Electron main process not detected (are you running the server standalone?).' })

  // Optional body { title?, buttonLabel?, defaultPath? } so callers can
  // customise the dialog wording. Defaults preserve the project-creation
  // wording from the original (sole) caller for back-compat.
  const title = typeof req.body?.title === 'string' && req.body.title
    ? req.body.title
    : 'Choose where to save this project'
  const buttonLabel = typeof req.body?.buttonLabel === 'string' && req.body.buttonLabel
    ? req.body.buttonLabel
    : 'Save Here'
  const defaultPath = typeof req.body?.defaultPath === 'string' && req.body.defaultPath
    ? req.body.defaultPath
    : undefined

  try {
    const result = await showOpenDialog(electron, {
      title, buttonLabel, defaultPath,
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

// ── Server-side file browser (used in server mode) ─────────────────────────
//
// In default (Electron) mode, picker buttons spawn the native macOS dialog
// via /system/pick-folder etc. above. In server mode, the user is on a remote
// browser — there's no native dialog to spawn — so the SPA opens an in-app
// modal that lists folders/files using these endpoints. The composable
// `usePathPicker` (frontend/composables/usePathPicker.ts) routes to the
// right backend automatically.

interface BrowseEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mtime?: string
  hidden: boolean
}

router.post('/system/browse-dir', async (req, res) => {
  const inputPath = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  const showHidden = req.body?.show_hidden === true
  if (!inputPath) return res.status(400).json({ detail: 'path required' })

  // Expand `~` for convenience — users typing paths into the modal expect
  // it to work like a shell. Stay strict about absolute-only otherwise.
  let expanded = inputPath
  if (expanded.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) expanded = path.join(home, expanded.slice(1))
  }
  if (!path.isAbsolute(expanded)) {
    return res.status(400).json({ detail: 'path must be absolute' })
  }

  try {
    const stat = await fs.stat(expanded)
    if (!stat.isDirectory()) return res.status(400).json({ detail: 'path is not a directory' })

    const dirents = await fs.readdir(expanded, { withFileTypes: true })
    const entries: BrowseEntry[] = []
    for (const d of dirents) {
      const hidden = d.name.startsWith('.')
      if (hidden && !showHidden) continue
      // Special-case the noise files macOS sprinkles everywhere.
      if (d.name === '.DS_Store' || d.name === 'Thumbs.db') continue
      const e: BrowseEntry = {
        name: d.name,
        type: d.isDirectory() ? 'dir' : 'file',
        hidden,
      }
      // Best-effort stat for size/mtime — never fail the listing if a single
      // entry's metadata can't be read (permissions, race with deletion).
      try {
        const s = await fs.stat(path.join(expanded, d.name))
        if (!d.isDirectory()) e.size = s.size
        e.mtime = s.mtime.toISOString()
      } catch { /* best effort */ }
      entries.push(e)
    }
    // Dirs first, then files; alphabetical within each group.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const parent = path.dirname(expanded)
    res.json({
      path: expanded,
      parent: parent === expanded ? null : parent,
      entries,
    })
  } catch (e: any) {
    if (e?.code === 'ENOENT') return res.status(404).json({ detail: `Path does not exist: ${expanded}` })
    if (e?.code === 'EACCES') return res.status(403).json({ detail: `Permission denied: ${expanded}` })
    res.status(500).json(humanizeBackendError(e, 'Failed to read directory'))
  }
})

router.post('/system/validate-path', async (req, res) => {
  const inputPath = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  const mustBeDir = req.body?.must_be_dir === true
  const mustExist = req.body?.must_exist !== false  // default true
  const mustHaveExt = Array.isArray(req.body?.must_have_extension)
    ? (req.body.must_have_extension as unknown[]).filter(x => typeof x === 'string') as string[]
    : []
  if (!inputPath) return res.json({ valid: false, reason: 'path is empty' })

  let expanded = inputPath
  if (expanded.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) expanded = path.join(home, expanded.slice(1))
  }
  if (!path.isAbsolute(expanded)) {
    return res.json({ valid: false, reason: 'path must be absolute', normalized: expanded })
  }
  const normalized = path.normalize(expanded)

  if (mustExist || mustBeDir) {
    try {
      const stat = await fs.stat(normalized)
      if (mustBeDir && !stat.isDirectory()) {
        return res.json({ valid: false, reason: 'path is not a directory', normalized })
      }
    } catch {
      return res.json({ valid: false, reason: 'path does not exist', normalized })
    }
  }

  if (mustHaveExt.length) {
    const lower = normalized.toLowerCase()
    const ok = mustHaveExt.some(ext => {
      const e = ext.startsWith('.') ? ext : `.${ext}`
      return lower.endsWith(e.toLowerCase())
    })
    if (!ok) {
      return res.json({
        valid: false,
        reason: `extension must be one of: ${mustHaveExt.join(', ')}`,
        normalized,
      })
    }
  }

  res.json({ valid: true, normalized })
})

router.get('/system/quick-locations', async (_req, res) => {
  // Sidebar shortcuts shown in the FileBrowserModal — common starting points
  // a user is likely to want when picking a folder. Each entry is checked for
  // existence so we don't surface broken paths (e.g. the "Mobile Documents"
  // iCloud dir doesn't exist on a fresh install with iCloud disabled).
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates: Array<{ label: string; path: string }> = []
  if (home) {
    candidates.push({ label: 'Home', path: home })
    candidates.push({ label: 'Desktop', path: path.join(home, 'Desktop') })
    candidates.push({ label: 'Documents', path: path.join(home, 'Documents') })
    candidates.push({ label: 'Downloads', path: path.join(home, 'Downloads') })
    if (process.platform === 'darwin') {
      candidates.push({
        label: 'iCloud Drive',
        path: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
      })
    }
  }
  // Always include the app's projects root — that's where most picker flows
  // want to start (e.g. choosing a subfolder of an existing project).
  try {
    candidates.push({ label: 'Projects', path: pm.PROJECTS_ROOT })
  } catch { /* PROJECTS_ROOT might be lazy-resolved; skip if unavailable */ }

  const present: Array<{ label: string; path: string }> = []
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c.path)
      if (stat.isDirectory()) present.push(c)
    } catch { /* doesn't exist on this machine — skip */ }
  }
  res.json({ locations: present })
})

router.post('/system/reveal-folder', async (req, res) => {
  // In server mode, "Reveal in Finder" would open Finder on the Mac mini —
  // useless to the user sitting at the iMac browser. Reject for remote users
  // (anyone whose req.user isn't the loopback marker), but still allow when
  // the request comes from the local Electron window on the mini itself.
  if (isServerMode() && (req as any).user?.username !== '__local__') {
    return res.status(503).json({
      detail: 'Reveal in Finder is not available over the web — open the app on the Mac mini directly to reveal folders.',
      reason: 'server_mode_remote',
    })
  }

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

// ── Machine identity ───────────────────────────────────────────────────────
//
// v1.0.93+ — per-device preset filtering needs a stable handle for "which Mac
// is this?". We piggy-back on the same `getMachineLabel()` helper that's
// already stamped on portable project manifests (manifest.ts:129), so the
// label the user sees in the preset picker matches the one they see in
// "last edited on <machine>" elsewhere. Just `os.hostname()` under the hood
// — no fingerprinting, no UUID, no tracking. If hostname resolution fails
// we return 'unknown' (same fallback the manifest path uses).

router.get('/system/machine-label', (_req, res) => {
  res.json({ machine_label: getMachineLabel() })
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

// ── Projects storage location (cloud-sync setup) ──────────────────────────
//
// Lets the user point the projects folder at any local path — typically
// inside iCloud Drive / Dropbox / Google Drive so the OS handles
// cross-machine sync. Persists to app-settings.json (per-machine, doesn't
// sync). The boot-time read in project-manager.ts picks up the override
// on next launch — so the typical flow is:
//
//   1. PUT  /app-settings/projects-root     { override: "/iCloud/SS Projects" }
//   2. POST /app-settings/projects-root/migrate
//                                            { target_path: "/iCloud/SS Projects" }
//   3. POST /system/restart-app
//
// All three are issued by the Storage tab UI in one user-visible action.

router.get('/app-settings/projects-root', async (_req, res) => {
  try {
    const { getAppSetting } = await import('../services/app-settings.js')
    const override = await getAppSetting('projects_root_override')
    const overrideStr = typeof override === 'string' ? override : ''
    const defaultPath = pm.getProjectsRootDefaultPath()
    const effectivePath = pm.PROJECTS_ROOT
    res.json({
      override: overrideStr,
      effective_path: effectivePath,
      default_path: defaultPath,
      is_overridden: !!overrideStr && effectivePath !== defaultPath,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read projects-root setting'))
  }
})

router.put('/app-settings/projects-root', async (req, res) => {
  try {
    const value = typeof req.body?.override === 'string' ? req.body.override.trim() : ''
    const { setAppSetting } = await import('../services/app-settings.js')
    await setAppSetting('projects_root_override', value)
    res.json({ ok: true, override: value })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to set projects-root override'))
  }
})

router.post('/app-settings/projects-root/preview-migration', async (_req, res) => {
  try {
    const { previewMigration } = await import('../services/projects-storage-mover.js')
    const r = await previewMigration()
    res.json(r)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to preview migration'))
  }
})

// Inspect a candidate target dir to see if it already contains projects.
// Used by the "Use existing folder (no copy)" flow on a second machine
// where iCloud has already synced the projects folder down — the UI
// shows the count + sample slugs before the user commits to switching.
router.post('/app-settings/projects-root/inspect-target', async (req, res) => {
  try {
    const target = typeof req.body?.target_path === 'string' ? req.body.target_path.trim() : ''
    if (!target) return res.status(400).json({ detail: 'target_path is required' })
    const { inspectTargetForExistingProjects } = await import('../services/projects-storage-mover.js')
    const r = await inspectTargetForExistingProjects(target)
    res.json(r)
  } catch (e: any) {
    const status = e?.statusCode === 400 ? 400 : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to inspect target'))
  }
})

router.post('/app-settings/projects-root/migrate', async (req, res) => {
  try {
    const target = typeof req.body?.target_path === 'string' ? req.body.target_path.trim() : ''
    if (!target) return res.status(400).json({ detail: 'target_path is required' })
    const { migrateProjectsTo } = await import('../services/projects-storage-mover.js')
    const result = await migrateProjectsTo(target, {
      merge_into_existing: req.body?.merge_into_existing === true,
    })
    res.json(result)
  } catch (e: any) {
    // Service throws with statusCode set on validation errors. Map
    // 400/409 distinctly so the UI can show the right confirmation
    // (e.g. 409 → "target not empty, switch to merge mode?").
    const status = e?.statusCode === 400 ? 400
      : e?.statusCode === 409 ? 409
      : 500
    res.status(status).json(humanizeBackendError(e, 'Migration failed'))
  }
})

// Last step of the migration flow: relaunch the Electron app so the
// boot-time PROJECTS_ROOT read picks up the new override path. Quietly
// 503s in dev (tsx) where there's no Electron app to relaunch — the
// dev script handles its own restarts.
router.post('/system/restart-app', async (_req, res) => {
  try {
    const electron = (() => {
      try { return require('electron') } catch { return null }
    })()
    if (!electron?.app) {
      return res.status(503).json({
        detail: 'Restart not available — Electron main process not detected (dev mode? restart npm run dev manually).',
      })
    }
    res.json({ ok: true, restarting: true })
    // Give the response a tick to flush before we tear down the process.
    setTimeout(() => {
      try {
        electron.app.relaunch()
        electron.app.exit(0)
      } catch { /* nothing else we can do here */ }
    }, 250)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Restart failed'))
  }
})

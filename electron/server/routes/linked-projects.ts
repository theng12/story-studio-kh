/**
 * Linked-projects routes.
 *
 * The per-Mac registry of project folders that live OUTSIDE the default
 * PROJECTS_ROOT (e.g. one project synced to iCloud while others stay
 * in the userData folder). Three concerns split across two route
 * groups:
 *
 *   - Registry CRUD: list / inspect / add / remove a linked path.
 *     Used by the "Add existing project folder…" button on the
 *     All Projects page.
 *
 *   - Per-project move: relocate one project to a chosen folder, then
 *     register the new path. Used by the Project tab → "Move this
 *     project to…" button.
 *
 * All endpoints map service errors via their attached statusCode so
 * the UI can render targeted messaging (400 = caller fix-able input,
 * 409 = blocker like .icloud placeholder, 507 = insufficient disk).
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import {
  listLinkedProjects,
  inspectLinkedPath,
  addLinkedProject,
  removeLinkedProject,
} from '../services/linked-projects.js'
import {
  detectProjectMoveStatus,
  moveProjectToFolder,
} from '../services/project-mover.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

// ── Registry CRUD ──────────────────────────────────────────────────────────

/**
 * List every linked project (path + slug + name + existence). Powers
 * the All Projects page's location chips. Read-only; safe to poll on
 * every page mount.
 */
router.get('/linked-projects', async (_req, res) => {
  try {
    const projects = await listLinkedProjects()
    res.json({ projects })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list linked projects'))
  }
})

/**
 * Inspect a candidate folder before adding. The "Add existing project
 * folder…" picker calls this after the user picks a path, so the
 * confirmation sheet can show the project name + warn on validation
 * failures (no project.json, unreadable, etc.) before committing.
 */
router.post('/linked-projects/inspect', async (req, res) => {
  const target = typeof req.body?.path === 'string' ? req.body.path : ''
  if (!target) return res.status(400).json({ detail: 'path required' })
  try {
    const info = await inspectLinkedPath(target)
    res.json(info)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to inspect linked path'))
  }
})

/**
 * Add a folder to the linked-projects registry. Validates by reading
 * project.json and surfacing the same 400 reasons inspectLinkedPath
 * exposes. Idempotent — adding the same path twice is a no-op.
 */
router.post('/linked-projects', async (req, res) => {
  const target = typeof req.body?.path === 'string' ? req.body.path : ''
  if (!target) return res.status(400).json({ detail: 'path required' })
  try {
    const info = await addLinkedProject(target)
    res.status(201).json(info)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to add linked project'))
  }
})

/**
 * Remove a path from the registry. Doesn't touch the folder on disk
 * — the user can re-add it later or delete the folder manually.
 * The path is sent in the body to avoid URL-encoding pain on absolute
 * paths with slashes.
 */
router.delete('/linked-projects', async (req, res) => {
  const target = typeof req.body?.path === 'string' ? req.body.path : ''
  if (!target) return res.status(400).json({ detail: 'path required' })
  try {
    const removed = await removeLinkedProject(target)
    if (!removed) return res.status(404).json({ detail: 'Path not found in linked-projects registry' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to remove linked project'))
  }
})

// ── Per-project move ──────────────────────────────────────────────────────

/**
 * Inspect a project's current folder. Used by the Project tab dialog
 * to render the size estimate + .icloud blocker list before the user
 * confirms.
 */
router.get('/projects/:slug/move-status', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  try {
    const status = await detectProjectMoveStatus(req.params.slug)
    res.json(status)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to inspect project move status'))
  }
})

/**
 * Move one project to a chosen folder. Body:
 *   {
 *     destination: string  (absolute path — parent folder for the new project dir)
 *     delete_source?: boolean  (default false; keeps source as <slug>.bak-<ISO>)
 *   }
 */
router.post('/projects/:slug/move-to-folder', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  const destination = typeof req.body?.destination === 'string' ? req.body.destination : ''
  if (!destination) return res.status(400).json({ detail: 'destination required' })
  const deleteSource = req.body?.delete_source === true
  try {
    const result = await moveProjectToFolder(req.params.slug, destination, { delete_source: deleteSource })
    res.json(result)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to move project'))
  }
})

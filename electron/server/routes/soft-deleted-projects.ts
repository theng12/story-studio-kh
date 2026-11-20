/**
 * Routes for the soft-deleted-projects ("hidden projects") flow.
 *
 *   GET    /soft-deleted-projects       → list of hidden slugs + paths
 *                                          + sizes for the home-page chip
 *   POST   /soft-deleted-projects/:slug/restore  → un-hide (folder
 *                                          re-appears in the project list)
 *   DELETE /soft-deleted-projects/:slug → hard delete (rm -rf the folder
 *                                          AND clear the tombstone)
 *
 * "Reveal in Finder" reuses the existing /system/reveal-folder route —
 * the frontend posts the orphan_path it got from the soft-delete result
 * (or the GET response) directly there.
 *
 * The DELETE is the *only* destructive operation in this whole flow,
 * and the frontend only fires it after a "Yes, permanently delete X
 * GB across N files" confirmation dialog. The soft-delete tombstone
 * is the exclusive gate — calling DELETE on a slug that's not currently
 * soft-deleted (e.g. because the user already restored it) returns 400.
 */

import { Router } from 'express'
import {
  listSoftDeletedProjects,
  forgetSoftDeletedProject,
  hardDeleteSoftDeletedProject,
} from '../services/soft-delete.js'
import { isOwnerRequest, readAutomationKeyHeader } from '../lib/auth-session.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { getServerModeConfig } from '../lib/server-mode.js'

export const router = Router()

// The same owner rule its sibling `POST /trash/delete-permanently` already applies (routes/trash.ts):
// a keyless loopback request is not the owner, and an automation key never is.
const viaAutomationKey = (req: any) => req.user?.via === 'automation_key' || readAutomationKeyHeader(req.headers || {}) !== undefined
const notOwner = (req: any) => viaAutomationKey(req) || !isOwnerRequest(req, getServerModeConfig()?.auth)

router.get('/soft-deleted-projects', async (_req, res) => {
  try {
    const items = await listSoftDeletedProjects()
    res.json({ projects: items })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list hidden projects'))
  }
})

router.post('/soft-deleted-projects/:slug/restore', async (req, res) => {
  try {
    const ok = await forgetSoftDeletedProject(req.params.slug)
    if (!ok) {
      return res.status(404).json({ detail: `'${req.params.slug}' is not currently hidden.` })
    }
    res.json({ ok: true, slug: req.params.slug })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to restore project'))
  }
})

router.delete('/soft-deleted-projects/:slug', async (req: any, res) => {
  // Irreversible, so it carries the same owner guard as its sibling in routes/trash.ts. Before
  // 2026-11-20 this route had no owner check at all while the sibling did — a confirmation in the
  // client is not a guard (row `20261120-161`).
  if (notOwner(req)) {
    return res.status(403).json({
      detail: 'Only the owner can delete a hidden channel from disk, from the app window or a signed-in '
        + 'browser. Automation keys never can. Nothing was deleted.',
    })
  }
  const { confirm, expected_bytes } = req.body || {}
  if (confirm !== true || !Number.isSafeInteger(expected_bytes)) {
    return res.status(400).json({
      detail: 'Confirm the size to delete. Nothing was deleted — reopen the hidden channel and confirm the '
        + 'number of bytes shown.',
    })
  }
  try {
    await hardDeleteSoftDeletedProject(req.params.slug, expected_bytes)
    res.json({ ok: true, slug: req.params.slug })
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to permanently delete project'))
  }
})

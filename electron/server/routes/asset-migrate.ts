/**
 * Per-project asset migration routes — relocate a project's
 * `output_root` (where its episode folders, scripts, images, audio,
 * and video files live) into the co-located `<projectDir>/episodes/`
 * layout. Two surfaces:
 *
 *   - The Project sub-tab "Move asset location" button (per-project).
 *   - The dashboard recovery banner that appears when a project's
 *     metadata is in iCloud but its assets aren't ("half-migrated"
 *     state).
 *
 * The Storage tab's "Move projects to..." flow calls the same service
 * directly — see services/projects-storage-mover.ts for that path.
 *
 * All endpoints require an existing project; 404 otherwise. Validation
 * + blocker errors map to 400/409/507 so the UI can render distinct
 * messaging without parsing strings.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import {
  detectAssetMigrationStatus,
  migrateProjectAssets,
} from '../services/asset-migrator.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

/**
 * Read-only status — fired by the dashboard banner composable on every
 * project switch + by the Project tab dialog before showing the
 * confirmation sheet. Cheap (one project.json read + a recursive scan
 * of the output_root if it's external); safe to poll.
 */
router.get('/projects/:slug/asset-migration-status', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  try {
    const status = await detectAssetMigrationStatus(req.params.slug)
    res.json(status)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to inspect asset migration status'))
  }
})

/**
 * Run the migration for one project. Body:
 *   { delete_source?: boolean }
 *
 * On success returns the AssetMigrationResult (bytes/files copied,
 * new output_root, source_kept_at). On validation failure returns
 * 400; on .icloud-placeholder block returns 409; on insufficient
 * disk space returns 507.
 */
router.post('/projects/:slug/migrate-assets', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  const deleteSource = req.body?.delete_source === true
  try {
    const result = await migrateProjectAssets(req.params.slug, { delete_source: deleteSource })
    res.json(result)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Asset migration failed'))
  }
})

/**
 * Bulk status — one row per project, used by the Storage tab's preview
 * to surface "X projects have external assets totaling Y GB" before
 * the user clicks Move. Read-only. Fires N project.json reads + N
 * recursive scans (only for projects that need migration); skip the
 * scan for already-co-located projects so listProjects on a healthy
 * tree stays cheap.
 */
router.get('/asset-migration-status', async (_req, res) => {
  try {
    const projects = await pm.listProjects()
    const rows = await Promise.all(projects.map(async (p) => {
      const status = await detectAssetMigrationStatus(p.slug)
      return {
        slug: p.slug,
        name: p.name,
        ...status,
      }
    }))
    res.json({ projects: rows })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to inspect bulk asset migration status'))
  }
})

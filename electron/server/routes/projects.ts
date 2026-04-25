import { Router } from 'express'
import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { validateBody } from '../lib/validate.js'
import { CreateProjectSchema, UpdateProjectSchema } from '../schemas/index.js'
import { importProjectFromFolder, inspectProjectFolder } from '../services/import-project.js'
import { getManifestStatus, readManifest, writeManifestCache } from '../services/manifest.js'
import { auditProjectAssets } from '../services/asset-status.js'
import { auditAssets } from '../services/manifest-audit.js'
import { getSecretsProvenanceStatus, resetSecretsForCurrentMachine } from '../services/secrets-store.js'
import { listFormats, loadFormat, getEffectiveFormat } from '../services/format-loader.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import type { ProjectMeta } from '../models/types.js'
import type { JobType } from '../models/types.js'

export const router = Router()

router.get('/projects', async (_req, res) => {
  res.json(await pm.listProjects())
})

router.get('/projects/templates', async (_req, res) => {
  res.json(await pm.getTemplates())
})

// ── Format library endpoints (Phase 1 of format/character/pattern system) ──
//
// Built-in + user-custom formats are merged by listFormats(). The picker UI
// uses /api/formats; the override editor uses /api/formats/:id for the full
// bundle. Per-project effective format (base + project's overrides applied)
// lives at /api/projects/:slug/effective-format.

router.get('/formats', async (_req, res) => {
  try {
    const formats = await listFormats()
    res.json(formats)
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to list formats: ${e.message}` })
  }
})

router.get('/formats/:id', async (req, res) => {
  try {
    const fmt = await loadFormat(req.params.id)
    if (!fmt) return res.status(404).json({ detail: `Format '${req.params.id}' not found` })
    res.json(fmt)
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to load format: ${e.message}` })
  }
})

router.get('/projects/:slug/effective-format', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    res.json(await getEffectiveFormat(req.params.slug))
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to resolve effective format: ${e.message}` })
  }
})

// Project-wide asset audit: per-episode presence counts across audio,
// scenes, thumbnails, video clips, merged audio. Powers the Settings →
// Assets matrix.
router.get('/projects/:slug/assets-audit', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const rows = await auditProjectAssets(req.params.slug)
    res.json({ episodes: rows })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audit failed'))
  }
})

// On-open asset integrity audit — returns per-episode × stage gaps so the
// project dashboard can surface a single banner when a synced/transferred
// project is missing files. Distinct from /assets-audit (which powers the
// bigger Assets matrix + Repair UI) because it differentiates "not started"
// from "started-but-missing" and returns exact filenames rather than just
// counts. Audit is cheap (directory listing only, no file reads) — safe to
// call on every dashboard mount.
router.get('/projects/:slug/assets-audit-detail', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const report = await auditAssets(req.params.slug)
    res.json(report)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audit failed'))
  }
})

// Universal repair — fans out the existing per-modality repair endpoints
// for every episode with missing assets. "Repair" here means: ask the
// provider for jobs it already completed (and billed) but whose output
// never landed on disk. Zero credit cost; safe to run anytime. For clips
// / images without a stored task id the repair job reports them as
// "needs_fresh_generation" in its log so the user can decide.
//
// Scope can be narrowed via body: `{ episode_codes?, modalities? }`.
// Default is all episodes × all modalities. Audio repair is synchronous
// (runs inline against GenAIPro's history) while image/video repair
// enqueue background jobs — the response shape reflects both paths.
router.post('/projects/:slug/assets/repair-all', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const requestedCodes: string[] | undefined = Array.isArray(req.body?.episode_codes)
      ? req.body.episode_codes.filter((c: any) => typeof c === 'string' && c)
      : undefined
    const requestedModalities: Array<'audio' | 'images' | 'video'> = Array.isArray(req.body?.modalities)
      ? req.body.modalities.filter((m: any) => m === 'audio' || m === 'images' || m === 'video')
      : ['audio', 'images', 'video']

    const rows = await auditProjectAssets(slug)
    const enqueued: Array<{ episode_id: string; type: JobType; job_id: string }> = []
    const skipped: Array<{ episode_id: string; modality: string; reason: string }> = []
    const audio_queued: string[] = []

    for (const row of rows) {
      if (requestedCodes && !requestedCodes.includes(row.episode_id)) continue

      // Images repair — covers scenes + thumbnails together (the endpoint
      // reconciles both sides in a single job).
      if (requestedModalities.includes('images')
          && (row.scenes.missing > 0 || row.thumbnails.missing > 0)) {
        if (jq.isDuplicate(slug, row.episode_id, 'images_repair')) {
          skipped.push({ episode_id: row.episode_id, modality: 'images', reason: 'already queued/running' })
        } else {
          const job = jq.enqueue({
            project_slug: slug,
            type: 'images_repair',
            episode_id: row.episode_id,
            title: 'Image Repair (no credits)',
            params: { episode_id: row.episode_id },
          })
          enqueued.push({ episode_id: row.episode_id, type: 'images_repair', job_id: job.job_id })
        }
      }

      // Video clip repair — only when the row has missing clips.
      if (requestedModalities.includes('video') && row.video.missing > 0) {
        if (jq.isDuplicate(slug, row.episode_id, 'video_repair' as any)) {
          skipped.push({ episode_id: row.episode_id, modality: 'video', reason: 'already queued/running' })
        } else {
          const job = jq.enqueue({
            project_slug: slug,
            type: 'video_repair' as any,
            episode_id: row.episode_id,
            title: 'Video Repair (no credits)',
            params: { episode_id: row.episode_id },
          })
          enqueued.push({ episode_id: row.episode_id, type: 'video_repair' as any, job_id: job.job_id })
        }
      }

      // Audio repair runs inline via GenAIPro history lookup — it's not
      // a background job. Surface the list to the client so it can kick
      // them off one by one (keeps this endpoint fast and idempotent).
      if (requestedModalities.includes('audio') && row.audio.missing > 0) {
        audio_queued.push(row.episode_id)
      }
    }

    res.json({
      enqueued,
      skipped,
      // Client-side: POST each one of these to
      // /projects/:slug/episodes/:code/audio-repair sequentially.
      audio_repair_candidates: audio_queued,
      total_repair_jobs: enqueued.length,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Repair-all failed'))
  }
})

router.post('/projects', validateBody(CreateProjectSchema), async (req, res) => {
  try {
    const project = await pm.createProject(req.body)
    res.status(201).json(project)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Project creation failed'))
  }
})

// ── Portable-folder import (Stage 3) ──────────────────────────────────────
// Peek at a folder's manifest without changing anything — used by the
// Import dialog's "confirm" step so the user sees what they're about to
// register before committing.
router.post('/projects/import/inspect', async (req, res) => {
  const sourcePath = typeof req.body?.source_path === 'string' ? req.body.source_path : ''
  if (!sourcePath) return res.status(400).json({ detail: 'source_path required' })
  const result = await inspectProjectFolder(sourcePath)
  if (!result.ok) return res.status(400).json({ detail: result.detail })
  res.json(result)
})

// Commit the import. Creates userData registration from the manifest, or
// relocates the existing project when the project_id already matches.
router.post('/projects/import', async (req, res) => {
  const sourcePath = typeof req.body?.source_path === 'string' ? req.body.source_path : ''
  if (!sourcePath) return res.status(400).json({ detail: 'source_path required' })
  const adopt = typeof req.body?.adopt_as_slug === 'string' ? req.body.adopt_as_slug : undefined
  try {
    const result = await importProjectFromFolder(sourcePath, { adopt_as_slug: adopt })
    res.status(result.action === 'imported' ? 201 : 200).json(result)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Import failed'))
  }
})

router.get('/projects/:slug', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  res.json(project)
})

router.put('/projects/:slug', validateBody(UpdateProjectSchema), async (req, res) => {
  const project = await pm.updateProject(req.params.slug, req.body)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  res.json(project)
})

router.delete('/projects/:slug', async (req, res) => {
  if (!await pm.deleteProject(req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  res.json({ ok: true })
})

// ── Manifest sync (Stage 5) ───────────────────────────────────────────────
// Detect when another machine has synced in a newer manifest while this
// machine has the project loaded. The status endpoint is the read; the
// sync endpoint is the reconcile.

// ── Secrets provenance (cross-machine folder-copy guard) ──────────────────
// On manual folder copies between machines, `secrets.json` travels intact.
// The store stamps every write with a machine-derived hash and refuses to
// load a file whose stamp doesn't match. This endpoint lets the UI surface
// a banner + offer a one-click reset without blocking the rest of the app.
router.get('/projects/:slug/secrets-status', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  const status = await getSecretsProvenanceStatus(req.params.slug)
  res.json(status)
})

router.post('/projects/:slug/secrets-reset', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    await resetSecretsForCurrentMachine(req.params.slug)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Reset failed'))
  }
})

router.get('/projects/:slug/manifest-status', async (req, res) => {
  const slug = req.params.slug
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return res.status(404).json({ detail: 'Project output not found' })
  const status = await getManifestStatus(outputRoot, projectDir)
  res.json(status)
})

/**
 * Pull the external manifest into this machine's userData: overwrite the
 * preset bag in `config.json` and the user-facing metadata in
 * `project.json` with whatever the synced manifest says. Per-machine
 * state (secrets.json, jobs.json, the `portable` flag, and the stable
 * `project_id` when one already exists locally) is preserved.
 *
 * Refreshes the cache mirror so subsequent `manifest-status` calls don't
 * immediately report out-of-sync again.
 */
router.post('/projects/:slug/sync-from-manifest', async (req, res) => {
  const slug = req.params.slug
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return res.status(404).json({ detail: 'Project output not found' })
  const manifest = await readManifest(outputRoot)
  if (!manifest) return res.status(400).json({ detail: 'No manifest at output root — nothing to sync.' })

  try {
    // Merge the manifest's structural fields into project.json. Preserve
    // local-only fields (output_root, portable flag, created_at). v2 manifests
    // carry no presets / production standards / YouTube templates — those are
    // per-machine setup and never cross-sync.
    const metaPath = path.join(projectDir, 'project.json')
    const localMetaRaw = existsSync(metaPath) ? await fs.readFile(metaPath, 'utf-8') : '{}'
    const localMeta: ProjectMeta = JSON.parse(localMetaRaw)
    const mergedMeta: ProjectMeta = {
      ...localMeta,
      name: manifest.name,
      slug,                                             // never rename on sync
      project_id: localMeta.project_id || manifest.project_id,
      episode_prefix: manifest.episode_prefix,
      episode_digits: manifest.episode_digits,
      season_size: manifest.season_size,
      season_prefix: manifest.season_prefix,
      folder_template: manifest.folder_template,
      subfolder_names: manifest.subfolder_names,
      output_root: localMeta.output_root,               // keep this machine's absolute path
    }
    await writeJsonAtomic(metaPath, mergedMeta)

    // Refresh the cache mirror so future status checks report in_sync.
    await writeManifestCache(projectDir, manifest)

    res.json({
      ok: true,
      pulled_from: { machine_label: manifest.last_edited?.machine_label, at: manifest.last_edited?.at },
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Sync from manifest failed'))
  }
})

import { Router } from 'express'
import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { validateBody } from '../lib/validate.js'
import { CreateProjectSchema, UpdateProjectSchema } from '../schemas/index.js'
import { importProjectFromFolder, inspectProjectFolder } from '../services/import-project.js'
// (Manifest read/poll surface removed with the legacy sync flow. The
// project-manager service still WRITES manifests on every mutation —
// see syncManifest() — for cross-machine project_id identity.)
import { auditProjectAssets } from '../services/asset-status.js'
import { auditAssets } from '../services/manifest-audit.js'
import { getSecretsProvenanceStatus, resetSecretsForCurrentMachine } from '../services/secrets-store.js'
import { listFormats, loadFormat, getEffectiveFormat, _clearFormatCaches } from '../services/format-loader.js'
import { listPatterns, loadPattern, saveUserPattern, deleteUserPattern, isBuiltinPatternId, checkPatternShape } from '../services/pattern-loader.js'
import { buildPatternExtractionPrompt, parseExtractedPatternJson } from '../lib/pattern-extraction-prompt.js'
import { buildFormatExtractionPrompt, parseExtractedFormatJson } from '../lib/format-extraction-prompt.js'
import { callAi } from '../lib/ai-client.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
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

// ── Pattern library endpoints (Phase 4b) ───────────────────────────────────
//
// Patterns are episode-shape templates that compose on top of Format. Picker
// lives on the script page (per-episode selection), not in project settings.

router.get('/patterns', async (_req, res) => {
  try {
    res.json(await listPatterns())
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to list patterns: ${e.message}` })
  }
})

router.get('/patterns/:id', async (req, res) => {
  try {
    const p = await loadPattern(req.params.id)
    if (!p) return res.status(404).json({ detail: `Pattern '${req.params.id}' not found` })
    res.json(p)
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to load pattern: ${e.message}` })
  }
})

// ── Pattern CRUD (user-custom only — built-ins are immutable) ──────────────
//
// Mirrors the format-custom routes (POST /formats/custom etc.). Built-in
// pattern ids are reserved; the route refuses to overwrite them unless
// the caller explicitly opts in via `allow_shadow_builtin: true`. The
// editor UI never sends that flag; only the import-pattern flow would.

router.post('/patterns/custom', async (req, res) => {
  const { pattern, overwrite, allow_shadow_builtin } = req.body || {}
  if (!pattern || typeof pattern !== 'object') {
    return res.status(400).json({ detail: 'pattern object is required' })
  }
  const check = checkPatternShape({ ...pattern, builtin: false, schemaVersion: 1 })
  if (!check.ok) {
    return res.status(400).json({ detail: `Pattern is invalid: ${check.missing.join(', ')}` })
  }
  try {
    const saved = await saveUserPattern(pattern, {
      overwrite: overwrite === true,
      allowShadowBuiltin: allow_shadow_builtin === true,
    })
    res.json({ pattern: saved })
  } catch (e: any) {
    // Conflict (already exists, no overwrite) → 409 so the UI can offer
    // to overwrite or rename. Other errors → 500.
    const msg = e?.message || 'Failed to save pattern'
    const isConflict = /already exists|matches a built-in/.test(msg)
    res.status(isConflict ? 409 : 500).json({ detail: msg })
  }
})

router.put('/patterns/custom/:id', async (req, res) => {
  const id = req.params.id
  const incoming = req.body?.pattern
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ detail: 'pattern object is required' })
  }
  // The id in the URL wins — protects against the editor sending a
  // different id field by accident (renaming via this endpoint isn't
  // supported; user must delete + re-create to change the id).
  const candidate = { ...incoming, id, builtin: false, schemaVersion: 1 }
  const check = checkPatternShape(candidate)
  if (!check.ok) {
    return res.status(400).json({ detail: `Pattern is invalid: ${check.missing.join(', ')}` })
  }
  try {
    // PUT is upsert with overwrite enabled — the typical "edit existing
    // pattern" flow. allow_shadow_builtin stays false so a built-in id
    // collision still fails.
    const saved = await saveUserPattern(candidate, { overwrite: true, allowShadowBuiltin: false })
    res.json({ pattern: saved })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to update pattern' })
  }
})

router.delete('/patterns/custom/:id', async (req, res) => {
  const id = req.params.id
  if (isBuiltinPatternId(id)) {
    // Surface a 400 (rather than 404) so the UI can show "built-ins are
    // protected" instead of "not found".
    return res.status(400).json({ detail: `Pattern "${id}" is built-in and cannot be deleted.` })
  }
  try {
    const r = await deleteUserPattern(id)
    res.json({ ok: true, id, deletedPath: r.deletedPath })
  } catch (e: any) {
    const msg = e?.message || 'Failed to delete pattern'
    res.status(/not found/.test(msg) ? 404 : 500).json({ detail: msg })
  }
})

// Pattern-from-Sample LLM extraction. Project-scoped because we use the
// project's API keys + provide the project's known formats so the LLM
// picks valid ids in `preferredFormats`.
router.post('/projects/:slug/patterns/from-sample', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const { samples, model, desired_name, intent } = req.body || {}
  if (!Array.isArray(samples) || samples.length === 0 || !samples.every((s: any) => typeof s === 'string' && s.trim())) {
    return res.status(400).json({ detail: 'samples must be a non-empty array of non-empty strings' })
  }
  if (typeof model !== 'string' || !model) {
    return res.status(400).json({ detail: 'model is required' })
  }

  const apiKeys = {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }

  // Pull the list of valid format ids so the prompt steers the LLM
  // toward real ids in preferredFormats. Falls back to no-list if the
  // call fails for any reason — the prompt's fallback enumerates a
  // couple of well-known ids.
  let knownFormatIds: string[] = []
  try {
    const all = await listFormats()
    knownFormatIds = all.map(f => f.id).filter(Boolean)
  } catch { /* non-fatal */ }

  const prompt = buildPatternExtractionPrompt({
    samples: samples.map((s: string) => s.trim()),
    desiredName: typeof desired_name === 'string' ? desired_name.trim() || undefined : undefined,
    intent: typeof intent === 'string' ? intent.trim() || undefined : undefined,
    knownFormatIds,
  })

  try {
    const raw = await callAi(model, '', prompt, apiKeys, false, { slug })
    const parsed = parseExtractedPatternJson(raw)
    // Eager validation so the wizard's "Review" step gets a structured
    // error instead of a JSON blob it can't interpret.
    const check = checkPatternShape({ ...(parsed as any), builtin: false, schemaVersion: 1 })
    if (!check.ok) {
      return res.status(422).json({
        detail: `LLM produced an incomplete pattern: ${check.missing.join(', ')}`,
        raw: parsed,
      })
    }
    res.json({ pattern: parsed })
  } catch (e: any) {
    res.status(500).json({ detail: `Pattern extraction failed: ${e.message}` })
  }
})

// ── Format-from-Sample wizard (Phase 4) ────────────────────────────────────
//
// Two-step flow so the user can review the LLM's extraction before it lands
// in the format library:
//
//   1. POST /api/projects/:slug/formats/from-sample
//      → { samples, model, desired_name?, channel_intent? }
//      → returns the extracted Format JSON (not saved). Uses the project's
//        API keys for the LLM call.
//
//   2. POST /api/formats/custom
//      → { format }
//      → validates, writes to ${PROJECTS_ROOT}/.formats/{id}.json,
//        returns the saved record. Refuses to overwrite an existing id
//        unless `overwrite: true` is passed.

router.post('/projects/:slug/formats/from-sample', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const { samples, model, desired_name, channel_intent } = req.body || {}
  if (!Array.isArray(samples) || samples.length === 0 || !samples.every((s: any) => typeof s === 'string' && s.trim())) {
    return res.status(400).json({ detail: 'samples must be a non-empty array of non-empty strings' })
  }
  if (typeof model !== 'string' || !model) {
    return res.status(400).json({ detail: 'model is required' })
  }

  const apiKeys = {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }

  const prompt = buildFormatExtractionPrompt({
    samples: samples.map((s: string) => s.trim()),
    desiredName: typeof desired_name === 'string' ? desired_name.trim() || undefined : undefined,
    channelIntent: typeof channel_intent === 'string' ? channel_intent.trim() || undefined : undefined,
  })

  try {
    const raw = await callAi(model, '', prompt, apiKeys, false, { slug })
    const parsed = parseExtractedFormatJson(raw)
    res.json({ format: parsed })
  } catch (e: any) {
    res.status(500).json({ detail: `Format extraction failed: ${e.message}` })
  }
})

router.post('/formats/custom', async (req, res) => {
  const { format, overwrite } = req.body || {}
  if (!format || typeof format !== 'object') {
    return res.status(400).json({ detail: 'format object is required' })
  }
  const id = String(format.id || '').trim()
  if (!id || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
    return res.status(400).json({ detail: 'format.id must be a kebab-case slug (lowercase, hyphens, alphanumeric)' })
  }
  if (typeof format.name !== 'string' || !format.name.trim()) {
    return res.status(400).json({ detail: 'format.name is required' })
  }

  const existing = await loadFormat(id).catch(() => null)
  if (existing && !overwrite) {
    return res.status(409).json({
      detail: `Format id "${id}" already exists${existing.builtin ? ' as a built-in' : ''}. Pass overwrite:true to replace, or rename.`,
      existingIsBuiltin: existing.builtin,
    })
  }

  const saveable = { ...format, builtin: false, schemaVersion: 1 }

  const userDir = path.join(pm.PROJECTS_ROOT, '.formats')
  const filePath = path.join(userDir, `${id}.json`)
  try {
    await fs.mkdir(userDir, { recursive: true })
    await withLock(filePath, async () => {
      await writeJsonAtomic(filePath, saveable)
    })
    _clearFormatCaches()
    res.json({ format: saveable, savedTo: filePath })
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to save format: ${e.message}` })
  }
})

router.delete('/formats/custom/:id', async (req, res) => {
  const id = req.params.id
  const filePath = path.join(pm.PROJECTS_ROOT, '.formats', `${id}.json`)
  if (!existsSync(filePath)) return res.status(404).json({ detail: `Custom format "${id}" not found` })
  try {
    await fs.rm(filePath, { force: true })
    _clearFormatCaches()
    res.json({ ok: true, id })
  } catch (e: any) {
    res.status(500).json({ detail: `Failed to delete: ${e.message}` })
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

// (Removed: legacy /projects/:slug/manifest-status + /sync-from-manifest
// routes. The manifest-based push/pull sync was paused via a feature
// flag and the underlying polling is gone — cloud sync now happens at
// the OS level via Settings → Storage → Projects storage location.
// The .story-studio-project.json manifest file is still WRITTEN on
// every project mutation as an identity marker, but no longer read
// for sync-state purposes.)

// ── Per-episode asset importer (Part 7 of mark-done plan) ──────────────────
//
// Lets the user point at files on disk that the project doesn't know about
// and have them copied/moved into the canonical asset folders with the
// canonical filenames. Pre-Story-Studio episodes typically have files like
// `1.mp3`, `final.png`, `cover.jpg` — this route handles the mapping +
// renaming so the existing detection logic picks them up.
//
// Body shape mirrors asset-importer.ts ImportItem discriminated union:
//   {
//     mode: 'copy' | 'move',
//     items: [
//       { type: 'audio',  source_path, section_slug },
//       { type: 'scene',  source_path, scene_number },
//       { type: 'thumb',  source_path, thumb_number },
//       { type: 'video',  source_path, scene_number },
//       { type: 'final',  source_path },
//       { type: 'merged', source_path },
//       { type: 'other',  source_path, dest_subpath },
//     ]
//   }

const VALID_ITEM_TYPES = new Set(['audio', 'scene', 'thumb', 'video', 'final', 'merged', 'other'])

function validateImportItems(raw: any): { ok: true; items: any[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'items must be an array' }
  const out: any[] = []
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i]
    if (!it || typeof it !== 'object') return { ok: false, error: `items[${i}] must be an object` }
    const t = it.type
    if (typeof t !== 'string' || !VALID_ITEM_TYPES.has(t)) {
      return { ok: false, error: `items[${i}].type invalid: ${t}` }
    }
    if (typeof it.source_path !== 'string' || !it.source_path) {
      return { ok: false, error: `items[${i}].source_path required (string)` }
    }
    // Per-type field validation. Throws an ergonomic 400 instead of
    // letting the importer crash on missing fields downstream.
    switch (t) {
      case 'audio':
        if (typeof it.section_slug !== 'string' || !it.section_slug) {
          return { ok: false, error: `items[${i}].section_slug required for audio` }
        }
        break
      case 'scene':
      case 'video':
        if (typeof it.scene_number !== 'number' || !Number.isInteger(it.scene_number) || it.scene_number < 1) {
          return { ok: false, error: `items[${i}].scene_number must be a positive integer` }
        }
        break
      case 'thumb':
        if (typeof it.thumb_number !== 'number' || !Number.isInteger(it.thumb_number) || it.thumb_number < 1) {
          return { ok: false, error: `items[${i}].thumb_number must be a positive integer` }
        }
        break
      case 'other':
        if (typeof it.dest_subpath !== 'string' || !it.dest_subpath) {
          return { ok: false, error: `items[${i}].dest_subpath required for "other" type` }
        }
        break
    }
    out.push(it)
  }
  return { ok: true, items: out }
}

router.post('/projects/:slug/episodes/:code/import-assets', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const mode = req.body?.mode === 'move' ? 'move' : 'copy'
    const validated = validateImportItems(req.body?.items)
    if (!validated.ok) return res.status(400).json({ detail: validated.error })

    const { importAssets } = await import('../services/asset-importer.js')
    const result = await importAssets(slug, code, validated.items as any, { mode })
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Asset import failed'))
  }
})

// ── Storage audit + cleanup (per-project) ──────────────────────────────────
//
// Surfaces per-episode local size + cleanup actions. Wired to the
// Storage sub-tab in Project Settings. The 5-10 GB-per-episode pain
// point: sleep stories produce huge final videos, and once they're on
// YouTube the local copy is operationally redundant. These endpoints
// let the user free space safely (sidecar guard) + optionally relocate
// finals to a non-cloud-synced external root (Phase C).

router.get('/projects/:slug/storage-audit', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const { auditProjectStorage } = await import('../services/storage-audit.js')
    const result = await auditProjectStorage(req.params.slug)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Storage audit failed'))
  }
})

router.post('/projects/:slug/storage/cleanup-final/:code', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const force = req.body?.force === true
    const { cleanupFinalVideoForEpisode } = await import('../services/storage-audit.js')
    const result = await cleanupFinalVideoForEpisode(req.params.slug, req.params.code, { force })
    res.json(result)
  } catch (e: any) {
    // 412 = "not uploaded, force not set" — UI shows a distinct
    // confirmation prompt rather than a generic error toast.
    const status = e?.statusCode === 412 ? 412 : 500
    res.status(status).json(humanizeBackendError(e, 'Cleanup failed'))
  }
})

router.post('/projects/:slug/storage/bulk-cleanup-final', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const force = req.body?.force === true
    const allUploaded = req.body?.all_uploaded === true
    const codes = Array.isArray(req.body?.episode_codes) ? req.body.episode_codes : undefined
    if (!allUploaded && (!codes || !codes.length)) {
      return res.status(400).json({ detail: 'Pass episode_codes (array) or all_uploaded=true' })
    }
    const { bulkCleanupFinalVideos } = await import('../services/storage-audit.js')
    const result = await bulkCleanupFinalVideos(req.params.slug, {
      episode_codes: codes,
      all_uploaded: allUploaded,
      force,
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Bulk cleanup failed'))
  }
})

// External final-video root — get/set the per-machine app setting.
// Lives at /api/app-settings/external-final-video-root rather than
// nested under a project because it's machine-global, not project-
// scoped. The migration endpoint below IS project-scoped because the
// move only affects the current project's tree.

router.get('/app-settings/external-final-video-root', async (_req, res) => {
  try {
    const { getExternalFinalVideoRoot, externalRootIsReachable } = await import('../services/external-video-store.js')
    const value = await getExternalFinalVideoRoot()
    const reach = await externalRootIsReachable()
    res.json({ value, reachable: reach.ok, reason: reach.reason || '' })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read external final-video root'))
  }
})

router.put('/app-settings/external-final-video-root', async (req, res) => {
  try {
    const value = typeof req.body?.value === 'string' ? req.body.value : ''
    const { setExternalFinalVideoRoot, externalRootIsReachable } = await import('../services/external-video-store.js')
    await setExternalFinalVideoRoot(value)
    const reach = await externalRootIsReachable()
    res.json({ ok: true, value, reachable: reach.ok, reason: reach.reason || '' })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to set external final-video root'))
  }
})

// Migration: move existing final videos in this project to the
// configured external root. No-op when the root isn't set (returns
// 400 so the UI can prompt the user to set it first).
router.post('/projects/:slug/storage/migrate-finals-to-external', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const { migrateFinalsToExternal } = await import('../services/storage-audit.js')
    const result = await migrateFinalsToExternal(req.params.slug)
    res.json(result)
  } catch (e: any) {
    const status = /not configured/i.test(e?.message || '') ? 400 : 500
    res.status(status).json(humanizeBackendError(e, 'Migration failed'))
  }
})

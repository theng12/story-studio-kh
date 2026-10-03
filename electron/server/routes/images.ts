import { Router } from 'express'
import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import type { Job, JobType } from '../models/types.js'
import { validateBody } from '../lib/validate.js'
import { GenerateImagesSchema } from '../schemas/index.js'
import { getImageStatus } from '../services/asset-status.js'
import { getImagesReconcileStatus, reconcileImages } from '../services/image-reconciler.js'
import { settleCompletedFailures } from '../services/stale-failures.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { readSelectedThumbnail, writeSelectedThumbnail } from '../services/upload-overrides.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── Status endpoint (for the per-episode integrity pill) ─────────────────
router.get('/projects/:slug/episodes/:code/image-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const s = await getImageStatus(req.params.slug, req.params.code, 'thumbnails')
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute image status'))
  }
})

// ── Thumbnail image ingest (for the Bulk Asset browser extension) ──
// Save a browser-generated image for the PROMPTS source with the same name +
// directory the native Image generator produces, so status/assembly pick it up:
//   kind 'scene'     → {CODE}_Scene{NN}_v1.png in "05 Scene Images"
//   kind 'thumbnail' → {CODE}_Thumb{NN}_v1.png in "06 Thumbnail Images"
// Mirrors scene-review's upload-image (which is for the scene_plan source).
// Body: { kind?: 'scene'|'thumbnail', number (1-based), data_base64, title? }.
// (`scene_number` accepted as an alias for `number`, back-compat.)
router.post('/projects/:slug/episodes/:code/image-ingest', async (req, res) => {
  const { slug } = req.params
  const code = req.params.code.toUpperCase()
  try {
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    if (req.body?.kind && req.body.kind !== 'thumbnail') {
      return res.status(410).json({ detail: 'Legacy scene ingest is retired. Upload planned scenes through Scene Review.' })
    }
    const kind = 'thumbnail' as const
    const n = Number(req.body?.number ?? req.body?.scene_number)
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ detail: 'number (>= 1) is required.' })

    const { decodeUploadBuffer } = await import('./image-references.js')
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })

    const title = typeof req.body?.title === 'string' ? req.body.title : ''
    const idea = (await im.getIdeas(slug, 'accepted')).find(i => i.episode_code === code)
    const paths = await resolveEpisodePaths(slug, code, title || idea?.title || '')
    const promptsPath = paths.thumb_prompts_docx
    const { resolveImageDirs } = await import('../generators/images.js')
    const dirs = await resolveImageDirs(slug, promptsPath || paths.scene_prompts_docx || '', code)
    const outDir = dirs.thumbDir

    await fsp.mkdir(outDir, { recursive: true })
    const stem = 'Thumb'
    const filename = `${code}_${stem}${String(n).padStart(2, '0')}_v1.png`
    await fsp.writeFile(path.join(outDir, filename), buf.data)

    try {
      const { episodeStatusCache } = await import('../services/episode-status-cache.js')
      episodeStatusCache.invalidate(slug, code)
    } catch {
      /* cache is best-effort */
    }
    res.json({ ok: true, saved_as: filename, image_dir: outDir })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Image ingest failed'))
  }
})

router.post('/projects/:slug/generate/images', validateBody(GenerateImagesSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config not found' })
  // API key validation happens at generation time (provider-specific)

  const mode: string = req.body.mode || 'thumbs'
  const { generation_action: _ignoredAction, operation_id: _ignoredOperation, ...imageParams } = req.body
  const submittedOperationId = typeof req.body.operation_id === 'string' ? req.body.operation_id.trim() : ''
  if (req.body.force === true && !OPERATION_ID.test(submittedOperationId)) {
    return res.status(400).json({ detail: 'operation_id must be a UUID for an explicit image re-render.' })
  }
  const operationId = req.body.force === true ? submittedOperationId : ''

  // Use distinct job types for scene vs thumbnail images
  let jobType: JobType
  let title: string

  if (mode === 'thumbs') {
    jobType = 'thumb_images'
    title = 'Thumbnail Images'
  } else {
    return res.status(410).json({ detail: 'Legacy Scene Images generation is retired. Render planned scenes in Scene Review.' })
  }

  // Dedupe per (episode, jobType, scene_number, thumb_number).
  // The previous coarse "(episode, jobType)" check rejected a second
  // per-row click for the same episode even when it targeted a different
  // scene — which made the v1.0.87 per-row Generate panel feel broken
  // (click scene 3 → queues; click scene 5 → 409). The narrowed predicate
  // lets the user queue multiple different scenes back-to-back while
  // still 409'ing a literal duplicate (two clicks on scene 3 in flight).
  // Bulk runs (no scene/thumb number) dedupe against other bulk runs and
  // run independently of per-row clicks — the executor's per-prompt skip
  // logic prevents any actual collision on disk.
  const requestedScene = req.body.scene_number
  const requestedThumb = req.body.thumb_number
  const sameTarget = (params: any) =>
    params?.scene_number === requestedScene && params?.thumb_number === requestedThumb
  const sameActionRequest = (candidate: any) => {
    const { generation_action, ...savedParams } = candidate.params || {}
    return candidate.type === jobType
      && candidate.episode_id === req.body.episode_id
      && generation_action?.id === operationId
      && JSON.stringify(savedParams) === JSON.stringify(imageParams)
  }
  if (operationId) {
    const existingAction = (await jq.getJobs(slug)).find(candidate =>
      candidate.type === jobType
      && candidate.episode_id === req.body.episode_id
      && candidate.params?.generation_action?.id === operationId,
    )
    if (existingAction) {
      if (!sameActionRequest(existingAction)) {
        return res.status(409).json({ detail: 'operation_id already belongs to a different image request.' })
      }
      return res.status(201).json({ ...existingAction, reused: true })
    }
  }

  let job: Awaited<ReturnType<typeof jq.enqueue>>
  try {
    job = await jq.enqueue({
      project_slug: slug,
      type: jobType,
      episode_id: req.body.episode_id,
      title,
      params: {
        ...imageParams,
        ...(operationId ? { generation_action: { id: operationId, kind: 'fresh' } } : {}),
      },
      dedupeParams: sameTarget,
    })
  } catch (error) {
    if (error instanceof jq.DuplicateJobError) {
      if (operationId) {
        const replay = (await jq.getJobs(slug)).find(sameActionRequest)
        if (replay) return res.status(201).json({ ...replay, reused: true })
      }
      const detail = requestedScene
        ? `Scene ${requestedScene} render already queued/running for ${req.body.episode_id}`
        : requestedThumb
          ? `Thumbnail ${requestedThumb} render already queued/running for ${req.body.episode_id}`
          : `${title} generation already queued/running for ${req.body.episode_id}`
      return res.status(409).json({ detail })
    }
    throw error
  }
  res.status(201).json(job)
})

// Quick read-only check for the Repair button — tells the UI how many
// missing images can be recovered (have a manifest entry) vs need a
// fresh generation. Cheap; safe to call on every page load.
router.get('/projects/:slug/episodes/:code/images-repair-status', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const s = await getImagesReconcileStatus(req.params.slug, req.params.code)
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute repair status'))
  }
})

// Repair endpoint — runs the reconciler instead of the generator. Free
// to call: the reconciler only downloads from already-paid-for provider
// task results. Files without a stored task id come back as
// "needs_fresh_generation" so the user knows to click Generate for those.
const inlineImageRepairs = new Map<string, Promise<{ result: Awaited<ReturnType<typeof reconcileImages>>; lines: string[] }>>()

router.post('/projects/:slug/generate/images-repair', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const episodeId: string | undefined = req.body?.episode_id
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required' })
  // v1.0.306 — scope to one pool (the Thumbnail vs Scene generator pages each
  // repair only their own). Omitted / invalid → 'all' (back-compat).
  const rawPool = req.body?.pool
  const pool: 'scenes' | 'thumbnails' | 'all' =
    rawPool === 'scenes' || rawPool === 'thumbnails' ? rawPool : 'all'

  if (jq.isDuplicate(slug, episodeId, 'images_repair' as JobType)) {
    return res.status(409).json({ detail: `Image repair already queued/running for ${episodeId}` })
  }

  // Dreamlands 2026-10-03 — Repair on a failed job's own row used to queue a
  // second job that failed for the same missing files, so one problem showed
  // up as two "needs attention" rows. Repairing a known job now runs inline:
  // the result is written into that job's own log, and the job settles itself
  // if every file is now on disk. No new row, nothing to wait for.
  const sourceJobId: unknown = req.body?.source_job_id
  if (typeof sourceJobId === 'string' && sourceJobId) {
    const source = (await jq.getJobs(slug)).find(job => job.job_id === sourceJobId)
    if (!source || source.episode_id !== episodeId || !['error', 'cancelled'].includes(source.status)) {
      return res.status(404).json({ detail: 'That failed job is no longer in the list.' })
    }
    try {
      const { assertMediaRootReady } = await import('../services/media-root.js')
      await assertMediaRootReady(slug)
      const key = `${slug}:${episodeId}:${pool}`
      let run = inlineImageRepairs.get(key)
      if (!run) {
        const scratch = { output_lines: [] as string[] } as Job
        run = reconcileImages(slug, episodeId, scratch, pool).then(result => ({ result, lines: scratch.output_lines }))
          .finally(() => inlineImageRepairs.delete(key))
        inlineImageRepairs.set(key, run)
      }
      const { result, lines } = await run
      if (result.total_expected === 0) {
        return res.status(409).json({ detail: 'No expected images were found to repair. Make the image prompts first, then use Generate missing.' })
      }
      await jq.noteOnFinishedJob(slug, sourceJobId, ['Repair (no charge):', ...lines])
      const resolved = await settleCompletedFailures(slug, episodeId)
      return res.json({ ...result, still_missing: result.needs_fresh_generation + result.unrecoverable, resolved })
    } catch (e: any) {
      return res.status(500).json(humanizeBackendError(e, 'Repair failed'))
    }
  }

  const poolTitle = pool === 'scenes' ? 'Scene Image Repair' : pool === 'thumbnails' ? 'Thumbnail Repair' : 'Image Repair'
  const job = await jq.enqueue({
    project_slug: slug,
    type: 'images_repair' as JobType,
    episode_id: episodeId,
    title: `${poolTitle} (no credits)`,
    params: { episode_id: episodeId, pool },
  })
  res.status(201).json(job)
})

// ── Thumbnail picker (v1.0.41) ─────────────────────────────────────────────
//
// Lists every PNG/JPG in the episode's thumbnails dir + which one is
// pinned via the per-platform `selected_thumbnail` override. The Images
// page picker uses the response to render its grid; the Upload Center
// pre-upload preview modal uses the same data to show "this is the
// thumbnail that will be pushed to YouTube".
//
// Auto-pick rule (highest `_v{N}` then lex-desc) lives in the
// upload-metadata resolver — we mirror it here so the UI can show what
// would auto-resolve when nothing is pinned, without a redundant trip
// through the resolver.

router.get('/projects/:slug/episodes/:code/thumbnails', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    const platform = (req.query.platform === 'tiktok' || req.query.platform === 'facebook') ? req.query.platform : 'youtube'
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const idea = (await im.getIdeas(slug, 'accepted')).find(i => i.episode_code === code)
    const fallbackTitle = idea?.title || ''
    const paths = await resolveEpisodePaths(slug, code, fallbackTitle)

    const files: Array<{ filename: string; size_bytes: number; is_pinned: boolean }> = []
    if (existsSync(paths.thumb_dir)) {
      const entries = await fsp.readdir(paths.thumb_dir)
      const imageFiles = entries.filter(f => /\.(png|jpe?g)$/i.test(f))
      for (const f of imageFiles) {
        let size_bytes = 0
        try { size_bytes = (await fsp.stat(path.join(paths.thumb_dir, f))).size } catch { /* unreadable */ }
        files.push({ filename: f, size_bytes, is_pinned: false })
      }
      // Sort matches the Images-page render order (auto-pick = first
      // entry after sort), so the picker grid + auto-resolve preview
      // line up visually.
      files.sort((a, b) => versionOf(b.filename) - versionOf(a.filename) || b.filename.localeCompare(a.filename))
    }

    const pinned = await readSelectedThumbnail(slug, code, fallbackTitle, platform as any)
    if (pinned) {
      const idx = files.findIndex(f => f.filename === pinned)
      if (idx >= 0) files[idx]!.is_pinned = true
    }

    // What the resolver WILL pick (pinned wins if it still exists,
    // otherwise the first file post-sort = auto-pick).
    let resolved = ''
    if (pinned && files.some(f => f.filename === pinned)) {
      resolved = pinned
    } else if (files.length > 0) {
      resolved = files[0]!.filename
    }

    res.json({
      files,
      pinned: pinned && files.some(f => f.filename === pinned) ? pinned : null,
      pinned_missing: !!(pinned && !files.some(f => f.filename === pinned)),
      resolved,
      auto_pick: files[0]?.filename || '',
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list thumbnails'))
  }
})

router.post('/projects/:slug/episodes/:code/thumbnails/pin', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    const platform = (req.body?.platform === 'tiktok' || req.body?.platform === 'facebook') ? req.body.platform : 'youtube'
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const filename = (req.body?.filename === null || req.body?.filename === '')
      ? null
      : (typeof req.body?.filename === 'string' ? req.body.filename.trim() : '')
    if (filename !== null && !filename) {
      return res.status(400).json({ detail: 'filename must be a string or null' })
    }

    const idea = (await im.getIdeas(slug, 'accepted')).find(i => i.episode_code === code)
    if (!idea) return res.status(404).json({ detail: `Episode ${code} not found` })

    // Validate the filename actually exists in the thumb dir before
    // pinning — saves the user from saving a typo'd filename that
    // would silently fall back to auto-pick at upload time.
    if (filename) {
      const paths = await resolveEpisodePaths(slug, code, idea.title || '')
      const candidate = path.join(paths.thumb_dir, filename)
      if (!existsSync(candidate)) {
        return res.status(404).json({ detail: `Thumbnail file "${filename}" not found in ${paths.thumb_dir}` })
      }
    }

    await writeSelectedThumbnail(slug, code, idea.title || '', platform as any, filename)
    res.json({ ok: true, pinned: filename })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to pin thumbnail'))
  }
})

/**
 * Mirrors the resolver in lib/upload-metadata.ts. Pulls the `_v{N}`
 * version off a thumbnail filename so the picker can sort by version
 * the same way uploads will. Returns 0 when no `_v{N}` suffix is found.
 */
function versionOf(filename: string): number {
  const m = /_v(\d+)/.exec(filename)
  return m ? parseInt(m[1]!, 10) : 0
}

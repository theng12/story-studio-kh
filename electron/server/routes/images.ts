import { Router } from 'express'
import fsp from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import type { JobType } from '../models/types.js'
import { validateBody } from '../lib/validate.js'
import { GenerateImagesSchema } from '../schemas/index.js'
import { getImageStatus } from '../services/asset-status.js'
import { getImagesReconcileStatus } from '../services/image-reconciler.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { readSelectedThumbnail, writeSelectedThumbnail } from '../services/upload-overrides.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

// ── Status endpoint (for the per-episode integrity pill) ─────────────────
router.get('/projects/:slug/episodes/:code/image-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const s = await getImageStatus(req.params.slug, req.params.code)
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute image status'))
  }
})

router.post('/projects/:slug/generate/images', validateBody(GenerateImagesSchema), async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config not found' })
  // API key validation happens at generation time (provider-specific)

  const mode: string = req.body.mode || 'all'

  // Use distinct job types for scene vs thumbnail images
  let jobType: JobType
  let title: string

  if (mode === 'scenes') {
    jobType = 'scene_images'
    title = 'Scene Images'
  } else if (mode === 'thumbs') {
    jobType = 'thumb_images'
    title = 'Thumbnail Images'
  } else {
    // mode === 'all' — use legacy 'images' type for backward compatibility
    jobType = 'images'
    title = 'Images (all)'
  }

  if (jq.isDuplicate(slug, req.body.episode_id, jobType)) {
    return res.status(409).json({ detail: `${title} generation already queued/running for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: jobType,
    episode_id: req.body.episode_id,
    title,
    params: req.body,
  })
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
router.post('/projects/:slug/generate/images-repair', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const episodeId: string | undefined = req.body?.episode_id
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required' })

  if (jq.isDuplicate(slug, episodeId, 'images_repair' as JobType)) {
    return res.status(409).json({ detail: `Image repair already queued/running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'images_repair' as JobType,
    episode_id: episodeId,
    title: 'Image Repair (no credits)',
    params: { episode_id: episodeId },
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

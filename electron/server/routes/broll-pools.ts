/**
 * B-Roll Pool routes — REST surface for the Library page.
 *
 *   GET    /api/broll-pools                        — list registered pools
 *   POST   /api/broll-pools                        — register a new pool
 *   PUT    /api/broll-pools/:id                    — update settings
 *   DELETE /api/broll-pools/:id                    — unregister (files kept)
 *   POST   /api/broll-pools/:id/scan               — re-scan folder
 *   GET    /api/broll-pools/:id/clips              — list clips
 *   PUT    /api/broll-pools/:id/clips/:filename/tags — set tags
 *   POST   /api/broll-pools/:id/clips/:filename/rename — rename single clip
 *   POST   /api/broll-pools/:id/clips/rename-bulk   — bulk rename via template
 *   GET    /api/broll-pools/:id/clips/:filename/thumbnail — serve thumb JPG
 *   POST   /api/broll-pools/:id/normalize-all      — queue normalize for unnormalized clips
 *   POST   /api/broll-pools/:id/clips/:filename/normalize — queue normalize for one clip
 *
 * No project-slug prefix because the pool is app-level. Per-project
 * subscription/usage lives elsewhere (Phase 2).
 */
import { Router } from 'express'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as bp from '../services/broll-pool-manager.js'
import * as jq from '../services/job-queue.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import type { JobType } from '../models/types.js'

export const router = Router()

// ── Pool CRUD ──────────────────────────────────────────────────────────

router.get('/broll-pools', async (_req, res) => {
  try {
    const pools = await bp.listPools()
    // Online state isn't stored — derive on read so a freshly-plugged-in
    // SSD reflects immediately without a forced refresh.
    const enriched = await Promise.all(pools.map(async (p) => ({
      ...p,
      online: await bp.isPoolOnline(p.id),
    })))
    res.json(enriched)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list pools'))
  }
})

router.post('/broll-pools', async (req, res) => {
  try {
    const { name, folder_path, auto_normalize, fps_target, media, slideshow } = req.body || {}
    const pool = await bp.createPool({
      name: String(name || '').trim(),
      folder_path: String(folder_path || '').trim(),
      // v1.0.92+ — default OFF. See broll-pool-manager.createPool for
      // rationale (auto-normalize on a fresh 200-clip pool is 1-3hrs
      // of CPU/disk and shouldn't fire without explicit consent).
      auto_normalize: auto_normalize === true,
      fps_target: fps_target === 30 ? 30 : 24,
      // 'image' = Image Pool (slideshow), 'audio' = SFX library; default 'video'.
      media: media === 'image' ? 'image' : media === 'audio' ? 'audio' : 'video',
      slideshow: (slideshow && typeof slideshow === 'object') ? slideshow : undefined,
    })
    res.status(201).json(pool)
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to create pool' })
  }
})

router.put('/broll-pools/:id', async (req, res) => {
  try {
    const { name, auto_normalize, fps_target, slideshow, folder_path } = req.body || {}
    const patch: any = {}
    if (typeof name === 'string' && name.trim()) patch.name = name.trim()
    if (typeof auto_normalize === 'boolean') patch.auto_normalize = auto_normalize
    if (fps_target === 24 || fps_target === 30) patch.fps_target = fps_target
    // v1.0.405 — repoint the pool to a different folder (validated in updatePool).
    if (typeof folder_path === 'string' && folder_path.trim()) patch.folder_path = folder_path.trim()
    // v1.0.403 — per-pool slideshow defaults (Image Pool format). Merged
    // field-by-field in updatePool so a partial patch keeps the rest.
    if (slideshow && typeof slideshow === 'object') patch.slideshow = slideshow
    const pool = await bp.updatePool(req.params.id, patch)
    res.json(pool)
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to update pool' })
  }
})

router.delete('/broll-pools/:id', async (req, res) => {
  try {
    await bp.deletePool(req.params.id)
    res.json({ ok: true, id: req.params.id })
  } catch (e: any) {
    res.status(404).json({ detail: e?.message || 'Pool not found' })
  }
})

// ── Scan / list / tag ──────────────────────────────────────────────────

router.post('/broll-pools/:id/scan', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: `Pool '${req.params.id}' not found` })
    if (!existsSync(pool.folder_path)) {
      return res.status(409).json({ detail: `Pool folder offline — plug in the SSD at ${pool.folder_path} and retry.` })
    }
    const media = bp.poolMedia(pool)
    const result = await scanPoolFolder(pool.folder_path, undefined, media)

    // Auto-normalize: queue a job per newly-discovered or freshly-changed
    // clip that hasn't been normalized yet. User toggles this off on the
    // pool if they want manual control over re-encodes. Image pools never
    // normalize (stills need no re-encode).
    if (pool.auto_normalize && media === 'video') {
      const clips = await bp.listClips(pool.id, { includeMissing: false })
      const unnormalized = clips.filter(c => !c.normalized).map(c => c.filename)
      // Only queue clips that scan TOUCHED this round — don't blast every
      // un-normalized clip on every scan (that'd queue 200 jobs on first
      // open). Phase 5 will add a separate "Normalize all" button for the
      // explicit bulk case.
      const touched = new Set([
        ...result.added,
        ...result.updated.map(s => s.includes(' → ') ? s.split(' → ')[1]! : s),
      ])
      const toQueue = unnormalized.filter(fn => touched.has(fn))
      for (const fn of toQueue) {
        if (jq.isDuplicate('_app_', pool.id, 'broll_normalize' as JobType, (p: any) => p?.filename === fn)) continue
        await jq.enqueue({
          project_slug: '_app_', // app-level job, no project association
          type: 'broll_normalize' as JobType,
          episode_id: pool.id,    // reuse the episode slot to thread pool id
          title: `Normalize B-Roll · ${fn}`,
          params: { pool_id: pool.id, filename: fn },
          dedupeParams: (p: any) => p?.filename === fn,
        })
      }
    }

    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Scan failed'))
  }
})

router.get('/broll-pools/:id/clips', async (req, res) => {
  try {
    const clips = await bp.listClips(req.params.id, { includeMissing: req.query.include_missing !== 'false' })
    res.json({ clips, online: await bp.isPoolOnline(req.params.id) })
  } catch (e: any) {
    res.status(404).json({ detail: e?.message || 'Pool not found' })
  }
})

router.put('/broll-pools/:id/clips/:filename/tags', async (req, res) => {
  try {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : []
    const clip = await bp.setClipTags(req.params.id, req.params.filename, tags)
    res.json(clip)
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to set tags' })
  }
})

// v1.0.92+ — single-clip rename. POST instead of PUT/PATCH because the
// resource path itself changes; clients re-fetch by the returned filename.
// Failure modes (invalid name, collision, offline pool) all surface as
// 400 with a human-readable detail so the Library UI can toast it.
router.post('/broll-pools/:id/clips/:filename/rename', async (req, res) => {
  try {
    const next = String(req.body?.new_filename || '').trim()
    if (!next) return res.status(400).json({ detail: 'new_filename is required' })
    const clip = await bp.renameClip(req.params.id, req.params.filename, next)
    res.json(clip)
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to rename clip' })
  }
})

// v1.0.92+ — bulk template rename. Accepts a list of filenames + a template
// string with {n} / {n:NN} / {ext} / {orig} / {sha} tokens. Returns a
// per-row status array so the UI can render successes vs collisions/
// validation errors without re-fetching the whole pool.
router.post('/broll-pools/:id/clips/rename-bulk', async (req, res) => {
  try {
    const template = String(req.body?.template || '').trim()
    const filenames = Array.isArray(req.body?.filenames) ? req.body.filenames.map((s: any) => String(s)) : []
    const startIndex = Number.isFinite(req.body?.start_index) ? Number(req.body.start_index) : 1
    if (!template) return res.status(400).json({ detail: 'template is required' })
    if (!filenames.length) return res.status(400).json({ detail: 'filenames must be a non-empty array' })
    const rows = await bp.renameClipsBulk(req.params.id, template, filenames, { startIndex })
    res.json({ rows })
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to bulk-rename' })
  }
})

router.get('/broll-pools/:id/clips/:filename/thumbnail', async (req, res) => {
  try {
    const clips = await bp.listClips(req.params.id, { includeMissing: true })
    const clip = clips.find(c => c.filename === req.params.filename)
    if (!clip) return res.status(404).json({ detail: 'Clip not in pool' })

    const abs = bp.thumbnailPath(clip.sha256)
    if (!existsSync(abs)) return res.status(404).json({ detail: 'Thumbnail not cached yet — re-scan to generate.' })

    const fsMod = await import('fs')
    const stat = await fs.stat(abs)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Content-Length', String(stat.size))
    const stream = fsMod.createReadStream(abs)
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ detail: 'Read failed' }) })
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve thumbnail'))
  }
})

// Serve an audio clip's bytes for in-browser preview (SFX / audio pools).
// Audio pools have no thumbnail, so the Library plays the file directly via
// an <audio> element pointed here. basename() guards against path traversal.
const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
}
router.get('/broll-pools/:id/clips/:filename/audio', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: `Pool '${req.params.id}' not found` })
    const safe = path.basename(req.params.filename)
    const abs = path.join(pool.folder_path, safe)
    if (!existsSync(abs)) return res.status(404).json({ detail: 'Clip not found on disk (SSD unplugged?)' })
    const stat = await fs.stat(abs)
    const fsMod = await import('fs')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Type', AUDIO_MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Content-Length', String(stat.size))
    res.setHeader('Accept-Ranges', 'none')
    const stream = fsMod.createReadStream(abs)
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ detail: 'Read failed' }) })
    stream.pipe(res)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve audio'))
  }
})

// v1.0.x — stream a pool clip's VIDEO bytes with HTTP Range support, so the
// Scripted B-Roll preview player can seek each beat's clip in a <video>.
const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
}
router.get('/broll-pools/:id/clips/:filename/video', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: `Pool '${req.params.id}' not found` })
    const safe = path.basename(req.params.filename)
    const abs = path.join(pool.folder_path, safe)
    if (!existsSync(abs)) return res.status(404).json({ detail: 'Clip not found on disk (SSD unplugged?)' })
    const stat = await fs.stat(abs)
    const fsMod = await import('fs')
    const mime = VIDEO_MIME[path.extname(safe).toLowerCase()] || 'video/mp4'
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Accept-Ranges', 'bytes')
    const range = req.headers.range
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
    if (m) {
      const start = parseInt(m[1]!, 10)
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
      if (start >= stat.size || end >= stat.size || start > end) {
        res.setHeader('Content-Range', `bytes */${stat.size}`)
        return res.status(416).end()
      }
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      const stream = fsMod.createReadStream(abs, { start, end })
      stream.on('error', () => { if (!res.headersSent) res.status(500).end() })
      stream.pipe(res)
    } else {
      res.setHeader('Content-Length', String(stat.size))
      const stream = fsMod.createReadStream(abs)
      stream.on('error', () => { if (!res.headersSent) res.status(500).end() })
      stream.pipe(res)
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve video'))
  }
})

// ── Normalize ──────────────────────────────────────────────────────────

router.post('/broll-pools/:id/clips/:filename/normalize', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    if (bp.poolMedia(pool) !== 'video') {
      return res.status(400).json({ detail: `Pool '${req.params.id}' is not a video pool.` })
    }
    const job = await jq.enqueue({
      project_slug: '_app_',
      type: 'broll_normalize' as JobType,
      episode_id: pool.id,
      title: `Normalize B-Roll · ${req.params.filename}`,
      params: { pool_id: pool.id, filename: req.params.filename },
      dedupeParams: (p: any) => p?.filename === req.params.filename,
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue normalize'))
  }
})

// ── Auto-tag (vision-LLM) ─────────────────────────────────────────────

router.post('/broll-pools/:id/clips/:filename/autotag', (_req, res) => {
  res.status(501).json({
    code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE',
    detail: 'Visual auto-tagging is unavailable until GenStudio KH publishes a qualified image-input LLM route.',
  })
})

// Bulk auto-tag: queue jobs for every clip whose `tags` array is empty
// (or every clip if force=true). Skips clips that already have at least
// one tag so re-running the bulk button doesn't burn vision credits on
// already-curated clips. Caller can force with body.force=true.
router.post('/broll-pools/:id/autotag-untagged', (_req, res) => {
  res.status(501).json({
    code: 'GENSTUDIO_CAPABILITY_UNAVAILABLE',
    detail: 'Visual auto-tagging is unavailable until GenStudio KH publishes a qualified image-input LLM route.',
  })
})

router.post('/broll-pools/:id/normalize-all', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    if (bp.poolMedia(pool) !== 'video') {
      return res.status(400).json({ detail: `Pool '${req.params.id}' is not a video pool.` })
    }
    const clips = await bp.listClips(pool.id, { includeMissing: false })
    const unnormalized = clips.filter(c => !c.normalized)
    let queued = 0
    for (const c of unnormalized) {
      if (jq.isDuplicate('_app_', pool.id, 'broll_normalize' as JobType, (p: any) => p?.filename === c.filename)) continue
      await jq.enqueue({
        project_slug: '_app_',
        type: 'broll_normalize' as JobType,
        episode_id: pool.id,
        title: `Normalize B-Roll · ${c.filename}`,
        params: { pool_id: pool.id, filename: c.filename },
        dedupeParams: (p: any) => p?.filename === c.filename,
      })
      queued += 1
    }
    res.status(201).json({ queued, remaining: unnormalized.length - queued })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue bulk normalize'))
  }
})

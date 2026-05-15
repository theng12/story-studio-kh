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
    const { name, folder_path, auto_normalize, fps_target } = req.body || {}
    const pool = await bp.createPool({
      name: String(name || '').trim(),
      folder_path: String(folder_path || '').trim(),
      auto_normalize: auto_normalize !== false,
      fps_target: fps_target === 30 ? 30 : 24,
    })
    res.status(201).json(pool)
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to create pool' })
  }
})

router.put('/broll-pools/:id', async (req, res) => {
  try {
    const { name, auto_normalize, fps_target } = req.body || {}
    const patch: any = {}
    if (typeof name === 'string' && name.trim()) patch.name = name.trim()
    if (typeof auto_normalize === 'boolean') patch.auto_normalize = auto_normalize
    if (fps_target === 24 || fps_target === 30) patch.fps_target = fps_target
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
    const result = await scanPoolFolder(pool.folder_path)

    // Auto-normalize: queue a job per newly-discovered or freshly-changed
    // clip that hasn't been normalized yet. User toggles this off on the
    // pool if they want manual control over re-encodes.
    if (pool.auto_normalize) {
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
        jq.enqueue({
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

// ── Normalize ──────────────────────────────────────────────────────────

router.post('/broll-pools/:id/clips/:filename/normalize', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    const job = jq.enqueue({
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

router.post('/broll-pools/:id/clips/:filename/autotag', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    const job = jq.enqueue({
      project_slug: '_app_',
      type: 'broll_autotag' as JobType,
      episode_id: pool.id,
      title: `Auto-tag B-Roll · ${req.params.filename}`,
      params: {
        pool_id: pool.id,
        filename: req.params.filename,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
        replace_tags: !!req.body?.replace_tags,
      },
      dedupeParams: (p: any) => p?.filename === req.params.filename,
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue auto-tag'))
  }
})

// Bulk auto-tag: queue jobs for every clip whose `tags` array is empty
// (or every clip if force=true). Skips clips that already have at least
// one tag so re-running the bulk button doesn't burn vision credits on
// already-curated clips. Caller can force with body.force=true.
router.post('/broll-pools/:id/autotag-untagged', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    const force = !!req.body?.force
    const clips = await bp.listClips(pool.id, { includeMissing: false })
    const targets = clips.filter(c => force ? true : !(c.tags && c.tags.length))
    let queued = 0
    for (const c of targets) {
      if (jq.isDuplicate('_app_', pool.id, 'broll_autotag' as JobType, (p: any) => p?.filename === c.filename)) continue
      jq.enqueue({
        project_slug: '_app_',
        type: 'broll_autotag' as JobType,
        episode_id: pool.id,
        title: `Auto-tag B-Roll · ${c.filename}`,
        params: {
          pool_id: pool.id,
          filename: c.filename,
          model: typeof req.body?.model === 'string' ? req.body.model : undefined,
          replace_tags: !!req.body?.replace_tags,
        },
        dedupeParams: (p: any) => p?.filename === c.filename,
      })
      queued += 1
    }
    res.status(201).json({ queued, total_targets: targets.length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue bulk auto-tag'))
  }
})

router.post('/broll-pools/:id/normalize-all', async (req, res) => {
  try {
    const pool = await bp.getPool(req.params.id)
    if (!pool) return res.status(404).json({ detail: 'Pool not found' })
    const clips = await bp.listClips(pool.id, { includeMissing: false })
    const unnormalized = clips.filter(c => !c.normalized)
    let queued = 0
    for (const c of unnormalized) {
      if (jq.isDuplicate('_app_', pool.id, 'broll_normalize' as JobType, (p: any) => p?.filename === c.filename)) continue
      jq.enqueue({
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

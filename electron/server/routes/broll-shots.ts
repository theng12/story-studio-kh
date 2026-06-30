/**
 * Scripted B-Roll routes — REST surface for the shot plan (broll_plan.json).
 *
 *   GET    /projects/:slug/episodes/:code/broll-plan           — read plan
 *   PUT    /projects/:slug/episodes/:code/broll-plan           — save edited plan
 *   DELETE /projects/:slug/episodes/:code/broll-plan           — remove (revert)
 *   POST   /projects/:slug/episodes/:code/broll-plan/generate  — shot director (+optional resolve)
 *   POST   /projects/:slug/episodes/:code/broll-plan/resolve   — search+download picks
 *   POST   /projects/:slug/episodes/:code/broll-plan/assemble  — write selection sidecar + queue render
 */
import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import {
  readPlan, writePlan, resolveBrollPlanPath, deletePlanAt, normalizePlan, emptyPlan,
} from '../services/broll-plan.js'
import { runShotDirector, requeryBeat } from '../services/broll-shot-director.js'
import { resolveBeats, planToSelectionSidecar, searchCandidates, downloadResultToPool, pickVideoPool } from '../services/broll-shot-resolver.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import { saveSelectionSidecar } from '../services/broll-selection-sidecar.js'
import type { JobType } from '../models/types.js'

export const router = Router()

const IMAGE_MODEL = /^(imagestudio|kie|fal|runware|replicate):/i

async function collectApiKeys() {
  const [a, o, k] = await Promise.all([
    getApiKey('anthropic').catch(() => ''),
    getApiKey('openai').catch(() => ''),
    getApiKey('kie').catch(() => ''),
  ])
  return { anthropic_api_key: a, openai_api_key: o, kie_api_key: k }
}

async function resolveTitle(slug: string, code: string): Promise<string> {
  try {
    const ideas = await im.getIdeas(slug, 'accepted')
    return ideas.find(i => i.episode_code === code)?.title || ''
  } catch { return '' }
}

// ── Read / write / delete ────────────────────────────────────────────────────

router.get('/projects/:slug/episodes/:code/broll-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    res.json((await readPlan(req.params.slug, code, paths.episode_dir)) ?? emptyPlan())
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read B-Roll plan'))
  }
})

router.put('/projects/:slug/episodes/:code/broll-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    const plan = normalizePlan(req.body)
    const at = await writePlan(req.params.slug, code, paths.episode_dir, plan)
    res.json({ ok: true, path: at, plan })
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'Failed to save B-Roll plan' })
  }
})

router.delete('/projects/:slug/episodes/:code/broll-plan', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    await deletePlanAt(await resolveBrollPlanPath(req.params.slug, code, paths.episode_dir))
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete B-Roll plan'))
  }
})

// ── Generate (shot director) + optional resolve ──────────────────────────────

router.post('/projects/:slug/episodes/:code/broll-plan/generate', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const body = req.body || {}
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (IMAGE_MODEL.test(model)) {
      return res.status(400).json({ detail: `"${model}" is an image model — this needs a text/LLM model.` })
    }

    const paths = await resolveEpisodePathsByCode(slug, code)
    const stitched = path.join(paths.subtitles_dir, `${code}_stitched.srt`)
    if (!existsSync(stitched)) {
      return res.status(409).json({ detail: `No stitched subtitles for ${code}. Run the Subtitles step first — the shot director needs the timed narration.` })
    }
    const cues = parseSrt(await fs.readFile(stitched, 'utf-8'))
    if (!cues.length) return res.status(409).json({ detail: 'The stitched subtitle track has no cues.' })

    const apiKeys = await collectApiKeys()
    let plan = await runShotDirector({
      cues,
      model,
      apiKeys,
      target_beat_sec: Number(body.target_beat_sec) > 0 ? Number(body.target_beat_sec) : undefined,
      broll_style: typeof body.broll_style === 'string' ? body.broll_style : undefined,
      style_hint: typeof body.style_hint === 'string' ? body.style_hint : undefined,
      slug,
    })

    let resolveInfo: any = {}
    if (body.resolve === true) {
      const r = await resolveBeats(plan, { poolId: typeof body.pool_id === 'string' ? body.pool_id : undefined })
      plan = r.plan
      resolveInfo = { downloaded: r.downloaded, matched: r.matched, pool_id: r.pool_id, resolve_skipped_reason: r.skipped_reason }
    }

    await writePlan(slug, code, paths.episode_dir, plan)
    res.json({ ok: true, plan, beat_count: plan.beats.length, ...resolveInfo })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Shot director failed'))
  }
})

// ── Resolve (search + download the picks) ────────────────────────────────────

router.post('/projects/:slug/episodes/:code/broll-plan/resolve', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const body = req.body || {}
    const paths = await resolveEpisodePathsByCode(slug, code)
    const current = body && Array.isArray(body.beats)
      ? normalizePlan(body)
      : (await readPlan(slug, code, paths.episode_dir)) ?? emptyPlan()
    const r = await resolveBeats(current, { poolId: typeof body.pool_id === 'string' ? body.pool_id : undefined })
    await writePlan(slug, code, paths.episode_dir, r.plan)
    res.json({ ok: true, plan: r.plan, downloaded: r.downloaded, matched: r.matched, pool_id: r.pool_id, resolve_skipped_reason: r.skipped_reason })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'B-Roll resolve failed'))
  }
})

// ── Preview (Phase 3): stream the episode's merged narration audio ───────────

router.get('/projects/:slug/episodes/:code/narration-audio', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(req.params.slug, code)
    if (!existsSync(paths.merged_audio_dir)) return res.status(404).json({ detail: 'No merged audio — run Audio Assembly first.' })
    let audioPath: string | null = null
    let best = 0
    for (const f of await fs.readdir(paths.merged_audio_dir).catch(() => [] as string[])) {
      if (!/\.(mp3|wav|m4a)$/i.test(f) || f.startsWith('.tmp_')) continue
      const st = await fs.stat(path.join(paths.merged_audio_dir, f)).catch(() => null)
      if (st && st.size > best) { best = st.size; audioPath = path.join(paths.merged_audio_dir, f) }
    }
    if (!audioPath) return res.status(404).json({ detail: 'No merged audio file.' })
    const ext = path.extname(audioPath).toLowerCase()
    const mime = ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg'
    const stat = await fs.stat(audioPath)
    const fsMod = await import('fs')
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Accept-Ranges', 'bytes')
    const m = req.headers.range ? /bytes=(\d+)-(\d*)/.exec(req.headers.range) : null
    if (m) {
      const start = parseInt(m[1]!, 10)
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      fsMod.createReadStream(audioPath, { start, end }).pipe(res)
    } else {
      res.setHeader('Content-Length', String(stat.size))
      fsMod.createReadStream(audioPath).pipe(res)
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to serve narration audio'))
  }
})

// ── Storyboard (Phase 2): re-query one beat, search alternatives, swap clip ───

router.post('/projects/:slug/episodes/:code/broll-plan/requery-beat', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const body = req.body || {}
    const idx = Number(body.beat_index)
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return res.status(400).json({ detail: 'model is required' })
    if (IMAGE_MODEL.test(model)) return res.status(400).json({ detail: `"${model}" is an image model.` })

    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = (await readPlan(slug, code, paths.episode_dir)) ?? emptyPlan()
    const beat = plan.beats[idx]
    if (!beat) return res.status(404).json({ detail: `Beat ${idx} not found` })

    const apiKeys = await collectApiKeys()
    const queries = await requeryBeat({
      line: beat.line, start_sec: beat.start_sec, end_sec: beat.end_sec, model, apiKeys,
      style_hint: typeof body.style_hint === 'string' ? body.style_hint : undefined, slug,
    })
    if (queries.length) beat.queries = queries
    await writePlan(slug, code, paths.episode_dir, plan)
    res.json({ ok: true, plan, queries })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Re-query failed'))
  }
})

router.post('/projects/:slug/episodes/:code/broll-plan/search', async (req, res) => {
  try {
    const body = req.body || {}
    const queries = Array.isArray(body.queries) ? body.queries.map((q: any) => String(q)).filter(Boolean) : []
    if (!queries.length) return res.status(400).json({ detail: 'queries is required' })
    const found = await searchCandidates(queries, Number(body.limit) > 0 ? Number(body.limit) : 12)
    // Trim to what the picker needs (thumbnail + ids); keep the full result for swap.
    const candidates = found.map(f => ({
      provider: f.provider,
      source_id: f.result.source_id,
      source_url: f.result.source_url,
      thumbnail_url: f.result.thumbnail_url,
      duration: f.result.duration,
      result: f.result,
    }))
    res.json({ candidates })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Search failed'))
  }
})

router.post('/projects/:slug/episodes/:code/broll-plan/swap-beat', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const body = req.body || {}
    const idx = Number(body.beat_index)
    const provider = body.provider
    const result = body.result
    if (!result || !provider) return res.status(400).json({ detail: 'provider and result are required' })

    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = (await readPlan(slug, code, paths.episode_dir)) ?? emptyPlan()
    const beat = plan.beats[idx]
    if (!beat) return res.status(404).json({ detail: `Beat ${idx} not found` })

    const pool = await pickVideoPool(typeof body.pool_id === 'string' ? body.pool_id : beat.pool_id)
    if (!pool) return res.status(409).json({ detail: 'No online video pool to download into.' })

    const filename = await downloadResultToPool(pool, result, provider, [beat.queries[0] || beat.line])
    try { await scanPoolFolder(pool.folder_path, undefined, 'video') } catch { /* index best-effort */ }
    beat.source = provider
    beat.pool_id = pool.id
    beat.clip = filename
    beat.in_point_sec = 0
    beat.status = 'user-swapped'
    await writePlan(slug, code, paths.episode_dir, plan)
    res.json({ ok: true, plan, filename })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Swap failed'))
  }
})

// ── Assemble: plan → selection sidecar → existing broll_assemble job ──────────

router.post('/projects/:slug/episodes/:code/broll-plan/assemble', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code.toUpperCase()
    const paths = await resolveEpisodePathsByCode(slug, code)
    const plan = (await readPlan(slug, code, paths.episode_dir)) ?? emptyPlan()

    const sidecar = await planToSelectionSidecar(plan, code)
    if (!sidecar) {
      return res.status(400).json({ detail: 'No resolved beats to assemble. Run Generate + Resolve so beats have clips first.' })
    }

    const title = await resolveTitle(slug, code)
    await saveSelectionSidecar(slug, code, title, sidecar)

    if (jq.isDuplicate(slug, code, 'broll_assemble' as JobType)) {
      return res.status(409).json({ detail: `B-Roll assembly already queued/running for ${code}` })
    }
    const job = jq.enqueue({
      project_slug: slug,
      type: 'broll_assemble' as JobType,
      episode_id: code,
      title: `Assemble Scripted B-Roll — ${code}`,
      params: { episode_id: code, title, broll_volume: 0 },
    })
    res.status(201).json({ ok: true, job, beats: sidecar.selection.length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Scripted B-Roll assembly failed to queue'))
  }
})

/**
 * Song Pool routes (music format, phase 1).
 *
 *   GET   /api/song-pools                                   — every pool, for the Episode Builder's picker
 *   GET   /api/projects/:slug/song-pool                     — the pool + window, coverage, needs, running batch
 *   PATCH /api/projects/:slug/song-pool/songs/:id           — rating / title / tags / enabled
 *   GET   /api/projects/:slug/song-pool/songs/:id/audio     — the file, for the inline player
 *   POST  /api/projects/:slug/song-pool/reject              — { song_ids } → trash, or archive when used
 *   POST  /api/projects/:slug/song-pool/plan                — what N new songs would cover (pure, free)
 *   POST  /api/projects/:slug/song-pool/preview-briefs      — writes 5 briefs, makes no audio
 *   POST  /api/projects/:slug/song-pool/generate            — the job (new | fill-gaps | regenerate)
 *
 * Building an episode never makes songs; only `generate` does, on a click.
 */
import { Router } from 'express'
import path from 'path'
import { existsSync } from 'fs'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as sp from '../services/song-pool.js'
import { getEffectiveNiche } from '../services/niche-loader.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { callAi } from '../lib/ai-client.js'
import { planCells, coverageGrid } from '../services/song-coverage.js'
import { BRIEFS_PER_CALL, SUNG_BRIEFS_PER_CALL, writeBriefs } from '../services/song-brief.js'
import { comboCount, poolNeeds, EpisodeDefaultsSchema, STARTING_EPISODE_DEFAULTS } from '../contracts/song-formula.js'
import { songFormulaFor } from '../generators/song-pool-generate.js'
import type { JobType } from '../models/types.js'

export const router = Router()

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail = (res: any, e: any, what: string) => res.status(e?.statusCode || 500).json(humanizeBackendError(e, what))

async function project(req: any, res: any): Promise<string | null> {
  const slug = String(req.params.slug || '')
  if (!(await pm.getProject(slug))) { res.status(404).json({ detail: 'Project not found' }); return null }
  return slug
}

async function episodeDefaultsFor(slug: string) {
  const niche: any = await getEffectiveNiche(slug).catch(() => null)
  const parsed = EpisodeDefaultsSchema.safeParse(niche?.musicFormat?.episodeDefaults)
  return { defaults: parsed.success ? parsed.data : STARTING_EPISODE_DEFAULTS, saved: parsed.success }
}

/** The running (or paused/queued) Song Pool batch, if any. */
async function activeBatch(slug: string) {
  const jobs = await jq.findJobs(slug, j => j.type === 'music_generate' && (j.params as any)?.song_pool === true)
  const live = jobs.filter(j => ['queued', 'running', 'paused'].includes(j.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (!live) return null
  const ip: any = live.item_progress || {}
  const dropped = (live.output_lines || []).filter(l => l.startsWith('✗ Brief dropped')).length
  return {
    job_id: live.job_id, status: live.status, title: live.title,
    total: Number(ip.total) || Number((live.params as any)?.count) || 0,
    saved: Number(ip.completed) || 0, failed: Number(ip.failed) || 0,
    on_fleet: Array.isArray(ip.active) ? ip.active.length : 0,
    writer_model: String((live.params as any)?.writer_model || ''),
    in_flight: Number((live.params as any)?.in_flight) || 1,
    mode: String((live.params as any)?.mode || 'new'),
    dropped,
  }
}

router.get('/song-pools', async (_req, res) => {
  try { res.json({ pools: await sp.listPools() }) } catch (e) { fail(res, e, 'Could not list the song pools') }
})

router.get('/projects/:slug/song-pool', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const pool = await sp.readPool(slug)
    const formula = await songFormulaFor(slug)
    const { defaults, saved: defaultsSaved } = await episodeDefaultsFor(slug)
    const window = sp.episodeWindow([pool], slug, defaults.no_repeat_episodes)
    const ready = pool.songs.filter(s => s.status === 'ready')
    const drawable = ready.filter(sp.isDrawable)
    const measured = ready.filter(s => Number(s.duration_s) > 0)
    const avgSong = measured.length ? measured.reduce((t, s) => t + s.duration_s!, 0) / measured.length : 0
    const timed = pool.songs.filter(s => Number(s.generation_s) > 0).slice(-50)
    const needs = avgSong ? poolNeeds(defaults.target_length_s, defaults.no_repeat_episodes, avgSong) : null
    let coverage = null
    if (!('error' in formula)) {
      const moods = formula.formula.moods.map(m => m.value)
      const bands = formula.formula.tempo_bands
      coverage = {
        rows: moods, cols: bands.map(b => b.label),
        grid: coverageGrid(ready, moods, bands.map(b => b.id), s => s.mood, s => s.tempo_band),
        combinations: comboCount(formula.formula),
        used_combinations: new Set(ready.map(s => s.combo_key).filter(Boolean)).size,
      }
    }
    res.json({
      pool,
      folder: sp.poolDir(slug),
      summary: sp.summarize(pool),
      window,
      episode_defaults: defaults,
      episode_defaults_saved: defaultsSaved,
      formula: 'error' in formula ? { error: formula.error } : { name: formula.name, song_formula: formula.formula, themes: formula.themes },
      coverage,
      stats: {
        songs: ready.length,
        total_s: Math.round(ready.reduce((t, s) => t + (s.duration_s || 0), 0)),
        free_next: drawable.filter(s => !sp.inWindow(s, window, slug)).length,
        rejected: pool.songs.filter(s => s.status === 'rejected').length,
        archived: pool.songs.filter(s => s.status === 'archived').length,
        average_song_s: Math.round(avgSong),
        average_generation_s: timed.length ? Math.round(timed.reduce((t, s) => t + s.generation_s!, 0) / timed.length) : null,
        per_episode: needs?.per_episode ?? null,
        needed: needs?.needed ?? null,
        missing: needs ? Math.max(0, needs.needed - drawable.length) : null,
      },
      active_batch: await activeBatch(slug),
    })
  } catch (e) { fail(res, e, 'Could not read the song pool') }
})

router.patch('/projects/:slug/song-pool/songs/:id', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const b = req.body || {}
    if (b.rating !== undefined && b.rating !== null && !(Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5)) {
      return res.status(400).json({ detail: 'A rating is 1 to 5 stars, or none.' })
    }
    const { result: found } = await sp.updatePool(slug, pool => {
      const s = pool.songs.find(x => x.id === req.params.id)
      if (!s) return false
      if (b.rating !== undefined) s.rating = b.rating
      if (typeof b.title === 'string' && b.title.trim()) s.title = b.title.trim().slice(0, 200)
      if (Array.isArray(b.tags)) s.tags = [...new Set(b.tags.map(String).map((t: string) => t.trim()).filter(Boolean))].slice(0, 20) as string[]
      if (Array.isArray(b.add_tags)) s.tags = [...new Set([...s.tags, ...b.add_tags.map(String).map((t: string) => t.trim()).filter(Boolean)])].slice(0, 20) as string[]
      if (typeof b.enabled === 'boolean') s.enabled = b.enabled
      return true
    })
    if (!found) return res.status(404).json({ detail: 'That song is not in this pool.' })
    res.json({ ok: true })
  } catch (e) { fail(res, e, 'Could not update the song') }
})

router.get('/projects/:slug/song-pool/songs/:id/audio', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const pool = await sp.readPool(slug)
    const s = pool.songs.find(x => x.id === req.params.id)
    const dir = sp.poolDir(slug)!
    const file = s && s.file === path.basename(s.file) ? path.join(dir, s.file) : ''
    if (!file || !existsSync(file)) return res.status(404).json({ detail: 'The audio file for this song is not in the folder.' })
    res.sendFile(file)
  } catch (e) { fail(res, e, 'Could not play the song') }
})

router.post('/projects/:slug/song-pool/reject', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const ids = Array.isArray(req.body?.song_ids) ? req.body.song_ids.map(String) : []
    if (!ids.length) return res.status(400).json({ detail: 'Pick the songs to reject first.' })
    res.json(await sp.rejectSongs(slug, ids))
  } catch (e) { fail(res, e, 'Could not reject the songs') }
})

function lengths(b: any) {
  const min = Number(b?.length_min_s); const max = Number(b?.length_max_s)
  return {
    ...(Number.isFinite(min) && min > 0 ? { length_min_s: Math.round(min) } : {}),
    ...(Number.isFinite(max) && max > 0 ? { length_max_s: Math.round(max) } : {}),
  }
}

router.post('/projects/:slug/song-pool/plan', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const got = await songFormulaFor(slug)
    if ('error' in got) return res.status(409).json({ detail: got.error })
    const count = Math.max(1, Math.min(2000, Math.round(Number(req.body?.count) || 1)))
    const pool = await sp.readPool(slug)
    const l = lengths(req.body)
    const formula = { ...got.formula, length_s: { min: l.length_min_s || got.formula.length_s.min, max: l.length_max_s || got.formula.length_s.max } }
    const cells = planCells(formula, pool.songs.filter(s => s.status !== 'rejected'), count, `plan:${pool.songs.length}`, got.themes)
    const tally = (k: 'mood' | 'tempo_band') => cells.reduce<Record<string, number>>((m, c) => { m[c[k]] = (m[c[k]] || 0) + 1; return m }, {})
    res.json({
      first: cells.slice(0, 4), count: cells.length, by_mood: tally('mood'), by_tempo_band: tally('tempo_band'),
      new_combinations: new Set(cells.map(c => c.combo_key)).size, combinations: comboCount(formula),
      writing_calls: Math.ceil(cells.length / (got.formula.lyrics?.enabled ? SUNG_BRIEFS_PER_CALL : BRIEFS_PER_CALL)),
    })
  } catch (e) { fail(res, e, 'Could not plan the songs') }
})

router.post('/projects/:slug/song-pool/preview-briefs', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const writer = String(req.body?.writer_model || '').trim()
    if (!writer) return res.status(400).json({ detail: 'Pick the writing model first.' })
    const got = await songFormulaFor(slug)
    if ('error' in got) return res.status(409).json({ detail: got.error })
    const pool = await sp.readPool(slug)
    const l = lengths(req.body)
    const formula = { ...got.formula, length_s: { min: l.length_min_s || got.formula.length_s.min, max: l.length_max_s || got.formula.length_s.max } }
    const cells = planCells(formula, pool.songs.filter(s => s.status !== 'rejected'), 5, `preview:${Date.now()}`, got.themes)
    const written = await writeBriefs(cells, {
      titles: pool.songs.map(s => s.title), lines: pool.songs.map(s => s.line || '').filter(Boolean),
      sceneIdeas: pool.songs.map(s => s.scene_idea || '').filter(Boolean), never: formula.never,
      maxTitleWordShare: formula.variety.max_title_word_share, maxSimilarity: formula.variety.max_similarity,
      ...(formula.lyrics?.enabled ? { lyrics: { language: formula.lyrics.language } } : {}),
    }, (system, user) => callAi(writer, system, user, {}, false, { slug, outputBudget: 'standard', temperature: 0.8, jsonMode: true }))
    res.json({ briefs: written.briefs, dropped: written.dropped.map(d => ({ ...d.cell, reason: d.reason })) })
  } catch (e) { fail(res, e, 'Could not write the preview briefs') }
})

router.post('/projects/:slug/song-pool/generate', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const b = req.body || {}
    const operationId = typeof b.operation_id === 'string' ? b.operation_id.trim() : ''
    if (!OPERATION_ID.test(operationId)) return res.status(400).json({ detail: 'operation_id must be a UUID.' })
    const mode = ['new', 'fill-gaps', 'regenerate'].includes(b.mode) ? b.mode : 'new'
    const songIds: string[] = Array.isArray(b.song_ids) ? b.song_ids.map(String) : []
    if (mode === 'regenerate' && !songIds.length) return res.status(400).json({ detail: 'Pick the songs to regenerate first.' })
    const count = mode === 'regenerate' ? songIds.length : Math.max(1, Math.min(2000, Math.round(Number(b.count) || 0)))
    const writer = String(b.writer_model || '').trim()
    if (mode !== 'regenerate' && !writer) return res.status(400).json({ detail: 'Pick the writing model. It writes the titles and lines; it does not make the audio.' })
    // Never a default: the first published music row can be a paid cloud model.
    if (!String(b.music_model || '').trim()) return res.status(400).json({ detail: 'Pick the song model (for example Stable Audio 3 on your fleet).' })
    if (mode !== 'regenerate') {
      const got = await songFormulaFor(slug)
      if ('error' in got) return res.status(409).json({ detail: got.error })
    }
    const existing = (await jq.findJobs(slug, j => j.type === 'music_generate' && (j.params as any)?.generation_action?.id === operationId))[0]
    if (existing) return res.status(201).json({ ...existing, reused: true })
    const live = await activeBatch(slug)
    if (live) return res.status(409).json({ detail: 'Songs are already being made for this pool. Wait for that batch, or open it on the Jobs page.' })
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'music_generate' as JobType,
      episode_id: '',
      title: mode === 'regenerate' ? `Regenerate ${count} song${count === 1 ? '' : 's'}` : `Make ${count} song${count === 1 ? '' : 's'}${mode === 'fill-gaps' ? ' (fill gaps)' : ''}`,
      params: {
        song_pool: true, mode, count, writer_model: writer,
        music_model: String(b.music_model).trim(),
        ...(String(b.check_model || '').trim() ? { check_model: String(b.check_model).trim() } : {}),
        ...lengths(b),
        in_flight: Math.max(1, Math.min(256, Math.round(Number(b.in_flight) || 1))),
        ...(songIds.length ? { song_ids: songIds } : {}),
        ...(mode === 'regenerate' && songIds.length === 1 && b.brief_edits && typeof b.brief_edits === 'object' ? { brief_edits: b.brief_edits } : {}),
        batch_id: `b_${operationId.replace(/-/g, '').slice(0, 16)}`,
        generation_action: { id: operationId, kind: 'fresh' },
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) return res.status(409).json({ detail: 'A music job is already queued or running for this project.' })
    fail(res, e, 'Could not start making songs')
  }
})

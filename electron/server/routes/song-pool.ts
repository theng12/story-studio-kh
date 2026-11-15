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
import { withLock } from '../lib/atomic-store.js'
import { freshActionFingerprint, freshActionMatch, stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { planCells, coverageGrid } from '../services/song-coverage.js'
import { BRIEFS_PER_CALL, SUNG_BRIEFS_PER_CALL, writeBriefs } from '../services/song-brief.js'
import { comboCount, poolNeeds, singleEpisodeNeed, nextEpisodeShortfall, windowStockDeficit } from '../contracts/song-formula.js'
import { songFormulaFor } from '../generators/song-pool-generate.js'
import {
  readSongPoolBatchCheckpoint,
  validSongPoolMusicAttempt,
  type BatchFile,
  type BatchItem,
  type SongPoolMusicAttempt,
} from '../generators/song-pool-generate.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { listMusicModels, type GenStudioMusicModel } from '../lib/genstudio-client.js'
import { musicModelCanServe } from '../contracts/music-model-choice.js'
import { readManualGenerationRedoIntent } from '../lib/fresh-generation-action.js'
import { channelStartingSettings, loadEpisodeContext } from '../services/music-episode-store.js'
import { songKey } from '../services/music-episode.js'
import type { Job, JobType } from '../models/types.js'

export const router = Router()

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail = (res: any, e: any, what: string) => res.status(e?.statusCode || 500).json(humanizeBackendError(e, what))

async function project(req: any, res: any): Promise<string | null> {
  const slug = String(req.params.slug || '')
  if (!(await pm.getProject(slug))) { res.status(404).json({ detail: 'Project not found' }); return null }
  return slug
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
    // Same target, pools and history the Episode Builder uses (channel settings, not the formula's
    // narrower legacy episode defaults): a channel saved at 150 minutes must not be judged by the
    // 65-minute starting figure, and a drafted episode holds its songs just like a rendered one.
    const { settings } = await channelStartingSettings(slug)
    const ctx = await loadEpisodeContext(slug, '', settings)
    const window = ctx.window_codes
    const ready = pool.songs.filter(s => s.status === 'ready')
    const measured = ctx.songs.filter(s => s.drawable && s.duration_s > 0)
    const avgSong = measured.length ? measured.reduce((t, s) => t + s.duration_s!, 0) / measured.length : 0
    const timed = pool.songs.filter(s => Number(s.generation_s) > 0).slice(-50)
    const needs = avgSong ? poolNeeds(settings.target_length_s, settings.no_repeat_episodes, avgSong) : null
    // Two different questions, never one number: the WINDOW's stock size (`needed`) versus the
    // pool's drawable total, and the NEXT episode's requirement versus the songs actually free for
    // it. A 500-song pool that blocks 490 in the no-repeat window has no window deficit but is far
    // from ready for one episode, so the two deficits are reported separately.
    const drawableTotal = ctx.songs.filter(s => s.drawable).length
    const freeNext = ctx.songs.filter(s => s.drawable && !ctx.blocked.has(songKey(s))).length
    const singleNeeded = avgSong ? singleEpisodeNeed(settings.target_length_s, avgSong) : null
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
      blocked: Object.fromEntries(ctx.blocked),
      episode_defaults: settings,
      formula: 'error' in formula ? { error: formula.error } : { name: formula.name, song_formula: formula.formula, themes: formula.themes },
      coverage,
      stats: {
        songs: ready.length,
        total_s: Math.round(ready.reduce((t, s) => t + (s.duration_s || 0), 0)),
        free_next: freeNext,
        rejected: pool.songs.filter(s => s.status === 'rejected').length,
        archived: pool.songs.filter(s => s.status === 'archived').length,
        average_song_s: Math.round(avgSong),
        average_generation_s: timed.length ? Math.round(timed.reduce((t, s) => t + s.generation_s!, 0) / timed.length) : null,
        // Window stock (channel default): `needed` is the whole no-repeat window's target and
        // `missing` its deficit against all drawable songs. The next episode's own readiness is
        // `free_next` against `single_episode_needed` — never these window figures.
        per_episode: needs?.per_episode ?? null,
        needed: needs?.needed ?? null,
        missing: needs ? windowStockDeficit(needs.needed, drawableTotal) : null,
        single_episode_needed: singleNeeded,
        next_episode_missing: nextEpisodeShortfall(singleNeeded, freeNext),
      },
      active_batch: await activeBatch(slug),
    })
  } catch (e) { fail(res, e, 'Could not read the song pool') }
})

router.get('/projects/:slug/song-pool/manual-redo-sources', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const jobs = await jq.findJobs(slug, () => true)
    const groups = await Promise.all(jobs.map(async job => {
      if (job.type !== 'music_generate' || job.episode_id !== '' || job.params?.song_pool !== true) return []
      const batch = await songPoolBatch(job)
      if (!batch) return []
      return batch.items.map(item => {
        let eligible = true
        let reason = 'Unresolved Gateway music request'
        if (job.status !== 'error' && job.status !== 'cancelled') {
          eligible = false; reason = 'The source Song Pool batch has not stopped.'
        } else if (!item.item_key || item.song_id) {
          eligible = false; reason = item.song_id ? 'This item already has a saved song.' : 'This older item has no exact request receipt.'
        } else if (!exactUnknownMusicAttempt(slug, job, batch, item)) {
          eligible = false; reason = 'No exact unresolved Gateway music evidence remains for this item.'
        }
        return {
          source_job_id: job.job_id,
          source_item_key: item.item_key || '',
          label: item.brief?.title || item.item_key || 'Song',
          eligible,
          reason,
        }
      })
    }))
    res.json({ sources: groups.flat() })
  } catch (e) { fail(res, e, 'Could not read Song Pool replacement sources') }
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
    res.sendFile(file, { dotfiles: 'allow' })
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

const BRIEF_EDIT_FIELDS = ['title', 'line', 'scene_idea', 'ensemble', 'mood', 'tempo_bpm', 'key', 'texture', 'structure', 'length_s'] as const

function normalizedSongPoolRequest(b: any) {
  const mode = ['new', 'fill-gaps', 'regenerate'].includes(b?.mode) ? b.mode as 'new' | 'fill-gaps' | 'regenerate' : 'new'
  const songIds = Array.isArray(b?.song_ids) ? b.song_ids.map(String) : []
  const briefEdits = b?.brief_edits && typeof b.brief_edits === 'object' && !Array.isArray(b.brief_edits)
    ? Object.fromEntries(BRIEF_EDIT_FIELDS.filter(key => b.brief_edits[key] !== undefined).map(key => [key, b.brief_edits[key]]))
    : undefined
  return {
    lane: 'song-pool' as const,
    mode,
    count: mode === 'regenerate' ? songIds.length : Math.max(1, Math.min(2000, Math.round(Number(b?.count) || 0))),
    writer_model: String(b?.writer_model || '').trim(),
    music_model: String(b?.music_model || '').trim(),
    check_model: String(b?.check_model || '').trim(),
    ...lengths(b),
    in_flight: Math.max(1, Math.min(256, Math.round(Number(b?.in_flight) || 1))),
    song_ids: songIds,
    ...(briefEdits ? { brief_edits: briefEdits } : {}),
  }
}

function acceptedSongPoolReplay(job: Readonly<Job>, operationId: string, clientFingerprint: string): boolean {
  const action = job.params?.generation_action
  const receipt = job.params?.song_pool_action
  const legacyFingerprint = job.params?.song_pool === true
    ? freshActionFingerprint(normalizedSongPoolRequest(job.params))
    : ''
  return job.type === 'music_generate' && job.episode_id === '' && job.params?.song_pool === true
    && action?.id === operationId && action?.kind === 'fresh'
    && ((receipt?.version === 1 && receipt?.lane === 'song-pool'
      && receipt?.client_request_fingerprint === clientFingerprint)
      || (!receipt && legacyFingerprint === clientFingerprint))
}

type MusicEvidence = NonNullable<Job['genstudio_jobs']>[number]
const musicEvidenceKey = (entry: MusicEvidence): string => {
  const values = [entry.request_key, entry.request?.idempotency_key]
    .filter((value): value is string => typeof value === 'string' && !!value)
  return values.length && new Set(values).size === 1 ? values[0]! : ''
}
const unresolvedMusicEvidence = (entry: MusicEvidence): boolean => entry.operation === 'music.generation'
  && entry.queue_state !== 'not_created' && entry.queue_state !== 'waiting_credits'
  && entry.state !== 'succeeded' && entry.state !== 'cancelled'
  && !(entry.state === 'failed' && entry.recovery_required !== true)
  && (entry.dispatch_state === 'dispatched' || ['running', 'accepted', 'reserved', 'reconciling'].includes(entry.state)
    || entry.recovery_required === true)

function exactUnknownMusicAttempt(
  slug: string,
  job: Readonly<Job>,
  batch: BatchFile,
  item: BatchItem,
  entries: readonly MusicEvidence[] = job.genstudio_jobs || [],
): SongPoolMusicAttempt | null {
  const current = (item.music_attempts || []).filter(attempt => {
    if (!validSongPoolMusicAttempt(slug, batch, item, attempt)) return false
    const related = entries.filter(entry => entry.operation === 'music.generation'
      && (musicEvidenceKey(entry) === attempt.idempotency_key
        || (!!attempt.accepted_task_id && entry.id === attempt.accepted_task_id)))
    if (related.length !== 1 || musicEvidenceKey(related[0]!) !== attempt.idempotency_key
      || !unresolvedMusicEvidence(related[0]!)) return false
    return attempt.accepted_task_id
      ? related[0]!.id === attempt.accepted_task_id
      : related[0]!.id === `pending:${attempt.idempotency_key}`
  })
  return current.length === 1 ? current[0]! : null
}

async function songPoolBatch(job: Readonly<Job>): Promise<BatchFile | null> {
  const dir = sp.poolDir(job.project_slug)
  const batchId = typeof job.params?.batch_id === 'string' ? job.params.batch_id : ''
  return dir && job.params?.song_pool === true && batchId ? readSongPoolBatchCheckpoint(dir, batchId) : null
}

function musicPriceClass(model: GenStudioMusicModel): 'free' | 'paid' | 'unknown' {
  if (model.chargeable === true || model.credits_per_request > 0 || model.minimum_credits > 0
    || (typeof model.standard_credits === 'number' && model.standard_credits > 0)
    || (typeof model.sale_credits === 'number' && model.sale_credits > 0)
    || Object.values(model.price_usd || {}).some(value => value > 0)
    || (model.price_variants || []).some(value => typeof value.usd === 'number' && value.usd > 0)) return 'paid'
  if (model.chargeable === false) return 'free'
  if (model.price_source === 'local' && model.credits_per_request === 0 && model.minimum_credits === 0
    && (model.standard_credits === null || model.standard_credits === 0)
    && (model.sale_credits === null || model.sale_credits === 0)
    && !Object.values(model.price_usd || {}).some(value => value !== 0)
    && !(model.price_variants || []).some(value => typeof value.usd !== 'number' || value.usd !== 0)) return 'free'
  return 'unknown'
}

function musicRequestLimitError(model: GenStudioMusicModel, request: SongPoolMusicAttempt['request']): string | null {
  const lyricsLength = request.lyrics?.length || 0
  const promptMaximum = !lyricsLength && Number.isInteger(model.max_prompt_without_lyrics_characters)
    ? model.max_prompt_without_lyrics_characters as number : model.max_prompt_characters
  const minPrompt = Number.isInteger(model.min_prompt_characters) && model.min_prompt_characters! >= 0 ? model.min_prompt_characters : null
  const minLyrics = Number.isInteger(model.min_lyrics_characters) && model.min_lyrics_characters! >= 0 ? model.min_lyrics_characters : null
  const tooLong = (field: string, actual: number, limit: number) => `${model.display_name} accepts up to ${limit.toLocaleString()} ${field} characters; this saved item has ${actual.toLocaleString()}. Nothing was queued.`
  const tooShort = (field: string, actual: number, limit: number) => `${model.display_name} requires at least ${limit.toLocaleString()} ${field} characters; this saved item has ${actual.toLocaleString()}. Nothing was queued.`
  if (request.title.length > model.max_title_characters) return tooLong('title', request.title.length, model.max_title_characters)
  if (minPrompt !== null && request.prompt.length < minPrompt) return tooShort('prompt', request.prompt.length, minPrompt)
  if (request.prompt.length > promptMaximum) return tooLong('prompt', request.prompt.length, promptMaximum)
  if (lyricsLength && minLyrics !== null && lyricsLength < minLyrics) return tooShort('lyrics', lyricsLength, minLyrics)
  if (lyricsLength > model.max_lyrics_characters) return tooLong('lyrics', lyricsLength, model.max_lyrics_characters)
  const seconds = request.duration_seconds
  if (seconds && model.min_duration_seconds && seconds < model.min_duration_seconds) return `${model.display_name} makes tracks at least ${model.min_duration_seconds} seconds long; this saved item asks for ${seconds}. Nothing was queued.`
  if (seconds && model.max_duration_seconds && seconds > model.max_duration_seconds) return `${model.display_name} makes tracks up to ${model.max_duration_seconds} seconds long; this saved item asks for ${seconds}. Nothing was queued.`
  return null
}

function manualSongPoolClientFingerprint(body: any, sourceJobId: string, sourceItemKey: string): string {
  return freshActionFingerprint({
    lane: 'song-pool-manual', model: String(body?.music_model || '').trim(), source_item_key: sourceItemKey,
    manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
    manual_music_payment: structuredClone(body?.manual_music_payment),
  })
}

function acceptedManualSongPoolReplay(
  job: Readonly<Job>, operationId: string, clientFingerprint: string,
  sourceJobId: string, sourceItemKey: string, modelId: string,
): boolean {
  const redo = job.params?.manual_redo
  const action = job.params?.generation_action
  return job.type === 'music_generate' && job.episode_id === '' && job.params?.song_pool === true
    && action?.id === operationId && action?.kind === 'fresh'
    && redo?.version === 1 && redo?.lane === 'song-pool' && redo?.intent === 'replace_unresolved'
    && redo?.source_job_id === sourceJobId && redo?.source_item_key === sourceItemKey
    && redo?.selected_model_id === modelId && redo?.client_request_fingerprint === clientFingerprint
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
    }, (system, user, minimumOutputTokens) => callAi(writer, system, user, {}, false, {
      slug,
      outputBudget: formula.lyrics?.enabled
        ? { tier: 'workload', minimumTokens: minimumOutputTokens }
        : 'standard',
      temperature: 0.8, jsonMode: true,
    }))
    res.json({ briefs: written.briefs, dropped: written.dropped.map(d => ({ ...d.cell, reason: d.reason })) })
  } catch (e) { fail(res, e, 'Could not write the preview briefs') }
})

router.post('/projects/:slug/song-pool/generate', async (req, res) => {
  try {
    const slug = await project(req, res); if (!slug) return
    const b = req.body || {}
    const operationId = typeof b.operation_id === 'string' ? b.operation_id.trim() : ''
    if (!OPERATION_ID.test(operationId)) return res.status(400).json({ detail: 'operation_id must be a UUID.' })
    let manualRedo
    try {
      manualRedo = readManualGenerationRedoIntent(b)
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual replacement.' })
    }
    if (manualRedo) {
      const sourceItemKey = typeof b.source_item_key === 'string' ? b.source_item_key.trim() : ''
      const modelId = typeof b.music_model === 'string' ? b.music_model.trim() : ''
      if (!sourceItemKey || !modelId) return res.status(400).json({ detail: 'Choose one unresolved Song Pool item and one music model.' })
      const payment = b.manual_music_payment
      if (!payment || typeof payment !== 'object' || Array.isArray(payment)
        || Object.keys(payment).some(key => !['version', 'model_id', 'price_version', 'confirmed_paid_music'].includes(key))
        || payment.version !== 1 || payment.model_id !== modelId
        || typeof payment.price_version !== 'string' || typeof payment.confirmed_paid_music !== 'boolean') {
        return res.status(409).json({ detail: 'Confirm the current published music price for this exact model.' })
      }
      const clientFingerprint = manualSongPoolClientFingerprint(b, manualRedo.source_job_id, sourceItemKey)
      return withLock(`fresh-song-pool:${slug}:${operationId}`, async () => {
        const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
        if (previous) {
          if (!acceptedManualSongPoolReplay(previous, operationId, clientFingerprint,
            manualRedo.source_job_id, sourceItemKey, modelId)) {
            return res.status(409).json({ detail: 'This operation_id already belongs to a different Song Pool action.' })
          }
          return res.status(200).json({ ...previous, reused: true })
        }
        const source = (await jq.findJobs(slug, job => job.job_id === manualRedo.source_job_id))[0]
        const batch = source && await songPoolBatch(source)
        const item = batch?.items.find(candidate => candidate.item_key === sourceItemKey)
        const attempt = source && batch && item ? exactUnknownMusicAttempt(slug, source, batch, item) : null
        if (!source || !batch || !item || !attempt || item.song_id) {
          return res.status(409).json({ detail: 'The selected item is not a durable unresolved Song Pool music request.' })
        }
        const apiKey = await getApiKey('genstudio').catch(() => '')
        const catalog = apiKey ? await listMusicModels(apiKey) : []
        const model = catalog.find(candidate => candidate.id === modelId)
        if (!model || model.coming_soon || model.locked) {
          return res.status(409).json({ detail: 'The selected music model is not currently available.' })
        }
        if (!musicModelCanServe(model, {
          instrumental: attempt.request.instrumental,
          hasLyrics: !!attempt.request.lyrics,
        })) {
          return res.status(409).json({ detail: 'The selected music model cannot make this saved item in its original instrumental or vocal mode.' })
        }
        const limitError = musicRequestLimitError(model, attempt.request)
        if (limitError) return res.status(409).json({ detail: limitError })
        if (!model.price_version || payment.price_version !== model.price_version) {
          return res.status(409).json({ detail: 'The published music price changed. Review it and confirm again.' })
        }
        const charge = musicPriceClass(model)
        if (charge === 'unknown') return res.status(409).json({ detail: 'This model has no clear published free or paid price. No music was queued.' })
        if (charge === 'paid' && payment.confirmed_paid_music !== true) {
          return res.status(409).json({ detail: 'Confirm this separate paid music request before it is queued.' })
        }
        const resourceIdentity = `song-pool:${batch.batch_id}:${sourceItemKey}:music`
        const params = stampFreshGenerationAction({
          song_pool: true,
          mode: 'manual-redo' as const,
          count: 1,
          writer_model: '',
          music_model: modelId,
          in_flight: 1,
          batch_id: `b_${operationId.replace(/-/g, '').slice(0, 16)}`,
          manual_song_pool_item: {
            version: 1 as const,
            source_job_id: source.job_id,
            source_batch_id: batch.batch_id,
            source_item_key: sourceItemKey,
            brief: structuredClone(item.brief!),
            request: structuredClone(attempt.request),
          },
          song_pool_action: { version: 1 as const, lane: 'song-pool-manual' as const, client_request_fingerprint: clientFingerprint },
          manual_redo: {
            version: 1 as const,
            intent: manualRedo.intent,
            lane: 'song-pool' as const,
            source_job_id: source.job_id,
            source_batch_id: batch.batch_id,
            source_item_key: sourceItemKey,
            selected_model_id: modelId,
            client_request_fingerprint: clientFingerprint,
            resource_identity: resourceIdentity,
            requested_at: new Date().toISOString(),
            payment: {
              version: 1 as const, model_id: modelId, price_version: model.price_version,
              charge_class: charge, credits_per_request: model.credits_per_request,
              minimum_credits: model.minimum_credits,
            },
          },
        }, operationId)
        try {
          const job = await jq.enqueueManualGenerationRedo({
            project_slug: slug,
            type: 'music_generate',
            episode_id: '',
            title: `Song Pool separate attempt — ${item.brief!.title}`,
            params,
          }, {
            sourceJobId: source.job_id,
            sourceType: 'music_generate',
            sourceLabel: 'Song Pool music batch',
            operation: 'music.generation',
            evidenceLabel: 'Song Pool music request',
            resource: {
              kind: 'custom', identity: resourceIdentity,
              matches: candidate => candidate.params?.song_pool === true && candidate.params?.batch_id === batch.batch_id,
            },
            hasCurrentEvidence: (candidate, entries) => exactUnknownMusicAttempt(slug, candidate, batch, item, entries) !== null,
          })
          return res.status(201).json(job)
        } catch (error: any) {
          return res.status(error?.status || error?.statusCode || 409).json({ detail: error?.message || 'Could not start the separate Song Pool attempt.' })
        }
      })
    }
    const normalized = normalizedSongPoolRequest(b)
    const clientFingerprint = freshActionFingerprint(normalized)
    const mode = normalized.mode
    const songIds = normalized.song_ids
    if (mode === 'regenerate' && !songIds.length) return res.status(400).json({ detail: 'Pick the songs to regenerate first.' })
    return withLock(`fresh-song-pool:${slug}:${operationId}`, async () => {
      const existing = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
      if (existing) {
        if (!acceptedSongPoolReplay(existing, operationId, clientFingerprint)) {
          return res.status(409).json({ detail: 'This operation_id already belongs to a different Song Pool action.' })
        }
        return res.status(200).json({ ...existing, reused: true })
      }
      const writer = normalized.writer_model
      if (mode !== 'regenerate' && !writer) return res.status(400).json({ detail: 'Pick the writing model. It writes the titles and lines; it does not make the audio.' })
      if (!normalized.music_model) return res.status(400).json({ detail: 'Pick the song model (for example Stable Audio 3 on your fleet).' })
      if (mode !== 'regenerate') {
        const got = await songFormulaFor(slug)
        if ('error' in got) return res.status(409).json({ detail: got.error })
      }
      const live = await activeBatch(slug)
      if (live) return res.status(409).json({ detail: 'Songs are already being made for this pool. Wait for that batch, or open it on the Jobs page.' })
      const count = normalized.count
      const params = stampFreshGenerationAction({
        song_pool: true, mode, count, writer_model: writer,
        music_model: normalized.music_model,
        ...(normalized.check_model ? { check_model: normalized.check_model } : {}),
        ...lengths(normalized), in_flight: normalized.in_flight,
        ...(songIds.length ? { song_ids: songIds } : {}),
        ...(mode === 'regenerate' && songIds.length === 1 && normalized.brief_edits ? { brief_edits: normalized.brief_edits } : {}),
        batch_id: `b_${operationId.replace(/-/g, '').slice(0, 16)}`,
        song_pool_action: { version: 1 as const, lane: 'song-pool' as const, client_request_fingerprint: clientFingerprint },
      }, operationId)
      const job = await jq.enqueue({
        project_slug: slug, type: 'music_generate' as JobType, episode_id: '',
        title: mode === 'regenerate' ? `Regenerate ${count} song${count === 1 ? '' : 's'}` : `Make ${count} song${count === 1 ? '' : 's'}${mode === 'fill-gaps' ? ' (fill gaps)' : ''}`,
        params,
      })
      res.status(201).json(job)
    })
  } catch (e: any) {
    if (e instanceof jq.DuplicateJobError) return res.status(409).json({ detail: 'A music job is already queued or running for this project.' })
    fail(res, e, 'Could not start making songs')
  }
})

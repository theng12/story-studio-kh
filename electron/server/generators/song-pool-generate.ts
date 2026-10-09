/**
 * Generate songs for a Song Pool (music format, phase 1; SPEC §2).
 *
 *   1. Code reserves N cells with the coverage planner (or, for Regenerate, takes the briefs of
 *      the chosen songs with a new seed).
 *   2. The writing model PICKED IN THE START DIALOG writes titles / lines / scene ideas, 20 per
 *      call; code checks every answer (rewritten once, then dropped and reported).
 *   3. The briefs are written to `music-library/batches/<batch_id>.json` BEFORE any audio is asked
 *      for, so a Retry never rewrites a brief or re-asks for a saved song.
 *   4. One Gateway request per song, `in_flight` at a time across the fleet (the Gateway queues the
 *      surplus for whichever Mac frees first); each song is saved as soon as it lands, trimmed,
 *      measured, and written to library.json.
 *
 * Runs as the existing `music_generate` job type with `params.song_pool: true`, so the lane,
 * label, cancel and completion audit (`auditMusicLibraryTopUp`) all apply unchanged.
 */
import { musicWindowSizer, runRollingWindow } from '../lib/music-window.js'
import fs from 'fs/promises'
import path from 'path'

import * as jq from '../services/job-queue.js'
import { callAi } from '../lib/ai-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { getEffectiveNiche } from '../services/niche-loader.js'
import {
  GenStudioMusicTerminalFailureError,
  generateMusicWithGenStudio,
  downloadGenStudioMusicTrack,
  isGenStudioInsufficientCredits,
  listMusicModels,
} from '../lib/genstudio-client.js'
import { freeMacWaitLine, isFreeMacPlan, waitUnlessStopped } from '../lib/genstudio-fleet-busy.js'
import { musicDurationPlan } from '../contracts/music-model-choice.js'
import { SongFormulaSchema, type SongFormula } from '../contracts/song-formula.js'
import { planCells, hashSeed, type PlannedCell } from '../services/song-coverage.js'
import { writeBriefs, assemblePrompt, type Brief } from '../services/song-brief.js'
import { checkSong } from '../services/song-audio.js'
import * as sp from '../services/song-pool.js'
import { musicFleetBusyRetryPlan, resolveMusicModel, saveMusicTrack } from './music-generate.js'
import { siblingGroupForJob } from '../services/music-library.js'
import type { Job } from '../models/types.js'

export type SongPoolMode = 'new' | 'fill-gaps' | 'regenerate'

export interface SongPoolGenerateParams {
  song_pool: true
  mode: SongPoolMode
  count: number
  writer_model: string
  music_model?: string
  length_min_s?: number
  length_max_s?: number
  /** Songs sent to the fleet at once. The Gateway queues any surplus for the next free Mac. */
  in_flight?: number
  /** Regenerate: the songs to retake (same brief, new seed). */
  song_ids?: string[]
  /** Regenerate one song with edited fields ("Edit Brief & Regenerate"). */
  brief_edits?: Partial<Pick<Brief, 'title' | 'line' | 'scene_idea' | 'ensemble' | 'mood' | 'tempo_bpm' | 'key' | 'texture' | 'structure' | 'length_s'>>
  batch_id: string
}

export interface BatchItem {
  cell: PlannedCell
  brief?: Brief
  take_of?: string
  song_id?: string
  file?: string
  dropped?: string
  error?: string
  /** After a settled failure the next request needs a new identity (derived from the dead job). */
  retry_scope?: string
}

export interface BatchFile {
  batch_id: string
  mode: SongPoolMode
  writer_model: string
  created_at: string
  items: BatchItem[]
}

export function batchPath(dir: string, batchId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(batchId)) throw new Error(`Invalid batch id: ${batchId}`)
  return path.join(dir, 'batches', `${batchId}.json`)
}

/** The formula this project's songs are written from, or a sentence saying what to do. */
export async function songFormulaFor(slug: string): Promise<{ formula: SongFormula; themes: string[]; name: string } | { error: string }> {
  const niche: any = await getEffectiveNiche(slug)
  const mf = niche?.musicFormat
  if (!mf) return { error: 'This project\'s Series Formula is not a music channel. Pick a music formula in Channel Identity first.' }
  const parsed = SongFormulaSchema.safeParse(mf.songFormula)
  if (!parsed.success) return { error: 'This channel has no saved song formula yet. Open Music Formula, check the starting values and Save Formula.' }
  const themes: string[] = Array.isArray(mf.worlds) && mf.worlds.length
    ? mf.worlds.map((w: any) => String(w?.name || '')).filter(Boolean)
    : Object.values(mf.registers || {}).map((r: any) => String(r?.label || '')).filter(Boolean)
  return { formula: parsed.data, themes, name: niche.name || '' }
}

/** A brief rebuilt from a saved song, for Regenerate. Null when the song has no brief (a Finder drop). */
export function briefFromSong(s: sp.SongRecord, seed: number, edits: SongPoolGenerateParams['brief_edits'] = {}, maxPromptChars?: number): Brief | null {
  const f = { ...s, ...edits }
  if (!f.ensemble || !f.mood || !f.tempo_bpm || !f.key || !f.structure || !f.texture || !f.line || !f.title) return null
  const cell: PlannedCell = {
    ensemble: f.ensemble, mood: f.mood, tempo_band: s.tempo_band || '', tempo_bpm: Number(f.tempo_bpm), key: f.key,
    structure: f.structure, texture: f.texture, theme: s.theme || '', length_s: Number(f.length_s || s.length_s || s.duration_s || 240),
    energy: s.energy || 3, combo_key: s.combo_key || '', seed,
  }
  return { ...cell, title: f.title, line: f.line, scene_idea: f.scene_idea || s.scene_idea || '', prompt: assemblePrompt(cell, f.line, maxPromptChars) }
}

export async function generateSongPool(job: Job): Promise<void> {
  const params = job.params as unknown as SongPoolGenerateParams
  const slug = job.project_slug
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add your Gateway API Key in Settings first.')
  const dir = sp.poolDir(slug)
  if (!dir) throw new Error(`Project ${slug} has no folder on disk.`)
  await fs.mkdir(path.join(dir, 'batches'), { recursive: true })
  const bpath = batchPath(dir, params.batch_id)
  const stopped = () => jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)

  // Live catalogue: the model is the one picked in the dialog, never substituted.
  const models = await listMusicModels(apiKey)
  const model = resolveMusicModel(models, params.music_model, { instrumental: true, hasLyrics: false })
  const maxPromptChars = Number.isInteger(model.max_prompt_without_lyrics_characters) ? model.max_prompt_without_lyrics_characters as number
    : Number.isInteger(model.max_prompt_characters) ? model.max_prompt_characters : undefined
  const outputFormat = await resolveOutputFormat(slug, 'music')

  let batch: BatchFile | null = await fs.readFile(bpath, 'utf8').then(JSON.parse, () => null)
  const pool = await sp.readPool(slug)
  const writer = (params.writer_model || '').trim()
  const got = await songFormulaFor(slug)
  if ('error' in got && params.mode !== 'regenerate') throw new Error(got.error)
  const variety = 'error' in got ? { trim_silence: true, flag_gap_s: 5 } : got.formula.variety
  const write = (cells: PlannedCell[], formula: SongFormula) => writeBriefs(cells, {
    titles: pool.songs.map(s => s.title), lines: pool.songs.map(s => s.line || '').filter(Boolean),
    sceneIdeas: pool.songs.map(s => s.scene_idea || '').filter(Boolean), never: formula.never,
    maxTitleWordShare: formula.variety.max_title_word_share, maxSimilarity: formula.variety.max_similarity, maxPromptChars,
  }, (system, user) => callAi(writer, system, user, {}, false, {
    slug, jobId: job.job_id, outputBudget: 'standard', temperature: 0.8, jsonMode: true,
  }), done => job.output_lines.push(`Briefs written for ${done} of ${cells.length}.`))
  const needWriter = () => { if (!writer) throw new Error('Pick the writing model in the Generate dialog. It writes the titles and lines; it does not make the audio.') }

  if (!batch) {
    let items: BatchItem[]
    if (params.mode === 'regenerate') {
      const ids = params.song_ids || []
      items = ids.map((id, i) => {
        const s = pool.songs.find(x => x.id === id)
        const brief = s && briefFromSong(s, hashSeed(`${params.batch_id}:${i}:retake`), ids.length === 1 ? params.brief_edits : undefined, maxPromptChars)
        if (!s || !brief) return { cell: {} as PlannedCell, take_of: id, dropped: s ? `"${s.title}" has no brief to regenerate (it was added from the folder)` : `song ${id} is not in the pool` }
        return { cell: brief, brief, take_of: id }
      })
    } else {
      if ('error' in got) throw new Error(got.error)
      const formula = { ...got.formula, length_s: {
        min: Math.round(params.length_min_s || got.formula.length_s.min),
        max: Math.round(params.length_max_s || got.formula.length_s.max),
      } }
      if (formula.length_s.min > formula.length_s.max) throw new Error('The shortest song must not be longer than the longest.')
      if (params.mode === 'fill-gaps') formula.variety = { ...formula.variety, spread_least_filled: true }
      const existing = pool.songs.filter(s => s.status !== 'rejected')
      const cells = planCells(formula, existing, params.count, params.batch_id, got.themes)
      items = cells.map(cell => ({ cell }))
      needWriter()
      job.output_lines.push(`Planned ${cells.length} song(s) across the combinations the pool has least of. Writing briefs with ${writer}, 20 per call…`)
      const written = await write(cells, formula)
      for (const it of items) {
        const b = written.briefs.find(x => x.combo_key === it.cell.combo_key && x.seed === it.cell.seed)
        if (b) it.brief = b
        else it.dropped = written.dropped.find(d => d.cell === it.cell)?.reason || 'no brief was written'
      }
    }
    batch = { batch_id: params.batch_id, mode: params.mode, writer_model: writer, created_at: new Date().toISOString(), items }
    await writeJsonAtomic(bpath, batch)
  } else if (params.mode !== 'regenerate' && !('error' in got)) {
    // Retry: a brief dropped last time gets one more writing attempt; saved briefs are never rewritten.
    const again = batch.items.filter(i => i.dropped && !i.brief)
    if (again.length) {
      needWriter()
      job.output_lines.push(`Writing ${again.length} brief(s) that were dropped last time…`)
      const written = await write(again.map(i => i.cell), got.formula)
      for (const it of again) {
        const b = written.briefs.find(x => x.combo_key === it.cell.combo_key && x.seed === it.cell.seed)
        if (b) { it.brief = b; delete it.dropped }
        else it.dropped = written.dropped.find(d => d.cell === it.cell)?.reason || it.dropped
      }
      await writeJsonAtomic(bpath, batch)
    }
  }
  const saveBatch = () => withLock(`song-batch:${bpath}`, () => writeJsonAtomic(bpath, batch))

  for (const it of batch.items.filter(i => i.dropped)) job.output_lines.push(`✗ Brief dropped: ${it.dropped}`)
  const todo = batch.items.filter(i => i.brief && !i.song_id)
  const width = Math.max(1, Math.min(256, Math.floor(Number(params.in_flight) || 1)))
  job.item_progress = { total: batch.items.length, completed: batch.items.filter(i => i.song_id).length, failed: 0, concurrency: width, active: [] }
  job.output_lines.push(`Making ${todo.length} song(s) on the fleet with ${model.display_name}. Songs appear in the pool as they finish.`)
  // 1.4.270 — a rolling window sized to the fleet (lib/music-window.ts).
  // Its "at once" number now applies only on a Gateway that cannot report the fleet's capacity.
  const sizer = await musicWindowSizer(apiKey, model.id, line => job.output_lines.push(line), width)
  const priority = sizer.priority
  const windowNow = async (inFlight: number): Promise<number> => {
    const size = Math.min(todo.length, await sizer.size(inFlight))
    job.item_progress!.concurrency = size
    return size
  }

  await runRollingWindow(todo, windowNow, async (it) => {
    const brief = it.brief!
    const started = Date.now()
    const length = musicDurationPlan(model, { requestedSeconds: brief.length_s })
    let attempt = 1
    let retryScope = it.retry_scope || ''
    job.item_progress!.active = [...(job.item_progress!.active || []), { label: brief.title, key: brief.seed.toString(), state: 'running', attempt: 1, max_attempts: 1 }]
    try {
      for (;;) {
        if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
        try {
          const result = await generateMusicWithGenStudio(apiKey, {
            title: brief.title, prompt: brief.prompt, instrumental: true, durationSeconds: length.seconds,
            modelId: model.id, seed: brief.seed, ...(outputFormat ? { outputFormat } : {}), ...(priority ? { priority } : {}),
            requestIdentity: `${slug}:song-pool:${params.batch_id}:${brief.combo_key || brief.title}:${brief.seed}${retryScope ? `:${retryScope}` : ''}`,
            isCancelled: () => jq.isCancelled(job.job_id),
          })
          // Every track the result carries is kept (a lane that returns two takes paid for both).
          const group = result.tracks.length > 1 ? siblingGroupForJob(result.jobId) : undefined
          for (const [take, track] of result.tracks.entries()) {
            const body = await downloadGenStudioMusicTrack(track.url, result.downloadHeaders, { isCancelled: () => jq.isCancelled(job.job_id) }, take + 1)
            // Saved, trimmed and measured in a hidden folder the pool never scans; it moves into the pool
            // folder under the pool lock, in the same step that adds its entry (1.4.270: a pool read in
            // between used to index the half-made file as a second, "folder" song).
            const staging = path.join(dir, '.incoming')
            await fs.mkdir(staging, { recursive: true })
            const { filename, warning } = await saveMusicTrack(staging, brief.title, result.jobId, take + 1, body)
            if (warning) job.output_lines.push(`⚠ ${filename}: ${warning}`)
            const check = await checkSong(path.join(staging, filename), { trim: variety.trim_silence !== false })
            const flagged = check.gap && check.gap.length > Number(variety.flag_gap_s || 5) ? check.gap : null
            const id = sp.newSongId()
            await sp.updatePool(slug, async p => {
              await fs.rename(path.join(staging, filename), path.join(dir, filename))
              p.songs.push({
                id, file: filename, status: 'ready', enabled: true,
                title: take ? `${brief.title} (take ${take + 1})` : brief.title,
                ensemble: brief.ensemble, mood: brief.mood, energy: brief.energy, tempo_bpm: brief.tempo_bpm,
                tempo_band: brief.tempo_band || undefined, key: brief.key, texture: brief.texture, structure: brief.structure,
                length_s: length.seconds, line: brief.line, prompt: brief.prompt, scene_idea: brief.scene_idea,
                theme: brief.theme || undefined, tags: [brief.mood, brief.ensemble].filter(Boolean) as string[],
                combo_key: brief.combo_key || undefined, seed: brief.seed, writer_model: batch!.writer_model || undefined,
                music_model: model.id, batch_id: params.batch_id, gateway_job_id: result.jobId,
                ...(it.take_of ? { take_of: it.take_of } : {}),
                ...(group ? { sibling_group: group, sibling_index: take + 1 } : {}),
                source: 'generated', created_at: new Date().toISOString(),
                duration_s: Math.round(check.duration_s * 100) / 100,
                ...(check.lufs !== null ? { lufs: check.lufs } : {}),
                ...(check.true_peak_db !== null ? { true_peak_db: check.true_peak_db } : {}),
                ...(flagged ? { gap_s: Math.round(flagged.length * 10) / 10, gap_at_s: Math.round(flagged.at) } : {}),
                generation_s: Math.round((Date.now() - started) / 1000),
                rating: null, episodes: [],
              })
              // Adding is idempotent: an entry already indexed for this file folds into this one.
              sp.mergeDuplicateFiles(p)
              // Regenerate keeps the old take, disabled, until the owner removes it.
              if (it.take_of) { const old = p.songs.find(s => s.id === it.take_of); if (old) old.enabled = false }
            })
            if (!take) { it.song_id = id; it.file = filename }
            job.output_lines.push(`✓ ${brief.title}${take ? ` (take ${take + 1})` : ''} — ${Math.round(check.duration_s)} s${check.lufs !== null ? `, ${check.lufs} LUFS` : ''}${flagged ? `, ⚠ ${Math.round(flagged.length)} s of silence at ${Math.floor(flagged.at / 60)}:${String(Math.round(flagged.at % 60)).padStart(2, '0')}` : ''}`)
          }
          delete it.error
          await saveBatch()
          job.item_progress!.completed++
          return
        } catch (error) {
          if (isGenStudioInsufficientCredits(error)) throw error
          if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
          const plan = musicFleetBusyRetryPlan(error, attempt)
          const deadJobId = error instanceof GenStudioMusicTerminalFailureError ? error.jobId : ''
          if (plan && deadJobId && !stopped()) {
            retryScope = siblingGroupForJob(deadJobId)
            job.output_lines.push(isFreeMacPlan(plan) ? freeMacWaitLine(brief.title, error, plan.waitMs)
              : `${brief.title}: ${plan.reason.toLowerCase()} — waiting ${Math.round(plan.waitMs / 1000)} s and asking again (attempt ${attempt + 1} of ${plan.maxAttempts}).`)
            await waitUnlessStopped(plan.waitMs, stopped)
            if (!stopped()) { attempt++; continue }
          }
          it.error = error instanceof Error ? error.message : String(error)
          // A settled job can never be reopened, so Retry asks under a new identity derived from it;
          // a lost connection keeps the old one and reconnects to the job already accepted.
          if (deadJobId) it.retry_scope = siblingGroupForJob(deadJobId)
          await saveBatch()
          job.item_progress!.failed++
          job.output_lines.push(`✗ ${brief.title} failed: ${it.error}. Continuing with the rest.`)
          return
        }
      }
    } finally {
      job.item_progress!.active = (job.item_progress!.active || []).filter(t => t.key !== brief.seed.toString())
      job.progress = Math.round((job.item_progress!.completed / Math.max(1, batch!.items.length)) * 100)
    }
  }, stopped)
  if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
  jq.throwIfPauseRequested(job.job_id)

  const saved = batch.items.filter(i => i.song_id)
  const missing = batch.items.filter(i => !i.song_id).map(i => i.dropped
    ? `brief dropped (${i.dropped})`
    : `${i.brief?.title || 'song'}: ${i.error || 'not made'}`)
  // `saved_tracks` + `requests` are what the music_generate cancel audit reads.
  job.result = { song_pool: true, batch_id: params.batch_id, saved_tracks: saved.map(i => i.file), requests: batch.items.length, song_ids: saved.map(i => i.song_id) }
  requireJobCompletion(job, {
    label: 'Song generation',
    expected: batch.items.length,
    completed: saved.length,
    missing,
    retry_hint: 'Saved songs are kept. Retry makes only the songs not saved yet and never rewrites a saved brief.',
  })
}

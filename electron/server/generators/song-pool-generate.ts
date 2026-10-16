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
import { freshActionFingerprint } from '../lib/fresh-generation-action.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { getEffectiveNiche } from '../services/niche-loader.js'
import {
  GenStudioMusicTerminalFailureError,
  buildGenStudioMusicIdempotencyKey,
  generateMusicWithGenStudio,
  downloadGenStudioMusicTrack,
  isGenStudioInsufficientCredits,
  listMusicModels,
  transcribeWithGenStudio,
  type GenStudioMusicRequest,
} from '../lib/genstudio-client.js'
import { freeMacWaitLine, isFreeMacPlan, waitUnlessStopped } from '../lib/genstudio-fleet-busy.js'
import { musicDurationPlan } from '../contracts/music-model-choice.js'
import { SongFormulaSchema, type SongFormula } from '../contracts/song-formula.js'
import { planCells, hashSeed, type PlannedCell } from '../services/song-coverage.js'
import { BRIEFS_PER_CALL, SUNG_BRIEFS_PER_CALL, writeBriefs, assemblePrompt, assembleSungPrompt, type Brief } from '../services/song-brief.js'
import { checkSong } from '../services/song-audio.js'
import { lyricsMatch, srtText } from '../services/lyrics-match.js'
import * as sp from '../services/song-pool.js'
import { musicFleetBusyRetryPlan, musicTrackFilename, resolveMusicModel, saveMusicTrack } from './music-generate.js'
import { siblingGroupForJob } from '../services/music-library.js'
import type { Job } from '../models/types.js'
import { safetyGate, safetyMode } from '../services/safety-checks.js'

export type SongPoolMode = 'new' | 'fill-gaps' | 'regenerate' | 'manual-redo'

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
  /** Songs with lyrics: the transcription model that listens back (free fleet models only). */
  check_model?: string
  /** Regenerate: the songs to retake (same brief, new seed). */
  song_ids?: string[]
  /** Regenerate one song with edited fields ("Edit Brief & Regenerate"). */
  brief_edits?: Partial<Pick<Brief, 'title' | 'line' | 'scene_idea' | 'ensemble' | 'mood' | 'tempo_bpm' | 'key' | 'texture' | 'structure' | 'length_s'>>
  batch_id: string
  manual_song_pool_item?: {
    version: 1
    source_job_id: string
    source_batch_id: string
    source_item_key: string
    brief: Brief
    request: SongPoolMusicAttempt['request']
  }
}

export interface BatchItem {
  /** Stable within this batch. Added when the exact music request is first checkpointed. */
  item_key?: string
  cell: PlannedCell
  brief?: Brief
  take_of?: string
  song_id?: string
  file?: string
  dropped?: string
  error?: string
  /** After a settled failure the next request needs a new identity (derived from the dead job). */
  retry_scope?: string
  /** Every exact paid music request, saved before POST and retained across retries/takes. */
  music_attempts?: SongPoolMusicAttempt[]
  /** Server-copied exact source request for one explicit music-stage replacement. */
  manual_request?: SongPoolMusicAttempt['request']
}

export interface SongPoolMusicAttempt {
  version: 1
  planned_item_fingerprint: string
  request: {
    title: string
    prompt: string
    lyrics?: string
    instrumental: boolean
    duration_seconds?: number
    model_id: string
    seed?: number
    output_format?: 'm4a'
    priority?: 'background'
    request_identity: string
  }
  idempotency_key: string
  accepted_task_id?: string
  state?: string
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

export async function readSongPoolBatchCheckpoint(dir: string, batchId: string): Promise<BatchFile | null> {
  try {
    const value = JSON.parse(await fs.readFile(batchPath(dir, batchId), 'utf8'))
    if (!value || value.batch_id !== batchId || !Array.isArray(value.items)) return null
    return value as BatchFile
  } catch {
    return null
  }
}

export function validSongPoolMusicAttempt(
  slug: string,
  batch: BatchFile,
  item: BatchItem,
  attempt: SongPoolMusicAttempt,
): boolean {
  const request = attempt?.request
  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const identity = item.item_key && item.brief
    ? new RegExp(`^${escapePattern(slug)}:song-pool:${escapePattern(batch.batch_id)}:${escapePattern(item.item_key)}:${item.brief.seed}(?::[0-9a-f]{16})?(?::take[2-9][0-9]*)?$`)
    : null
  if (!item.item_key || !item.brief || attempt?.version !== 1 || !request
    || attempt.planned_item_fingerprint !== freshActionFingerprint({ item_key: item.item_key, brief: item.brief })
    || request.title !== request.title?.trim() || request.prompt !== request.prompt?.trim()
    || !request.title || !request.prompt || !request.model_id?.trim() || !request.request_identity?.trim()
    || request.title !== item.brief.title.trim()
    || !(request.prompt === item.brief.prompt.trim() || request.prompt.startsWith(`${item.brief.prompt.trim()}, `))
    || (request.lyrics || '') !== (item.brief.lyrics?.trim() || '')
    || !identity?.test(request.request_identity)) return false
  return attempt.idempotency_key === buildGenStudioMusicIdempotencyKey({
    title: request.title, prompt: request.prompt, lyrics: request.lyrics,
    instrumental: request.instrumental, durationSeconds: request.duration_seconds,
    modelId: request.model_id, requestIdentity: request.request_identity,
    outputFormat: request.output_format, seed: request.seed,
  })
}

function unresolvedSavedAttempt(job: Readonly<Job>, slug: string, batch: BatchFile, item: BatchItem): SongPoolMusicAttempt | null {
  const evidence = job.genstudio_jobs || []
  const matches = (item.music_attempts || []).filter(attempt => {
    if (!validSongPoolMusicAttempt(slug, batch, item, attempt)) return false
    const related = evidence.filter(entry => entry.operation === 'music.generation'
      && (entry.request_key === attempt.idempotency_key || entry.request?.idempotency_key === attempt.idempotency_key
        || (!!attempt.accepted_task_id && entry.id === attempt.accepted_task_id)))
    if (related.length !== 1) return false
    const entry = related[0]!
    const keys = [entry.request_key, entry.request?.idempotency_key].filter(Boolean)
    if (!keys.length || new Set(keys).size !== 1 || keys[0] !== attempt.idempotency_key) return false
    if (attempt.accepted_task_id ? entry.id !== attempt.accepted_task_id : entry.id !== `pending:${attempt.idempotency_key}`) return false
    return entry.queue_state !== 'not_created' && entry.queue_state !== 'waiting_credits'
      && entry.state !== 'succeeded' && entry.state !== 'cancelled'
      && !(entry.state === 'failed' && entry.recovery_required !== true)
  })
  return matches.length === 1 ? matches[0]! : null
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
  if (s.lyrics && s.style) {
    return { ...cell, title: f.title, line: f.line, scene_idea: f.scene_idea || s.scene_idea || '', lyrics: s.lyrics, style: s.style, prompt: assembleSungPrompt(cell, s.style, maxPromptChars) }
  }
  return { ...cell, title: f.title, line: f.line, scene_idea: f.scene_idea || s.scene_idea || '', prompt: assemblePrompt(cell, f.line, maxPromptChars) }
}

type Heard = { check: 'passed' | 'failed' | 'unchecked'; match?: number; why?: string }
const pct = (v: number | undefined) => `${Math.round((v ?? 0) * 100)}%`

/**
 * Songs with lyrics: transcribe the sung song with the picked (free) model and score it against its lyrics.
 * Never charges: a quote above zero is refused before it is confirmed. A failed transcription is
 * `unchecked`, never a score of 0 — the caller keeps the song switched off either way.
 */
export async function listenBack(
  apiKey: string, file: string, lyrics: string, modelId: string, minMatch: number, identity: string,
  isCancelled: () => boolean,
): Promise<Heard> {
  try {
    const { srt } = await transcribeWithGenStudio(apiKey, {
      audioPath: file, modelId, requestIdentity: identity, isCancelled,
      beforeConfirm: quote => {
        if (Number(quote.quoted_credit_cost || 0) > 0) {
          throw new Error(`${modelId} would charge ${quote.quoted_credit_cost} credits; the listen-back only uses free fleet models`)
        }
      },
    })
    const match = lyricsMatch(lyrics, srtText(srt))
    if (match === null) return { check: 'unchecked', why: 'the lyrics have no words to compare' }
    return { check: match >= minMatch ? 'passed' : 'failed', match }
  } catch (error) {
    if (isCancelled()) throw new Error('Cancelled by user')
    return { check: 'unchecked', why: error instanceof Error ? error.message : String(error) }
  }
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
  const manualItem = params.manual_song_pool_item
  const got = manualItem ? { error: 'Manual music-stage replacement uses its saved item.' } as const : await songFormulaFor(slug)
  if ('error' in got && params.mode !== 'regenerate' && !manualItem) throw new Error(got.error)
  // Songs with lyrics (owner 2026-10-12): the channel's switch, off unless its formula turns it on.
  const lyricsCfg = 'error' in got ? undefined : got.formula.lyrics
  const sung = manualItem ? manualItem.request.instrumental === false : lyricsCfg?.enabled === true
  // The channel's singer(s): a fixed voice phrase + seed on every song (owner-approved same-singer recipe).
  const singers = sung ? lyricsCfg?.singers || [] : []
  const singerFor = (brief: Brief) => singers.length ? singers[brief.seed % singers.length]! : null
  const model = resolveMusicModel(models, params.music_model, { instrumental: !sung, hasLyrics: sung })
  const sings = model.requires_lyrics === true || model.supports_vocals === true
  if (sung && !sings) throw new Error(`This channel makes songs with lyrics, and ${model.display_name} does not sing. Pick a model that sings (YuE2).`)
  if (!sung && model.requires_lyrics === true) throw new Error(`${model.display_name} only sings from lyrics, and this channel's songs are instrumental. Pick another song model, or turn on Songs with lyrics in Music Formula.`)
  const checkModel = (params.check_model || '').trim()
  if (sung && !manualItem && !checkModel) throw new Error('Pick the listen-back model in the Generate dialog. It checks that each song sings its lyrics.')
  // 1.4.300 "Sung lyrics listen-back" safety check: the retakes above are the channel's own control;
  // this decides only what a song that still fails does. Block: it stays switched off and the item
  // fails (as before). Off/Warn: the last take is kept switched on and counts as made.
  const lyricsSafetyMode = sung ? await safetyMode(slug, 'lyrics_listen_back') : 'off'
  const lyricsBlock = sung && lyricsSafetyMode === 'block'
  const heardOk = (heard: Heard | null) => !heard || heard.check === 'passed' || !lyricsBlock
  const maxPromptChars = !sung && Number.isInteger(model.max_prompt_without_lyrics_characters) ? model.max_prompt_without_lyrics_characters as number
    : Number.isInteger(model.max_prompt_characters) ? model.max_prompt_characters : undefined
  const outputFormat = await resolveOutputFormat(slug, 'music')

  let batch: BatchFile | null = await fs.readFile(bpath, 'utf8').then(JSON.parse, () => null)
  const pool = await sp.readPool(slug)
  const writer = (params.writer_model || '').trim()
  const variety = 'error' in got ? { trim_silence: true, flag_gap_s: 5 } : got.formula.variety
  const write = (cells: PlannedCell[], formula: SongFormula) => writeBriefs(cells, {
    titles: pool.songs.map(s => s.title), lines: pool.songs.map(s => s.line || '').filter(Boolean),
    sceneIdeas: pool.songs.map(s => s.scene_idea || '').filter(Boolean), never: formula.never,
    maxTitleWordShare: formula.variety.max_title_word_share, maxSimilarity: formula.variety.max_similarity, maxPromptChars,
    ...(sung ? { lyrics: { language: lyricsCfg!.language, fixedSinger: singers.length > 0 } } : {}),
  }, (system, user, minimumOutputTokens) => callAi(writer, system, user, {}, false, {
    slug, jobId: job.job_id,
    outputBudget: sung ? { tier: 'workload', minimumTokens: minimumOutputTokens } : 'standard',
    temperature: 0.8, jsonMode: true,
  }), done => job.output_lines.push(`Briefs written for ${done} of ${cells.length}.`))
  const needWriter = () => { if (!writer) throw new Error('Pick the writing model in the Generate dialog. It writes the titles and lines; it does not make the audio.') }

  if (!batch) {
    let items: BatchItem[]
    if (manualItem) {
      items = [{ item_key: 'song-0', cell: manualItem.brief, brief: manualItem.brief, manual_request: manualItem.request }]
    } else if (params.mode === 'regenerate') {
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
      job.output_lines.push(`Planned ${cells.length} song(s) across the combinations the pool has least of. Writing briefs with ${writer}, ${sung ? SUNG_BRIEFS_PER_CALL : BRIEFS_PER_CALL} per call…`)
      const written = await write(cells, formula)
      for (const it of items) {
        const b = written.briefs.find(x => x.combo_key === it.cell.combo_key && x.seed === it.cell.seed)
        if (b) it.brief = b
        else it.dropped = written.dropped.find(d => d.cell === it.cell)?.reason || 'no brief was written'
      }
    }
    items.forEach((item, index) => { item.item_key ||= `song-${index}` })
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
  let addedItemKeys = false
  batch.items.forEach((item, index) => {
    if (!item.item_key) { item.item_key = `song-${index}`; addedItemKeys = true }
  })
  if (addedItemKeys) await saveBatch()

  for (const it of batch.items.filter(i => i.dropped)) job.output_lines.push(`✗ Brief dropped: ${it.dropped}`)
  const todo = batch.items.filter(i => i.brief && !i.song_id)
  const width = Math.max(1, Math.min(256, Math.floor(Number(params.in_flight) || 1)))
  job.item_progress = { total: batch.items.length, completed: batch.items.filter(i => i.song_id).length, failed: 0, concurrency: width, active: [] }
  job.output_lines.push(`Making ${todo.length} song(s) on the fleet with ${model.display_name}. Songs appear in the pool as they finish.`)
  // 1.4.270 — a rolling window sized to the fleet (lib/music-window.ts).
  // Its "at once" number now applies only on a Gateway that cannot report the fleet's capacity.
  const sizer = await musicWindowSizer(apiKey, model.id, line => job.output_lines.push(line), width, { normal: sung })
  const priority = sizer.priority
  const windowNow = async (inFlight: number): Promise<number> => {
    const size = Math.min(todo.length, await sizer.size(inFlight))
    job.item_progress!.concurrency = size
    return size
  }

  await runRollingWindow(todo, windowNow, async (it) => {
    const brief = it.brief!
    let savedUnknown = unresolvedSavedAttempt(job, slug, batch!, it)
    if (savedUnknown && savedUnknown.request.model_id !== model.id) {
      throw new Error('The unresolved saved music request belongs to another model. Nothing was submitted.')
    }
    const started = Date.now()
    // Provisional delivery allowance: YuE2 stops with the words; musicDurationPlan clamps to live model limits.
    const length = musicDurationPlan(model, sung
      ? { lyrics: brief.lyrics, requestedSeconds: Math.round(brief.length_s * 1.25) }
      : { requestedSeconds: brief.length_s })
    let attempt = 1
    let retryScope = it.retry_scope || ''
    // Songs with lyrics: a take the listen-back fails goes to Trash and the song is sung again.
    let sing = 1
    const maxTakes = lyricsCfg?.max_takes ?? 1
    const singer = singerFor(brief)
    job.item_progress!.active = [...(job.item_progress!.active || []), { label: brief.title, key: brief.seed.toString(), state: 'running', attempt: 1, max_attempts: 1 }]
    try {
      for (;;) {
        if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
        try {
          if (sung && !brief.lyrics) throw new Error('this song has no lyrics (it was made before Songs with lyrics was on), so it cannot be sung; Generate makes new sung songs')
          const requestIdentity = savedUnknown?.request.request_identity
            || `${slug}:song-pool:${params.batch_id}:${it.item_key || brief.combo_key || brief.title}:${brief.seed}${retryScope ? `:${retryScope}` : ''}${sing > 1 ? `:take${sing}` : ''}`
          const requestSeed = it.manual_request?.seed ?? (sing > 1 ? hashSeed(`${brief.seed}:take${sing}`) : (singer ? singer.seed : brief.seed))
          const exact = savedUnknown?.request || it.manual_request
          const request: GenStudioMusicRequest = exact ? {
            title: exact.title, prompt: exact.prompt, instrumental: exact.instrumental,
            ...(exact.lyrics !== undefined ? { lyrics: exact.lyrics } : {}),
            ...(exact.duration_seconds !== undefined ? { durationSeconds: exact.duration_seconds } : {}),
            modelId: model.id,
            ...(exact.seed !== undefined ? { seed: exact.seed } : {}),
            ...(exact.output_format !== undefined ? { outputFormat: exact.output_format } : {}),
            ...(exact.priority !== undefined ? { priority: exact.priority } : {}),
            requestIdentity,
            isCancelled: () => jq.isCancelled(job.job_id),
          } : {
            title: brief.title,
            prompt: singer ? `${brief.prompt}, ${singer.voice}` : brief.prompt,
            instrumental: !sung,
            ...(sung && brief.lyrics ? { lyrics: brief.lyrics } : {}),
            durationSeconds: length.seconds,
            modelId: model.id, seed: requestSeed,
            ...(outputFormat ? { outputFormat } : {}),
            ...(priority ? { priority } : {}),
            requestIdentity,
            isCancelled: () => jq.isCancelled(job.job_id),
          }
          const idempotencyKey = buildGenStudioMusicIdempotencyKey(request)
          if (savedUnknown && idempotencyKey !== savedUnknown.idempotency_key) {
            throw new Error('The unresolved saved music request no longer matches its exact provider key. Nothing was submitted.')
          }
          const attempts = it.music_attempts ||= []
          let receipt = attempts.find(candidate => candidate.idempotency_key === idempotencyKey)
          if (!receipt) {
            receipt = {
              version: 1,
              planned_item_fingerprint: freshActionFingerprint({ item_key: it.item_key, brief }),
              request: {
                title: request.title.trim(), prompt: request.prompt.trim(),
                ...(request.lyrics?.trim() ? { lyrics: request.lyrics.trim() } : {}),
                instrumental: request.instrumental, duration_seconds: request.durationSeconds,
                model_id: request.modelId.trim(), seed: request.seed, output_format: request.outputFormat,
                priority: request.priority, request_identity: requestIdentity,
              },
              idempotency_key: idempotencyKey,
            }
            attempts.push(receipt)
            await saveBatch()
          }
          const activeReceipt = receipt
          const result = await generateMusicWithGenStudio(apiKey, {
            ...request,
            idempotencyKey,
            onJobAccepted: async (taskId, key) => {
              if (key !== activeReceipt.idempotency_key) throw new Error('The accepted music task did not match its saved Song Pool request.')
              activeReceipt.accepted_task_id = taskId
              activeReceipt.state = 'accepted'
              await saveBatch()
            },
            onState: async (state, taskId) => {
              if (activeReceipt.accepted_task_id && activeReceipt.accepted_task_id !== taskId) {
                throw new Error('The music task state did not match its saved Song Pool request.')
              }
              activeReceipt.accepted_task_id ||= taskId
              activeReceipt.state = state
              await saveBatch()
            },
          })
          // The provider returned an authoritative result. A later retry or sung take is fresh work
          // under the existing derived identity rules, never another replay of this resolved request.
          savedUnknown = null
          let retake = false
          let heard: Heard | null = sung && manualItem
            ? { check: 'unchecked', why: 'this music-only replacement does not run listen-back' }
            : null
          // Every track the result carries is kept (a lane that returns two takes paid for both).
          const group = result.tracks.length > 1 ? siblingGroupForJob(result.jobId) : undefined
          for (const [take, track] of result.tracks.entries()) {
            const body = await downloadGenStudioMusicTrack(track.url, result.downloadHeaders, { isCancelled: () => jq.isCancelled(job.job_id) }, take + 1)
            // Saved, trimmed and measured in a hidden folder the pool never scans; it moves into the pool
            // folder under the pool lock, in the same step that adds its entry (1.4.270: a pool read in
            // between used to index the half-made file as a second, "folder" song).
            const staging = path.join(dir, '.incoming')
            await fs.mkdir(staging, { recursive: true })
            // A quit after an earlier save + trim leaves this exact scratch name behind with trimmed
            // bytes, which the no-replace writer would refuse for ever. It is never promoted: it goes
            // to Trash and the fresh download is saved (review 2026-10-16).
            const scratch = path.join(staging, musicTrackFilename(brief.title, result.jobId, take + 1))
            if (await fs.stat(scratch).catch(() => null)) sp.trashPoolFile(slug, scratch)
            const { filename, warning } = await saveMusicTrack(staging, brief.title, result.jobId, take + 1, body)
            if (warning) job.output_lines.push(`⚠ ${filename}: ${warning}`)
            const check = await checkSong(path.join(staging, filename), { trim: variety.trim_silence !== false })
            const flagged = check.gap && check.gap.length > Number(variety.flag_gap_s || 5) ? check.gap : null
            if (sung && !manualItem) {
              heard = await listenBack(apiKey, path.join(staging, filename), brief.lyrics!, checkModel, lyricsCfg!.min_match,
                `${slug}:song-check:${params.batch_id}:${brief.seed}:${sing}:${take}`, () => jq.isCancelled(job.job_id))
              if (heard.check === 'failed' && sing < maxTakes) {
                sp.trashPoolFile(slug, path.join(staging, filename))
                job.output_lines.push(`↻ ${brief.title}: ${pct(heard.match)} of its words were heard (needs ${pct(lyricsCfg!.min_match)}); take ${sing} moved to Trash, singing it again (take ${sing + 1} of ${maxTakes})${singer ? ` — a retake has a new seed, so ${singer.name} may sound a little different` : ''}.`)
                retake = true
                break
              }
            }
            const id = sp.newSongId()
            await sp.updatePool(slug, async p => {
              await fs.rename(path.join(staging, filename), path.join(dir, filename))
              p.songs.push({
                id, file: filename, status: 'ready', enabled: heardOk(heard),
                title: take ? `${brief.title} (take ${take + 1})` : brief.title,
                ensemble: brief.ensemble, mood: brief.mood, energy: brief.energy, tempo_bpm: brief.tempo_bpm,
                tempo_band: brief.tempo_band || undefined, key: brief.key, texture: brief.texture, structure: brief.structure,
                length_s: activeReceipt.request.duration_seconds ?? length.seconds,
                line: brief.line, prompt: activeReceipt.request.prompt, scene_idea: brief.scene_idea,
                theme: brief.theme || undefined, tags: [brief.mood, brief.ensemble].filter(Boolean) as string[],
                combo_key: brief.combo_key || undefined, seed: activeReceipt.request.seed ?? brief.seed,
                writer_model: batch!.writer_model || undefined,
                music_model: model.id, batch_id: params.batch_id, gateway_job_id: result.jobId,
                ...(it.take_of ? { take_of: it.take_of } : {}),
                ...(group ? { sibling_group: group, sibling_index: take + 1 } : {}),
                source: 'generated', created_at: new Date().toISOString(),
                duration_s: Math.round(check.duration_s * 100) / 100,
                ...(check.lufs !== null ? { lufs: check.lufs } : {}),
                ...(check.true_peak_db !== null ? { true_peak_db: check.true_peak_db } : {}),
                ...(flagged ? { gap_s: Math.round(flagged.length * 10) / 10, gap_at_s: Math.round(flagged.at) } : {}),
                generation_s: Math.round((Date.now() - started) / 1000),
                ...(heard ? {
                  lyrics: activeReceipt.request.lyrics, style: brief.style, lyrics_check: heard.check, ...(singer ? { singer: singer.name } : {}),
                  ...(heard.match !== undefined ? { lyrics_match: heard.match } : {}),
                } : {}),
                rating: null, episodes: [],
              })
              // Adding is idempotent: an entry already indexed for this file folds into this one.
              sp.mergeDuplicateFiles(p)
              // Regenerate keeps the old take, disabled, until the owner removes it.
              if (it.take_of) { const old = p.songs.find(s => s.id === it.take_of); if (old) old.enabled = false }
            })
            if (!take && heardOk(heard)) { it.song_id = id; it.file = filename }
            job.output_lines.push(`${heard && heard.check !== 'passed' ? '⚠' : '✓'} ${brief.title}${take ? ` (take ${take + 1})` : ''} — ${Math.round(check.duration_s)} s${check.lufs !== null ? `, ${check.lufs} LUFS` : ''}${flagged ? `, ⚠ ${Math.round(flagged.length)} s of silence at ${Math.floor(flagged.at / 60)}:${String(Math.round(flagged.at % 60)).padStart(2, '0')}` : ''}${heard ? `, ${heard.check === 'unchecked' ? 'words not checked' : `${pct(heard.match)} of the words heard`}` : ''}`)
          }
          if (retake) { sing++; continue }
          if (heard && heard.check !== 'passed' && !lyricsBlock) {
            await safetyGate(slug, 'lyrics_listen_back', job, heard.check === 'unchecked'
              ? `${brief.title}: the listen-back could not run (${heard.why}); the song is kept in the pool switched on.`
              : `${brief.title}: only ${pct(heard.match)} of its words were heard after ${sing} take${sing === 1 ? '' : 's'} `
                + `(needs ${pct(lyricsCfg!.min_match)}); the last take is kept in the pool switched on.`)
          } else if (heard && heard.check !== 'passed') {
            // Kept in the pool switched off, so it is never drawn unheard; Retry sings it again under a new identity.
            it.error = heard.check === 'unchecked'
              ? `the listen-back could not run (${heard.why}); the song is in the pool switched off — listen and switch it on, or Retry`
              : `only ${pct(heard.match)} of its words were heard after ${sing} take${sing === 1 ? '' : 's'} (needs ${pct(lyricsCfg!.min_match)}); the last take is in the pool switched off`
            it.retry_scope = siblingGroupForJob(result.jobId)
            await saveBatch()
            job.item_progress!.failed++
            job.output_lines.push(`✗ ${brief.title}: ${it.error}.`)
            return
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
          if (deadJobId) savedUnknown = null
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
  job.result = { ...(job.result?.safety_warnings ? { safety_warnings: job.result.safety_warnings } : {}), song_pool: true, batch_id: params.batch_id, saved_tracks: saved.map(i => i.file), requests: batch.items.length, song_ids: saved.map(i => i.song_id) }
  requireJobCompletion(job, {
    label: 'Song generation',
    expected: batch.items.length,
    completed: saved.length,
    missing,
    retry_hint: 'Saved songs are kept. Retry makes only the songs not saved yet and never rewrites a saved brief.',
  })
}

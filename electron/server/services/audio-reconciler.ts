/**
 * Audio reconciler — detect and recover missing TTS chunks.
 *
 * Recovery is intentionally GenStudio-only. Historical direct-provider
 * sidecars remain readable evidence but cannot trigger provider requests.
 *
 * Strategy:
 *   1. Replicate the generator's chunk-filename logic to compute what files
 *      SHOULD exist for a given episode (same parser, same shared request
 *      planner, same per-model published boundary).
 *   2. Compare to what's on disk.
 *   3. Reclaim only accepted GenStudio jobs with their durable job id.
 *
 * This is a recovery tool, not a generator — it never creates new TTS tasks.
 */

import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { normalizeForTts } from '../lib/tts-text.js'
import { findNarrationFile, episodeDirForNarration, resolveAudioDir, isTerminalGenStudioTaskFailure } from '../generators/audio.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'
import type { ProjectFactsCache } from './utils.js'
import { readManifest, recordTask } from './task-manifest.js'
import { readAudioTtsModelRecord } from './audio-tts-model-record.js'
import { readAudioQualityProvenance } from './audio-quality-store.js'
import { listChapterTakes } from './audio-versions.js'
import { rejectedTakeFileSet } from './audio-take-rejection.js'
import { hashSubtitleAudioSources } from './subtitle-completion.js'
import {
  recoverTtsToFile as recoverGenStudioTtsToFile,
  GenStudioArtifactUnavailableError,
  isClosedHoldCode,
  splitGenStudioApiRequests,
  listTtsModels as listGenStudioTtsModels,
} from '../lib/genstudio-client.js'
import { findFileCaseInsensitive } from './fs-case-insensitive.js'
import { getApiKey } from './app-secrets-store.js'
import { resolveTtsRequestBudget } from './tts-request-plan.js'

export interface ExpectedChunk {
  filename: string        // e.g. TN0001_Chapter_03_part2.mp3
  fullPath: string        // absolute path where it should live
  text: string            // exact input sent to TTS (used for history match)
  sectionLabel: string
  sectionWordCount: number
  sectionCharacterCount: number
  chunkIndex: number      // 0-based index within the section
  totalChunks: number     // how many chunks this section splits into
}

export interface AudioStatus {
  audio_dir: string
  expected: ExpectedChunk[]
  present: string[]       // filenames on disk with size > 0
  missing: string[]       // filenames absent OR zero-byte
  /** 'genstudio' when an audio job identified the model this episode was (or
   *  will be) generated with, '' when none could be found. Informational only:
   *  GenStudio is the sole route, and recovery reads the manifest entry's own
   *  provider rather than this field. */
  provider: string
  /** Split chapters with every part on disk but never activated or joined (see `chaptersAwaitingJoin`). */
  awaiting_join: string[]
}

export interface ReconcileOutcome {
  filename: string
  status: 'recovered' | 'skipped' | 'failed'
  task_id?: string
  reason?: string
}

export interface ReconcileResult {
  total_expected: number
  present_before: number
  recovered: number
  still_missing: number
  outcomes: ReconcileOutcome[]
  logs: string[]
  /** The audio job Repair queued to activate and join chapters whose parts are all on disk. */
  join_job_id?: string
  /** Free fleet parts whose saved request is dead (1.4.269): one fresh run asks for them again. */
  fresh_job_id?: string
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Counts the normalized text that will actually be submitted to TTS. */
export function narrationTextStats(text: string): { wordCount: number; characterCount: number } {
  const normalized = text.trim()
  return {
    wordCount: normalized ? normalized.split(/\s+/u).length : 0,
    characterCount: normalized.length,
  }
}

/**
 * The request boundary a named model publishes right now, or `undefined` when
 * the catalogue cannot answer. Never a substitute number: an unresolved
 * boundary means the section is expected as ONE request, which is the honest
 * answer when Story Studio does not know how long the model accepts.
 */
async function publishedRequestBudgetFor(modelId: string): Promise<number | undefined> {
  try {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) return undefined
    const ttsModel = (await listGenStudioTtsModels(apiKey).catch(() => []))
      .find(candidate => candidate.id === modelId)
    return ttsModel ? resolveTtsRequestBudget(ttsModel).effective : undefined
  } catch {
    return undefined
  }
}

type NarrationSections = Awaited<ReturnType<typeof parseNarrationDocx>>

function selectedFiles(row: { source_file?: unknown; source_files?: unknown }): string[] | null {
  const raw = Array.isArray(row.source_files) && row.source_files.length
    ? row.source_files
    : row.source_file !== undefined ? [row.source_file] : []
  if (!raw.length || !raw.every(file => (
    typeof file === 'string' && !!file.trim() && path.basename(file) === file
  ))) return null
  const files = raw.map(file => (file as string).trim())
  return new Set(files).size === files.length ? files : null
}

function sourceCountMatchesPlan(files: string[], sectionText: string, requestBudget: number | undefined): boolean {
  if (files.length === 1) return true
  const chunks = requestBudget ? splitGenStudioApiRequests(sectionText, requestBudget) : [sectionText]
  return files.length === chunks.length
}

/**
 * Resolve exact active filenames without letting an old unsuffixed import mask
 * a newly activated multipart generation. Audio Assembly's explicit selector
 * wins. Before Assembly exists, generation provenance is accepted only as a
 * complete, model-bound active-source map; it verifies available audio bytes,
 * not current-script freshness.
 */
async function activeAudioSources(
  episodeDir: string,
  audioDir: string,
  sections: NarrationSections,
  model: string,
  requestBudget: number | undefined,
  strictIo: boolean,
): Promise<Map<string, string[]> | null> {
  const selectorPath = path.join(episodeDir, 'audio_chapters.json')
  let selector: { sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }> } | null = null
  try {
    selector = JSON.parse(await fs.readFile(selectorPath, 'utf8'))
  } catch (error) {
    if (!isMissing(error) && strictIo) {
      throw new Error(`The active audio selection cannot be read: ${(error as Error)?.message || String(error)}`)
    }
  }

  if (selector) {
    const rows = Array.isArray(selector.sections) ? selector.sections : []
    const mapped = new Map<string, string[]>()
    let valid = rows.length > 0
    for (const row of rows) {
      const slug = typeof row.slug === 'string' ? row.slug.trim() : ''
      const files = selectedFiles(row)
      const key = slug.toLowerCase()
      if (!slug || !files || mapped.has(key)) { valid = false; break }
      mapped.set(key, files)
    }
    for (const section of sections) {
      const files = mapped.get(section.slug.toLowerCase())
      const sectionText = normalizeForTts(section.text).text
      if (!files || !sourceCountMatchesPlan(files, sectionText, requestBudget)) { valid = false; break }
    }
    if (valid) return mapped
    if (strictIo) throw new Error('The active audio selection is malformed or incomplete; re-run Audio Assembly.')
  }

  if (!model) return null
  const provenance = await readAudioQualityProvenance(episodeDir)
  const chapters = new Map(Object.entries(provenance.chapters)
    .map(([slug, chapter]) => [slug.toLowerCase(), chapter] as const))
  const mapped = new Map<string, string[]>()
  for (const section of sections) {
    const chapter = chapters.get(section.slug.toLowerCase())
    const sectionText = normalizeForTts(section.text).text
    if (!chapter
      || chapter.tts?.model_id !== model
      || !sourceCountMatchesPlan(chapter.source_files, sectionText, requestBudget)) return null
    const sourcePaths = chapter.source_files.map(file => path.join(audioDir, file))
    let missing = false
    for (const sourcePath of sourcePaths) {
      try {
        const stat = await fs.stat(sourcePath)
        if (!stat.isFile() || stat.size <= 0) missing = true
      } catch (error) {
        if (isMissing(error)) missing = true
        else if (strictIo) throw error
        else return null
      }
    }
    // A committed map remains authoritative when one of its exact files goes
    // missing: return the names so the status reports that loss rather than
    // falling back to a stale base file. Present bytes must still match the
    // activation hash, and strict callers surface unreadable bytes.
    if (!missing) {
      const hash = await hashSubtitleAudioSources(sourcePaths)
      if (!hash && strictIo) throw new Error(`Active audio for ${section.slug} cannot be read for verification.`)
      if (!hash || hash !== chapter.source_audio_hash) return null
    }
    mapped.set(section.slug.toLowerCase(), [...chapter.source_files])
  }
  return mapped.size === sections.length ? mapped : null
}

/**
 * The model this episode's RETAINED take was made with, read from the task
 * manifest instead of predicted.
 *
 * `audio_tts_model.json` is the episode's own record, but an episode generated
 * before it existed — or one whose record was lost — still has its successful
 * TTS tasks in `.task-manifest.json`, keyed by the exact part files on disk.
 * That is a fact about THIS episode's bytes, and it is the only retained answer
 * when the record and the job history are both gone. Without it the planner has
 * no boundary, expects one whole file per section, and the retained `_partN`
 * files never match: PR0001 (2026-10-15) read "0/5 present" while all 11 parts
 * sat on disk, and every caller of `getAudioStatus` — the Audio integrity card,
 * Pipeline, subtitles, asset status, readiness — inherited that false zero.
 *
 * Unambiguous evidence only: every section's active take is multipart, every one
 * of its parts is present and carries a succeeded GenStudio `tts` task, they all
 * name the SAME model, and that model's live published boundary plans exactly
 * the files on disk. Anything else keeps the honest unknown-model answer rather
 * than a confident wrong one.
 */
async function retainedModelForActiveTakes(
  episodeDir: string,
  audioDir: string,
  code: string,
  sections: NarrationSections,
): Promise<{ model: string; requestBudget: number } | undefined> {
  const tasks = (await readManifest(audioDir)).tasks
  const takes: string[][] = []
  let model = ''
  for (const section of sections) {
    const take = (await listChapterTakes(episodeDir, audioDir, code, section.slug)).find(candidate => candidate.active)
    // Only a multipart take proves a boundary: one whole file per section is what
    // every published model does with a chapter-length section.
    if (!take || take.files.length < 2) return undefined
    for (const file of take.files) {
      const task = tasks[file]
      if (!task || task.provider !== 'genstudio' || task.operation !== 'tts' || task.last_state !== 'succeeded') return undefined
      const id = String(task.model_id || '').trim()
      if (!id || (model && model !== id)) return undefined
      model = id
    }
    takes.push(take.files)
  }
  const requestBudget = await publishedRequestBudgetFor(model)
  if (!requestBudget) return undefined
  // The live boundary must reproduce the split the retained bytes were made at;
  // a catalogue that has since moved the number must not re-interpret them.
  for (const [index, section] of sections.entries()) {
    if (splitGenStudioApiRequests(normalizeForTts(section.text).text, requestBudget).length !== takes[index]!.length) return undefined
  }
  return { model, requestBudget }
}

/**
 * Compute the full list of audio chunks that SHOULD exist for an episode,
 * plus what's currently on disk.
 *
 * Mirrors the chunking + naming logic in generators/audio.ts exactly:
 *   - Single chunk per section → `{code}_{slug}.mp3`
 *   - Multiple chunks          → `{code}_{slug}_part{N}.mp3`
 */
export async function getAudioStatus(
  slug: string,
  episodeId: string,
  /**
   * The model the caller is about to generate WITH, when it knows one.
   *
   * The Audio Generator does: the customer has picked a voice model in the
   * form, and the split it is shown must follow that choice. Without it this
   * falls back to the model the episode (or the project) last generated with,
   * which answers a different question — "how was it made" rather than "how
   * will it be made" — and predicts against the wrong ceiling the moment the
   * customer switches to a model with a different published boundary.
   */
  selectedModelId?: string,
  /**
   * v1.4.76 — the caller's request-scoped project facts, passed straight
   * through to `findNarrationFile` so a list response resolves the episodes
   * tree once instead of once per episode. Omitted, every lookup happens
   * exactly as before.
  */
  cache?: ProjectFactsCache,
  /** Preserve unexpected artifact lookup/stat failures for measurement callers. */
  options: { strictIo?: boolean } = {},
): Promise<AudioStatus> {
  const narrationPath = await findNarrationFile(slug, episodeId, cache, options)
  const audioDir = await resolveAudioDir(slug, narrationPath, episodeId, cache, options)
  const sections = await parseNarrationDocx(narrationPath)
  const code = episodeId.toUpperCase()

  // Resolve the SAME request boundary the generator submitted at, so the
  // filenames predicted here are the filenames generation writes.
  //
  // GenStudio is the only TTS route now — `resolveAudioProvider` returns
  // 'genstudio' unconditionally — so there is exactly one boundary to
  // reproduce: the SELECTED model's published `maximum_input_characters`,
  // less Story Studio's head-room. `resolveTtsRequestBudget` is the one place
  // that decides it, and generation, quoting and this status view now all read
  // it from there, so the three cannot drift.
  //
  // This used to classify the model by id prefix and only take the GenStudio
  // path when the classification said 'genstudio'. That classification could
  // no longer succeed: its inputs came from `config.audio_models`, which
  // `genStudioOnlyAudioModels()` now always returns empty, so every model fell
  // through to a prefix test that a published handle like `fish-audio-s2-1-pro`
  // does not match. Status therefore planned at `chunkText`'s 4,800-character
  // default — an ElevenLabs-era figure belonging to a retired direct route —
  // and predicted a `_part1`/`_part2` split for any section over 4,800
  // characters that generation submits whole. Model-specific chunking is the
  // fleet's business, not Story Studio's; the only length this client may hold
  // is the one the selected model publishes.
  //
  // Dynamic imports avoid an import cycle (this module is a static dep of the
  // job-queue's executor graph).
  let requestBudget: number | undefined
  let provider = ''
  // The caller's current selection wins outright, and is resolved WITHOUT
  // reading job history — a caller that knows the model must not lose it
  // because the job store happened to be unreadable.
  let model: string = selectedModelId?.trim() || ''
  if (model) {
    provider = 'genstudio'
    requestBudget = await publishedRequestBudgetFor(model)
  }
  // Owner decision #8, 2026-09-20 — THIS episode's own record of the voice
  // model its active audio was generated with. It outranks the job-history
  // borrow below because it is a fact about this episode rather than an
  // inference from another run: after a model change the borrow predicts the
  // wrong `_partN` filenames and reports parts that were never meant to exist
  // (AGENTS.md §4). The stored boundary is used as recorded, because the files
  // on disk were split at exactly that number — a catalogue change since then
  // must not re-interpret them. A record that names a model but carries no
  // usable budget is re-resolved against the live catalogue, never guessed.
  if (!model) {
    const record = await readAudioTtsModelRecord(episodeDirForNarration(narrationPath))
    if (record) {
      model = record.model_id
      provider = 'genstudio'
      requestBudget = record.request_budget > 0
        ? record.request_budget
        : await publishedRequestBudgetFor(record.model_id)
    }
  }
  // RETAINED TAKE — the record above is the episode's own, but an episode
  // generated before it existed (or one whose record was lost) still has its
  // successful TTS tasks in `.task-manifest.json`, keyed by the exact part files
  // on disk. That is a fact about THIS episode's bytes, so it outranks the
  // job-history borrow below for the same reason the record does.
  if (!model) {
    const retained = await retainedModelForActiveTakes(
      episodeDirForNarration(narrationPath), audioDir, code, sections,
    )
    if (retained) {
      model = retained.model
      provider = 'genstudio'
      requestBudget = retained.requestBudget
    }
  }
  // LEGACY FALLBACK — episodes generated before that record existed. Terminal
  // job history is pruned, so an episode whose job has aged out borrows the
  // project's model — but ONLY when this episode's own job is absent AND the
  // retained history agrees on one model. Ownership is a fact, not a guess
  // (AGENTS.md §4): `audioJobs[0]` used to hand the newest job of ANY episode
  // to this one, so a project whose episodes were voiced with different models
  // predicted `_partN` files for a section another model renders whole. The
  // single-model borrow is the "same model in practice" this path always
  // assumed; conflicting history has no honest answer, so the section is
  // expected whole (exactly as when there is no history at all).
  if (!model) {
    try {
      const { getJobs } = await import('./job-queue.js')
      const audioJobs = (await getJobs(slug, { type: 'audio' }))
        .sort((a, b) => String(b.finished_at || b.created_at || '').localeCompare(String(a.finished_at || a.created_at || '')))
      const ownJob = audioJobs.find(j => (j.episode_id || '').toUpperCase() === code)
      let remembered = ownJob?.params?.model
      if (typeof remembered !== 'string' || !remembered.trim()) {
        const models = new Set(
          audioJobs.map(j => String(j.params?.model || '').trim()).filter(Boolean),
        )
        remembered = models.size === 1 ? [...models][0] : undefined
      }
      if (typeof remembered === 'string') model = remembered.trim()
    } catch { /* no history — handled below */ }
    if (model) {
      provider = 'genstudio'
      requestBudget = await publishedRequestBudgetFor(model)
    }
  }

  // A request-scoped selected model asks what this run must produce, so it
  // deliberately bypasses the currently active map. All other callers ask
  // what is active now and receive exact selector/provenance filenames.
  const activeSources = selectedModelId?.trim()
    ? null
    : await activeAudioSources(
      episodeDirForNarration(narrationPath),
      audioDir,
      sections,
      model,
      requestBudget,
      options.strictIo === true,
    )

  const expected: ExpectedChunk[] = []
  for (const section of sections) {
    const base = `${code}_${section.slug}.mp3`
    // Mirror the generator's pre-TTS normalization (v1.0.215+) BEFORE chunking
    // so chunk boundaries — and thus the predicted filenames + per-chunk text
    // used for recovery matching — match what the generator actually produced.
    const sectionText = normalizeForTts(section.text).text
    const sectionStats = narrationTextStats(sectionText)
    // No boundary resolved means this project has never run an audio job (750
    // terminal jobs are retained, so history does not quietly age out under a
    // working project), or the catalogue was momentarily unreachable. Either
    // way Story Studio does not know this model's published request length and
    // must not substitute a number of its own — the previous 4,800 default is
    // exactly the mistake this avoids. Expect the section as one request: it is
    // what every published GenStudio TTS model does with a chapter-length
    // section, and a project with no audio job has no part files to miss.
    const chunks = requestBudget
      ? splitGenStudioApiRequests(sectionText, requestBudget)
      : [sectionText]

    const selected = activeSources?.get(section.slug.toLowerCase())
    if (selected) {
      const texts = selected.length === 1 ? [sectionText] : chunks
      for (const [index, filename] of selected.entries()) {
        expected.push({
          filename,
          fullPath: path.join(audioDir, filename),
          text: texts[index]!,
          sectionLabel: section.label,
          sectionWordCount: sectionStats.wordCount,
          sectionCharacterCount: sectionStats.characterCount,
          chunkIndex: index,
          totalChunks: selected.length,
        })
      }
      continue
    }

    // v1.0.310 — imported / hand-placed whole-chapter override. If the
    // generator WOULD split this section into _part1/_part2… but a single
    // `{code}_{slug}.mp3` is already on disk, treat that one file as the whole
    // section so the status reads "complete" (e.g. a chapter rendered
    // externally on ElevenLabs and imported). A NORMALLY-generated multi-part
    // section has no bare base file — only the _partN files — so this only ever
    // fires for a single imported file, never masking a real partial gen.
    // Single-chunk generated sections already use `base`, so they're unchanged.
    if (chunks.length > 1) {
      let basePresent = false
      try {
        const actual = await findFileCaseInsensitive(audioDir, base, options)
        if (actual) basePresent = (await fs.stat(actual)).size > 0
      } catch (error) {
        if (options.strictIo && !isMissing(error)) throw error
      }
      if (basePresent) {
        expected.push({
          filename: base,
          fullPath: path.join(audioDir, base),
          text: sectionText,
          sectionLabel: section.label,
          sectionWordCount: sectionStats.wordCount,
          sectionCharacterCount: sectionStats.characterCount,
          chunkIndex: 0,
          totalChunks: 1,
        })
        continue
      }
    }

    for (let i = 0; i < chunks.length; i++) {
      const filename = chunks.length > 1
        ? base.replace('.mp3', `_part${i + 1}.mp3`)
        : base
      expected.push({
        filename,
        fullPath: path.join(audioDir, filename),
        text: chunks[i],
        sectionLabel: section.label,
        sectionWordCount: sectionStats.wordCount,
        sectionCharacterCount: sectionStats.characterCount,
        chunkIndex: i,
        totalChunks: chunks.length,
      })
    }
  }

  // Lookup is case-insensitive so a legacy/foreign-cased chunk file
  // (e.g. `tn0001_chapter_01.mp3`) still counts as present even on a
  // case-sensitive filesystem where `existsSync` on the uppercase-
  // prefix expected name would miss.
  //
  // A REJECTED take is never present, even while its bytes are still on disk
  // for the owner to restore (AGENTS.md §8, owner 2026-10-26). Generation, Audio
  // Assembly, Pipeline and the Production Board all read presence from here, so
  // a section whose only take was rejected is honestly incomplete everywhere
  // instead of being merged into a master nobody can listen to.
  const rejectedFiles = await rejectedTakeFileSet(episodeDirForNarration(narrationPath))
  const present: string[] = []
  for (const ec of expected) {
    if (rejectedFiles.has(ec.filename)) continue
    try {
      const actual = await findFileCaseInsensitive(audioDir, ec.filename, options)
      if (!actual) continue
      const st = await fs.stat(actual)
      if (st.size > 0) present.push(ec.filename)
    } catch (error) {
      if (options.strictIo && !isMissing(error)) throw error
    }
  }

  const missing = expected.filter(e => !present.includes(e.filename)).map(e => e.filename)
  return { audio_dir: audioDir, expected, present, missing, provider, awaiting_join: await chaptersAwaitingJoin(episodeDirForNarration(narrationPath), audioDir, code, expected, missing, model) }
}

/**
 * Split chapters whose parts are all on disk, made by `model` (task manifest),
 * but never activated: the run that made the last part ended before the
 * chapter became active and was joined. Generate missing / Repair finish them.
 */
async function chaptersAwaitingJoin(episodeDir: string, audioDir: string, code: string, expected: ExpectedChunk[], missing: string[], model: string): Promise<string[]> {
  const partRe = new RegExp(`^${code}_(.+)_part\\d+\\.mp3$`, 'i')
  const split = new Map<string, ExpectedChunk[]>()
  for (const chunk of expected) {
    const slug = chunk.totalChunks > 1 ? chunk.filename.match(partRe)?.[1] : undefined
    if (slug) split.set(slug, [...(split.get(slug) || []), chunk])
  }
  const candidates = [...split].filter(([, chunks]) => chunks.every(chunk => !missing.includes(chunk.filename)))
  if (!model || !candidates.length) return []
  const active = (await readAudioQualityProvenance(episodeDir)).chapters
  const tasks = (await readManifest(audioDir)).tasks
  return candidates.filter(([slug, chunks]) => !Object.keys(active).some(key => key.toLowerCase() === slug.toLowerCase())
    && chunks.every(chunk => {
      const task = tasks[chunk.filename]
      return task?.provider === 'genstudio' && task.operation === 'tts' && task.last_state === 'succeeded' && task.model_id === model
    }))
    .map(([slug]) => slug)
}

/**
 * Recover accepted GenStudio work only. Historical sidecars from direct
 * providers remain readable evidence, but are never contacted: retrying those
 * assets creates a fresh, idempotent GenStudio request through generateAudio.
 */
export async function reconcileAudio(slug: string, episodeId: string): Promise<ReconcileResult> {
  const logs: string[] = []
  const outcomes: ReconcileOutcome[] = []

  const status = await getAudioStatus(slug, episodeId)
  logs.push(`Expected ${status.expected.length} chunks; ${status.present.length} present, ${status.missing.length} missing.`)

  if (status.missing.length === 0) {
    const join_job_id = await queueJoin(slug, episodeId, status, logs)
    return {
      total_expected: status.expected.length,
      present_before: status.present.length,
      recovered: 0,
      still_missing: 0,
      outcomes: [],
      logs: status.awaiting_join.length ? logs : [...logs, 'Nothing to repair.'],
      ...(join_job_id ? { join_job_id } : {}),
    }
  }

  const manifest = await readManifest(status.audio_dir)
  const expectedByName = new Map(status.expected.map(e => [e.filename, e]))
  let recovered = 0
  const apiKey = await getApiKey('genstudio').catch(() => '')

  const fail = (filename: string, task_id: string | undefined, reason: string) => {
    outcomes.push({ filename, status: 'failed', task_id, reason })
    logs.push(`✗ ${filename}: ${reason}`)
  }
  // The same rule as generation (1.4.265): a saved request that ended, whose hold an operator closed
  // (HOLD_CLOSED / DISCARDED_UNCERTAIN), or whose audio is gone or unusable answers the same way on
  // every collect. Its key is dropped (a terminal last_state makes the next run send a new one);
  // free fleet parts are asked for again right away, paid voices wait for the owner's Retry.
  const freshParts: string[] = []
  let freshModel = ''
  const deadResult = (filename: string, entry: typeof manifest.tasks[string], why: string) => {
    if (entry.model_id && isFreeFleetModelId(entry.model_id) && (!freshModel || freshModel === entry.model_id)) {
      freshModel = entry.model_id
      freshParts.push(filename)
      fail(filename, entry.task_id, `The earlier result can't be used (${why}); asking for it again, free on your own Macs.`)
    } else {
      fail(filename, entry.task_id, `The earlier result can't be used (${why}). Generate missing sends a new request`
        + (isFreeFleetModelId(entry.model_id) ? '.' : '; a paid voice is never asked again by itself.'))
    }
  }

  for (const filename of status.missing) {
    const entry = manifest.tasks[filename]
    if (!entry) {
      fail(filename, undefined, 'No request for this part reached the Gateway. Retry generation to make it.')
      continue
    }
    if (entry.provider !== 'genstudio') {
      fail(
        filename,
        entry.task_id,
        // The manifest entry names the transport that served this chunk, and
        // on anything written before the GenStudio-only migration that is an
        // upstream routing identity. `result.logs` is returned straight to the
        // customer by POST /audio-repair, so the name is dropped — what matters
        // is that the evidence is read-only and nothing was contacted.
        'Legacy evidence is read-only. Retry generation through the Gateway; the legacy route was not contacted.',
      )
      continue
    }
    if (!entry.task_id) {
      fail(filename, undefined, 'The Gateway request was prepared but has no accepted job id. Retry generation with the same idempotency identity.')
      continue
    }
    if (!apiKey) {
      fail(filename, entry.task_id, 'No Gateway API Key configured. Add it in Settings → This Mac.')
      continue
    }
    if (isTerminalGenStudioTaskFailure(entry)) {
      deadResult(filename, entry, entry.last_state === 'artifact_expired' ? 'the audio is gone' : 'the request ended')
      continue
    }
    const chunk = expectedByName.get(filename)!
    try {
      await recoverGenStudioTtsToFile(apiKey, chunk.fullPath, entry.task_id, {
        text: chunk.text,
        speed: 1,
      })
      recovered++
      // Downloaded = the Gateway job finished: the part is now evidence a later join can activate.
      await recordTask(status.audio_dir, filename, { ...entry, last_state: 'succeeded' })
      outcomes.push({ filename, status: 'recovered', task_id: entry.task_id })
      logs.push(`✓ ${filename}: reclaimed from the Gateway (task ${entry.task_id.slice(0, 12)}…)`)
    } catch (e: any) {
      const unusable = e instanceof GenStudioArtifactUnavailableError && e.modality === 'tts'
      if (unusable || isClosedHoldCode(e?.failureCode)) {
        await recordTask(status.audio_dir, filename, { ...entry, last_state: unusable ? 'artifact_expired' : 'failed' })
        deadResult(filename, entry, unusable ? 'unusable audio' : e.failureCode)
        continue
      }
      fail(filename, entry.task_id, `Gateway recovery failed: ${e.message}`)
    }
  }

  const still_missing = status.missing.length - recovered
  logs.push(`Done: recovered ${recovered}, still missing ${still_missing}.`)
  // A fresh run also joins any chapter it completes, so it replaces the join-only run.
  const fresh_job_id = freshParts.length ? await queueFresh(slug, episodeId, freshModel, freshParts, logs) : null
  const join_job_id = recovered && !fresh_job_id ? await queueJoin(slug, episodeId, await getAudioStatus(slug, episodeId), logs) : null

  return {
    total_expected: status.expected.length,
    present_before: status.present.length,
    recovered,
    still_missing,
    outcomes,
    logs,
    ...(join_job_id ? { join_job_id } : {}),
    ...(fresh_job_id ? { fresh_job_id } : {}),
  }
}

/**
 * A split chapter with every part on disk but never activated is finished by
 * the one path that activates audio: an ordinary audio run, here `join_only`
 * (it refuses to make anything) with the settings of the run that made the
 * parts. Nothing is bought; the run joins the parts and activates the chapter.
 */
async function queueJoin(slug: string, episodeId: string, status: AudioStatus, logs: string[]): Promise<string | null> {
  if (!status.awaiting_join.length) return null
  const names = status.awaiting_join.map(chapter => chapter.replaceAll('_', ' ')).join(', ')
  const code = episodeId.toUpperCase()
  const firstPart = status.expected.find(chunk => chunk.totalChunks > 1
    && chunk.filename.toLowerCase().startsWith(`${code}_${status.awaiting_join[0]}_part`.toLowerCase()))
  const model = firstPart ? (await readManifest(status.audio_dir)).tasks[firstPart.filename]?.model_id : undefined
  const queued = await queueLikeLastRun(slug, code, model, status.awaiting_join, `Audio (join ${names})`, { join_only: true })
  logs.push(queued === 'no-run'
    ? `${names}: every part is here but the chapter is not joined yet. Generate missing joins it without making anything again.`
    : queued === 'busy'
    ? `${names}: every part is here but the chapter is not joined yet. An audio job is running for this episode; press Repair again when it ends.`
    : `${names}: every part is here; joining them into the chapter now (nothing is made or charged).`)
  return queued === 'no-run' || queued === 'busy' ? null : queued
}

/** Free fleet parts whose saved request is dead: one ordinary run for their chapters makes only what is missing. */
async function queueFresh(slug: string, episodeId: string, model: string, filenames: string[], logs: string[]): Promise<string | null> {
  const code = episodeId.toUpperCase()
  const prefix = new RegExp(`^${code}_`, 'i')
  const sections = [...new Set(filenames.map(name => name.replace(prefix, '').replace(/(_part\d+)?\.mp3$/i, '')))]
  const queued = await queueLikeLastRun(slug, code, model, sections, `Audio (ask again: ${sections.join(', ').replaceAll('_', ' ')})`, {})
  logs.push(queued === 'no-run'
    ? `${filenames.length} part(s) need a new request. Generate missing sends it, free on your own Macs.`
    : queued === 'busy'
    ? `${filenames.length} part(s) need a new request. An audio job is running for this episode; press Repair again when it ends.`
    : `Asking again for ${filenames.length} part(s) with a new request, free on your own Macs.`)
  return queued === 'no-run' || queued === 'busy' ? null : queued
}

/** Enqueue an audio run with the settings of the episode's latest run on `model`. */
async function queueLikeLastRun(slug: string, code: string, model: string | undefined, sections: string[], title: string, extra: Record<string, unknown>): Promise<string | 'no-run' | 'busy'> {
  const jq = await import('./job-queue.js')
  const made = (await jq.findJobs(slug, job => job.type === 'audio' && (job.episode_id || '').toUpperCase() === code
      && job.params?.model === model && typeof job.params?.voice === 'string'
      && !job.params.quality_repair && !job.params.quality_check))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
  if (!made) return 'no-run'
  if (jq.isDuplicate(slug, made.episode_id, 'audio')) return 'busy'
  const p = made.params
  const job = await jq.enqueue({
    project_slug: slug,
    type: 'audio',
    episode_id: made.episode_id,
    title,
    params: {
      episode_id: made.episode_id, model: p.model, voice: p.voice, speed: p.speed,
      ...(p.controls ? { controls: p.controls } : {}),
      ...(p.paragraph_pause_sec !== undefined ? { paragraph_pause_sec: p.paragraph_pause_sec } : {}),
      ...(p.sentence_pause_sec !== undefined ? { sentence_pause_sec: p.sentence_pause_sec } : {}),
      sections: sections.join(','), force: false, no_overwrite: false, ...extra,
    },
  })
  return job.job_id
}

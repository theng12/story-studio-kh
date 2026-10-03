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
import { findNarrationFile, episodeDirForNarration, resolveAudioDir } from '../generators/audio.js'
import type { ProjectFactsCache } from './utils.js'
import { readManifest } from './task-manifest.js'
import { readAudioTtsModelRecord } from './audio-tts-model-record.js'
import { readAudioQualityProvenance } from './audio-quality-store.js'
import { hashSubtitleAudioSources } from './subtitle-completion.js'
import {
  recoverTtsToFile as recoverGenStudioTtsToFile,
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
      const jobs = await getJobs(slug)
      const audioJobs = jobs
        .filter(j => j.type === 'audio')
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
  const present: string[] = []
  for (const ec of expected) {
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
  return { audio_dir: audioDir, expected, present, missing, provider }
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
    return {
      total_expected: status.expected.length,
      present_before: status.present.length,
      recovered: 0,
      still_missing: 0,
      outcomes: [],
      logs: [...logs, 'Nothing to repair.'],
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
      fail(filename, entry.task_id, 'No Gateway key configured. Add it in Settings → This Mac.')
      continue
    }
    const chunk = expectedByName.get(filename)!
    try {
      await recoverGenStudioTtsToFile(apiKey, chunk.fullPath, entry.task_id, {
        text: chunk.text,
        speed: 1,
      })
      recovered++
      outcomes.push({ filename, status: 'recovered', task_id: entry.task_id })
      logs.push(`✓ ${filename}: reclaimed from the Gateway (task ${entry.task_id.slice(0, 12)}…)`)
    } catch (e: any) {
      fail(filename, entry.task_id, `Gateway recovery failed: ${e.message}`)
    }
  }

  const still_missing = status.missing.length - recovered
  logs.push(`Done: recovered ${recovered}, still missing ${still_missing}.`)

  return {
    total_expected: status.expected.length,
    present_before: status.present.length,
    recovered,
    still_missing,
    outcomes,
    logs,
  }
}

/** @deprecated Back-compat shim — repair is now provider-aware and resolves keys
 *  itself. Prefer `reconcileAudio(slug, episodeId)`. */
export function reconcileAudioViaGenaipro(slug: string, episodeId: string, _apiKey?: string): Promise<ReconcileResult> {
  return reconcileAudio(slug, episodeId)
}

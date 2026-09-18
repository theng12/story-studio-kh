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
import { findNarrationFile, resolveAudioDir } from '../generators/audio.js'
import type { ProjectFactsCache } from './utils.js'
import { readManifest } from './task-manifest.js'
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

/** Counts the normalized text that will actually be submitted to TTS. */
export function narrationTextStats(text: string): { wordCount: number; characterCount: number } {
  const normalized = text.trim()
  return {
    wordCount: normalized ? normalized.split(/\s+/u).length : 0,
    characterCount: normalized.length,
  }
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
): Promise<AudioStatus> {
  const narrationPath = await findNarrationFile(slug, episodeId, cache)
  const audioDir = await resolveAudioDir(slug, narrationPath, episodeId, cache)
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
  if (!model) {
    try {
      const { getJobs } = await import('./job-queue.js')
      const jobs = await getJobs(slug)
      const audioJobs = jobs
        .filter(j => j.type === 'audio')
        .sort((a, b) => String(b.finished_at || b.created_at || '').localeCompare(String(a.finished_at || a.created_at || '')))
      // This episode's own job names the model it was generated with. Terminal
      // job history is pruned, so an episode whose job has aged out falls back
      // to the project's most recent audio job — the same model in practice,
      // and a far better answer than a constant.
      const lastAudio = audioJobs.find(j => (j.episode_id || '').toUpperCase() === code) || audioJobs[0]
      const remembered = (lastAudio?.params as any)?.model
      if (typeof remembered === 'string') model = remembered.trim()
    } catch { /* no history — handled below */ }
  }
  if (model) {
    provider = 'genstudio'
    try {
      const apiKey = await getApiKey('genstudio').catch(() => '')
      if (apiKey) {
        const ttsModel = (await listGenStudioTtsModels(apiKey).catch(() => []))
          .find(candidate => candidate.id === model)
        if (ttsModel) requestBudget = resolveTtsRequestBudget(ttsModel).effective
      }
    } catch { /* boundary unresolved — handled per section below */ }
  }

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
        const actual = await findFileCaseInsensitive(audioDir, base)
        if (actual) basePresent = (await fs.stat(actual)).size > 0
      } catch { /* unreadable → fall through to the chunk expectation */ }
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
      const actual = await findFileCaseInsensitive(audioDir, ec.filename)
      if (!actual) continue
      const st = await fs.stat(actual)
      if (st.size > 0) present.push(ec.filename)
    } catch { /* treat unreadable as missing */ }
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
      fail(filename, undefined, 'No accepted GenStudio task is recorded. Retry generation; no legacy provider fallback was attempted.')
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
        'Legacy evidence is read-only. Retry generation through GenStudio; the legacy route was not contacted.',
      )
      continue
    }
    if (!entry.task_id) {
      fail(filename, undefined, 'The GenStudio request was prepared but has no accepted job id. Retry generation with the same idempotency identity.')
      continue
    }
    if (!apiKey) {
      fail(filename, entry.task_id, 'No GenStudio KH API key configured. Add it in Settings → This Mac.')
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
      logs.push(`✓ ${filename}: reclaimed from GenStudio (task ${entry.task_id.slice(0, 12)}…)`)
    } catch (e: any) {
      fail(filename, entry.task_id, `GenStudio recovery failed: ${e.message}`)
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

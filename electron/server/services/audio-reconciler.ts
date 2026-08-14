/**
 * Audio reconciler — detect and recover missing TTS chunks.
 *
 * Recovery is intentionally GenStudio-only. Historical direct-provider
 * sidecars remain readable evidence but cannot trigger provider requests.
 *
 * Strategy:
 *   1. Replicate the generator's chunk-filename logic to compute what files
 *      SHOULD exist for a given episode (same parser + same 4800-char split).
 *   2. Compare to what's on disk.
 *   3. Reclaim only accepted GenStudio jobs with their durable job id.
 *
 * This is a recovery tool, not a generator — it never creates new TTS tasks.
 */

import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { chunkText } from '../lib/text-chunker.js'
import { normalizeForTts } from '../lib/tts-text.js'
import { findNarrationFile, resolveAudioDir } from '../generators/audio.js'
import { readManifest } from './task-manifest.js'
import {
  recoverTtsToFile as recoverGenStudioTtsToFile,
  splitGenStudioApiRequests,
  listTtsModels as listGenStudioTtsModels,
} from '../lib/genstudio-client.js'
import { findFileCaseInsensitive } from './fs-case-insensitive.js'
import { getApiKey } from './app-secrets-store.js'

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
  /** Historical provider classification inferred from the latest audio job.
   *  It is used only to reproduce legacy chunk filenames while reading status;
   *  it never selects a recovery client. */
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
export async function getAudioStatus(slug: string, episodeId: string): Promise<AudioStatus> {
  const narrationPath = await findNarrationFile(slug, episodeId)
  const audioDir = await resolveAudioDir(slug, narrationPath, episodeId)
  const sections = await parseNarrationDocx(narrationPath)
  const code = episodeId.toUpperCase()

  // Resolve the SAME per-model TTS chunk cap the generator used, so our
  // expected chunk split matches the files actually on disk. The generator
  // splits at AudioModelConfig.tts_soft_max_chars (e.g. Voice Studio Kokoro =
  // 2000); using the chunker's 4800 default here under-counts chunks for local
  // models, so a fully-generated multi-part section (…_part1/_part2) looked
  // "missing" because we only expected a single …{slug}.mp3. Mirror
  // generators/audio.ts: read the cap off the episode's most recent audio
  // job's model. Dynamic imports avoid an import cycle (this module is a
  // static dep of the job-queue's executor graph). Fail-quiet → chunker default.
  let ttsChunkCap: number | undefined
  let genStudioMaxCharacters: number | undefined
  let provider = ''
  try {
    const { getJobs } = await import('./job-queue.js')
    const jobs = await getJobs(slug)
    const lastAudio = jobs
      .filter(j => j.type === 'audio' && (j.episode_id || '').toUpperCase() === code)
      .sort((a, b) => String(b.finished_at || b.created_at || '').localeCompare(String(a.finished_at || a.created_at || '')))[0]
    const model = (lastAudio?.params as any)?.model
    if (model) {
      const pm = await import('./project-manager.js')
      const config = await pm.getConfig(slug)
      const entry = (config as any)?.audio_models?.[model]
      const cap = entry?.tts_soft_max_chars
      if (typeof cap === 'number' && cap > 0) ttsChunkCap = cap
      // Reproduce the generator's GenStudio boundary from the same live source
      // it used: the selected model's published maximum_input_characters. A
      // remembered number here would silently predict the wrong filenames.
      const { getApiKey } = await import('./app-secrets-store.js')
      const apiKey = await getApiKey('genstudio').catch(() => '')
      if (apiKey) {
        const ttsModel = (await listGenStudioTtsModels(apiKey).catch(() => []))
          .find(candidate => candidate.id === model)
        if (ttsModel) genStudioMaxCharacters = ttsModel.maximum_input_characters
      }
      // Preserve the provider classification only so status calculation can
      // reproduce the old chunk boundaries. Recovery ignores this field and
      // accepts GenStudio manifest entries only.
      provider = entry?.provider
        || (model.startsWith('eleven_') ? 'elevenlabs'
          : model.startsWith('genaipro-') ? 'genaipro'
          : model.startsWith('kie-') ? 'kie'
          : model.startsWith('fishaudio-') ? 'fishaudio'
          : model.startsWith('voicestudio-') ? 'voicestudio'
          : model.startsWith('genstudio-') ? 'genstudio'
          : model.startsWith('macos-') ? 'macos'
          : 'fal')
    }
  } catch { /* fall back to the chunker's default cap */ }

  const expected: ExpectedChunk[] = []
  for (const section of sections) {
    const base = `${code}_${section.slug}.mp3`
    // Mirror the generator's pre-TTS normalization (v1.0.215+) BEFORE chunking
    // so chunk boundaries — and thus the predicted filenames + per-chunk text
    // used for recovery matching — match what the generator actually produced.
    const sectionText = normalizeForTts(section.text).text
    const sectionStats = narrationTextStats(sectionText)
    const chunks = provider === 'genstudio' && genStudioMaxCharacters
      ? splitGenStudioApiRequests(sectionText, genStudioMaxCharacters)
      : chunkText(sectionText, ttsChunkCap)

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

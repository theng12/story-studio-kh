/**
 * Audio reconciler — detect and recover missing TTS chunks.
 *
 * Why this exists: GenAIPro TTS tasks routinely take >5 min per chapter, and
 * until recently the client timed out at 5 min, orphaning the result on
 * GenAIPro's side. GenAIPro keeps task history for only ~1 day, so recovery
 * is time-sensitive.
 *
 * Strategy:
 *   1. Replicate the generator's chunk-filename logic to compute what files
 *      SHOULD exist for a given episode (same parser + same 4800-char split).
 *   2. Compare to what's on disk.
 *   3. For each missing chunk, look it up in GenAIPro's task history by
 *      exact input text, download the result URL, write to the expected path.
 *
 * This is a recovery tool, not a generator — it never creates new TTS tasks.
 */

import fs from 'fs/promises'
import path from 'path'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import { chunkText } from '../lib/text-chunker.js'
import { normalizeForTts } from '../lib/tts-text.js'
import { listAllLabsTasks, getTaskById, type LabsTask } from '../lib/genaipro-client.js'
import { downloadAudio, pollExistingFalAudio } from '../lib/fal-client.js'
import { fetchKieAudioUrlByTaskId } from '../lib/kie-tts-client.js'
import { resolveApiKeyForProviderId } from '../providers/registry.js'
import { findNarrationFile, resolveAudioDir } from '../generators/audio.js'
import { readManifest } from './task-manifest.js'
import { findFileCaseInsensitive } from './fs-case-insensitive.js'

export interface ExpectedChunk {
  filename: string        // e.g. TN0001_Chapter_03_part2.mp3
  fullPath: string        // absolute path where it should live
  text: string            // exact input sent to TTS (used for history match)
  sectionLabel: string
  chunkIndex: number      // 0-based index within the section
  totalChunks: number     // how many chunks this section splits into
}

export interface AudioStatus {
  audio_dir: string
  expected: ExpectedChunk[]
  present: string[]       // filenames on disk with size > 0
  missing: string[]       // filenames absent OR zero-byte
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
      const cap = (config as any)?.audio_models?.[model]?.tts_soft_max_chars
      if (typeof cap === 'number' && cap > 0) ttsChunkCap = cap
    }
  } catch { /* fall back to the chunker's default cap */ }

  const expected: ExpectedChunk[] = []
  for (const section of sections) {
    const base = `${code}_${section.slug}.mp3`
    // Mirror the generator's pre-TTS normalization (v1.0.215+) BEFORE chunking
    // so chunk boundaries — and thus the predicted filenames + per-chunk text
    // used for recovery matching — match what the generator actually produced.
    const sectionText = normalizeForTts(section.text).text
    const chunks = chunkText(sectionText, ttsChunkCap)

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
  return { audio_dir: audioDir, expected, present, missing }
}

/**
 * Normalize text for matching against GenAIPro history.
 * Collapses whitespace runs and trims — the server may round-trip text
 * through serialization that normalizes whitespace slightly.
 */
function normalizeForMatch(t: string): string {
  return t.trim().replace(/\s+/g, ' ')
}

/**
 * Attempt to recover every missing chunk for an episode by re-fetching each
 * chunk's completed-but-lost result from the provider that made it. Never
 * creates new tasks (that's what Regenerate is for).
 *
 * Provider coverage:
 *   - task-based cloud gateways record a task id in the sidecar manifest at
 *     submit time, so recovery is deterministic: GenAIPro (getTaskById),
 *     kie.ai (recordInfo by taskId), fal.ai (re-poll the stored status/result
 *     URLs). GenAIPro additionally supports a text-match fallback across its
 *     1-day history for chunks with no sidecar id (legacy losses).
 *   - streaming providers (direct ElevenLabs, Fish Audio, Voice Studio, macOS)
 *     have no server-side task to re-fetch — those chunks can only be
 *     REGENERATED, and are reported as such.
 *
 * Keys are resolved internally per provider from the app-secrets store.
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

  // Load the sidecar manifest first — stored task_ids give us deterministic,
  // provider-aware recovery. Anything without a stored id falls back to
  // GenAIPro text-matching (legacy) or a "regenerate" note (streaming provider).
  const manifest = await readManifest(status.audio_dir)
  const expectedByName = new Map(status.expected.map(e => [e.filename, e]))
  const missingWithoutSidecar: string[] = []
  let recovered = 0

  // Lazily resolve + cache each provider's key the SAME way the generator did
  // (accounts + app-secrets), so repair finds the key that made the task.
  const keyCache: Record<string, string> = {}
  const providerKey = async (p: string): Promise<string> =>
    (keyCache[p] ??= (await resolveApiKeyForProviderId(slug, p).catch(() => '')) || '')

  const fail = (filename: string, task_id: string | undefined, reason: string) => {
    outcomes.push({ filename, status: 'failed', task_id, reason })
    logs.push(`✗ ${filename}: ${reason}`)
  }

  for (const filename of status.missing) {
    const entry = manifest.tasks[filename]
    if (!entry || !entry.task_id) { missingWithoutSidecar.push(filename); continue }
    const chunk = expectedByName.get(filename)!

    // Resolve the completed result URL from the recording provider.
    let url: string | null = null
    try {
      if (entry.provider === 'genaipro') {
        const key = await providerKey('genaipro')
        if (!key) { fail(filename, entry.task_id, 'No GenAIPro API key — add one in Settings → API Keys'); continue }
        const task = await getTaskById(key, entry.task_id)
        if (!task) { missingWithoutSidecar.push(filename); continue } // aged out → try text-match
        if (task.status !== 'completed' || !task.result) {
          fail(filename, entry.task_id, `GenAIPro task status "${task.status || 'unknown'}" — still running or failed`)
          continue
        }
        url = task.result
      } else if (entry.provider === 'kie') {
        const key = await providerKey('kie')
        if (!key) { fail(filename, entry.task_id, 'No kie.ai API key — add one in Settings → API Keys'); continue }
        const r = await fetchKieAudioUrlByTaskId(entry.task_id, key)
        if (r.status !== 'success' || !r.url) {
          fail(filename, entry.task_id, `kie.ai task not recoverable (${r.message || r.status})`)
          continue
        }
        url = r.url
      } else if (entry.provider === 'fal') {
        const key = await providerKey('fal')
        if (!key) { fail(filename, entry.task_id, 'No fal.ai API key — add one in Settings → API Keys'); continue }
        url = await pollExistingFalAudio(entry.poll_path || '', entry.result_url || '', key)
        if (!url) { fail(filename, entry.task_id, 'fal.ai task not recoverable (expired or failed on provider side)'); continue }
      } else {
        // Unknown / streaming provider recorded no re-fetchable task.
        missingWithoutSidecar.push(filename)
        continue
      }
    } catch (e: any) {
      fail(filename, entry.task_id, `Provider lookup failed: ${e.message}`)
      continue
    }

    try {
      await downloadAudio(url, chunk.fullPath)
      recovered++
      outcomes.push({ filename, status: 'recovered', task_id: entry.task_id })
      logs.push(`✓ ${filename}: recovered from ${entry.provider} (task ${entry.task_id.slice(0, 12)}…)`)
    } catch (e: any) {
      fail(filename, entry.task_id, `Download failed: ${e.message}`)
    }
  }

  // Chunks with no re-fetchable task record. GenAIPro can still text-match its
  // 1-day history (legacy losses); otherwise these must be regenerated.
  if (missingWithoutSidecar.length > 0) {
    const apiKey = await providerKey('genaipro')
    if (!apiKey) {
      for (const filename of missingWithoutSidecar) {
        fail(filename, undefined, 'No recoverable task for this chunk — regenerate it (streaming providers like direct ElevenLabs / Fish / Voice Studio / macOS can\'t be repaired).')
      }
      const still = status.missing.length - recovered
      logs.push(`Done: recovered ${recovered}, still missing ${still}.`)
      return { total_expected: status.expected.length, present_before: status.present.length, recovered, still_missing: still, outcomes, logs }
    }
    logs.push(`Text-matching ${missingWithoutSidecar.length} remaining chunk(s) against GenAIPro history…`)
    let tasks: LabsTask[] = []
    try {
      tasks = await listAllLabsTasks(apiKey)
    } catch (e: any) {
      for (const filename of missingWithoutSidecar) {
        outcomes.push({
          filename, status: 'failed',
          reason: `Could not read GenAIPro history: ${e.message}`,
        })
      }
      logs.push(`✗ GenAIPro history unreachable: ${e.message}`)
      return {
        total_expected: status.expected.length,
        present_before: status.present.length,
        recovered,
        still_missing: status.missing.length - recovered,
        outcomes, logs,
      }
    }
    logs.push(`Found ${tasks.length} task(s) in GenAIPro history.`)

    const byText = new Map<string, LabsTask>()
    for (const t of tasks) {
      if (t.status !== 'completed' || !t.result) continue
      const key = normalizeForMatch(t.input || '')
      const prev = byText.get(key)
      if (!prev || (t.created_at || '') > (prev.created_at || '')) {
        byText.set(key, t)
      }
    }

    for (const filename of missingWithoutSidecar) {
      const chunk = expectedByName.get(filename)!
      const match = byText.get(normalizeForMatch(chunk.text))
      if (!match) {
        outcomes.push({
          filename, status: 'failed',
          reason: 'No matching completed task in GenAIPro history (outside 1-day window, different provider, or text mismatch)',
        })
        logs.push(`✗ ${filename}: no history match`)
        continue
      }
      try {
        await downloadAudio(match.result!, chunk.fullPath)
        recovered++
        outcomes.push({ filename, status: 'recovered', task_id: match.id })
        logs.push(`✓ ${filename}: recovered via text-match (task ${match.id.slice(0, 12)}…)`)
      } catch (e: any) {
        outcomes.push({
          filename, status: 'failed', task_id: match.id,
          reason: `Download failed: ${e.message}`,
        })
        logs.push(`✗ ${filename}: download failed — ${e.message}`)
      }
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

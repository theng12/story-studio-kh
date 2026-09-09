/**
 * Subtitle generation jobs.
 *
 * `subtitles_transcribe` uses Story Studio's transcription service and live
 * model catalog. Imported SRTs remain synchronous local operations.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveSubfolderNames, resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { stitchSubtitles } from '../services/subtitle-stitcher.js'
import {
  inspectPipelineSubtitleRepairReadiness,
  inspectSubtitleCompletion,
  hashSubtitleAudioSources,
  isPipelineRepairTranscriptUsable,
} from '../services/subtitle-completion.js'
import { recordSubtitleSourceEvidence } from '../services/subtitle-recovery.js'
import { readSubtitleTimelineIntegrity } from '../services/scene-timeline-integrity.js'
import { scanEpisodeAssets } from './video.js'
import {
  GenStudioArtifactUnavailableError,
  GenStudioCatalogUnavailableError,
  GenStudioTerminalFailureError,
  GenStudioTranscriptionQuoteExpiredError,
  isGenStudioInsufficientCredits,
  listTranscriptionModels,
  refreshGenStudioAdmission,
} from '../lib/genstudio-client.js'
import type { GenStudioTranscriptionModel } from '../lib/genstudio-client.js'
import { normalizeSrtOrVtt } from '../lib/subtitle-builder.js'
import { fileExistsWithContent } from '../lib/http-retry.js'
import { hashInput } from '../services/task-manifest.js'
import { isFleetBusyFailure } from '../lib/genstudio-fleet-busy.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import type { Job } from '../models/types.js'
import { requireAudioAssemblyReady } from '../services/audio-workflow-readiness.js'
import { runSubtitleTranscription } from '../services/subtitle-recovery.js'

/**
 * Ask GenStudio for per-word timings on every transcription Story Studio runs.
 *
 * The capability is real and proven: Voice Studio's MLX Whisper Large v3 Turbo
 * returns validated per-word times, GenStudio forwards the flag to the fleet
 * and stores the words, and it costs NOTHING extra — transcription is priced
 * as `duration x rate` and the flag appears nowhere in the cost function.
 *
 * Story Studio does not consume the words yet (GenStudio has not published the
 * endpoint that serves them, and the caption engine still interpolates and
 * labels its word timings `estimated`). We set the flag anyway so the exact
 * timings are BANKED from now on. A transcription made today without them can
 * only get them back by re-transcribing, which spends the customer's credits
 * for data that was free to collect the first time.
 *
 * IMPORTANT: this value must be folded into BOTH the local task-reuse hash and
 * the GenStudio idempotency key. Leaving either at a hardcoded `false` makes a
 * with-timestamps request hash identically to the without-timestamps job that
 * already ran, so GenStudio replays the old word-less result while every
 * status in the app reports success.
 */
export const TRANSCRIPTION_WORD_TIMESTAMPS = true

export interface TranscribeSubtitlesRequest {
  episode_id: string
  audio_path?: string        // overrides the default merged-audio discovery
  language?: string
  model?: string
  /**
   * When true, re-run transcription even if the SRT already exists. Default
   * false so verified chapter work is preserved across retries.
   */
  force?: boolean
  /** Server-stamped identity for one deliberate fresh action. */
  generation_action?: { id: string; kind: 'fresh' }
  /**
   * v1.0.216+ — Per-chapter mode for the audio-paced pipeline. Instead of one
   * SRT off the merged audio, transcribe each chapter's clean narration audio
   * separately into `{code}_{slug}.srt`. These are exactly the per-chapter
   * SRTs Scene Plan's stitcher consumes (it offsets each by the known gaps).
   * Transcribing the clean per-chapter audio also avoids the intro/music in
   * the merged track contaminating the transcript.
   */
  per_chapter?: boolean
  /**
   * v1.2.2 — restrict a per-chapter run to these section slugs.
   *
   * Exists so "re-transcribe this chapter" can be offered against a chapter
   * whose transcript is corrupt without re-paying for the twelve chapters that
   * are fine. Empty or absent means every chapter, which is the old behaviour.
   * Ignored outside `per_chapter` mode, where there is only one audio track.
   */
  sections?: string[]
  /** Pipeline-stamped, deliberate one-action repair identity. */
  pipeline_repair?: { action_id: string }
  /** Backend-only explicit owner purchase, scoped to the failed job's missing set. */
  subtitle_purchase?: { additional_credit_ceiling: number }
  /** New work uses the current live transcription catalog. */
  engine?: 'genstudio' | 'openai' | 'voicestudio'
}

/**
 * A completed chapter batch is not a completed subtitle job until the fresh
 * stitched timeline exists. Keeping this boundary explicit prevents the queue
 * from terminalizing an episode whose Scene Plan prerequisite is still absent.
 */
export function requireWrittenSubtitleStitch(outcome: { status: string; reason: string }): void {
  if (outcome.status === 'stitched' || outcome.status === 'fresh') return
  throw new Error(`Subtitle stitch did not complete: ${outcome.reason}. Retry the local subtitle stitch before Scene Plan.`)
}

/**
 * Local `last_state` values that mean the saved GenStudio transcription can
 * never produce an SRT again.
 *
 * There is no `cancelled` or `rejected` JobState in GenStudio — the enum is
 * accepted|reserved|dispatched|running|validating|reconciling|succeeded|failed
 * and cancellation rides on a boolean. Those two names are retained ONLY so
 * manifests written by older Story Studio releases still classify correctly;
 * nothing writes them any more. `expired`/`artifact_expired` are Story-local
 * markers for a settled job whose quote or artifact is gone.
 */
const TERMINAL_TRANSCRIPTION_TASK_STATES: ReadonlySet<string> = new Set([
  'failed',
  'expired',
  'artifact_expired',
  'cancelled',
  'rejected',
])

/**
 * An accepted transcription can be reconnected safely after an app restart
 * or network interruption. A terminal GenStudio task cannot: replaying its
 * idempotency key only returns the same failed/expired provider task.
 */
export function isTerminalGenStudioTranscriptionTaskFailure(entry: {
  task_id?: string
  idempotency_key?: string
  last_state?: string
} | null | undefined): boolean {
  return Boolean(
    (entry?.task_id || entry?.idempotency_key)
    && TERMINAL_TRANSCRIPTION_TASK_STATES.has((entry.last_state || '').toLowerCase()),
  )
}

/**
 * GenStudio settled this transcription request and no replay of its identity
 * can change that: the job failed/was cancelled, its quote expired before it
 * could be confirmed, or the finished SRT is no longer served.
 *
 * Typed on purpose. The previous implementation matched words like "failed" or
 * "expired" anywhere in an error message, which classified unrelated failures
 * (and would silently reclassify on any provider wording change).
 */
export function isTerminalGenStudioTranscriptionProviderError(error: unknown): boolean {
  if (error instanceof GenStudioTranscriptionQuoteExpiredError) return true
  if (error instanceof GenStudioTerminalFailureError) return error.modality === 'transcription'
  if (error instanceof GenStudioArtifactUnavailableError) return error.modality === 'transcription'
  return false
}

/**
 * "Every machine was busy" — see `lib/genstudio-fleet-busy.ts` for the rule and
 * for why retrying it is free. Re-exported here because 1.4.24 shipped it under
 * this name and the tests, and any future reader, should still find it.
 */
export function isFleetBusyTranscriptionFailure(error: unknown): boolean {
  return isFleetBusyFailure(error, 'transcription')
}


async function hashTranscriptionAudio(audioPath: string): Promise<string> {
  const audio = await fs.readFile(audioPath)
  return `sha256:${createHash('sha256').update(audio).digest('hex')}`
}

/**
 * The language a transcription submits with.
 *
 * The requested language must be one the selected live model publishes.
 * Omitting it means auto-detect only when that same model explicitly publishes
 * `supports_language_auto_detect: true`; missing contract data never becomes
 * permission to guess or silently submit.
 */
export function resolveTranscriptionLanguage(
  model: Pick<GenStudioTranscriptionModel, 'display_name' | 'language' | 'supported_languages' | 'supports_language_auto_detect'>,
  requested: string | undefined,
): string | undefined {
  const name = model.display_name || 'The selected transcription model'
  const wanted = (requested || '').trim()
  const automatic = !wanted || wanted.toLowerCase() === 'auto'
  if (automatic) {
    if (model.supports_language_auto_detect === true) return undefined
    throw new Error(`${name} has not published auto-detect. Select one of its published languages before transcription; no transcription was submitted or charged.`)
  }
  const sentinels = new Set(['multilingual', 'multi', 'auto', 'any'])
  const listed = Array.isArray(model.supported_languages)
    ? model.supported_languages.filter(code => typeof code === 'string' && !!code.trim())
    : []
  const concrete = (model.language || '').trim()
  if (!listed.length && concrete && !sentinels.has(concrete.toLowerCase())) listed.push(concrete)
  const matched = listed.find(code => code.toLowerCase() === wanted.toLowerCase())
  if (!matched) {
    throw new Error(`${name} does not publish ${wanted} as a supported language. Select a language from its live catalogue; no transcription was submitted or charged.`)
  }
  return matched
}

async function resolveGenStudioTranscription(
  job: Job,
  req: TranscribeSubtitlesRequest,
): Promise<{ apiKey: string; modelId: string; language: string | undefined }> {
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const apiKey = await getApiKey('genstudio')
  if (!apiKey.trim()) {
    throw new Error(
      'Transcription is not configured. Add an API key in Settings → This Mac → API Keys.',
    )
  }
  let models: Awaited<ReturnType<typeof listTranscriptionModels>>
  try {
    models = await listTranscriptionModels(apiKey)
  } catch (error) {
    // A catalogue beyond the staleness window is already a clear, typed
    // refusal that names the cost consequence — do not flatten it into a
    // generic message, and never fall back to an unverified product.
    if (error instanceof GenStudioCatalogUnavailableError) throw error
    throw new Error(
      'Could not load transcription models after automatic reconnect attempts. ' +
      'No transcription was submitted or charged; check your connection and Retry.',
    )
  }
  const requestedModel = req.model?.trim() || ''
  const migratedModel = resolveGenStudioModelId('transcription', requestedModel)
  if (!migratedModel) throw new Error(unavailableLegacyModelMessage('transcription', requestedModel || '(none)'))
  const selected = models.find(model => model.id === migratedModel)
  if (!selected) throw new Error('The selected transcription model is no longer available.')
  if (!selected.available) {
    throw new Error('The selected transcription model is temporarily unavailable.')
  }
  if (selected.locked) {
    throw new Error('The selected transcription model is locked for this GenStudio account. Choose an unlocked model. No request or credit charge was made.')
  }
  if (requestedModel !== migratedModel) {
    job.output_lines.push(`Migrated legacy transcription model ${requestedModel} → ${migratedModel}.`)
  }
  job.output_lines.push(`Model: ${selected.display_name}`)
  const language = resolveTranscriptionLanguage(selected, req.language)
  job.output_lines.push(
    language
      ? `Language: ${language}${req.language?.trim() ? ' (requested)' : ` (published by ${selected.display_name})`}`
      : `Language: automatic detection requested — ${selected.display_name} publishes auto-detect.`,
  )
  return { apiKey, modelId: selected.id, language }
}

export async function generateSubtitlesTranscribe(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as TranscribeSubtitlesRequest
  const code = episode_id.toUpperCase()
  const generationActionId = req.generation_action?.kind === 'fresh'
    && typeof req.generation_action.id === 'string' && req.generation_action.id.trim()
    ? req.generation_action.id.trim()
    : undefined
  const effectiveForce = req.force === true || !!generationActionId

  job.progress = 0
  job.output_lines.push(`Starting transcription for ${code}`)

  // Subtitle coverage is defined by Audio Assembly's verified section
  // timeline. Gate before any catalog lookup, upload, or paid submission so a
  // missing merge/manifest cannot become a misleading 0/0 completion error.
  const assembly = await requireAudioAssemblyReady(project_slug, code)
  job.output_lines.push(
    `Audio Assembly verified: ${assembly.timeline_sections.length}/${assembly.expected_sections.length} timeline section(s) ready`,
  )

  // v1.0.216+ — Per-chapter mode (audio-paced pipeline). Routed before the
  // merged-audio path: transcribe each chapter's clean narration into
  // {code}_{slug}.srt for Scene Plan's stitcher to consume.
  if (req.per_chapter) {
    return await transcribePerChapter(job, project_slug, episode_id, req)
  }

  // Preserve already-verified work. GenStudio has its own durable idempotency,
  // while this file guard prevents an unnecessary new Story job entirely.
  const outDir = await resolveSubtitlesDir(project_slug, code)
  const outPath = path.join(outDir, `${code}_whisper.srt`)
  if (!effectiveForce && await fileExistsWithContent(outPath)) {
    const existing = normalizeSrtOrVtt(await fs.readFile(outPath, 'utf-8'))
    if (existing.cues > 0) {
      job.output_lines.push(`Skipping — ${code}_whisper.srt already exists and ${existing.cues} cue(s) were verified. Tick "Re-run transcription" to overwrite.`)
      job.output_dir = outDir
      ;(job as any).result = { srt_path: outPath, cues: existing.cues, skipped: true, complete: true }
      job.progress = 100
      return
    }
    job.output_lines.push(`Existing ${code}_whisper.srt has no valid cues — regenerating it.`)
  }

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project not found')

  const genstudio = await resolveGenStudioTranscription(job, req)

  // Resolve the audio source: explicit override wins; otherwise we use the
  // first merged-audio file the scanner surfaces. Rejecting the chapter
  // files here is intentional — transcribing 10+ small clips ~double-counts
  // the Whisper API call budget and produces stitched-together offsets we'd
  // have to reconcile manually.
  let audioPath = req.audio_path
  if (!audioPath) {
    const assets = await scanEpisodeAssets(project_slug, episode_id)
    const merged = assets.merged_audio[0]
    if (!merged) throw new Error('No merged audio file found — run Audio Assembly first')
    audioPath = merged.path
  }
  // `const` so TS keeps the string narrowing inside the async closures below.
  const sourceAudio: string = audioPath
  job.output_lines.push(`Source: ${path.basename(sourceAudio)}`)
  const manifestKey = path.basename(outPath)

  // Cancellation aborts upload, durable polling, or private SRT download.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    const currentAudioHash = await hashTranscriptionAudio(sourceAudio)
    const requestIdentity = `${project_slug}:${code}:transcription:${manifestKey}`
    const currentInputHash = hashInput(JSON.stringify({
      requestIdentity, audioHash: currentAudioHash, modelId: genstudio.modelId,
      language: genstudio.language, wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS,
    }))
    const result = await runSubtitleTranscription({
      job, outDir, section: 'merged', manifestKey, inputHash: currentInputHash,
      audioHash: currentAudioHash, apiKey: genstudio.apiKey, force: effectiveForce,
      generationActionId,
      manualCreditCeiling: req.subtitle_purchase?.additional_credit_ceiling,
      request: {
        audioPath: sourceAudio, modelId: genstudio.modelId, requestIdentity,
        language: genstudio.language, wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS,
        signal: controller.signal, isCancelled: () => jq.isCancelled(job.job_id),
      },
    })
    // Run the rest of the pipeline under the same try so `finally` always
    // clears the watcher interval — otherwise a parse failure would leak
    // a 500 ms timer per cancelled-during-parse job.
    return await finalizeTranscript(job, project_slug, episode_id, result.srt)
  } finally {
    clearInterval(cancelWatcher)
  }
}

/**
 * v1.0.216+ — Transcribe each chapter's clean narration audio separately into
 * `{code}_{slug}.srt`. These per-chapter SRTs (timed from 0) are what Scene
 * Plan's stitcher offsets by the known section durations + gap. Chapter audio
 * arrives as one or more MP3 parts (`{code}_{slug}_partN.mp3`); we concat a
 * chapter's parts into one temp track, transcribe it, write the SRT, repeat.
 */
/**
 * v1.2.2 — narrow a per-chapter run to an explicit chapter allow-list.
 *
 * Exists so "re-transcribe this chapter" can repair one corrupt transcript
 * without re-charging for the twelve chapters that are fine. An absent or empty
 * list means every chapter, which is the long-standing behaviour.
 *
 * A list that matches nothing throws rather than falling back to a full run.
 * Silently transcribing the whole episode when the user asked for one chapter
 * is the expensive surprise, and a wrong slug is a bug worth seeing.
 *
 * Matching is case-insensitive: the slug reaches us from a filename on a
 * case-preserving-but-insensitive filesystem, so the caller's casing and the
 * directory's casing are not guaranteed to agree.
 */
export function selectRequestedSections<T extends { slug: string }>(
  available: T[],
  requested: string[] | undefined,
): T[] {
  const wanted = Array.isArray(requested)
    ? requested.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : []
  if (!wanted.length) return available
  const selected = available.filter(s => wanted.includes(s.slug.toLowerCase()))
  if (!selected.length) {
    throw new Error(
      `None of the requested chapters have audio: ${wanted.join(', ')}. ` +
      `Available: ${available.map(s => s.slug).join(', ') || '(none)'}.`,
    )
  }
  return selected
}

export interface ChapterAudioSource {
  slug: string
  /** Exact active source order recorded by Audio Assembly. */
  files: string[]
}

/**
 * Audio Assembly owns which retained chapter bytes are active.  In particular,
 * a selected `_vN` candidate and a mixed base-plus-part chapter cannot be
 * reconstructed safely from a directory listing.
 *
 * `null` is deliberately limited to legacy sidecars with no source selection
 * at all.  Once a sidecar names any active source, an incomplete or missing
 * selection is an error rather than permission to transcribe different bytes.
 */
export async function resolveActiveSubtitleChapterSources(
  episodeDir: string,
  audioDir: string,
): Promise<ChapterAudioSource[] | null> {
  let sidecar: { sections?: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }> }
  try {
    sidecar = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8'))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`Audio Assembly's active source map cannot be read. Re-run Audio Assembly before transcription: ${error?.message || String(error)}`)
  }
  if (!Array.isArray(sidecar.sections)) return null

  const hasSourceSelection = sidecar.sections.some(section => (
    Array.isArray(section?.source_files) || section?.source_file !== undefined
  ))
  if (!hasSourceSelection) return null
  const selected: ChapterAudioSource[] = []
  const seen = new Set<string>()
  for (const section of sidecar.sections) {
    const sourceList = Array.isArray(section?.source_files)
      ? section.source_files
      : section?.source_file !== undefined ? [section.source_file] : null
    const slug = typeof section?.slug === 'string' ? section.slug.trim() : ''
    if (sourceList === null) {
      throw new Error(`Audio Assembly's active source map is missing a selected source for ${slug || 'a chapter'}. Re-run Audio Assembly before transcription.`)
    }
    const validFiles = sourceList.length > 0
      && sourceList.every(file => typeof file === 'string' && file.trim() !== '' && path.basename(file) === file)
    if (!slug || !validFiles) {
      throw new Error(`Audio Assembly's active source map is invalid for ${slug || 'a chapter'}. Re-run Audio Assembly before transcription.`)
    }
    const key = slug.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`Audio Assembly's active source map repeats ${slug}. Re-run Audio Assembly before transcription.`)
    }
    const files = sourceList.map(file => (file as string).trim())
    const available = await Promise.all(files.map(async file => {
      const stat = await fs.stat(path.join(audioDir, file)).catch(() => null)
      return !!stat?.isFile() && stat.size > 0
    }))
    if (!available.every(Boolean)) {
      throw new Error(`Audio Assembly's active source for ${slug} is missing or empty. Re-run Audio Assembly before transcription.`)
    }
    seen.add(key)
    selected.push({ slug, files })
  }
  return selected
}

async function transcribePerChapter(
  job: Job,
  projectSlug: string,
  episodeId: string,
  req: TranscribeSubtitlesRequest,
): Promise<void> {
  const code = episodeId.toUpperCase()
  const config = await pm.getConfig(projectSlug)
  if (!config) throw new Error('Project not found')

  const genstudio = await resolveGenStudioTranscription(job, req)

  // Resolve the audio dir via the reconciler (it knows the 07-folder contract),
  // then scan that dir DIRECTLY for chapter MP3s.
  //
  // v1.0.393 — we used to group `status.present` (the reconciler's view), but
  // `present` is computed by rebuilding the EXPECTED filenames from the
  // narration doc + a CHARACTER-based chunk predictor and intersecting with
  // disk. When the TTS engine chunked a chapter differently from that
  // prediction — e.g. fishaudio split TN0169's Chapter_02 into 30 sentence-sized
  // `_partN` files — none of the predicted names matched, so `present` came back
  // empty and we aborted "No chapter audio found" with the mp3s sitting right
  // there on disk. Scanning the directory with our own `partRe` finds whatever
  // chapter audio actually exists, independent of how it was chunked.
  const { getAudioStatus } = await import('../services/audio-reconciler.js')
  const status = await getAudioStatus(projectSlug, code)
  const episodePaths = await resolveEpisodePathsByCodeWithSidecar(projectSlug, episodeId, 'audio_chapters.json')
  const selectedSources = await resolveActiveSubtitleChapterSources(episodePaths.episode_dir, episodePaths.audio_dir)
  // A same-code sibling with the authoritative sidecar owns its matching audio
  // folder too. Legacy scan behavior keeps the reconciler's audio directory.
  const audioDir = selectedSources ? episodePaths.audio_dir : status.audio_dir

  // Legacy Audio Assembly sidecars only recorded durations. Keep the prior
  // directory scan for those episodes, but current sidecars below are the
  // authority for active chapter bytes.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `_vN` files are explicit alternates, not the active chapter source. A
  // transcript must stay attached to the base file until a later Audio Assembly
  // deliberately selects a different source; merely saving a new version must
  // not make existing captions look stale.
  const partRe = new RegExp(`^${esc(code)}_(.+?)(?:_part(\\d+))?\\.mp3$`, 'i')
  let dirFiles: string[]
  try {
    dirFiles = await fs.readdir(audioDir)
  } catch {
    dirFiles = []
  }
  let allSections: ChapterAudioSource[]
  if (selectedSources) {
    allSections = selectedSources
  } else {
    const bySlug = new Map<string, { slug: string; files: Array<{ name: string; part: number }> }>()
    for (const f of dirFiles) {
      if (/_v\d+\.mp3$/i.test(f)) continue
      const m = f.match(partRe)
      if (!m) continue
      const slug = m[1]!
      const part = m[2] ? parseInt(m[2], 10) : 1
      const g = bySlug.get(slug) || { slug, files: [] as Array<{ name: string; part: number }> }
      if (!g.files.some(file => file.part === part)) g.files.push({ name: f, part })
      bySlug.set(slug, g)
    }
    allSections = [...bySlug.values()].map(section => ({
      slug: section.slug,
      files: section.files.sort((a, b) => a.part - b.part).map(file => file.name),
    }))
  }
  if (!allSections.length) {
    throw new Error('No chapter audio found — generate audio (and Audio Assembly) for this episode first.')
  }

  const outDir = await resolveSubtitlesDir(projectSlug, code)
  await fs.mkdir(outDir, { recursive: true })

  const { runFfmpeg, formatConcatFileLine } = await import('../lib/ffmpeg-utils.js')
  const os = await import('os')
  const { randomUUID } = await import('crypto')

  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  let sections = selectRequestedSections(allSections, req.sections)
  const repairActionId = typeof req.pipeline_repair?.action_id === 'string'
    ? req.pipeline_repair.action_id.trim()
    : ''
  const generationActionId = req.generation_action?.kind === 'fresh'
    && typeof req.generation_action.id === 'string' && req.generation_action.id.trim()
    ? req.generation_action.id.trim()
    : undefined
  // A queued retry clears request `force`, but the server-stamped fresh action
  // remains its durable one-action authority. Treat it as force only inside
  // this job so old SRTs cannot short-circuit recovery of that same action.
  const force = repairActionId ? false : req.force === true || !!generationActionId
  const repairSections = new Set<string>()
  if (repairActionId) {
    const paths = await resolveEpisodePathsByCodeWithSidecar(projectSlug, episodeId, 'audio_chapters.json')
    const readiness = await inspectPipelineSubtitleRepairReadiness(paths.episode_dir, outDir, code)
    for (const section of readiness.affected_sections) repairSections.add(section.toLowerCase())
    // The stamped action owns its exact audited scope. Ignore a stale or
    // widened caller list so completed chapters cannot be regenerated.
    sections = allSections.filter(section => repairSections.has(section.slug.toLowerCase()))
    if (!sections.length) job.output_lines.push('Pipeline repair found no unusable subtitle source sections; existing subtitles were preserved while stitch verification continues.')
  }
  if (sections.length !== allSections.length) {
    job.output_lines.push(
      `Re-transcribing ${sections.length} of ${allSections.length} chapter(s): ${sections.map(s => s.slug).join(', ')}.`,
    )
  }
  let done = 0
  let totalCues = 0
  let generatedSections = 0
  // Preserve successful chapters when another GenStudio job fails. Completion
  // verification below names every missing section so Retry fills only gaps.
  const failures: Array<{ slug: string; error: string }> = []

  const { resolveGenStudioLocalFanout } = await import('../lib/genstudio-runtime.js')
  const admission = await refreshGenStudioAdmission(genstudio.apiKey)
  const concurrency = resolveGenStudioLocalFanout(
    sections.length,
    admission.burst_concurrency_ceiling,
  )
  job.output_lines.push(
    `Staging ${sections.length} transcription request(s); GenStudio account admission is authoritative…`,
  )

  // One chapter's transcription. (The old loop's `continue`s become `return`s.)
  async function transcribeSection(sec: ChapterAudioSource): Promise<void> {
    const outPath = path.join(outDir, `${code}_${sec.slug}.srt`)
    const repairSection = repairSections.has(sec.slug.toLowerCase())
    if (!force && !repairSection && await fileExistsWithContent(outPath)) {
      job.output_lines.push(`Skipping ${sec.slug} — SRT already exists. Tick "Re-run" to overwrite.`)
      done++; job.progress = Math.round((done / sections.length) * 100)
      return
    }

    // Order this chapter's parts; concat (re-encode, so it's robust whether
    // the parts are real MP3 or legacy WAV-in-.mp3) when there's more than one.
    let audioPath: string
    let tmpConcat: string | null = null
    let tmpList: string | null = null
    if (sec.files.length === 1) {
      audioPath = path.join(audioDir, sec.files[0]!)
    } else {
      tmpConcat = path.join(os.tmpdir(), `subt-${randomUUID()}.mp3`)
      tmpList = path.join(os.tmpdir(), `subt-${randomUUID()}.txt`)
      const listText = sec.files
        .map(file => formatConcatFileLine(path.join(audioDir, file)))
        .join('\n') + '\n'
      await fs.writeFile(tmpList, listText)
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', tmpList, '-c:a', 'libmp3lame', '-b:a', '192k', tmpConcat])
      audioPath = tmpConcat
    }

    // Guard: never hand a missing/empty file to the transcriber. This catches
    // an iCloud-evicted 0-byte placeholder part or a concat that silently
    // produced nothing — otherwise the engine just returns "zero cues" with
    // no actionable reason. Surface a clear per-chapter skip instead.
    if (!(await fileExistsWithContent(audioPath))) {
      if (tmpConcat) await fs.unlink(tmpConcat).catch(() => {})
      if (tmpList) await fs.unlink(tmpList).catch(() => {})
      job.output_lines.push(`  ⚠ ${sec.slug}: chapter audio is missing or empty (0 bytes) — skipped. Re-generate this chapter's audio.`)
      failures.push({ slug: sec.slug, error: 'chapter audio is missing or empty (0 bytes)' })
      done++; job.progress = Math.round((done / sections.length) * 100)
      return
    }

    job.output_lines.push(`Transcribing ${sec.slug} (${sec.files.length} part${sec.files.length === 1 ? '' : 's'})…`)
    try {
      const manifestKey = path.basename(outPath)
      const sourceAudioHash = await hashSubtitleAudioSources(
        sec.files.map(file => path.join(audioDir, file)),
      )
      if (!sourceAudioHash) throw new Error(`Could not fingerprint active audio for ${sec.slug}`)
      const currentAudioHash = await hashTranscriptionAudio(audioPath)
      const requestIdentity = `${projectSlug}:${code}:transcription:${manifestKey}`
      const currentInputHash = hashInput(JSON.stringify({
        requestIdentity, audioHash: currentAudioHash, modelId: genstudio.modelId,
        language: genstudio.language, wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS,
      }))
      const result = await runSubtitleTranscription({
        job, outDir, section: sec.slug, manifestKey, inputHash: currentInputHash,
        audioHash: currentAudioHash, apiKey: genstudio.apiKey, force,
        generationActionId,
        ...(repairSection ? {
          pipelineRepair: { actionId: repairActionId, isResultUsable: isPipelineRepairTranscriptUsable },
        } : {}),
        manualCreditCeiling: req.subtitle_purchase?.additional_credit_ceiling,
        request: {
          audioPath: audioPath, modelId: genstudio.modelId, requestIdentity,
          language: genstudio.language, wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS,
          signal: controller.signal, isCancelled: () => jq.isCancelled(job.job_id),
        },
      })
      const { srt, cues, warnings } = normalizeSrtOrVtt(result.srt)
      for (const w of warnings) job.output_lines.push(`  Warning (${sec.slug}): ${w}`)
      if (cues === 0) {
        job.output_lines.push(`  ⚠ ${sec.slug}: zero cues — skipped`)
        failures.push({ slug: sec.slug, error: 'transcription returned zero usable cues' })
      } else {
        await fs.writeFile(outPath, srt, 'utf-8')
        await recordSubtitleSourceEvidence(outDir, manifestKey, sourceAudioHash, result.modelId)
        totalCues += cues
        generatedSections += 1
        job.output_lines.push(`  ✓ ${sec.slug}: ${cues} cues → ${path.basename(outPath)}`)
      }
    } finally {
      if (tmpConcat) await fs.unlink(tmpConcat).catch(() => {})
      if (tmpList) await fs.unlink(tmpList).catch(() => {})
    }
    done++; job.progress = Math.round((done / sections.length) * 100)
  }

  try {
    // Bounded worker pool over the chapters. Workers stop pulling new chapters
    // on cancel; any in-flight transcribe is aborted by the cancelWatcher's
    // shared AbortController. Sequential behaviour falls out naturally at N=1.
    let nextIdx = 0
    let creditFailure: unknown
    const worker = async (): Promise<void> => {
      while (true) {
        if (jq.isCancelled(job.job_id) || creditFailure) return
        if (jq.isPauseRequested(job.job_id)) return
        const i = nextIdx++
        if (i >= sections.length) return
        const sec = sections[i]!
        try {
          await transcribeSection(sec)
        } catch (e) {
          if (isGenStudioInsufficientCredits(e)) {
            creditFailure ||= e
            return
          }
          // Cancellation aborts the in-flight transcribe via the shared
          // AbortController — that's not a chapter failure, so bail quietly and
          // let the post-loop cancel check report it.
          if (jq.isCancelled(job.job_id)) return
          const msg = (e as Error)?.message || String(e)
          failures.push({ slug: sec.slug, error: msg })
          job.output_lines.push(`  ✗ ${sec.slug}: ${msg} — skipped (re-run to fill it in).`)
          done++; job.progress = Math.round((done / sections.length) * 100)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, sections.length) }, () => worker()))
    if (creditFailure) throw creditFailure
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    jq.throwIfPauseRequested(job.job_id)
  } finally {
    clearInterval(cancelWatcher)
  }

  job.output_dir = outDir
  job.progress = 100

  // Never trust "the worker returned" as completion. Verify the files against
  // Audio Assembly's authoritative section manifest. This catches provider
  // errors, zero-cue responses, empty audio, and a whole missing audio section.
  const epaths = await resolveEpisodePathsByCodeWithSidecar(projectSlug, episodeId, 'audio_chapters.json')
  const coverage = await inspectSubtitleCompletion(
    epaths.episode_dir,
    outDir,
    code,
    { require_per_section: true },
  )
  const failedSlugs = Array.from(new Set([
    ...coverage.missing_sections,
    ...failures.map(failure => failure.slug),
  ]))
  // A fresh attempt may fail after an older SRT remains on disk. Physical file
  // coverage is useful evidence, but it cannot count as ready for this job's
  // result or Episode recovery would report a failed replacement as complete.
  const failedKeys = new Set(failedSlugs.map(slug => slug.toLowerCase()))
  const readySections = coverage.completed_sections.filter(section => !failedKeys.has(section.toLowerCase()))
  job.result = {
    subtitles_dir: outDir,
    complete: coverage.complete && failures.length === 0,
    expected_sections: coverage.expected_sections.length,
    ready_sections: readySections.length,
    generated_sections: generatedSections,
    new_cues: totalCues,
    missing_sections: failedSlugs,
    recovery_state: 'needs_attention',
  }

  if (!coverage.complete || failures.length) {
    const missingLabel = failedSlugs.length
      ? failedSlugs.join(', ')
      : 'coverage could not be verified; run Audio Assembly to rebuild audio_chapters.json'
    const message =
      `Transcription incomplete: ${readySections.length}/${coverage.expected_sections.length} sections ready. ` +
      `Missing: ${missingLabel}. Successful chapter files were saved; Retry fills only the missing sections.`
    job.output_lines.push(`✗ INCOMPLETE — ${message}`)
    throw new Error(message)
  }

  job.output_lines.push(
    `✓ Transcription complete: ${coverage.completed_sections.length}/${coverage.expected_sections.length} sections ready` +
    ` · ${generatedSections} generated now · ${totalCues} new cues → ${outDir}`,
  )

  // Auto-stitch cascade. The prerequisite gate above guarantees the exact
  // Audio Assembly sidecar is already present; never reconstruct guessed
  // timing after transcription.
  // users kept forgetting to re-stitch after a (re-)transcribe — leaving the
  // planner on a stale timeline. Roll the fresh per-chapter SRTs up into
  // {CODE}_stitched.srt right here. A stitch failure remains visible because
  // downstream Scene Plan must never consume a stale or partial timeline.
  try {
    // v1.0.397 — offset the stitched timeline by the intro lead-in so the
    // burned captions line up with the merged audio (which plays the intro
    // before any narration). Read-only against the merged file + sidecar.
    //
    // v1.3.4 — the bare `catch {}` that used to wrap this is gone. It spelled
    // "I could not work out the intro" and "there is no intro" the same way —
    // `leadIn = 0`, no log line — so a stitched timeline running sixteen
    // seconds ahead of the video reported itself as a clean success. The
    // resolver now returns a measurement and every outcome is stated below.
    // v1.4.0 — through `ensureStitchedSubtitle`, which measures the lead-in and
    // records the fingerprint of every input in the meta sidecar. A transcribe
    // has by definition just rewritten those inputs, so this always restitches;
    // routing it here is about the RECORD, so the render-time freshness check
    // finds one and does not rebuild a good file on every render.
    const { describeEpisodeIntroLeadIn } = await import('../lib/intro-lead-in.js')
    const { ensureStitchedSubtitle } = await import('../lib/subtitle-autostitch.js')
    const outcome = await ensureStitchedSubtitle({
      episodeDir: epaths.episode_dir,
      subtitlesDir: outDir,
      mergedAudioDir: epaths.merged_audio_dir,
      audioDir: epaths.audio_dir,
      episodeCode: code,
    })
    if (outcome.status !== 'stitched' && outcome.status !== 'fresh') {
      requireWrittenSubtitleStitch(outcome)
      throw new Error('Unreachable subtitle stitch state')
    }
    const timeline = await readSubtitleTimelineIntegrity(outDir, code)
    if (!timeline.complete) {
      throw new Error(`Subtitle stitch did not verify: ${timeline.missing_sections.join(', ')}. Retry the local subtitle stitch before Scene Plan.`)
    }
    job.result = { ...job.result, complete: true, stitch_complete: true, recovery_state: 'repaired' }
    job.output_lines.push(outcome.status === 'stitched'
      ? `✓ Auto-stitched ${outcome.result.total_cues} cue(s) (${outcome.result.total_duration_sec.toFixed(1)}s)` +
        ` → ${path.basename(outcome.result.output_path)}. Re-run Scene Plan to pick up the new timeline.`
      : `✓ Stitched transcript is already current → ${path.basename(outcome.path)}.`)
    job.output_lines.push(`${outcome.lead_in.status === 'measured' ? '·' : '⚠'} ${describeEpisodeIntroLeadIn(outcome.lead_in)}`)
  } catch (e: any) {
    const msg = (e as Error)?.message || String(e)
    const hint = msg.includes('audio_chapters.json not found') ? 'run Audio Assembly first' : msg
    job.result = { ...job.result, complete: false, stitch_complete: false, stitch_error: hint }
    job.output_lines.push(`✗ STITCH INCOMPLETE — ${hint}`)
    throw new Error(`Subtitle transcription is incomplete because its stitched timeline is not ready: ${hint}`)
  }
}

/**
 * Write the normalised SRT to disk. Split out from the main generator so
 * the cancel-watching `try/finally` stays readable — everything below
 * here is pure I/O with no more paid API calls.
 */
async function finalizeTranscript(
  job: Job,
  projectSlug: string,
  episodeId: string,
  srtRaw: string,
): Promise<void> {
  const code = episodeId.toUpperCase()

  // GenStudio already returns SRT, but run it through the normalizer to
  // harden against odd trailing whitespace and strip VTT-style timestamps
  // if the model ever returns them.
  const { srt, cues, warnings } = normalizeSrtOrVtt(srtRaw)
  if (warnings.length) {
    for (const w of warnings) job.output_lines.push(`Warning: ${w}`)
  }
  if (cues === 0) throw new Error('Transcript had zero valid cues')

  // Write to {episode_dir}/{subtitles_subfolder}/{code}.srt
  const outDir = await resolveSubtitlesDir(projectSlug, code)
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${code}_whisper.srt`)
  await fs.writeFile(outPath, srt, 'utf-8')

  job.output_lines.push(`Wrote ${cues} cues → ${outPath}`)
  job.output_dir = outDir
  job.progress = 100
  job.result = { srt_path: outPath, cues, complete: true, recovery_state: 'repaired' }
}

/**
 * Resolve where subtitle files live for an episode. Follows the 07→08→09→10
 * folder contract: new projects use `subfolder_names.subtitles` (default
 * "{code} - 09 Subtitles Output"). For backward compatibility, if an older
 * project already has a "{code} - 09 Subtitles" folder sitting on disk
 * (from before the rename), we keep writing there so the existing .srt
 * files aren't orphaned into a parallel folder.
 */
export async function resolveSubtitlesDir(slug: string, code: string): Promise<string> {
  const assets = await scanEpisodeAssets(slug, code).catch(() => null)
  const episodeDir = assets?.episode_dir
  const names = await resolveSubfolderNames(slug, code)

  if (!episodeDir) {
    // Tests / projects with no episode folder yet — keep the old safety path.
    const projectDir = pm.getProjectDir(slug) || process.cwd()
    return path.join(projectDir, names.script, 'subtitles')
  }

  const primary = path.join(episodeDir, names.subtitles)
  const legacy = path.join(episodeDir, `${code} - 09 Subtitles`)
  // If the legacy folder already holds content (pre-rename projects),
  // prefer it so we don't silently create a parallel "Subtitles Output"
  // folder next to the existing SRTs.
  if (existsSync(legacy) && !existsSync(primary)) return legacy
  return primary
}

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
  inspectSubtitleSourceFreshness,
  hashSubtitleAudioSources,
  isPipelineRepairTranscriptUsable,
} from '../services/subtitle-completion.js'
import { describeSubtitleGaps } from '../contracts/subtitle-gaps.js'
import { readSubtitleSourceAudioHashes, recordSubtitleSourceEvidence } from '../services/subtitle-recovery.js'
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
import { resolveGenStudioModelId, unavailableLegacyModelMessage, unavailableTranscriptionModelMessage } from '../services/genstudio-model-migration.js'
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
  audio_path?: string        // may pin Audio Assembly's authoritative merged output
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


async function hashTranscriptionAudio(audioPath: string): Promise<{
  requestHash: string
  evidenceHash: string
}> {
  const audio = await fs.readFile(audioPath)
  const raw = createHash('sha256').update(audio).digest('hex')
  return {
    // GenStudio's idempotency contract uses the raw file SHA-256.
    requestHash: `sha256:${raw}`,
    // Subtitle provenance uses the shared ordered-source hash contract, even
    // for one whole-track file. Derive it from the same read rather than
    // streaming a potentially large merged track twice.
    evidenceHash: `sha256:${createHash('sha256').update(JSON.stringify([raw])).digest('hex')}`,
  }
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
  if (!selected) throw new Error(unavailableTranscriptionModelMessage(migratedModel))
  if (!selected.available) {
    throw new Error('The selected transcription model is temporarily unavailable.')
  }
  if (selected.locked) {
    throw new Error('The selected transcription model is locked for this Gateway account. Choose an unlocked model. No request or credit charge was made.')
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

/**
 * May an existing whole-track transcript be kept instead of transcribed again?
 *
 * This was `existing.cues > 0`, and that alone was not enough for three reasons:
 *
 *  1. **No staleness check.** The per-chapter path consults `staleSections`; this
 *     one did not, so re-running Audio and then Retry left the OLD transcript in
 *     place and blessed it as current.
 *  2. **`cues > 0` is not coverage.** One cue over a 40-minute episode passed.
 *  3. It short-circuits before the stitch, which is recorded separately below.
 *
 * The check now also asks `inspectSubtitleSourceFreshness`, the same authority
 * the per-chapter path uses, so "the audio changed under this transcript" cannot
 * be skipped. Extracted as a predicate rather than inlined so the decision is
 * unit-testable without driving the generator, which would call a provider.
 */
export async function existingTranscriptIsCurrent(input: {
  projectSlug: string
  episodeId: string
  code: string
  outDir: string
  /** Audio Assembly's exact selected merge. Omitted only by legacy callers. */
  sourceAudio?: string
}): Promise<{ skip: boolean; reason: string; cues: number }> {
  const outPath = path.join(input.outDir, `${input.code}_whisper.srt`)
  let cues = 0
  try {
    cues = normalizeSrtOrVtt(await fs.readFile(outPath, 'utf-8')).cues
  } catch {
    return { skip: false, reason: 'the existing transcript could not be read', cues: 0 }
  }
  if (!(cues > 0)) return { skip: false, reason: 'the existing transcript has no valid cues', cues: 0 }

  if (input.sourceAudio) {
    const manifestKey = path.basename(outPath)
    const savedHash = (await readSubtitleSourceAudioHashes(input.outDir))[manifestKey]
    if (savedHash) {
      const currentHash = await hashSubtitleAudioSources([input.sourceAudio])
      if (!currentHash || currentHash !== savedHash) {
        return { skip: false, cues, reason: 'the authoritative merged audio changed' }
      }
    } else {
      // Migration fallback for imported and pre-provenance whole tracks. A
      // legacy transcript remains intentional unless Audio Assembly has since
      // replaced its source; cue duration is deliberately not a completeness
      // heuristic because sparse timing can be intentional.
      const statOrAbsent = async (filePath: string, label: string) => {
        try {
          return await fs.stat(filePath)
        } catch (error: any) {
          if (error?.code === 'ENOENT') return null
          throw new Error(
            `Could not inspect ${label} (${error?.code || error?.message || error}); no transcription was submitted.`,
          )
        }
      }
      const [transcriptStat, audioStat] = await Promise.all([
        statOrAbsent(outPath, 'the existing transcript'),
        statOrAbsent(input.sourceAudio, 'authoritative merged audio'),
      ])
      if (!transcriptStat || !audioStat || audioStat.mtimeMs > transcriptStat.mtimeMs) {
        return { skip: false, cues, reason: 'the authoritative merged audio changed' }
      }
    }
  }

  const epaths = await resolveEpisodePathsByCodeWithSidecar(
    input.projectSlug, input.episodeId, 'audio_chapters.json',
  )
  const freshness = await inspectSubtitleSourceFreshness(
    epaths.episode_dir, epaths.audio_dir, input.outDir, input.code,
  )
  if (freshness.stale_sections.length) {
    return {
      skip: false,
      cues,
      reason: `the audio changed for ${freshness.stale_sections.length} section(s): ${freshness.stale_sections.join(', ')}`,
    }
  }
  return { skip: true, cues, reason: `${cues} cue(s)` }
}

/**
 * Roll the per-chapter SRTs up into {CODE}_stitched.srt, and PROVE the timeline.
 *
 * Extracted so the successful-transcription path and the "transcript is already
 * current" skip path run the SAME stitch. Before this, the skip path returned at
 * :294 — before the stitch — so a job that failed the stitch was told "Retry the
 * local subtitle stitch before Scene Plan", and the Retry then skipped straight
 * back out without stitching. **The Retry could not perform the repair its own
 * error named.**
 *
 * `ensureStitchedSubtitle` owns the freshness decision and returns `'fresh'`
 * when the existing stitch is current, so calling it on the skip path is cheap
 * and idempotent. Deliberately NOT "refuse to skip when the stitch is missing":
 * falling through would re-transcribe, spending money to repair a local file.
 */
async function stitchAndVerifyTranscript(
  job: Job,
  code: string,
  epaths: Awaited<ReturnType<typeof resolveEpisodePathsByCodeWithSidecar>>,
  outDir: string,
): Promise<void> {
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

  const sourceAudio = assembly.merged_audio_path
  if (!sourceAudio) throw new Error('No authoritative merged audio file found — run Audio Assembly first')
  if (req.audio_path && path.resolve(req.audio_path) !== path.resolve(sourceAudio)) {
    throw new Error(
      `The requested audio_path is not Audio Assembly's authoritative output (${path.basename(sourceAudio)}). ` +
      'Re-run Audio Assembly or omit audio_path; no transcription was submitted or charged.',
    )
  }

  // Preserve already-verified work. GenStudio has its own durable idempotency,
  // while this file guard prevents an unnecessary new Story job entirely.
  const outDir = await resolveSubtitlesDir(project_slug, code)
  const outPath = path.join(outDir, `${code}_whisper.srt`)
  if (!effectiveForce && await fileExistsWithContent(outPath)) {
    const current = await existingTranscriptIsCurrent({
      projectSlug: project_slug, episodeId: episode_id, code, outDir, sourceAudio,
    })
    if (current.skip) {
      job.output_lines.push(`Skipping — ${code}_whisper.srt already exists and ${current.reason} were verified. Tick "Re-run transcription" to overwrite.`)
      job.output_dir = outDir
      ;(job as any).result = { srt_path: outPath, cues: current.cues, skipped: true, complete: true }
      job.progress = 100
      // THE FIX. Return only AFTER the stitch has run and been verified. The
      // skip path used to return here, before the stitch, so a job that had
      // failed the stitch was told "Retry the local subtitle stitch before
      // Scene Plan" and the Retry came straight back through this branch and
      // out again without stitching — the Retry could not perform the repair
      // its own error named.
      const skipPaths = await resolveEpisodePathsByCodeWithSidecar(
        project_slug, episode_id, 'audio_chapters.json',
      )
      await stitchAndVerifyTranscript(job, code, skipPaths, outDir)
      return
    }
    job.output_lines.push(`Existing ${code}_whisper.srt is not current — regenerating: ${current.reason}`)
  }

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project not found')

  const genstudio = await resolveGenStudioTranscription(job, req)

  job.output_lines.push(`Source: ${path.basename(sourceAudio)}`)
  const manifestKey = path.basename(outPath)

  // Cancellation aborts upload, durable polling, or private SRT download.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    const audioIdentity = await hashTranscriptionAudio(sourceAudio)
    const requestIdentity = `${project_slug}:${code}:transcription:${manifestKey}`
    const currentInputHash = hashInput(JSON.stringify({
      requestIdentity, audioHash: audioIdentity.requestHash, modelId: genstudio.modelId,
      language: genstudio.language, wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS,
    }))
    const result = await runSubtitleTranscription({
      job, outDir, section: 'merged', manifestKey, inputHash: currentInputHash,
      audioHash: audioIdentity.requestHash, apiKey: genstudio.apiKey, force: effectiveForce,
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
    return await finalizeTranscript(job, project_slug, episode_id, result.srt, {
      manifestKey,
      sourceAudioHash: audioIdentity.evidenceHash,
      modelId: result.modelId,
    })
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
  const unknown = wanted.filter(slug => !selected.some(section => section.slug.toLowerCase() === slug))
  if (unknown.length) {
    throw new Error(
      `Requested chapters have no matching audio: ${unknown.join(', ')}. ` +
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
  const staleSections = new Set((await inspectSubtitleSourceFreshness(
    episodePaths.episode_dir,
    audioDir,
    outDir,
    code,
  )).stale_sections.map(section => section.toLowerCase()))

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
  const hasPipelineContinuation = Array.isArray(job.params?.pipeline_chain) && job.params.pipeline_chain.length > 0
  const explicitlyScoped = !repairActionId && !hasPipelineContinuation && Array.isArray(req.sections)
    && req.sections.some(section => typeof section === 'string' && section.trim() !== '')
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
    `Transcribing ${sections.length} chapter(s)…`,
  )

  // One chapter's transcription. (The old loop's `continue`s become `return`s.)
  async function transcribeSection(sec: ChapterAudioSource): Promise<void> {
    const outPath = path.join(outDir, `${code}_${sec.slug}.srt`)
    const repairSection = repairSections.has(sec.slug.toLowerCase())
    if (!force && !repairSection && !staleSections.has(sec.slug.toLowerCase()) && await fileExistsWithContent(outPath)) {
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
      const currentAudioIdentity = await hashTranscriptionAudio(audioPath)
      const requestIdentity = `${projectSlug}:${code}:transcription:${manifestKey}`
      const currentInputHash = hashInput(JSON.stringify({
        requestIdentity, audioHash: currentAudioIdentity.requestHash, modelId: genstudio.modelId,
        language: genstudio.language, wordTimestamps: TRANSCRIPTION_WORD_TIMESTAMPS,
      }))
      const result = await runSubtitleTranscription({
        job, outDir, section: sec.slug, manifestKey, inputHash: currentInputHash,
        audioHash: currentAudioIdentity.requestHash, apiKey: genstudio.apiKey, force,
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
  const scopeKeys = new Set(sections.map(section => section.slug.toLowerCase()))
  const unselectedStaleKeys = new Set(Array.from(staleSections).filter(section => !scopeKeys.has(section)))
  const unselectedStaleSections = Array.from(unselectedStaleKeys).map(key => (
    allSections.find(section => section.slug.toLowerCase() === key)?.slug || key
  ))
  const completedScopeKeys = new Set(coverage.completed_sections
    .filter(section => scopeKeys.has(section.toLowerCase()))
    .map(section => section.toLowerCase()))
  const scopeMissingSections = sections
    .filter(section => !completedScopeKeys.has(section.slug.toLowerCase()))
    .map(section => section.slug)
  const scopeFailedSections = failures
    .map(failure => failure.slug)
    .filter(section => scopeKeys.has(section.toLowerCase()))
  const scopeFailedSlugs = Array.from(new Set([...scopeMissingSections, ...scopeFailedSections]))
  const scopeComplete = scopeFailedSlugs.length === 0
  // An explicitly scoped job can finish its requested work while the episode
  // still lacks other chapters or has stale unselected sources.
  const episodeComplete = coverage.complete && failures.length === 0
    && (!explicitlyScoped || unselectedStaleSections.length === 0)
  const unselectedStaleLabelKeys = new Set(unselectedStaleSections.map(section => section.toLowerCase()))
  const readySections = coverage.completed_sections.filter(section => !failedKeys.has(section.toLowerCase())
    && !unselectedStaleLabelKeys.has(section.toLowerCase()))
  const episodeMissingSlugs = Array.from(new Set([...failedSlugs, ...unselectedStaleSections]))
  job.result = {
    subtitles_dir: outDir,
    complete: explicitlyScoped ? scopeComplete : episodeComplete,
    scope_complete: scopeComplete,
    episode_complete: episodeComplete,
    scoped_sections: explicitlyScoped ? sections.map(section => section.slug) : undefined,
    ...(explicitlyScoped && !episodeComplete ? { stitch_complete: false } : {}),
    expected_sections: coverage.expected_sections.length,
    ready_sections: readySections.length,
    generated_sections: generatedSections,
    new_cues: totalCues,
    missing_sections: episodeMissingSlugs,
    recovery_state: 'needs_attention',
  }

  if (!scopeComplete || (!explicitlyScoped && !episodeComplete)) {
    const incompleteSlugs = explicitlyScoped ? scopeFailedSlugs : failedSlugs
    // A chapter whose fresh SRT exists but skips speech is not "missing":
    // name the gap so the owner knows to listen there and re-transcribe it.
    const failedNow = new Set(failures.map(failure => failure.slug.toLowerCase()))
    const gapEntries = (coverage.coverage_gaps || []).filter(entry =>
      incompleteSlugs.some(slug => slug.toLowerCase() === entry.slug.toLowerCase())
      && !failedNow.has(entry.slug.toLowerCase()))
    const gapKeys = new Set(gapEntries.map(entry => entry.slug.toLowerCase()))
    const missingSlugs = incompleteSlugs.filter(slug => !gapKeys.has(slug.toLowerCase()))
    const gapSentence = `${gapEntries.length === 1 ? 'has a gap' : 'have gaps'} where speech was not transcribed ` +
      `(${describeSubtitleGaps(gapEntries.flatMap(entry => entry.gaps.map(gap => ({ slug: entry.slug, ...gap }))))}). Open Subtitles to re-transcribe ${gapEntries.length === 1 ? 'it' : 'them'}.`
    const missingLabel = missingSlugs.length
      ? missingSlugs.join(', ')
      : 'coverage could not be verified; run Audio Assembly to rebuild audio_chapters.json'
    const message = gapEntries.length && !missingSlugs.length
      ? `Subtitles made for all ${explicitlyScoped ? sections.length : coverage.expected_sections.length} ` +
        `${explicitlyScoped ? 'requested ' : ''}chapters, but ${gapEntries.length} ${gapSentence}`
      : `Transcription incomplete: ${readySections.length}/${coverage.expected_sections.length} sections ready. ` +
        `Missing: ${missingLabel}. Successful chapter files were saved; Retry fills only the missing sections.` +
        (gapEntries.length ? ` Also, ${gapEntries.length} chapter${gapEntries.length === 1 ? '' : 's'} ${gapSentence}` : '')
    job.output_lines.push(`✗ INCOMPLETE — ${message}`)
    throw new Error(message)
  }

  if (explicitlyScoped && !episodeComplete) {
    job.output_lines.push(
      `✓ Requested subtitle sections complete: ${sections.length}/${sections.length} ready. ` +
      `Episode coverage remains incomplete (${readySections.length}/${coverage.expected_sections.length}); ` +
      'auto-stitch waits until every chapter is present and current.',
    )
    return
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
  await stitchAndVerifyTranscript(job, code, epaths, outDir)
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
  evidence?: { manifestKey: string; sourceAudioHash: string; modelId: string },
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
  if (evidence) {
    await recordSubtitleSourceEvidence(
      outDir,
      evidence.manifestKey,
      evidence.sourceAudioHash,
      evidence.modelId,
    )
  }

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

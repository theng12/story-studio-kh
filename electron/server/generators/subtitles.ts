/**
 * Subtitle generation jobs.
 *
 * `subtitles_transcribe` uses GenStudio KH as Story Studio's sole AI
 * transcription boundary. GenStudio owns Studio Hub routing, VoiceStudio
 * workers, durable polling, and private artifacts. Chapter-derived and
 * user-uploaded SRTs remain synchronous local operations.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveSubfolderNames, resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import { stitchSubtitles } from '../services/subtitle-stitcher.js'
import { inspectSubtitleCompletion } from '../services/subtitle-completion.js'
import { scanEpisodeAssets } from './video.js'
import {
  buildGenStudioTranscriptionIdempotencyKey,
  listTranscriptionModels,
  recoverTranscriptionWithGenStudio,
  transcribeWithGenStudio,
} from '../lib/genstudio-client.js'
import { normalizeSrtOrVtt } from '../lib/subtitle-builder.js'
import { fileExistsWithContent } from '../lib/http-retry.js'
import { hashInput, readManifest, recordTaskStrict } from '../services/task-manifest.js'
import { checkpointGenStudioAsset, type GenStudioRecoveryState } from '../services/genstudio-recovery.js'
import type { GenStudioTranscriptionRequest } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import type { Job } from '../models/types.js'

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
   * New work always uses GenStudio. Retired values remain accepted only so a
   * queued pre-migration job can heal onto the published GenStudio model.
   */
  engine?: 'genstudio' | 'openai' | 'voicestudio'
}

async function hashTranscriptionAudio(audioPath: string): Promise<string> {
  const audio = await fs.readFile(audioPath)
  return `sha256:${createHash('sha256').update(audio).digest('hex')}`
}

async function resolveGenStudioTranscription(
  job: Job,
  req: TranscribeSubtitlesRequest,
): Promise<{ apiKey: string; modelId: string }> {
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const apiKey = await getApiKey('genstudio')
  if (!apiKey.trim()) {
    throw new Error(
      'GenStudio KH API key not configured. Save a key with audio:transcribe in Settings → This Mac → API Keys.',
    )
  }
  let models: Awaited<ReturnType<typeof listTranscriptionModels>>
  try {
    models = await listTranscriptionModels(apiKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message}. Ensure the saved GenStudio KH key includes audio:transcribe.`,
    )
  }
  const requestedModel = req.model?.trim() || ''
  const migratedModel = resolveGenStudioModelId('transcription', requestedModel)
  if (!migratedModel) throw new Error(unavailableLegacyModelMessage('transcription', requestedModel || '(none)'))
  const selected = models.find(model => model.id === migratedModel)
  if (!selected) throw new Error(`GenStudio KH no longer publishes transcription model "${migratedModel}".`)
  if (!selected.available) {
    throw new Error(`GenStudio KH transcription model "${selected.display_name}" has no ready workers.`)
  }
  if (requestedModel !== migratedModel) {
    job.output_lines.push(`Migrated legacy transcription model ${requestedModel} → ${migratedModel}.`)
  }
  job.output_lines.push(`Engine: GenStudio KH · ${selected.display_name}`)
  return { apiKey, modelId: selected.id }
}

export async function generateSubtitlesTranscribe(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as TranscribeSubtitlesRequest
  const code = episode_id.toUpperCase()

  job.progress = 0
  job.output_lines.push(`Starting GenStudio transcription for ${code}`)

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
  if (!req.force && await fileExistsWithContent(outPath)) {
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
  const manifest = await readManifest(outDir)
  const manifestKey = path.basename(outPath)

  // Cancellation aborts upload, durable polling, or private SRT download.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    const savedTask = manifest.tasks[manifestKey]
    const currentAudioHash = await hashTranscriptionAudio(sourceAudio)
    const currentInputHash = hashInput(JSON.stringify({
      requestIdentity: `${project_slug}:${code}:transcription:${manifestKey}`,
      audioHash: currentAudioHash,
      modelId: genstudio.modelId,
      language: req.language || 'en',
      wordTimestamps: false,
    }))
    const reusableTask = savedTask?.provider === 'genstudio'
      && (savedTask.input_hash === currentInputHash
        || (!!savedTask.task_id && savedTask.input_hash === currentAudioHash))
      ? savedTask
      : null
    const requestIdentity = `${project_slug}:${code}:transcription:${manifestKey}`
    const idempotencyKey = reusableTask?.idempotency_key
      || buildGenStudioTranscriptionIdempotencyKey({
        requestIdentity,
        fileSha256: currentAudioHash.slice('sha256:'.length),
        modelId: genstudio.modelId,
        language: req.language || 'en',
      })
    const submittedAt = reusableTask?.submitted_at || new Date().toISOString()
    await recordTaskStrict(outDir, manifestKey, {
      provider: 'genstudio',
      task_id: reusableTask?.task_id || '',
      submitted_at: submittedAt,
      input_hash: currentInputHash,
      idempotency_key: idempotencyKey,
      operation: 'transcription',
      last_state: reusableTask?.last_state || 'prepared',
    })
    await checkpointGenStudioAsset(job, manifestKey, {
      operation: 'transcription',
      idempotency_key: idempotencyKey,
      ...(reusableTask?.task_id ? { job_id: reusableTask.task_id } : {}),
      state: (reusableTask?.last_state || 'prepared') as GenStudioRecoveryState,
    })
    job.output_lines.push(`GenStudio request: merged -> ${idempotencyKey}`)
    const transcriptionRequest: GenStudioTranscriptionRequest = {
      audioPath: sourceAudio,
      modelId: genstudio.modelId,
      requestIdentity,
      idempotencyKey,
      language: req.language || 'en',
      signal: controller.signal,
      isCancelled: () => jq.isCancelled(job.job_id),
      onState: async (state, providerJobId) => {
        const progressByState: Record<string, number> = {
          accepted: 10,
          reserved: 15,
          dispatched: 25,
          running: 55,
          reconciling: 55,
          validating: 85,
          succeeded: 95,
        }
        job.progress = Math.max(job.progress ?? 0, progressByState[state] || 10)
        await recordTaskStrict(outDir, manifestKey, {
          provider: 'genstudio',
          task_id: providerJobId,
          submitted_at: submittedAt,
          input_hash: currentInputHash,
          idempotency_key: idempotencyKey,
          operation: 'transcription',
          last_state: state,
        })
        await checkpointGenStudioAsset(job, manifestKey, {
          operation: 'transcription',
          idempotency_key: idempotencyKey,
          job_id: providerJobId,
          state: state as GenStudioRecoveryState,
        })
      },
      onJobAccepted: async (providerJobId: string, idempotencyKey: string, fileSha256: string) => {
        await recordTaskStrict(outDir, manifestKey, {
          provider: 'genstudio',
          task_id: providerJobId,
          submitted_at: submittedAt,
          input_hash: currentInputHash,
          idempotency_key: idempotencyKey,
          operation: 'transcription',
          last_state: 'accepted',
        })
        await checkpointGenStudioAsset(job, manifestKey, {
          operation: 'transcription',
          idempotency_key: idempotencyKey,
          job_id: providerJobId,
          state: 'accepted',
        })
        job.output_lines.push(`GenStudio task: merged -> ${providerJobId}`)
      },
    }
    const result = reusableTask?.task_id
      ? await recoverTranscriptionWithGenStudio(genstudio.apiKey, reusableTask.task_id, transcriptionRequest)
      : await transcribeWithGenStudio(genstudio.apiKey, transcriptionRequest)
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
  const audioDir = status.audio_dir

  // Group MP3s in the audio dir by section slug: `{code}_{slug}[_partN][_vN].mp3`.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Capture the optional `_vN` ("save as new version") suffix (group 3) so a
  // versioned file groups under its real chapter slug AND so we keep the NEWEST
  // file per part instead of concatenating an old + new copy of the same part.
  const partRe = new RegExp(`^${esc(code)}_(.+?)(?:_part(\\d+))?(?:_v(\\d+))?\\.mp3$`, 'i')
  let dirFiles: string[]
  try {
    dirFiles = await fs.readdir(audioDir)
  } catch {
    dirFiles = []
  }
  const bySlug = new Map<string, { slug: string; files: Array<{ name: string; part: number; version: number }> }>()
  for (const f of dirFiles) {
    const m = f.match(partRe)
    if (!m) continue
    const slug = m[1]!
    const part = m[2] ? parseInt(m[2], 10) : 1
    const version = m[3] ? parseInt(m[3], 10) : 1
    const g = bySlug.get(slug) || { slug, files: [] }
    const existing = g.files.find(x => x.part === part)
    if (existing) {
      // Same part rendered more than once (e.g. `_v2`) — keep the newest.
      if (version > existing.version) { existing.name = f; existing.version = version }
    } else {
      g.files.push({ name: f, part, version })
    }
    bySlug.set(slug, g)
  }
  if (!bySlug.size) {
    throw new Error('No chapter audio found — generate audio (and Audio Assembly) for this episode first.')
  }

  const outDir = await resolveSubtitlesDir(projectSlug, code)
  await fs.mkdir(outDir, { recursive: true })
  const transcriptionManifest = await readManifest(outDir)

  const { runFfmpeg, formatConcatFileLine } = await import('../lib/ffmpeg-utils.js')
  const os = await import('os')
  const { randomUUID } = await import('crypto')

  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  const sections = [...bySlug.values()]
  let done = 0
  let totalCues = 0
  let generatedSections = 0
  // Preserve successful chapters when another GenStudio job fails. Completion
  // verification below names every missing section so Retry fills only gaps.
  const failures: Array<{ slug: string; error: string }> = []

  // Story controls upload concurrency; GenStudio alone owns worker capacity
  // and fleet routing behind its API boundary.
  const { getConfig } = await import('../services/project-manager.js')
  const subConfig = await getConfig(projectSlug)
  const rawConc = (subConfig as any)?.subtitle_concurrency
  const concurrency = rawConc === 'auto'
    ? 3
    : Math.max(1, Math.min(50, Math.floor(Number(rawConc ?? 3) || 3)))
  const routingNote = rawConc === 'auto' ? ' (GenStudio default)' : ''
  job.output_lines.push(
    `Transcribing ${sections.length} chapter(s)` +
    (concurrency > 1 ? ` — up to ${concurrency} at a time${routingNote}` : ` (sequential${routingNote})`) + '…',
  )

  // One chapter's transcription. (The old loop's `continue`s become `return`s.)
  async function transcribeSection(sec: { slug: string; files: Array<{ name: string; part: number }> }): Promise<void> {
    const outPath = path.join(outDir, `${code}_${sec.slug}.srt`)
    if (!req.force && await fileExistsWithContent(outPath)) {
      job.output_lines.push(`Skipping ${sec.slug} — SRT already exists. Tick "Re-run" to overwrite.`)
      done++; job.progress = Math.round((done / sections.length) * 100)
      return
    }

    // Order this chapter's parts; concat (re-encode, so it's robust whether
    // the parts are real MP3 or legacy WAV-in-.mp3) when there's more than one.
    sec.files.sort((a, b) => a.part - b.part)
    let audioPath: string
    let tmpConcat: string | null = null
    let tmpList: string | null = null
    if (sec.files.length === 1) {
      audioPath = path.join(audioDir, sec.files[0]!.name)
    } else {
      tmpConcat = path.join(os.tmpdir(), `subt-${randomUUID()}.mp3`)
      tmpList = path.join(os.tmpdir(), `subt-${randomUUID()}.txt`)
      const listText = sec.files
        .map(f => formatConcatFileLine(path.join(audioDir, f.name)))
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
      const savedTask = transcriptionManifest.tasks[manifestKey]
      const currentAudioHash = await hashTranscriptionAudio(audioPath)
      const currentInputHash = hashInput(JSON.stringify({
        requestIdentity: `${projectSlug}:${code}:transcription:${manifestKey}`,
        audioHash: currentAudioHash,
        modelId: genstudio.modelId,
        language: req.language || 'en',
        wordTimestamps: false,
      }))
      const reusableTask = savedTask?.provider === 'genstudio'
        && (savedTask.input_hash === currentInputHash
          || (!!savedTask.task_id && savedTask.input_hash === currentAudioHash))
        ? savedTask
        : null
      const requestIdentity = `${projectSlug}:${code}:transcription:${manifestKey}`
      const idempotencyKey = reusableTask?.idempotency_key
        || buildGenStudioTranscriptionIdempotencyKey({
          requestIdentity,
          fileSha256: currentAudioHash.slice('sha256:'.length),
          modelId: genstudio.modelId,
          language: req.language || 'en',
        })
      const submittedAt = reusableTask?.submitted_at || new Date().toISOString()

      await recordTaskStrict(outDir, manifestKey, {
        provider: 'genstudio',
        task_id: reusableTask?.task_id || '',
        submitted_at: submittedAt,
        input_hash: currentInputHash,
        idempotency_key: idempotencyKey,
        operation: 'transcription',
        last_state: reusableTask?.last_state || 'prepared',
      })
      await checkpointGenStudioAsset(job, manifestKey, {
        operation: 'transcription',
        idempotency_key: idempotencyKey,
        ...(reusableTask?.task_id ? { job_id: reusableTask.task_id } : {}),
        state: (reusableTask?.last_state || 'prepared') as GenStudioRecoveryState,
      })
      job.output_lines.push(`  GenStudio request: ${sec.slug} -> ${idempotencyKey}`)

      const transcriptionRequest: GenStudioTranscriptionRequest = {
        audioPath,
        modelId: genstudio.modelId,
        requestIdentity,
        idempotencyKey,
        language: req.language || 'en',
        signal: controller.signal,
        isCancelled: () => jq.isCancelled(job.job_id),
        onState: async (state, providerJobId) => {
          await recordTaskStrict(outDir, manifestKey, {
            provider: 'genstudio',
            task_id: providerJobId,
            submitted_at: submittedAt,
            input_hash: currentInputHash,
            idempotency_key: idempotencyKey,
            operation: 'transcription',
            last_state: state,
          })
          await checkpointGenStudioAsset(job, manifestKey, {
            operation: 'transcription',
            idempotency_key: idempotencyKey,
            job_id: providerJobId,
            state: state as GenStudioRecoveryState,
          })
        },
        onJobAccepted: async (providerJobId: string, idempotencyKey: string, fileSha256: string) => {
          await recordTaskStrict(outDir, manifestKey, {
            provider: 'genstudio',
            task_id: providerJobId,
            submitted_at: submittedAt,
            input_hash: currentInputHash,
            idempotency_key: idempotencyKey,
            operation: 'transcription',
            last_state: 'accepted',
          })
          await checkpointGenStudioAsset(job, manifestKey, {
            operation: 'transcription',
            idempotency_key: idempotencyKey,
            job_id: providerJobId,
            state: 'accepted',
          })
          job.output_lines.push(`  GenStudio task: ${sec.slug} -> ${providerJobId}`)
        },
      }
      const result = reusableTask?.task_id
        ? await recoverTranscriptionWithGenStudio(genstudio.apiKey, reusableTask.task_id, transcriptionRequest)
        : await transcribeWithGenStudio(genstudio.apiKey, transcriptionRequest)
      const { srt, cues, warnings } = normalizeSrtOrVtt(result.srt)
      for (const w of warnings) job.output_lines.push(`  Warning (${sec.slug}): ${w}`)
      if (cues === 0) {
        job.output_lines.push(`  ⚠ ${sec.slug}: zero cues — skipped`)
        failures.push({ slug: sec.slug, error: 'transcription returned zero usable cues' })
      } else {
        await fs.writeFile(outPath, srt, 'utf-8')
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
    const worker = async (): Promise<void> => {
      while (true) {
        if (jq.isCancelled(job.job_id)) return
        if (jq.isPauseRequested(job.job_id)) return
        const i = nextIdx++
        if (i >= sections.length) return
        const sec = sections[i]!
        try {
          await transcribeSection(sec)
        } catch (e) {
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
  job.result = {
    subtitles_dir: outDir,
    complete: coverage.complete && failures.length === 0,
    expected_sections: coverage.expected_sections.length,
    ready_sections: coverage.completed_sections.length,
    generated_sections: generatedSections,
    new_cues: totalCues,
    missing_sections: failedSlugs,
  }

  if (!coverage.complete || failures.length) {
    const missingLabel = failedSlugs.length
      ? failedSlugs.join(', ')
      : 'coverage could not be verified; run Audio Assembly to rebuild audio_chapters.json'
    const message =
      `Transcription incomplete: ${coverage.completed_sections.length}/${coverage.expected_sections.length} sections ready. ` +
      `Missing: ${missingLabel}. Successful chapter files were saved; Retry fills only the missing sections.`
    job.output_lines.push(`✗ INCOMPLETE — ${message}`)
    throw new Error(message)
  }

  job.output_lines.push(
    `✓ Transcription complete: ${coverage.completed_sections.length}/${coverage.expected_sections.length} sections ready` +
    ` · ${generatedSections} generated now · ${totalCues} new cues → ${outDir}`,
  )

  // v1.0.251 — auto-stitch cascade. Scene Plan reads the STITCHED SRT, and
  // users kept forgetting to re-stitch after a (re-)transcribe — leaving the
  // planner on a stale timeline. Roll the fresh per-chapter SRTs up into
  // {CODE}_stitched.srt right here. Best-effort: a missing prerequisite (e.g.
  // audio not merged yet) logs a note but never fails the transcribe job.
  try {
    // v1.0.398 — self-heal a missing audio_chapters.json (episodes merged
    // before the sidecar was written reliably) by rebuilding it from the
    // per-chapter audio on disk, so both the lead-in read below AND the stitch
    // succeed without forcing a re-merge. No-op when the sidecar exists.
    try {
      const { ensureAudioChaptersSidecar } = await import('../lib/audio-chapters-reconstruct.js')
      const note = await ensureAudioChaptersSidecar({
        episodeDir: epaths.episode_dir,
        audioDir: epaths.audio_dir,
        mergedAudioDir: epaths.merged_audio_dir,
        episodeCode: code,
      })
      if (note) job.output_lines.push(`ℹ ${note}`)
    } catch { /* best-effort; the stitch below will report if the sidecar is still missing */ }
    // v1.0.397 — offset the stitched timeline by the intro lead-in so the
    // burned captions line up with the merged audio (which plays the intro
    // before any narration). Read-only against the merged file + sidecar.
    let leadIn = 0
    try {
      const { computeEpisodeIntroLeadInSec } = await import('../lib/intro-lead-in.js')
      leadIn = await computeEpisodeIntroLeadInSec(
        epaths.episode_dir,
        epaths.merged_audio_dir,
        code,
      )
    } catch { /* no merged audio / sidecar — leadIn stays 0 (intro-less timeline) */ }
    const r = await stitchSubtitles({
      episode_dir: epaths.episode_dir,
      subtitles_dir: outDir,
      episode_code: code,
      lead_in_sec: leadIn,
    })
    job.output_lines.push(
      `✓ Auto-stitched ${r.total_cues} cue(s) (${r.total_duration_sec.toFixed(1)}s)` +
      `${leadIn > 0 ? ` · intro lead-in ${leadIn.toFixed(1)}s applied` : ''} → ${path.basename(r.output_path)}. ` +
      `Re-run Scene Plan to pick up the new timeline.`,
    )
  } catch (e: any) {
    const msg = (e as Error)?.message || String(e)
    const hint = msg.includes('audio_chapters.json not found') ? 'run Audio Assembly first' : msg
    job.output_lines.push(`ℹ Auto-stitch skipped (${hint}). You can stitch manually in the Subtitles workspace.`)
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
  ;(job as any).result = { srt_path: outPath, cues, complete: true }
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

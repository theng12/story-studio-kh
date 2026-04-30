/**
 * Subtitle generation jobs.
 *
 * Today there's exactly one async job: `subtitles_transcribe`, which hits
 * OpenAI Whisper on the episode's merged audio and writes an SRT into the
 * episode's subtitles folder. Chapter-derived and user-uploaded SRTs are
 * synchronous and handled inside their route (no job queue needed).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveApiKeyForProviderId } from '../providers/registry.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { scanEpisodeAssets } from './video.js'
import { transcribeToSrt } from '../lib/whisper-client.js'
import { normalizeSrtOrVtt } from '../lib/subtitle-builder.js'
import { fileExistsWithContent } from '../lib/http-retry.js'
import type { Job } from '../models/types.js'

export interface TranscribeSubtitlesRequest {
  episode_id: string
  audio_path?: string        // overrides the default merged-audio discovery
  language?: string
  model?: string
  /**
   * When true, re-run Whisper even if `{code}_whisper.srt` already exists.
   * Default false: a previously-transcribed episode is silently skipped to
   * avoid re-billing the paid Whisper API. Surface in the UI as a "Re-run
   * transcription" checkbox so the user has to consciously opt into the
   * cost.
   */
  force?: boolean
}

export async function generateSubtitlesTranscribe(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as TranscribeSubtitlesRequest
  const code = episode_id.toUpperCase()

  job.progress = 0
  job.output_lines.push(`Starting Whisper transcription for ${code}`)

  // Cost-saver: if {code}_whisper.srt already exists with content, skip the
  // (paid) Whisper API call. Whisper has no manifest/recovery flow because
  // the API is one-shot (no task_id), so the only protection against
  // double-billing is this existence check. The user can pass force=true
  // (UI: "Re-run transcription") to consciously opt into the cost.
  const outDir = await resolveSubtitlesDir(project_slug, code)
  const outPath = path.join(outDir, `${code}_whisper.srt`)
  if (!req.force && await fileExistsWithContent(outPath)) {
    job.output_lines.push(`Skipping — ${code}_whisper.srt already exists. Tick "Re-run transcription" to overwrite.`)
    job.output_dir = outDir
    ;(job as any).result = { srt_path: outPath, skipped: true }
    job.progress = 100
    return
  }

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project not found')
  const apiKey = await resolveApiKeyForProviderId(project_slug, 'openai', {
    model: req.model || 'whisper',
    jobId: job.job_id,
  })
  if (!apiKey) throw new Error('OpenAI API key not configured — add it in Settings → API Keys')

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
  job.output_lines.push(`Source: ${path.basename(audioPath)}`)

  // Whisper is a single long HTTP call (30-90 s on a merged sleep-story).
  // Without cancel propagation, clicking Cancel would mark the job cancelled
  // but the OpenAI request would still complete and still bill. We poll
  // `isCancelled` every 500 ms and fire the AbortController — the SDK unwinds
  // the fetch and `transcribeToSrt` rejects with an AbortError, which the
  // queue runner then classifies as `cancelled` (not `error`) because the
  // cancelled set is populated before we abort.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    const srtRaw = await transcribeToSrt({
      apiKey,
      audioPath,
      language: req.language,
      model: req.model,
      signal: controller.signal,
      onProgress: (phase, pct) => {
        job.progress = Math.max(job.progress ?? 0, pct)
        job.output_lines.push(`Whisper: ${phase} (${pct}%)`)
      },
    })
    // Run the rest of the pipeline under the same try so `finally` always
    // clears the watcher interval — otherwise a parse failure would leak
    // a 500 ms timer per cancelled-during-parse job.
    return await finalizeTranscript(job, project_slug, episode_id, srtRaw)
  } finally {
    clearInterval(cancelWatcher)
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

  // Whisper already returns SRT, but run it through the normalizer to
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
  ;(job as any).result = { srt_path: outPath, cues }
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

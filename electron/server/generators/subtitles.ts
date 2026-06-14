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
import { resolveSubfolderNames, resolveEpisodePathsByCode } from '../services/utils.js'
import { stitchSubtitles } from '../services/subtitle-stitcher.js'
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
   * When true, re-run Whisper even if the SRT already exists. Default false:
   * a previously-transcribed episode/chapter is silently skipped to avoid
   * re-billing the paid Whisper API. Surface in the UI as a "Re-run
   * transcription" checkbox so the user consciously opts into the cost.
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
   * v1.0.217+ — which transcription engine to use:
   *   - 'voicestudio' → the local Voice Studio modal's Whisper STT (free; for
   *     `model` pass a Whisper repo, defaulting to the modal's default_model).
   *   - 'openai'      → the paid OpenAI Whisper API (the always-available
   *     fallback). Default when unset, for backward compat.
   * The user picks per the Subtitles tab; there is no silent auto-default to
   * either in the UI.
   */
  engine?: 'openai' | 'voicestudio'
}

export async function generateSubtitlesTranscribe(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as TranscribeSubtitlesRequest
  const code = episode_id.toUpperCase()

  job.progress = 0
  job.output_lines.push(`Starting Whisper transcription for ${code}`)

  // v1.0.216+ — Per-chapter mode (audio-paced pipeline). Routed before the
  // merged-audio path: transcribe each chapter's clean narration into
  // {code}_{slug}.srt for Scene Plan's stitcher to consume.
  if (req.per_chapter) {
    return await transcribePerChapter(job, project_slug, episode_id, req)
  }

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

  // v1.0.217+ — resolve the chosen engine up front. 'voicestudio' uses the
  // local modal's free Whisper STT; 'openai' is the paid fallback.
  const engine = req.engine === 'voicestudio' ? 'voicestudio' : 'openai'
  const { transcribeFile, DEFAULT_VOICESTUDIO_BASE_URL, runOnTranscribePool } =
    await import('../lib/voicestudio-client.js')
  let apiKey = ''            // OpenAI key (openai engine)
  let vsStoredUrl = ''       // Voice Studio modal URL list (voicestudio engine)
  let vsModel = req.model    // requested Whisper repo (voicestudio engine)

  if (engine === 'voicestudio') {
    const { getApiKey } = await import('../services/app-secrets-store.js')
    // v1.0.348 — keep the URL list intact. The per-chapter call below uses
    // the shared least-busy transcription dispatcher, so separate episode jobs
    // can run on separate Macs instead of every job choosing endpoint #1.
    vsStoredUrl = (await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
    if (!vsStoredUrl) {
      throw new Error('Voice Studio URL not set — add it in Settings → This Mac → Local Models.')
    }
    job.output_lines.push(`Engine: Voice Studio (local pool) · ${vsModel || 'default Whisper model'}`)
  } else {
    apiKey = await resolveApiKeyForProviderId(projectSlug, 'openai', {
      model: req.model || 'whisper',
      jobId: job.job_id,
    })
    if (!apiKey) throw new Error('OpenAI API key not configured — add it in Settings → API Keys')
    job.output_lines.push('Engine: OpenAI Whisper API')
  }

  // Source the chapter audio files (+ their dir) from the reconciler's view.
  const { getAudioStatus } = await import('../services/audio-reconciler.js')
  const status = await getAudioStatus(projectSlug, code)
  const audioDir = status.audio_dir

  // Group present chapter MP3s by section slug: `{code}_{slug}[_partN].mp3`.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Tolerate the optional `_vN` suffix that "save as new version" audio runs
  // append, so a versioned file groups under its real chapter slug instead of
  // inventing a phantom chapter (e.g. `Chapter_01_v2`).
  const partRe = new RegExp(`^${esc(code)}_(.+?)(?:_part(\\d+))?(?:_v\\d+)?\\.mp3$`, 'i')
  const bySlug = new Map<string, { slug: string; files: Array<{ name: string; part: number }> }>()
  for (const f of status.present) {
    const m = f.match(partRe)
    if (!m) continue
    const slug = m[1]!
    const part = m[2] ? parseInt(m[2], 10) : 1
    const g = bySlug.get(slug) || { slug, files: [] }
    g.files.push({ name: f, part })
    bySlug.set(slug, g)
  }
  if (!bySlug.size) {
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

  const sections = [...bySlug.values()]
  let done = 0
  let totalCues = 0

  // v1.0.389/390 — per-chapter transcription concurrency (Settings → Performance
  // → Subtitle Concurrency). Voice Studio fans chapters across its endpoint pool;
  // cloud Whisper parallelises requests. Value is a number (clamped 1–16) or
  // 'auto'. DEFAULT 'auto': match the live pool — one transcription per ready
  // Voice Studio Mac (self-healing: the dispatcher fails a dropped Mac over),
  // or 3 for cloud Whisper. A single local machine → 1 = sequential.
  const { getConfig } = await import('../services/project-manager.js')
  const subConfig = await getConfig(projectSlug)
  const rawConc = (subConfig as any)?.subtitle_concurrency
  const isAuto = rawConc === 'auto' || rawConc == null
  let concurrency: number
  if (isAuto) {
    if (engine === 'voicestudio') {
      const { readyTranscribeEndpointCount } = await import('../lib/voicestudio-client.js')
      const n = await readyTranscribeEndpointCount(vsStoredUrl, vsModel).catch(() => 1)
      concurrency = Math.max(1, Math.min(50, n || 1))
    } else {
      concurrency = 3  // cloud Whisper — safe parallel default
    }
  } else {
    concurrency = Math.max(1, Math.min(50, Math.floor(Number(rawConc) || 1)))
  }
  const autoNote = isAuto ? (engine === 'voicestudio' ? ` (auto — ${concurrency} online Mac${concurrency === 1 ? '' : 's'})` : ' (auto)') : ''
  job.output_lines.push(
    `Transcribing ${sections.length} chapter(s)` +
    (concurrency > 1 ? ` — up to ${concurrency} at a time${autoNote}` : ` (sequential${autoNote})`) + '…',
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
      done++; job.progress = Math.round((done / sections.length) * 100)
      return
    }

    job.output_lines.push(`Transcribing ${sec.slug} (${sec.files.length} part${sec.files.length === 1 ? '' : 's'})…`)
    try {
      let srtRaw: string
      if (engine === 'voicestudio') {
        const result = await runOnTranscribePool(vsStoredUrl, vsModel, async (endpoint, model) => {
          job.output_lines.push(`  Voice Studio endpoint: ${endpoint} · ${model}`)
          vsModel = model
          return transcribeFile(endpoint, audioPath, {
            model,
            language: req.language || 'en',
            signal: controller.signal,
          })
        })
        srtRaw = result.srt
      } else {
        srtRaw = await transcribeToSrt({
          apiKey,
          audioPath,
          language: req.language,
          model: req.model,
          signal: controller.signal,
        })
      }
      const { srt, cues, warnings } = normalizeSrtOrVtt(srtRaw)
      for (const w of warnings) job.output_lines.push(`  Warning (${sec.slug}): ${w}`)
      if (cues === 0) {
        job.output_lines.push(`  ⚠ ${sec.slug}: zero cues — skipped`)
      } else {
        await fs.writeFile(outPath, srt, 'utf-8')
        totalCues += cues
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
        const i = nextIdx++
        if (i >= sections.length) return
        await transcribeSection(sections[i]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, sections.length) }, () => worker()))
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
  } finally {
    clearInterval(cancelWatcher)
  }

  if (totalCues === 0) throw new Error('No cues produced — every chapter transcript was empty.')
  job.output_dir = outDir
  job.progress = 100
  job.output_lines.push(
    `Per-chapter transcription complete: ${sections.length} chapter(s), ${totalCues} cues total → ${outDir}`,
  )
  ;(job as any).result = { subtitles_dir: outDir, chapters: sections.length, cues: totalCues }

  // v1.0.251 — auto-stitch cascade. Scene Plan reads the STITCHED SRT, and
  // users kept forgetting to re-stitch after a (re-)transcribe — leaving the
  // planner on a stale timeline. Roll the fresh per-chapter SRTs up into
  // {CODE}_stitched.srt right here. Best-effort: a missing prerequisite (e.g.
  // audio not merged yet) logs a note but never fails the transcribe job.
  try {
    const epaths = await resolveEpisodePathsByCode(projectSlug, episodeId)
    const r = await stitchSubtitles({
      episode_dir: epaths.episode_dir,
      subtitles_dir: outDir,
      episode_code: code,
    })
    job.output_lines.push(
      `✓ Auto-stitched ${r.total_cues} cue(s) (${r.total_duration_sec.toFixed(1)}s) → ${path.basename(r.output_path)}. ` +
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

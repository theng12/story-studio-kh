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

  // v1.0.393 — honour the chosen engine on the merged-audio path too. This used
  // to ALWAYS call OpenAI, so a Voice Studio job that ran here (or a retry of
  // one) silently billed OpenAI — or failed "400 invalid model ID" when it
  // forwarded the local Whisper repo. Now 'voicestudio' transcribes the merged
  // file on the same local Mac pool the per-chapter path uses; OpenAI is only
  // touched when the user explicitly picked the OpenAI engine.
  const engine = req.engine === 'voicestudio' ? 'voicestudio' : 'openai'

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

  // Whisper is a single long HTTP call (30-90 s on a merged sleep-story).
  // Without cancel propagation, clicking Cancel would mark the job cancelled
  // but the request would still complete (and still bill, on OpenAI). We poll
  // `isCancelled` every 500 ms and fire the AbortController — the client unwinds
  // the in-flight fetch and the transcribe call rejects with an AbortError,
  // which the queue runner classifies as `cancelled` (not `error`) because the
  // cancelled set is populated before we abort.
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)

  try {
    let srtRaw: string
    if (engine === 'voicestudio') {
      // Same local-pool dispatcher the per-chapter path uses: least-busy Mac
      // with mid-job failover. Never falls back to OpenAI.
      const { getApiKey } = await import('../services/app-secrets-store.js')
      const { transcribeFile, DEFAULT_VOICESTUDIO_BASE_URL, runOnTranscribePool } =
        await import('../lib/voicestudio-client.js')
      const vsStoredUrl = (await getApiKey('voicestudio')) || DEFAULT_VOICESTUDIO_BASE_URL
      if (!vsStoredUrl) {
        throw new Error('Voice Studio URL not set — add it in Settings → This Mac → Local Models.')
      }
      job.output_lines.push(`Engine: Voice Studio (local pool) · ${req.model || 'default Whisper model'}`)
      job.progress = Math.max(job.progress ?? 0, 10)
      const result = await runOnTranscribePool(vsStoredUrl, req.model, async (endpoint, model) => {
        job.output_lines.push(`Voice Studio endpoint: ${endpoint} · ${model}`)
        return transcribeFile(endpoint, sourceAudio, {
          model,
          language: req.language || 'en',
          signal: controller.signal,
        })
      })
      srtRaw = result.srt
      job.progress = Math.max(job.progress ?? 0, 90)
    } else {
      const apiKey = await resolveApiKeyForProviderId(project_slug, 'openai', {
        model: req.model || 'whisper',
        jobId: job.job_id,
      })
      if (!apiKey) throw new Error('OpenAI API key not configured — add it in Settings → API Keys')
      job.output_lines.push('Engine: OpenAI Whisper API')
      srtRaw = await transcribeToSrt({
        apiKey,
        audioPath: sourceAudio,
        language: req.language,
        model: req.model,
        signal: controller.signal,
        onProgress: (phase, pct) => {
          job.progress = Math.max(job.progress ?? 0, pct)
          job.output_lines.push(`Whisper: ${phase} (${pct}%)`)
        },
      })
    }
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
  // v1.0.393 — per-chapter failure isolation. A chapter whose transcription
  // exhausts the Voice Studio pool's failover (e.g. a Mac slept mid-request and
  // the pool was momentarily empty) used to THROW out of the worker, rejecting
  // the whole `Promise.all` and discarding every chapter that already
  // succeeded. We now record the failure and keep going — mirroring the
  // zero-cue / missing-audio skip paths — so good chapters are written and the
  // user can re-run to fill in just the stragglers (existing SRTs are skipped).
  const failures: Array<{ slug: string; error: string }> = []

  // v1.0.389/390 — per-chapter transcription concurrency (Settings → Performance
  // → Subtitle Concurrency). Voice Studio fans chapters across its endpoint pool;
  // cloud Whisper parallelises requests. Value is a number (clamped 1–50) or
  // 'auto'. New projects default to 3; Auto remains available to match the live
  // Voice Studio pool (with dispatcher failover) or use 3 for cloud Whisper.
  const { getConfig } = await import('../services/project-manager.js')
  const subConfig = await getConfig(projectSlug)
  const rawConc = (subConfig as any)?.subtitle_concurrency
  const isAuto = rawConc === 'auto'
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
    concurrency = Math.max(1, Math.min(50, Math.floor(Number(rawConc ?? 3) || 3)))
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
  } finally {
    clearInterval(cancelWatcher)
  }

  // Only hard-fail when NOTHING usable came out. If some chapters succeeded we
  // keep their SRTs and report which ones to retry — one unreachable Mac no
  // longer throws away a near-complete episode.
  if (totalCues === 0) {
    if (failures.length) {
      throw new Error(
        `All ${failures.length} chapter(s) failed to transcribe. First error: ${failures[0]!.error}`,
      )
    }
    throw new Error('No cues produced — every chapter transcript was empty.')
  }
  if (failures.length) {
    job.output_lines.push(
      `⚠ ${failures.length} of ${sections.length} chapter(s) failed: ${failures.map(f => f.slug).join(', ')}. ` +
      `Re-run transcription for this episode to fill in just these — chapters with an existing SRT are skipped.`,
    )
  }
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

/**
 * Video generator — multi-pass pipeline for assembling scene images + narration + logo + music.
 *
 * Architecture (replaces the old single filter_complex approach):
 *   1. Prep phase   — generate short video clips from each scene image
 *   2. Concat phase — build a concat list that cycles scenes to fill target duration
 *   3. Final phase  — single FFmpeg command: concat + logo overlay + audio mix
 *
 * This scales to 3-hour videos with recycled scenes without blowing up the filter graph.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import * as pm from '../services/project-manager.js'
import { trackChild } from '../services/job-queue.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { runFfmpeg, getAudioDuration, checkFfmpeg, hasDrawtextFilter, formatConcatFileLine } from '../lib/ffmpeg-utils.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { assertValidMedia, getMediaInfo, summarizeMedia, fileExistsNonEmpty } from '../lib/ffmpeg-validation.js'
import { planTransitions, buildXfadeFilterComplex } from '../lib/transition-filters.js'
import { getTransition } from '../models/transitions.js'
import { buildAnimationFilter, supersampleMultiplier, normalizeFrame } from '../lib/animation-filters.js'
import { getAnimation } from '../models/animations.js'
import { resolveAssetPath, isPortablePath } from '../services/path-resolver.js'
import { checkAssetAvailability } from '../lib/sync-safe.js'
import { estimateBytesForStep, getFreeBytes, formatBytes } from '../lib/disk.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import type {
  GenerateVideoRequest, Job, VideoLogoConfig, VideoIntroConfig,
  VideoOutroConfig, VideoTimelineClip, VideoTimelineClipStatic, TimelineAnchor,
  VideoTitleImageConfig, VideoSceneRecycling, VideoMusicConfig,
  VideoDurationConfig, VideoColorGrading, VideoVignetteConfig,
  VideoChromaKeyConfig, VideoOverlaysConfig, VideoOverlay, VideoBackgroundNoise, VideoFilmGrain, VideoLetterbox,
  BackgroundPlate, ForegroundDefaults, ForegroundPosition,
  VideoSceneAnimation, VideoPostAudio,
} from '../models/types.js'

// ── Constants ──────────────────────────────────────────────────────────────

const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  '720p':  { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '1440p': { w: 2560, h: 1440 },
  '4k':    { w: 3840, h: 2160 },
}

/**
 * Quality tier → default (CRF, x264/x265 preset) pair.
 *
 *   `compact` — new in this release. CRF 32 is right at the edge of where
 *               macroblocks start to show on still-image content (sleep
 *               stories with slow motion). File size is ~half of `fast`
 *               and YouTube re-transcodes to VP9 regardless, so the quality
 *               loss is mostly invisible on upload.
 *   `fast`    — historical default. Reasonable quality for local review.
 *   `medium`  — YouTube's sweet spot when you want a clean master.
 *   `high`    — near-visually-lossless for archival.
 *
 * Callers can override the preset independently via `encoding_effort`.
 */
const QUALITY_PRESETS: Record<string, { crf: number; preset: string }> = {
  compact: { crf: 32, preset: 'ultrafast' },
  fast:    { crf: 28, preset: 'ultrafast' },
  medium:  { crf: 23, preset: 'medium' },
  high:    { crf: 18, preset: 'slow' },
}

const DEFAULT_FPS = 30

/**
 * Pure builder for the codec/audio/pixfmt portion of the final encode argv.
 * Pulled out of `runFinalComposition` so it can be snapshot-tested against a
 * silent flag flip (wrong codec, wrong CRF, wrong preset, missing
 * `+faststart`, etc.) without spawning ffmpeg or constructing a full episode.
 *
 * Inputs map 1:1 onto the closure variables that used to drive the inline
 * builder; the call site in `runFinalComposition` now delegates here.
 */
/**
 * Summarise the total runtime of all user-supplied timeline clips so a
 * long after-scenes tail (a sleep-story staple — 1-3 hours of ambient
 * footage layered over post-narration silence) is visible in the job
 * log before the encode starts. Originally written as a hard abort
 * after a 7212s clip blew through the encode watchdog, but sleep
 * stories deliberately ship 2-hour tails and aborting was wrong: the
 * fix landed in the watchdog instead (it scales with output duration
 * now). Kept as a warn-only summary so the operator gets a heads-up
 * about expected wall-clock time without losing the run.
 *
 * Pure helper — exported separately from `generateVideo` so it can be
 * unit-tested without spawning ffmpeg or building an episode fixture.
 */
export type TimelineClipForCheck = { path: string; duration: number; anchor: string }
export type TimelineSanityResult = { warning?: string }

export function checkTimelineDurationSanity(
  clips: TimelineClipForCheck[],
  referenceDuration: number,
): TimelineSanityResult {
  if (clips.length === 0) return {}
  const totalTimelineDur = clips.reduce((s, c) => s + c.duration, 0)
  if (totalTimelineDur <= referenceDuration) return {}
  // Long-tail surface area — common for sleep-story channels. Surface
  // the expected output length up-front so the user reads the right
  // number in the job log and isn't confused by a hours-long encode.
  const totalMin = (totalTimelineDur / 60).toFixed(1)
  const finalMin = ((totalTimelineDur + referenceDuration) / 60).toFixed(1)
  return {
    warning:
      `Timeline clips total ${totalTimelineDur.toFixed(1)}s (~${totalMin} min) — longer than the narration ` +
      `(${(referenceDuration / 60).toFixed(1)} min). Final video will be ~${finalMin} min; encode wall-clock ` +
      `scales with that. The ffmpeg watchdog auto-extends for long renders, so this will run to completion.`,
  }
}

/**
 * Wall-clock budget for a single ffmpeg encode invocation, scaled by the
 * intended output duration. Pure: takes `outputDurationSec` (the value
 * passed to ffmpeg's `-t`) and the optional env override, returns ms.
 *
 * Floor 30 min keeps short videos safe; ceiling 12h prevents a truly
 * runaway process from holding the queue forever. Between the bounds:
 *   1.5× output + 5 min buffer
 * — derived from observed encode rates on M-series Macs at libx264
 * `medium` preset (≈1.2-1.5× real-time). 2026-04-28 case study: a
 * 9219s output needed ~2.1h wall-clock; the formula gives 14129 ms ×
 * 1000 ≈ 235 min ≈ 3.9h, comfortable headroom on a slower CPU too.
 */
export function computeWatchdogMs(
  outputDurationSec: number,
  envOverrideMs?: string | undefined,
): number {
  if (envOverrideMs) {
    const n = Number(envOverrideMs)
    if (Number.isFinite(n) && n > 0) return n
  }
  const FLOOR_MS = 30 * 60_000          // 30 min
  const CEILING_MS = 12 * 3600 * 1000   // 12 hours
  if (!Number.isFinite(outputDurationSec) || outputDurationSec <= 0) return FLOOR_MS
  const scaled = Math.ceil(outputDurationSec * 1.5 * 1000) + 5 * 60_000
  return Math.min(CEILING_MS, Math.max(FLOOR_MS, scaled))
}

/**
 * Map a libx264 CRF value to an h264_videotoolbox `-q:v` value.
 *
 * libx264 uses CRF on a 0-51 scale (lower = better). videotoolbox uses
 * `-q:v` on a 0-100 scale (higher = better). The mapping below is
 * empirically calibrated against typical 1080p output for sleep-story
 * footage — slightly biased toward higher q:v than a strict linear map
 * because Apple's hardware encoder is more compression-efficient at the
 * upper quality end than libx264 is. Output: clamped to [25, 90].
 *
 *   CRF 18 (high)    → q:v 80   (visually transparent)
 *   CRF 23 (medium)  → q:v 65   (good for streaming / sleep videos)
 *   CRF 28 (low)     → q:v 50
 *   CRF 32 (drafty)  → q:v 38
 */
export function crfToVideotoolboxQ(crf: number): number {
  // Linear: q:v = 80 - (crf - 18) × 3, clamped.
  const raw = 80 - (crf - 18) * 3
  return Math.max(25, Math.min(90, Math.round(raw)))
}

export function buildEncoderArgs(opts: {
  codec: 'h264' | 'h265'
  format: 'mp4' | 'mov' | 'webm' | string
  crf: number
  effort: string
}): string[] {
  const { codec, format, crf, effort } = opts
  if (format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9', '-crf', crf.toString(), '-b:v', '0',
      '-c:a', 'libopus',
    ]
  }
  // Hardware-accelerated path — h264_videotoolbox routes the encode
  // through Apple's Media Engine silicon, ~8-15× faster on M-series
  // Macs than libx264 medium. Quality at the same bitrate is ~5-10%
  // worse than libx264 (Apple trades compression efficiency for speed),
  // but for sleep-story footage — long, mostly static, low motion —
  // the difference is functionally invisible. Falls back to libx264
  // through the existing tier-2/3 recovery chain if videotoolbox fails
  // to initialise (e.g. very old Intel Macs without the right
  // hardware-encode entitlement). Only h264 is offered here; we don't
  // pair the hardware path with h265 because hevc_videotoolbox quality
  // varies more across hardware generations.
  if (effort === 'hardware') {
    return [
      '-c:v', 'h264_videotoolbox',
      // q:v drives quality on videotoolbox (no CRF support). The map
      // above tunes for parity with the operator's CRF expectations.
      '-q:v', crfToVideotoolboxQ(crf).toString(),
      // Permit ffmpeg's own software fallback if the hardware path
      // can't open the session — a second safety net beneath the
      // tier-2/3 recovery chain.
      '-allow_sw', '1',
      '-c:a', 'aac', '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ]
  }
  if (codec === 'h265') {
    // HEVC. `-tag:v hvc1` makes the .mp4 playable in QuickTime/Safari —
    // without the tag it plays in VLC only.
    return [
      '-c:v', 'libx265', '-crf', crf.toString(), '-preset', effort,
      '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ]
  }
  return [
    '-c:v', 'libx264', '-crf', crf.toString(), '-preset', effort,
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  ]
}

/**
 * Build the `:enable='<expr>'` suffix that FFmpeg filters like `noise`,
 * `eq`, `vignette`, `subtitles`, and `overlay` accept to time-gate their
 * application. Cheap pure string op — no I/O.
 *
 *   start > 0, end > 0 → `between(t,start,end)`
 *   start > 0          → `gt(t,start)`
 *   end   > 0          → `lt(t,end)`
 *   both zero          → `''`  (no gate; filter applies to every frame)
 *
 * Used to keep intro/title/outro/post-audio segments free of colour
 * grading, grain, vignette, chroma, subtitles, and logo — the user's
 * branded or flat-black content shouldn't get stylised.
 */
function buildGateEnable(start: number, end: number): string {
  if (start > 0 && end > 0) return `:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`
  if (start > 0)            return `:enable='gt(t,${start.toFixed(2)})'`
  if (end > 0)              return `:enable='lt(t,${end.toFixed(2)})'`
  return ''
}

// ── Portable-path expansion ────────────────────────────────────────────────
// Walks the fields of a GenerateVideoRequest that carry user-supplied file
// paths and expands portable forms (`${PROJECT}/foo`, `${TERRANASH}/bar`) to
// absolute paths for this machine. Mutates `req` in place so downstream
// code (existsSync, ffmpeg -i arg builders) doesn't need to know about
// portable paths at all. Legacy absolute paths pass through unchanged.
//
// When a `${NAME}` variable isn't defined on this machine, we log a warning
// to the job output panel and blank the field so the generator silently
// skips that asset — same behaviour as an absent file. The user sees the
// log line and knows to define the named root in Settings.
function resolveAssetPathsInPlace(req: GenerateVideoRequest, outputRoot: string, job: Job): void {
  const tryResolve = (p: string | undefined, label: string): string | undefined => {
    if (!p || !isPortablePath(p)) return p
    try {
      return resolveAssetPath(p, outputRoot)
    } catch (e: any) {
      job.output_lines.push(`⚠ ${label}: ${e.message}`)
      return undefined
    }
  }
  if (req.title_image?.image_path) {
    req.title_image.image_path = tryResolve(req.title_image.image_path, 'title_image.image_path') || ''
  }
  if (req.intro?.video_path) {
    req.intro.video_path = tryResolve(req.intro.video_path, 'intro.video_path') || ''
  }
  if (req.outro?.video_path) {
    req.outro.video_path = tryResolve(req.outro.video_path, 'outro.video_path') || ''
  }
  if (req.logo?.image_path) {
    req.logo.image_path = tryResolve(req.logo.image_path, 'logo.image_path') || ''
  }
  if (req.chroma_key?.source_path) {
    req.chroma_key.source_path = tryResolve(req.chroma_key.source_path, 'chroma_key.source_path') || ''
  }
  if (req.background_noise?.custom_file) {
    req.background_noise.custom_file = tryResolve(req.background_noise.custom_file, 'background_noise.custom_file') || ''
  }
  if (req.music?.files?.length) {
    req.music.files = req.music.files
      .map((f, i) => tryResolve(f, `music.files[${i}]`) || '')
      .filter(Boolean)
  }
  // User-supplied timeline clips (before_intro / after_intro / after_scenes /
  // after_outro). Resolve each path; drop rows whose portable token can't be
  // expanded on this machine (same "warn + skip" pattern as above). Don't
  // drop rows whose path is legit-but-not-yet-existing — that existence
  // check happens later in prepareTimelineClips alongside intro/outro.
  if (req.timeline_clips?.length) {
    req.timeline_clips = req.timeline_clips
      .map((c, i) => {
        // Static clips carry image_path; classic clips carry video_path.
        // Resolve whichever this row uses; drop the row if the portable
        // token can't expand on this machine.
        if (c.kind === 'static') {
          const resolved = tryResolve(c.image_path, `timeline_clips[${i}].image_path`)
          return resolved ? { ...c, image_path: resolved } : null
        }
        const resolved = tryResolve(c.video_path, `timeline_clips[${i}].video_path`)
        return resolved ? { ...c, video_path: resolved } : null
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
  }
  // Scene paths come from the scanner (always absolute) so we skip them.
}

// ── Scanned Assets Interface ───────────────────────────────────────────────

interface ScannedAssets {
  scenes: Array<{ filename: string; path: string; number: number; width?: number; height?: number }>
  thumbnails: Array<{ filename: string; path: string; number: number }>
  audio_sections: Array<{ filename: string; path: string; label: string; duration?: number }>
  narration_full?: { path: string; duration: number }
  merged_audio: Array<{ filename: string; path: string; duration?: number }>
  intro_videos: Array<{ filename: string; path: string }>
  music_files: Array<{ filename: string; path: string; duration?: number }>
  rendered_videos: Array<{ filename: string; path: string; mtime: number }>
  episode_dir: string
  video_dir: string
  // When true, intro/chapter audio files are bypassed in favor of merged_audio.
  // The audio assembly step is now upstream; raw chapters should not be remuxed here.
  skip_chapters: boolean
}

// Re-export checkFfmpeg for routes that import from this module
export { checkFfmpeg } from '../lib/ffmpeg-utils.js'

// ── Scan Episode Assets ────────────────────────────────────────────────────

export async function scanEpisodeAssets(slug: string, episodeId: string): Promise<ScannedAssets> {
  const code = episodeId.toUpperCase()
  const projectDir = pm.getProjectDir(slug)
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!projectDir || !outputRoot) throw new Error('Project directory not found')

  const names = await resolveSubfolderNames(slug, code)

  // Look up the canonical title from the ideas store so findEpisodeDir
  // can disambiguate when the user has multiple folders starting with the
  // same {code} prefix (e.g. leftover from a rename).
  let titleHint: string | undefined
  try {
    const im = await import('../services/idea-manager.js')
    const ideas = await im.getIdeas(slug, 'accepted')
    const match = ideas.find(i => i.episode_code === code)
    if (match?.title) titleHint = match.title
  } catch { /* fall back to code-only match */ }

  const episodeDir = await findEpisodeDir(outputRoot, code, titleHint)
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  const imagesDir = await resolveSubfolder(episodeDir, names.images)
  const thumbsDir = await resolveSubfolder(episodeDir, names.thumbnails)
  const audioDir = await resolveSubfolder(episodeDir, names.audio)
  const mergedAudioDir = await resolveSubfolder(episodeDir, names.merged_audio)
  const videoDir = await resolveSubfolder(episodeDir, names.video)

  const result: ScannedAssets = {
    scenes: [],
    thumbnails: [],
    audio_sections: [],
    merged_audio: [],
    intro_videos: [],
    music_files: [],
    rendered_videos: [],
    episode_dir: episodeDir,
    video_dir: videoDir || path.join(episodeDir, names.video),
    skip_chapters: false,
  }

  // Scan scene images
  if (imagesDir) {
    const files = await safeReaddir(imagesDir)
    for (const file of files) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue
      const num = extractSceneNumber(file)
      if (num !== null) {
        result.scenes.push({
          filename: file,
          path: path.join(imagesDir, file),
          number: num,
        })
      }
    }
    result.scenes.sort((a, b) => a.number - b.number)
  }

  // Scan thumbnails
  if (thumbsDir) {
    const files = await safeReaddir(thumbsDir)
    for (const file of files) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue
      const num = extractSceneNumber(file)
      if (num !== null) {
        result.thumbnails.push({
          filename: file,
          path: path.join(thumbsDir, file),
          number: num,
        })
      }
    }
    result.thumbnails.sort((a, b) => a.number - b.number)
  }

  // Scan audio files. Legacy projects store both chapter clips and the
  // merged output in the same "07 Audio Assets" folder — filter anything
  // matching *_merged_audio* off to the merged_audio array instead of the
  // chapters list so the video pipeline picks the merged track.
  const isMergedFilename = (name: string) => /_merged_audio(?:_v\d+)?\.(mp3|wav|m4a)$/i.test(name)

  if (audioDir) {
    const files = await safeReaddir(audioDir)
    let fullNarrationPath: string | undefined

    for (const file of files) {
      if (!/\.(mp3|wav|m4a)$/i.test(file)) continue
      const filePath = path.join(audioDir, file)
      const duration = await getAudioDuration(filePath)

      // Merged-audio files sometimes live in the chapter folder (legacy layout).
      // Route them to the merged_audio list so downstream logic sees them.
      if (isMergedFilename(file)) {
        result.merged_audio.push({ filename: file, path: filePath, duration })
        continue
      }

      if (!/\.mp3$/i.test(file)) continue

      const label = file
        .replace(/^[A-Z]+\d+_/, '')
        .replace(/\.mp3$/i, '')
        .replace(/_/g, ' ')

      result.audio_sections.push({
        filename: file,
        path: filePath,
        label,
        duration,
      })

      if (file.toLowerCase().includes('full') || file.toLowerCase().includes('narration')) {
        fullNarrationPath = filePath
      }
    }

    // Sort audio sections: Introduction first, then chapters numerically
    result.audio_sections.sort((a, b) => {
      const aIsIntro = /intro/i.test(a.filename)
      const bIsIntro = /intro/i.test(b.filename)
      if (aIsIntro && !bIsIntro) return -1
      if (!aIsIntro && bIsIntro) return 1
      // Extract chapter numbers for numeric sort
      const aNum = a.filename.match(/chapter[_\s]*(\d+)/i)
      const bNum = b.filename.match(/chapter[_\s]*(\d+)/i)
      if (aNum && bNum) return parseInt(aNum[1]) - parseInt(bNum[1])
      if (aNum && !bNum) return 1
      if (!aNum && bNum) return -1
      return a.filename.localeCompare(b.filename, undefined, { numeric: true })
    })

    if (fullNarrationPath) {
      const dur = await getAudioDuration(fullNarrationPath)
      if (dur) {
        result.narration_full = { path: fullNarrationPath, duration: dur }
      }
    } else if (result.audio_sections.length === 1 && result.audio_sections[0].duration) {
      result.narration_full = {
        path: result.audio_sections[0].path,
        duration: result.audio_sections[0].duration,
      }
    }
  }

  // Scan merged audio files
  if (mergedAudioDir) {
    const files = await safeReaddir(mergedAudioDir)
    for (const file of files) {
      if (!/\.(mp3|wav|m4a)$/i.test(file)) continue
      if (file.startsWith('.tmp_')) continue
      const filePath = path.join(mergedAudioDir, file)
      const duration = await getAudioDuration(filePath)
      result.merged_audio.push({
        filename: file,
        path: filePath,
        duration,
      })
    }
  }

  // If merged audio exists, intro/chapter audio is stale — the audio assembly
  // step already consumed those. Flag it so the UI stops offering them.
  if (result.merged_audio.length > 0) {
    result.skip_chapters = true
  }

  // Scan already-rendered videos in the episode's video folder so the UI can
  // tell the user this episode has been assembled before (and show an mtime).
  if (videoDir) {
    const files = await safeReaddir(videoDir)
    for (const file of files) {
      if (!/\.(mp4|mov|webm|mkv)$/i.test(file)) continue
      if (file.startsWith('.tmp_')) continue
      const filePath = path.join(videoDir, file)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue
        result.rendered_videos.push({
          filename: file,
          path: filePath,
          mtime: stat.mtimeMs,
        })
      } catch { /* ignore */ }
    }
    result.rendered_videos.sort((a, b) => b.mtime - a.mtime)
  }

  // Scan for intro videos in episode dir and project root
  const introLocations = [episodeDir, projectDir]
  for (const loc of introLocations) {
    const files = await safeReaddir(loc)
    for (const file of files) {
      if (!/\.(mp4|mov|mkv|webm)$/i.test(file)) continue
      if (/intro/i.test(file)) {
        result.intro_videos.push({
          filename: file,
          path: path.join(loc, file),
        })
      }
    }
  }

  // Scan for music files in project root, episode dir, and a "music" subfolder
  const musicLocations = [projectDir, episodeDir]
  const musicSubdir = path.join(projectDir, 'music')
  if (existsSync(musicSubdir)) musicLocations.push(musicSubdir)
  const episodeMusicDir = path.join(episodeDir, 'music')
  if (existsSync(episodeMusicDir)) musicLocations.push(episodeMusicDir)

  const seenMusicPaths = new Set<string>()
  for (const loc of musicLocations) {
    const files = await safeReaddir(loc)
    for (const file of files) {
      if (!/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file)) continue
      const fullPath = path.join(loc, file)
      if (seenMusicPaths.has(fullPath)) continue
      seenMusicPaths.add(fullPath)
      const duration = await getAudioDuration(fullPath)
      result.music_files.push({
        filename: file,
        path: fullPath,
        duration,
      })
    }
  }

  return result
}

// ── Generate Video (multi-pass pipeline) ──────────────────────────────────

export async function generateVideo(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateVideoRequest
  const code = episode_id.toUpperCase()

  // 1. Validate FFmpeg
  const ffmpegCheck = await checkFfmpeg()
  if (!ffmpegCheck.installed) {
    throw new Error('FFmpeg is not installed. Please install FFmpeg to generate videos.')
  }
  job.output_lines.push(`FFmpeg version: ${ffmpegCheck.version}`)
  const canDrawtext = ffmpegCheck.has_drawtext
  if (!canDrawtext) {
    job.output_lines.push('Warning: drawtext filter not available — text overlays will be skipped')
  }

  // Resolve output directory
  const outputRoot = await pm.getProjectOutputRoot(project_slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Per-episode free-disk-space precheck. The run-batch route does this
  // up front for the whole batch; this is a defence-in-depth gate for
  // single-episode runs (and for batches that started with enough space
  // but were drained by an earlier episode). Throw BEFORE any FFmpeg
  // spawns so we don't burn encode time only to fail on the final write.
  // 1.2× margin here (vs 1.5× at the batch gate) — temp files for one
  // episode are bounded by the final output size plus per-clip prep.
  {
    const dur = (req.duration?.mode === 'custom'
      ? (req.duration.max_duration || req.duration.min_duration || 0)
      : 0) || undefined
    const estBytes = estimateBytesForStep('video_assembly', {
      durationSec: dur,
      resolution: req.resolution,
      quality: req.quality,
    })
    const required = Math.ceil(estBytes * 1.2)
    const free = await getFreeBytes(outputRoot)
    if (free > 0 && free < required) {
      throw new Error(
        `Not enough free disk space for ${code}. Have: ${formatBytes(free)}, need: ${formatBytes(required)} ` +
        `(estimated for ${req.resolution || '1080p'} ${req.quality || 'medium'}, includes 1.2× safety margin). ` +
        `Free up space and retry.`,
      )
    }
  }

  // Expand any portable asset paths (`${PROJECT}/...`, `${TERRANASH}/...`)
  // to absolute paths on this machine BEFORE downstream code touches them.
  // Keeps legacy absolute paths unchanged.
  resolveAssetPathsInPlace(req, outputRoot, job)

  // Brand fallback for the logo overlay. When the project has a brand
  // attached and the user enabled the logo overlay but didn't pin a
  // specific image, fall back to brand.visual.logo_path. Symmetric with
  // the audio voice fallback. Per-project / per-episode overrides on
  // req.logo.image_path still win — this only fills the empty case.
  if (req.logo?.enabled && (!req.logo.image_path || !req.logo.image_path.trim())) {
    try {
      const { getEffectiveBrand } = await import('../services/brand-loader.js')
      const brand = await getEffectiveBrand(project_slug)
      const brandLogo = brand?.visual?.logo_path?.trim()
      if (brandLogo) {
        req.logo.image_path = brandLogo
        job.output_lines.push(`Logo fallback from brand: ${brandLogo}`)
      }
    } catch { /* brand layer must never break video assembly */ }
  }

  const names = await resolveSubfolderNames(project_slug, code)
  // Prefer the titled folder when the user has leftover renamed siblings.
  let titleHint: string | undefined
  try {
    const im = await import('../services/idea-manager.js')
    const ideas = await im.getIdeas(project_slug, 'accepted')
    const match = ideas.find(i => i.episode_code === code)
    if (match?.title) titleHint = match.title
  } catch { /* fall back to code-only match */ }
  const episodeDir = await findEpisodeDir(outputRoot, code, titleHint)
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  const videoDir = await resolveSubfolder(episodeDir, names.video) || path.join(episodeDir, names.video)
  await fs.mkdir(videoDir, { recursive: true })

  // Workstream B — chapter alignment auto-load. When the flag is on
  // but the request didn't carry `chapter_durations`, try the audio
  // merge sidecar that lives in the episode directory. Frontend can
  // either send durations directly or rely on this fallback so the
  // payload stays small. If the sidecar is missing, the alignment
  // branch in `buildConcatList` silently falls back to legacy cycling
  // (logged once below for diagnostics).
  if (req.align_visuals_to_chapters && (!Array.isArray(req.chapter_durations) || req.chapter_durations.length === 0)) {
    try {
      const sidecarPath = path.join(episodeDir, 'audio_chapters.json')
      const raw = await fs.readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw) as { sections?: Array<{ slug: string; duration_s: number }> }
      if (Array.isArray(parsed.sections) && parsed.sections.length > 0) {
        req.chapter_durations = parsed.sections
          .filter(s => s && typeof s.slug === 'string' && Number.isFinite(s.duration_s) && s.duration_s > 0)
          .map(s => ({ slug: s.slug, duration_s: s.duration_s }))
        job.output_lines.push(`Chapter alignment: loaded ${req.chapter_durations.length} chapter duration(s) from audio_chapters.json`)
      }
    } catch {
      job.output_lines.push(`Chapter alignment: ON but no audio_chapters.json sidecar — falling back to uniform cycling. Re-run Audio Merge to emit it.`)
    }
  }

  // Per-scene swap (v1.0.57+) — auto-load explicit assignments when
  // alignment is on AND any scene lacks a chapter_slug. Frontend
  // typically stamps the slug onto each VideoScene before sending,
  // but old cached payloads or scripted re-runs may not. Reading the
  // sidecar here makes the override behaviour reliable regardless of
  // what the caller knew at submit time. If no sidecar exists, scenes
  // stay un-stamped and the alignment branch positional-splits (the
  // Workstream B v1.0.54 behaviour).
  if (req.align_visuals_to_chapters && Array.isArray(req.scenes) && req.scenes.length > 0) {
    const anyMissing = req.scenes.some(s => typeof s.chapter_slug !== 'string' || !s.chapter_slug)
    if (anyMissing) {
      try {
        const sidecarPath = path.join(episodeDir, 'scene_chapter_assignments.json')
        const raw = await fs.readFile(sidecarPath, 'utf-8')
        const parsed = JSON.parse(raw) as {
          assignments?: Array<{ scene_number: number; chapter_slug: string }>
        }
        if (Array.isArray(parsed.assignments) && parsed.assignments.length > 0) {
          const bySceneNumber = new Map<number, string>()
          for (const a of parsed.assignments) {
            if (typeof a?.scene_number === 'number' && typeof a?.chapter_slug === 'string' && a.chapter_slug) {
              bySceneNumber.set(a.scene_number, a.chapter_slug)
            }
          }
          let applied = 0
          for (let i = 0; i < req.scenes.length; i++) {
            const sc = req.scenes[i]!
            // Treat scene_number as 1-based when missing — falls back
            // to positional index. Lines up with how the rest of the
            // app numbers Scene01, Scene02, …
            const sn = typeof sc.scene_number === 'number' ? sc.scene_number : (i + 1)
            const slug = bySceneNumber.get(sn)
            if (slug && !sc.chapter_slug) {
              sc.chapter_slug = slug
              applied++
            }
          }
          if (applied > 0) {
            job.output_lines.push(`Per-scene chapter assignments: applied ${applied} override(s) from scene_chapter_assignments.json`)
          }
        }
      } catch {
        // Sidecar absent — fine. Positional even-split kicks in.
      }
    }
  }

  // Validate scenes
  if (!req.scenes || req.scenes.length === 0) {
    throw new Error('No scenes provided for video generation')
  }
  for (const scene of req.scenes) {
    if (!existsSync(scene.image_path)) {
      throw new Error(`Scene image not found: ${scene.image_path}`)
    }
  }

  // Validate narration — merged audio takes priority, then chapters, then single narration
  const useMergedAudio = !!req.merged_audio_path && existsSync(req.merged_audio_path)
  const narrationChapters = req.narration_chapters || []
  const hasChapters = !useMergedAudio && narrationChapters.length > 1

  if (useMergedAudio) {
    job.output_lines.push(`Using pre-merged audio: ${path.basename(req.merged_audio_path!)}`)
  } else if (hasChapters) {
    const validChapters = narrationChapters.filter(f => existsSync(f))
    if (validChapters.length === 0) {
      throw new Error(`No valid narration chapter files found. Checked: ${narrationChapters[0]}`)
    }
    job.output_lines.push(`Found ${validChapters.length}/${narrationChapters.length} narration chapters`)
  } else if (!existsSync(req.narration_path)) {
    throw new Error(`Narration audio not found: ${req.narration_path}`)
  }

  const { w, h } = RESOLUTIONS[req.resolution] || RESOLUTIONS['1080p']
  const baseQuality = QUALITY_PRESETS[req.quality] || QUALITY_PRESETS['medium']
  const fps = req.fps ?? DEFAULT_FPS
  // Every clip-prep function reads from this shared bag. `fps` hitches a
  // ride so we don't need to thread a separate parameter through six
  // function signatures. The final encode overrides `preset` with the
  // user's `encoding_effort` pick (see `runFinalComposition`).
  const quality = { ...baseQuality, fps }
  const format = req.format || 'mp4'

  // 2. Calculate target duration
  let narrationDuration: number | undefined
  if (useMergedAudio) {
    narrationDuration = await getAudioDuration(req.merged_audio_path!)
  } else if (hasChapters) {
    let totalChapterDur = 0
    for (const chPath of narrationChapters) {
      if (!existsSync(chPath)) continue
      const d = await getAudioDuration(chPath)
      if (d) totalChapterDur += d
    }
    // Add estimated gap time
    const audioGapEst = req.audio_gap ?? 5
    totalChapterDur += (narrationChapters.filter(f => existsSync(f)).length - 1) * audioGapEst
    narrationDuration = totalChapterDur > 0 ? totalChapterDur : undefined
  } else {
    narrationDuration = await getAudioDuration(req.narration_path)
  }
  if (!narrationDuration) {
    throw new Error('Could not determine narration audio duration')
  }
  job.output_lines.push(`Narration duration: ${narrationDuration.toFixed(1)}s`)

  let targetDuration: number
  if (req.duration.mode === 'custom') {
    const min = req.duration.min_duration
    const max = req.duration.max_duration
    targetDuration = min + Math.random() * (max - min)
    // Ensure target is at least as long as narration
    if (targetDuration < narrationDuration) {
      targetDuration = narrationDuration + 30
      job.output_lines.push(`Warning: custom duration shorter than narration, extending to ${targetDuration.toFixed(0)}s`)
    }
  } else {
    targetDuration = narrationDuration + 30
  }
  job.output_lines.push(`Target duration: ${targetDuration.toFixed(1)}s`)

  // 3. Create temp directory — under os.tmpdir() (never iCloud-synced)
  // so the multi-GB intermediate clips/concat-list/premixed-audio don't
  // trigger an iCloud upload while ffmpeg is mid-encode. The final
  // rename to `videoDir` or the external root happens after success
  // (see the EXDEV-aware copy fallback near the end of this function).
  const tempDir = await getWorkTempDir(project_slug, code)

  // Debug mode: when STORY_STUDIO_VIDEO_DEBUG is truthy, preserve the
  // temp dir on every run (success OR failure) so the user can replay a
  // single FFmpeg stage manually. Without it, the temp dir is preserved
  // only on failure, so post-mortem analysis of a broken intermediate
  // is still possible from a normal run.
  const debugMode = !!process.env.STORY_STUDIO_VIDEO_DEBUG && process.env.STORY_STUDIO_VIDEO_DEBUG !== '0'
  if (debugMode) {
    job.output_lines.push(`Debug mode ON — temp dir will be preserved: ${tempDir}`)
  }
  let succeeded = false

  try {
    const { w: resW, h: resH } = { w, h }

    job.output_lines.push(`Resolution: ${resW}x${resH} @ ${quality.fps}fps`)
    job.output_lines.push(`Quality: ${req.quality} (CRF ${quality.crf}, preset ${req.encoding_effort || quality.preset})`)
    if (req.codec && req.codec !== 'h264') job.output_lines.push(`Codec: ${req.codec.toUpperCase()}`)
    job.output_lines.push(`Scenes: ${req.scenes.length}`)

    // 4. Prepare narration audio
    let narrationFilePath: string
    const audioGap = req.audio_gap ?? 5

    if (useMergedAudio) {
      // Use pre-merged audio directly — skip chapter concatenation
      narrationFilePath = req.merged_audio_path!
      job.output_lines.push(`Merged audio duration: ${narrationDuration!.toFixed(1)}s`)
    } else if (hasChapters && audioGap > 0) {
      narrationFilePath = await prepareNarrationWithGaps(narrationChapters, audioGap, tempDir, job)
      // Re-measure duration after adding gaps
      const newDur = await getAudioDuration(narrationFilePath)
      if (newDur) {
        narrationDuration = newDur
        job.output_lines.push(`Narration with gaps: ${narrationDuration.toFixed(1)}s (${narrationChapters.length} chapters, ${audioGap}s gaps)`)
      }
    } else if (hasChapters) {
      // Multiple chapters but no gap — just concatenate
      narrationFilePath = await prepareNarrationWithGaps(narrationChapters, 0, tempDir, job)
      const newDur = await getAudioDuration(narrationFilePath)
      if (newDur) narrationDuration = newDur
    } else {
      narrationFilePath = req.narration_path
    }

    // ── Compilation video layout (Path C / v1.0.63+) ─────────────────────
    // When the request opts into compilation mode, the standard scene-
    // clip pipeline below is bypassed entirely. Instead we render a
    // looping background plate as the base video and convert the per-
    // scene image list into chapter-aligned foreground overlays. The
    // final composition + rename + cleanup steps are duplicated inline
    // here so the standard flow stays byte-identical for sleep-story
    // projects (regression-safe).
    if (req.video_layout === 'compilation') {
      // Validation up front so we fail fast with a clear message.
      if (!req.background_plate?.source_path) {
        throw new Error(
          'Compilation video_layout requires a background_plate.source_path. ' +
          'Pick a looping background video (e.g. starfield) in Video Assembly settings.',
        )
      }
      if (!existsSync(req.background_plate.source_path)) {
        throw new Error(`Background plate file not found: ${req.background_plate.source_path}`)
      }
      if (!Array.isArray(req.chapter_durations) || req.chapter_durations.length === 0) {
        throw new Error(
          'Compilation mode requires chapter_durations from audio_chapters.json — ' +
          'run Audio Merge first to generate the per-chapter duration sidecar.',
        )
      }
      const totalRenderDuration = narrationDuration!
      job.output_lines.push(
        `Compilation mode ON · ${req.scenes.length} scene(s), ${req.chapter_durations.length} chapter(s), ${totalRenderDuration.toFixed(1)}s total`,
      )

      // 1. Build the looped background as the intermediate video.
      const intermediateVideoPath = await prepareCompilationBackground(
        req.background_plate, resW, resH, quality, tempDir, totalRenderDuration, job,
      )

      // 2. Auto-generate one foreground overlay per chapter, merge with
      //    any user-provided decorative overlays (fireflies, frames…).
      const fgDefaults: ForegroundDefaults = req.foreground_defaults || {
        scale_pct: 0.5,
        position: 'center',
        chroma_key: { color: '#FFFFFF', similarity: 0.15, blend: 0.10 },
      }
      const audioGap = req.audio_gap ?? 0
      const autoOverlays = buildCompilationOverlays(
        req.scenes, req.chapter_durations, fgDefaults, audioGap, job,
      )
      const userOverlays = (req.overlays?.layers || [])
      req.overlays = {
        enabled: true,
        layers: [...autoOverlays, ...userOverlays],
      }

      // 3. Premix audio (same helper the standard pipeline uses).
      let musicFilePath: string | undefined
      if (req.music?.enabled && req.music.files.length > 0) {
        musicFilePath = await prepareMusicTrack(req.music, tempDir, job)
      }
      const premixedAudioPath = await premixAudio({
        narrationPath: narrationFilePath,
        narrationDuration: narrationDuration!,
        narrationVolume: req.narration_volume ?? 1.0,
        musicFilePath, musicConfig: req.music,
        backgroundNoise: req.background_noise,
        targetDuration: totalRenderDuration, tempDir, job,
      })

      // 4. Final composition + rename, mirroring the standard flow's
      //    structure so the Promote-to-final + cache-invalidate paths
      //    stay identical.
      const compTimestamp = Date.now()
      const compOutputFile = path.join(tempDir, `${code}_video_${compTimestamp}.${format}`)
      let compEncodeOk = false
      try {
        await runFinalComposition({
          videoInputPath: intermediateVideoPath, premixedAudioPath,
          logo: req.logo,
          targetDuration: totalRenderDuration, w: resW, h: resH, quality, format,
          outputFile: compOutputFile,
          colorGrading: req.color_grading,
          vignette: req.vignette,
          chromaKey: req.chroma_key,
          overlays: req.overlays,
          filmGrain: req.film_grain,
          letterbox: req.letterbox,
          subtitles: req.subtitles,
          // Compilation has no intro/title/outro segments in v1, so the
          // intro-exclusion gate is a no-op. Effects play through the
          // entire bg-plate duration.
          excludeIntroFromEffects: false,
          preSceneDuration: 0,
          postAudioStart: undefined,
          encodingEffort: req.encoding_effort,
          codec: req.codec,
          job,
        })
        compEncodeOk = true
      } finally {
        if (!compEncodeOk) {
          try {
            await fs.rm(compOutputFile, { force: true })
            job.output_lines.push(`Removed partial output: ${path.basename(compOutputFile)}`)
          } catch { /* best-effort */ }
        }
      }

      // Promote to final name — same external-root vs project-tree
      // logic the standard flow uses below.
      const compFinalName = `${code}_final_video.${format}`
      const compProjectTreeFinalPath = path.join(videoDir, compFinalName)
      let compFinalPath = compProjectTreeFinalPath
      try {
        const { ensureExternalFinalVideoDir } = await import('../services/external-video-store.js')
        const externalDir = await ensureExternalFinalVideoDir(project_slug, code, titleHint || '')
        if (externalDir) {
          compFinalPath = path.join(externalDir, compFinalName)
          job.output_lines.push(`External final-video root configured → ${compFinalPath}`)
        }
      } catch (e: any) {
        job.output_lines.push(`External path resolve failed (${e?.message || e}); using project tree`)
      }
      let compResolvedPath = compOutputFile
      try {
        await fs.rename(compOutputFile, compFinalPath)
        compResolvedPath = compFinalPath
        job.output_lines.push(`Renamed to: ${compFinalName}`)
      } catch (e: any) {
        if (e?.code === 'EXDEV' && compFinalPath !== compProjectTreeFinalPath) {
          try {
            await fs.copyFile(compOutputFile, compFinalPath)
            await fs.rm(compOutputFile, { force: true })
            compResolvedPath = compFinalPath
            job.output_lines.push(`Copied to external (cross-device): ${compFinalName}`)
          } catch (copyErr: any) {
            job.output_lines.push(`Warning: external copy failed (${copyErr.message || copyErr}); falling back to project tree`)
            try {
              await fs.rename(compOutputFile, compProjectTreeFinalPath)
              compResolvedPath = compProjectTreeFinalPath
              job.output_lines.push(`Renamed to: ${compFinalName} (project tree fallback)`)
            } catch (fallbackErr: any) {
              job.output_lines.push(`Warning: final rename skipped (${fallbackErr.message || 'unknown'})`)
            }
          }
        } else {
          job.output_lines.push(`Warning: final rename skipped (${e.message || 'unknown error'})`)
        }
      }

      job.progress = 100
      job.output_lines.push(`Video saved: ${path.basename(compResolvedPath)}`)
      job.output_lines.push(`Full path: ${compResolvedPath}`)
      job.output_dir = path.dirname(compResolvedPath)

      try {
        const { episodeStatusCache } = await import('../services/episode-status-cache.js')
        episodeStatusCache.invalidate(project_slug, code)
      } catch { /* best-effort */ }

      succeeded = true
      return  // skip the standard scene-clip pipeline below
    }

    // 5. Resolve scene animation — defaults to 'none' when the request
    // omits it. The breathe/parallax knobs are only consulted by the
    // animation pipeline when type !== 'none', so the values below are
    // a sensible no-op default rather than meaningful settings.
    const sceneAnimation: VideoSceneAnimation = req.scene_animation ?? {
      type: 'none', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103,
    }

    // 6. Prepare scene clips.
    // v1.0.81+: when the project's format opts into sentence alignment
    // AND audio_sentences.json exists, compute per-scene durations from
    // sentence-level timing instead of using the uniform recycling
    // default. This is what gives Bound-style explainer pacing — each
    // scene stays on screen exactly as long as its assigned sentences.
    // The block is fully optional and best-effort: any failure falls
    // back to uniform per-scene durations and logs why.
    let sentenceDurations: number[] | undefined
    try {
      const { getEffectiveFormat } = await import('../services/format-loader.js')
      const fmt = await getEffectiveFormat(project_slug)
      if (fmt.imagePrompts.alignment === 'sentence') {
        const sentencesPath = path.join(episodeDir, 'audio_sentences.json')
        const raw = await fs.readFile(sentencesPath, 'utf-8').catch(() => null)
        if (raw) {
          const { parseSentenceSidecar, assignScenesToSentences } = await import('../lib/sentence-timing.js')
          const parsed = parseSentenceSidecar(JSON.parse(raw))
          if (parsed && parsed.sections.length > 0) {
            const fallback = req.scene_recycling?.seconds_per_scene || 4
            const result = assignScenesToSentences(
              req.scenes.map(s => ({ chapter_slug: s.chapter_slug })),
              parsed,
              fallback,
            )
            sentenceDurations = result.perSceneDurations
            const totalSec = sentenceDurations.reduce((a, b) => a + b, 0)
            job.output_lines.push(
              `Sentence alignment: ON — ${result.assignments.length} scene(s) mapped to ` +
              `${parsed.sections.reduce((s, sec) => s + sec.sentences.length, 0)} sentence(s); ` +
              `target scene-track duration ${totalSec.toFixed(1)}s`,
            )
          } else {
            job.output_lines.push(`Sentence alignment: format opts in but audio_sentences.json is empty/invalid — falling back to uniform per-scene duration.`)
          }
        } else {
          job.output_lines.push(`Sentence alignment: format opts in but audio_sentences.json missing — re-run Audio Merge to emit it. Falling back to uniform per-scene duration.`)
        }
      }
    } catch (e: any) {
      job.output_lines.push(`Note: sentence-alignment check skipped (${e?.message || 'lookup error'})`)
    }

    const sceneClips = await prepareSceneClips(
      req.scenes, sceneAnimation, req.chapter_titles, resW, resH, quality, tempDir, canDrawtext, req.scene_recycling, job,
      {
        pool: (req as any).animation_pool || [],
        randomizeMode: ((req as any).animation_randomize || 'off') as 'off' | 'single' | 'per-scene',
        seed: (req as any).animation_seed,
      },
      sentenceDurations,
    )

    // 6. Prepare title image clip (if provided)
    let titleClipPath: string | undefined
    if (req.title_image?.enabled && req.title_image.image_path) {
      const avail = checkAssetAvailability(req.title_image.image_path, 'title_image.image_path')
      if (avail.status === 'available') {
        titleClipPath = await prepareTitleClip(req.title_image, resW, resH, quality, tempDir, job)
      } else {
        // Stale image_path from a preset saved in a different episode is a
        // common way to hit 'missing'. 'placeholder' means the file is
        // waiting for iCloud to download it — the message explains how.
        job.output_lines.push(`${avail.message} — title step skipped`)
      }
    }

    // 7. Prepare intro video (if provided)
    let introClipPath: string | undefined
    if (req.intro?.enabled && req.intro.video_path) {
      const avail = checkAssetAvailability(req.intro.video_path, 'intro.video_path')
      if (avail.status === 'available') {
        introClipPath = await prepareIntroClip(req.intro, resW, resH, quality, tempDir, job)
      } else {
        job.output_lines.push(`${avail.message} — intro step skipped`)
      }
    }

    // 7b. Prepare outro video (if provided). Outro is purely cosmetic tail
    // content and lives at the very end of the concat list, AFTER the
    // post-audio segment. Never receives effects — the final composition
    // gate clears at `sceneEndTime` which is before the outro starts.
    let outroClipPath: string | undefined
    if (req.outro?.enabled && req.outro.video_path) {
      const avail = checkAssetAvailability(req.outro.video_path, 'outro.video_path')
      if (avail.status === 'available') {
        outroClipPath = await prepareOutroClip(req.outro, resW, resH, quality, tempDir, job)
      } else {
        job.output_lines.push(`${avail.message} — outro step skipped`)
      }
    }

    // 7c. Prepare user-supplied timeline clips. Each clip is normalised to
    // the output frame (same as intro/outro) and bucketed by anchor so
    // `buildConcatList` can emit the right set at each insertion point.
    // Failures are isolated per-clip: a missing file warns + skips that row
    // rather than aborting the job — consistent with intro/outro handling.
    const timelineClipsByAnchor: Record<TimelineAnchor, Array<{ path: string; duration: number }>> = {
      before_intro: [],
      after_intro: [],
      after_scenes: [],
      after_outro: [],
    }
    if (req.timeline_clips?.length) {
      let idx = 0
      for (const clip of req.timeline_clips) {
        if (!clip.enabled) { idx++; continue }
        // Discriminate: static = image+duration; video (default) = video_path.
        // Old presets that predate the variant don't carry `kind` — treat
        // missing kind as 'video' for back-compat.
        const isStatic = clip.kind === 'static'
        const sourcePath = isStatic ? clip.image_path : clip.video_path
        const fieldName = isStatic ? `timeline_clips[${idx}].image_path` : `timeline_clips[${idx}].video_path`
        if (!sourcePath) { idx++; continue }
        const avail = checkAssetAvailability(sourcePath, fieldName)
        if (avail.status !== 'available') {
          job.output_lines.push(`${avail.message} — timeline clip [${clip.anchor}] skipped`)
          idx++
          continue
        }
        if (isStatic && (!Number.isFinite(clip.duration_sec) || clip.duration_sec <= 0)) {
          job.output_lines.push(`⚠ Static timeline clip [${clip.anchor}] has invalid duration_sec=${clip.duration_sec} — skipped`)
          idx++
          continue
        }
        try {
          const preparedPath = await prepareTimelineClip(clip, idx, resW, resH, quality, tempDir, job)
          const dur = (await getAudioDuration(preparedPath)) || 0
          timelineClipsByAnchor[clip.anchor].push({ path: preparedPath, duration: dur })
        } catch (e: any) {
          job.output_lines.push(`⚠ Failed to prepare timeline clip [${clip.anchor}]: ${e.message} — skipped`)
        }
        idx++
      }
    }
    // Bucket totals drive head-of-video (preSceneDuration) vs tail
    // (totalRenderDuration) math below. Sum once here, reuse below.
    const beforeIntroDur = timelineClipsByAnchor.before_intro.reduce((s, c) => s + c.duration, 0)
    const afterIntroDur  = timelineClipsByAnchor.after_intro.reduce((s, c) => s + c.duration, 0)
    const afterScenesDur = timelineClipsByAnchor.after_scenes.reduce((s, c) => s + c.duration, 0)
    const afterOutroDur  = timelineClipsByAnchor.after_outro.reduce((s, c) => s + c.duration, 0)
    const totalTimelineClipCount =
      timelineClipsByAnchor.before_intro.length +
      timelineClipsByAnchor.after_intro.length +
      timelineClipsByAnchor.after_scenes.length +
      timelineClipsByAnchor.after_outro.length
    if (totalTimelineClipCount > 0) {
      job.output_lines.push(
        `Timeline clips: ${totalTimelineClipCount} clip(s) — ` +
        `before_intro=${timelineClipsByAnchor.before_intro.length} ` +
        `after_intro=${timelineClipsByAnchor.after_intro.length} ` +
        `after_scenes=${timelineClipsByAnchor.after_scenes.length} ` +
        `after_outro=${timelineClipsByAnchor.after_outro.length}`
      )

      const allClips: TimelineClipForCheck[] = [
        ...timelineClipsByAnchor.before_intro.map(c => ({ ...c, anchor: 'before_intro' })),
        ...timelineClipsByAnchor.after_intro.map(c  => ({ ...c, anchor: 'after_intro'  })),
        ...timelineClipsByAnchor.after_scenes.map(c => ({ ...c, anchor: 'after_scenes' })),
        ...timelineClipsByAnchor.after_outro.map(c  => ({ ...c, anchor: 'after_outro'  })),
      ]
      const referenceDuration = Math.max(narrationDuration, targetDuration)
      const sanity = checkTimelineDurationSanity(allClips, referenceDuration)
      if (sanity.warning) job.output_lines.push(sanity.warning)
    }

    // How many seconds of the final video are intro + title. When the
    // `exclude_intro_from_effects` flag is on, effects gated by `enable=`
    // (color grade, vignette, grain, subtitles, logo, chroma key) only
    // start after this point — so the user's branded pre-scene content
    // doesn't get tinted or vignetted.
    let preSceneDuration = 0
    // User timeline clips at before_intro / after_intro also live at the
    // head of the video, so their durations count toward the effect-gate
    // start. Without this, color grade / vignette / grain would start
    // playing ON the user's pre-scene clips instead of on the first scene.
    preSceneDuration += beforeIntroDur
    if (introClipPath) {
      preSceneDuration += (await getAudioDuration(introClipPath)) || 5
    }
    preSceneDuration += afterIntroDur
    if (titleClipPath) {
      preSceneDuration += req.title_image?.duration ?? 5
    }

    // Measure outro length so the final encode's `-t` flag covers it.
    // Without this, the outro IS appended to the concat list (so it lives
    // in the intermediate video) but the encoder's `-t targetDuration`
    // truncates output at narration+30s — and since the outro lives
    // beyond `sceneEndTime`, it gets silently chopped off. Mirrors the
    // intro duration measurement above.
    let outroDuration = 0
    if (outroClipPath) {
      const probed = await getAudioDuration(outroClipPath)
      if (probed && probed > 0) {
        outroDuration = probed
        job.output_lines.push(`Outro duration: ${outroDuration.toFixed(1)}s`)
        if (outroDuration > 300) {
          job.output_lines.push(
            `Warning: outro is ${outroDuration.toFixed(1)}s (>5 min) — final render extended accordingly`
          )
        }
      } else {
        job.output_lines.push('Warning: could not probe outro duration; final encode may truncate outro')
      }
    }

    // Two duration scales — keep them separate:
    //   `targetDuration`        (= narration+30) governs the concat list's
    //                           post-audio fill math (postDuration =
    //                           targetDuration - sceneEndTime). Inflating
    //                           it would stretch the black/fade/hold tail.
    //   `totalRenderDuration`   (= targetDuration + outroDuration) governs
    //                           the premix audio length and the final
    //                           encode's `-t` flag, so the outro segment
    //                           that sits after the post-audio tail isn't
    //                           clipped by the encoder.
    // Tail duration includes outro plus user timeline clips that live
    // after_scenes (before post-audio) and after_outro (very end). Both
    // extend the encoder's `-t` so nothing gets clipped, and both
    // contribute to the premix audio length in identical fashion.
    const tailClipsDuration = afterScenesDur + afterOutroDur
    const totalRenderDuration = targetDuration + outroDuration + tailClipsDuration
    if (outroDuration > 0 || tailClipsDuration > 0) {
      const parts = [`target ${targetDuration.toFixed(1)}s`]
      if (outroDuration > 0) parts.push(`outro ${outroDuration.toFixed(1)}s`)
      if (afterScenesDur > 0) parts.push(`after_scenes ${afterScenesDur.toFixed(1)}s`)
      if (afterOutroDur > 0) parts.push(`after_outro ${afterOutroDur.toFixed(1)}s`)
      job.output_lines.push(
        `Total render duration: ${totalRenderDuration.toFixed(1)}s (${parts.join(' + ')})`
      )
    }

    // Disk-space pre-flight gate #2 — accurate edition. The early gate at
    // the top of generateVideo() runs BEFORE narration + timeline durations
    // are known, so it has to fall back to a 1-hour estimate that wildly
    // under-counts long sleep-story tails (a 2.5h render needs ~25 GB peak
    // temp; the early check would estimate ~540 MB and pass on a nearly-
    // full disk). Now that totalRenderDuration is locked in, re-check with
    // the real number and a 6× safety margin that covers the four parallel
    // disk consumers during a render:
    //   1. per-scene clip prep   (~0.5× output bytes — short pre-rendered MP4s)
    //   2. intermediate concat   (~1.0× output — stream-copy of the per-scene clips)
    //   3. premix WAV (PCM)      (~1.5× output — uncompressed at 48k/s16le is bigger than H.264)
    //   4. final output          (~1.0× output)
    // Plus ~2× general buffer for the user's other apps + filesystem
    // overhead. The early gate keeps catching truly drained disks; this
    // gate catches the much more common "8 GB free, need 14 GB" case.
    {
      const estOutputBytes = estimateBytesForStep('video_assembly', {
        durationSec: totalRenderDuration,
        resolution: req.resolution,
        quality: req.quality,
      })
      const required = Math.ceil(estOutputBytes * 6)
      const free = await getFreeBytes(outputRoot)
      if (free > 0 && free < required) {
        const minutesFinal = (totalRenderDuration / 60).toFixed(1)
        throw new Error(
          `Not enough free disk space for the ${minutesFinal}-min render of ${code}. ` +
          `Have: ${formatBytes(free)}, need: ${formatBytes(required)} ` +
          `(${req.resolution || '1080p'} ${req.quality || 'medium'} × 6× safety for intermediate/premix/per-clip temps). ` +
          `Free up space and retry — your render would otherwise crash near the end with "No space left on device".`,
        )
      }
      if (free > 0) {
        job.output_lines.push(
          `Disk pre-flight OK: ${formatBytes(free)} free, ~${formatBytes(required)} estimated peak usage.`,
        )
      }
    }

    // 8. Prepare music file (if multiple, concatenate them)
    let musicFilePath: string | undefined
    if (req.music?.enabled && req.music.files.length > 0) {
      musicFilePath = await prepareMusicTrack(req.music, tempDir, job)
    }

    // 9. Resolve post-audio behavior
    const postAudio = req.post_audio ?? { behavior: 'fade-to-black' as const, fade_duration: 5 }

    // 10. Build concat list — scenes match narration duration, post-audio fills the rest
    const lastSceneImagePath = req.scenes[req.scenes.length - 1]?.image_path
    const { listPath: concatListPath, sceneEndTime } = await buildConcatList(
      tempDir, introClipPath, titleClipPath, sceneClips,
      targetDuration, narrationDuration, postAudio,
      req.scene_recycling, resW, resH, quality, lastSceneImagePath, job,
      req.transition && req.transition !== 'none' ? {
        primaryId: req.transition,
        pool: (req as any).transition_pool || [],
        randomizeMode: ((req as any).transition_randomize || 'off') as 'off' | 'single' | 'per-scene',
        durationSec: Math.max(0.2, Math.min(req.transition_duration || 1.5, req.scene_recycling.seconds_per_scene - 0.5)),
        seed: (req as any).transition_seed,
      } : undefined,
      outroClipPath,
      timelineClipsByAnchor,
      // Chapter alignment (Workstream B). Frontend sends durations from
      // `${episode}/audio_chapters.json`; backend partitions scenes
      // across them when the flag is on. Off → legacy cycling.
      req.align_visuals_to_chapters && Array.isArray(req.chapter_durations) && req.chapter_durations.length > 0
        ? { enabled: true, chapterDurations: req.chapter_durations }
        : undefined,
      // Per-scene chapter overrides (v1.0.57+). Pulled directly off
      // each VideoScene so a half-edited assignments file (some scenes
      // unassigned) still produces a valid render — the alignment
      // branch falls back to positional placement for unmapped clips.
      req.scenes.map(s => s.chapter_slug),
    )

    // 11. Pre-mix all audio into a single WAV file. Length must match the
    // intermediate video's full span (= `totalRenderDuration`) so audio
    // doesn't run out mid-outro.
    const premixedAudioPath = await premixAudio({
      narrationPath: narrationFilePath,
      narrationDuration,
      narrationVolume: req.narration_volume ?? 1.0,
      musicFilePath, musicConfig: req.music,
      backgroundNoise: req.background_noise,
      targetDuration: totalRenderDuration, tempDir, job,
    })

    // 12. Run final composition (simple: concat video + premixed audio + logo/effects)
    // Encode into the OS-tempdir scratch area so iCloud doesn't see the
    // multi-GB output stream while ffmpeg is mid-encode. The rename
    // below moves the finished file to videoDir or the external root —
    // a same-volume rename is atomic + invisible to iCloud, and the
    // existing EXDEV branch handles cross-volume moves.
    const timestamp = Date.now()
    const outputFile = path.join(tempDir, `${code}_video_${timestamp}.${format}`)

    // Concat all scene clips into a single intermediate MP4 (stream copy, near-instant)
    const intermediateVideoPath = await concatToIntermediate(concatListPath, tempDir, job)

    // Track whether the final encode succeeded so the finally block can
    // remove a partial `outputFile` on failure. Before this, a watchdog
    // kill / cancel / all-tiers-failed run left a multi-hundred-MB
    // truncated `.mp4` in the user's `_video/` folder with no marker —
    // sometimes mistaken for a valid render. The finally only deletes on
    // failure; the rename below handles the happy path.
    let encodeSucceeded = false
    try {
      await runFinalComposition({
        videoInputPath: intermediateVideoPath, premixedAudioPath,
        // Pass `totalRenderDuration` so the encoder's `-t` flag covers the
        // outro segment too. Using `targetDuration` here (the historical
        // bug) chopped off any outro that lived past narration+30s.
        logo: req.logo, targetDuration: totalRenderDuration, w: resW, h: resH, quality, format, outputFile,
        colorGrading: req.color_grading,
        vignette: req.vignette,
        chromaKey: req.chroma_key,
        overlays: req.overlays,
        filmGrain: req.film_grain,
        letterbox: req.letterbox,
        subtitles: req.subtitles,
        excludeIntroFromEffects: req.exclude_intro_from_effects,
        preSceneDuration,
        postAudioStart: sceneEndTime,
        encodingEffort: req.encoding_effort,
        codec: req.codec,
        job,
      })
      encodeSucceeded = true
    } finally {
      if (!encodeSucceeded) {
        try {
          await fs.rm(outputFile, { force: true })
          job.output_lines.push(`Removed partial output: ${path.basename(outputFile)}`)
        } catch { /* best-effort cleanup */ }
      }
    }

    // Promote the just-finished render to the project-standard "final" name.
    // Atomic on-same-filesystem rename: fs.rename() is atomic per POSIX so
    // there's no partial state at any point, and if a previous "_final_video"
    // exists the rename replaces it in one step. If FFmpeg had failed,
    // runFinalComposition would have thrown above and we'd never reach here —
    // so this path only runs on confirmed-good output.
    //
    // External final-video root (Phase C of the storage plan):
    //   When the user configured `external_final_video_root` in
    //   app-settings.json, the final lands at the EXTERNAL location
    //   instead of inside the project tree's `Video Assembly Output`
    //   folder. Detection in asset-status.ts already looks at both
    //   places, so the pipeline view sees it either way. Keeps the
    //   5-10 GB output OUT of iCloud-synced project trees while
    //   preserving the project-tree fallback for users who haven't
    //   opted in. Falls back to the project-tree path if the external
    //   write fails (cross-device error, perms, etc.) — never blocks
    //   the user from getting a final video.
    const finalName = `${code}_final_video.${format}`
    const projectTreeFinalPath = path.join(videoDir, finalName)
    let finalPath = projectTreeFinalPath
    try {
      const { ensureExternalFinalVideoDir } = await import('../services/external-video-store.js')
      // titleHint is the project's canonical title for this episode
      // (loaded from ideas store earlier in this function); falls back
      // to the code-only folder name when missing.
      const externalDir = await ensureExternalFinalVideoDir(project_slug, code, titleHint || '')
      if (externalDir) {
        finalPath = path.join(externalDir, finalName)
        job.output_lines.push(`External final-video root configured → ${finalPath}`)
      }
    } catch (e: any) {
      // Logging only; treat as fallback to project tree.
      job.output_lines.push(`External path resolve failed (${e?.message || e}); using project tree`)
    }

    let resolvedOutputPath = outputFile
    try {
      await fs.rename(outputFile, finalPath)
      resolvedOutputPath = finalPath
      job.output_lines.push(`Renamed to: ${finalName}`)
    } catch (e: any) {
      // First failure mode: external path is on a different filesystem
      // (EXDEV). Fall back to copy + remove so the user still gets a
      // final at their chosen location.
      if (e?.code === 'EXDEV' && finalPath !== projectTreeFinalPath) {
        try {
          await fs.copyFile(outputFile, finalPath)
          await fs.rm(outputFile, { force: true })
          resolvedOutputPath = finalPath
          job.output_lines.push(`Copied to external (cross-device): ${finalName}`)
        } catch (copyErr: any) {
          // External-copy failure → fall back to project-tree rename so
          // we don't lose the file the user just spent compute on.
          job.output_lines.push(`Warning: external copy failed (${copyErr.message || copyErr}); falling back to project tree`)
          try {
            await fs.rename(outputFile, projectTreeFinalPath)
            resolvedOutputPath = projectTreeFinalPath
            job.output_lines.push(`Renamed to: ${finalName} (project tree fallback)`)
          } catch (fallbackErr: any) {
            job.output_lines.push(`Warning: final rename skipped (${fallbackErr.message || 'unknown error'})`)
          }
        }
      } else {
        // Cloud-synced filesystems (iCloud, Dropbox) sometimes reject rename
        // with EPERM. Keep the timestamped file as the canonical output in
        // that case — the render is still usable.
        job.output_lines.push(`Warning: final rename skipped (${e.message || 'unknown error'})`)
      }
    }

    job.progress = 100
    job.output_lines.push(`Video saved: ${path.basename(resolvedOutputPath)}`)
    job.output_lines.push(`Full path: ${resolvedOutputPath}`)
    job.output_dir = path.dirname(resolvedOutputPath)

    // Invalidate the episode-status cache so the next /episodes call
    // recomputes status.video_assembly. The chokidar watcher catches
    // writes inside the project tree, but when the final video lands
    // at an external path (eg ~/Downloads/YouTube - Channels/...) the
    // watcher never fires — so we must signal the cache explicitly.
    try {
      const { episodeStatusCache } = await import('../services/episode-status-cache.js')
      episodeStatusCache.invalidate(project_slug, code)
    } catch { /* best-effort — not worth failing the job over */ }

    succeeded = true

  } finally {
    // Cleanup policy:
    //   - debug mode  → keep tempDir always (replay any stage)
    //   - failed run  → keep tempDir so the user can inspect the broken
    //                   intermediate / xfade chunk that caused the failure
    //   - success     → remove tempDir (default historical behaviour)
    const keep = debugMode || !succeeded
    if (keep) {
      job.output_lines.push(
        debugMode
          ? `Debug mode: preserved temp files at ${tempDir}`
          : `Run failed — preserved temp files for inspection at ${tempDir}`
      )
    } else {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch {
        // Non-critical cleanup failure
      }
    }
  }
}

// ── Compilation-mode helpers (Path C — v1.0.63+) ─────────────────────────

/**
 * Render a looped background-plate clip that fills the full target
 * duration. Used as the base video in compilation mode (BrainWise-style
 * listicle / explainer channels) where the visual continuity comes
 * from a starfield / atmospheric loop and per-chapter foreground icons
 * are composited on top via the auto-generated overlay layers.
 *
 * Static images vs videos: ffmpeg uses different loop flags. Detect by
 * extension and apply the right one — `-loop 1` for stills,
 * `-stream_loop -1` for videos. Result is always re-encoded to libx264
 * at the canvas resolution + project fps so downstream filter graphs
 * have predictable input dimensions/timestamps.
 */
async function prepareCompilationBackground(
  plate: BackgroundPlate,
  w: number,
  h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  totalDuration: number,
  job: Job,
): Promise<string> {
  const outputPath = path.join(tempDir, 'compilation_background.mp4')
  const isImage = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(plate.source_path)
  job.output_lines.push(
    `Compilation: ${isImage ? 'looping still' : 'looping video'} background ` +
    `(${path.basename(plate.source_path)}) → ${totalDuration.toFixed(1)}s @ ${w}×${h} ${quality.fps}fps`,
  )

  const args: string[] = ['-y']
  if (isImage) {
    // Stills: -loop 1 + -t target. Frame rate is provided by the
    // output -r flag; ffmpeg synthesises a stream of frames from the
    // single image.
    args.push('-loop', '1', '-i', plate.source_path)
  } else {
    // Videos: -stream_loop -1 wraps the input infinitely; -t below
    // caps the output. We accept the small perf cost of reading the
    // file repeatedly because users typically supply a 10-30s loop
    // and a 1h+ episode would otherwise need a very long source.
    args.push('-stream_loop', '-1', '-i', plate.source_path)
  }

  args.push(
    '-t', totalDuration.toString(),
    // scale=force_aspect_ratio=decrease,pad=… letterboxes/pillarboxes
    // sources that don't match canvas aspect — keeps the bg crisp
    // without distorting it. fps + format normalise the stream so the
    // downstream concat / filter passes don't trip on mismatched
    // pixel formats.
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${quality.fps},format=yuv420p`,
    '-c:v', 'libx264',
    // Pre-render speed — the FINAL encode at runFinalComposition uses
    // the user's chosen preset/crf. This is just an intermediate.
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    // Match standard pipeline's color tagging (see prepareSceneClips
    // commentary) so the concat into the final filter graph doesn't
    // produce mixed bt709/unspecified streams.
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-an',
    outputPath,
  )

  await runFfmpeg(args)

  try {
    const info = await assertValidMedia(outputPath, {
      label: 'compilation_background.mp4',
      requireVideo: true,
      minDurationSec: 1,
    })
    job.output_lines.push(`Compilation background ready · ${summarizeMedia(info)}`)
  } catch (e: any) {
    job.output_lines.push(`Compilation background validation failed: ${e.message}`)
    throw e
  }
  return outputPath
}

/**
 * Generate one foreground overlay per chapter from the scene image
 * list + chapter audio durations. Each overlay is gated to its
 * chapter's time range (`[start_s, start_s + duration_s + gap]`) so
 * chapter N narration plays with chapter N foreground. Carries the
 * project's foreground_defaults (scale_pct + position_anchor +
 * chroma_key) onto every overlay so the layout stays consistent
 * across chapters without per-scene tuning.
 *
 * Mismatched counts (more scenes than chapters or vice versa) are
 * warned but tolerated — extras are dropped, missing chapters render
 * with no foreground.
 */
function buildCompilationOverlays(
  scenes: Array<{ image_path: string }>,
  chapterDurations: Array<{ slug: string; duration_s: number }>,
  fgDefaults: ForegroundDefaults,
  audioGap: number,
  job: Job,
): VideoOverlay[] {
  const sceneCount = Math.min(scenes.length, chapterDurations.length)
  if (sceneCount === 0) {
    job.output_lines.push(
      `Compilation: no scenes/chapters to align (scenes=${scenes.length}, chapters=${chapterDurations.length}). ` +
      `Background plate will play with no foreground overlays.`,
    )
    return []
  }
  if (scenes.length !== chapterDurations.length) {
    job.output_lines.push(
      `Compilation: ${scenes.length} scene(s) vs ${chapterDurations.length} chapter(s) — ` +
      `using positional pairing for the first ${sceneCount}, dropping any extras.`,
    )
  }

  const overlays: VideoOverlay[] = []
  let cumulativeOffset = 0
  for (let i = 0; i < sceneCount; i++) {
    const scene = scenes[i]!
    const chapter = chapterDurations[i]!
    const isLast = i === sceneCount - 1
    const startS = cumulativeOffset
    // Extend each foreground through the silent gap that follows it
    // so there's never a "no foreground" beat between chapters. Last
    // chapter has no trailing gap.
    const endS = cumulativeOffset + chapter.duration_s + (isLast ? 0 : audioGap)
    overlays.push({
      id: `compilation-scene-${i + 1}`,
      enabled: true,
      source_path: scene.image_path,
      chroma_key: fgDefaults.chroma_key
        ? { color: fgDefaults.chroma_key.color, similarity: fgDefaults.chroma_key.similarity, blend: fgDefaults.chroma_key.blend }
        : null,
      opacity: 1,
      scale_pct: fgDefaults.scale_pct,
      position_anchor: fgDefaults.position,
      time_range: { start_s: startS, end_s: endS },
      loop: false,
    })
    cumulativeOffset = endS
  }
  job.output_lines.push(
    `Compilation: ${overlays.length} foreground overlay(s) generated · ` +
    `total ${cumulativeOffset.toFixed(1)}s coverage`,
  )
  return overlays
}

// ── Prepare Scene Clips ───────────────────────────────────────────────────

/** Deterministic per-scene animation pick — same seed → same sequence. */
function pickAnimationsPerScene(
  count: number,
  primary: string,
  pool: string[],
  mode: 'off' | 'single' | 'per-scene',
  seed?: number,
): string[] {
  const picks: string[] = []
  if (count === 0) return picks
  if (mode === 'off' || pool.length === 0) {
    for (let i = 0; i < count; i++) picks.push(primary)
    return picks
  }
  const rnd = mulberry32(seed ?? 7)
  if (mode === 'single') {
    const pick = pool[Math.floor(rnd() * pool.length)]
    for (let i = 0; i < count; i++) picks.push(pick)
  } else {
    for (let i = 0; i < count; i++) {
      picks.push(pool[Math.floor(rnd() * pool.length)])
    }
  }
  return picks
}

function mulberry32(seed: number) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function prepareSceneClips(
  scenes: GenerateVideoRequest['scenes'],
  sceneAnimation: VideoSceneAnimation,
  chapterTitles: GenerateVideoRequest['chapter_titles'],
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  canDrawtext: boolean,
  recycling: VideoSceneRecycling,
  job: Job,
  /** Optional per-scene animation randomization. When enabled, each scene
   *  clip gets an animation picked from the pool; deterministic via seed. */
  animationOpts?: {
    pool: string[]
    randomizeMode: 'off' | 'single' | 'per-scene'
    seed?: number
  },
  /** v1.0.81+: sentence-aligned per-scene durations. Index-aligned with
   *  `scenes`. When provided, scene i renders for perSceneDurations[i]
   *  seconds instead of the uniform recycling.seconds_per_scene. Falls
   *  back to the uniform default when an entry is 0/undefined. Clamped
   *  to a sane floor (0.5s) to avoid sub-frame clips. */
  perSceneDurations?: number[],
): Promise<string[]> {
  const clipPaths: string[] = []
  const defaultDuration = recycling.seconds_per_scene || 10

  // Pre-pick an animation type for each scene. 'off' = use the primary type;
  // 'single' = one random type for all scenes; 'per-scene' = different each time.
  const picks = pickAnimationsPerScene(
    scenes.length,
    sceneAnimation.type || 'none',
    animationOpts?.pool || [],
    animationOpts?.randomizeMode || 'off',
    animationOpts?.seed,
  )

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const clipPath = path.join(tempDir, `scene_${String(i).padStart(4, '0')}.mp4`)

    // Pick per-scene duration: sentence-aligned override (when supplied
    // by the caller) wins over the uniform recycling default. Floor at
    // 0.5s so tiny sentence assignments don't produce sub-frame clips.
    const sceneOverride = perSceneDurations?.[i]
    const duration = (typeof sceneOverride === 'number' && Number.isFinite(sceneOverride) && sceneOverride > 0)
      ? Math.max(0.5, sceneOverride)
      : defaultDuration

    const pickedType = picks[i]
    const durLog = perSceneDurations && Math.abs(duration - defaultDuration) > 0.05 ? ` [dur=${duration.toFixed(2)}s]` : ''
    job.output_lines.push(`Preparing scene clips: ${i + 1}/${scenes.length}${pickedType !== sceneAnimation.type ? ` [anim=${pickedType}]` : ''}${durLog}`)

    const vfParts = buildAnimationFilter({
      type: pickedType,
      params: sceneAnimation,
      w, h,
      fps: quality.fps,
      duration,
    })

    // Chapter title overlay. v1.0.56+ optionally animates entry via
    // drawtext's `alpha=` (fade) or `x=` / `y=` (slide) expressions.
    // The legacy `animation: 'none'` (or missing field) emits exactly
    // the same filtergraph string the pre-animation pipeline produced
    // so older projects render byte-identically. See
    // VideoChapterTitles.animation in types.ts for preset semantics.
    if (canDrawtext && chapterTitles?.enabled && scene.title && scene.show_title) {
      const fontSize = getFontSize(chapterTitles.font_size, h)
      const yPos = getTextPosition(chapterTitles.position, h)
      const fontColor = getStyleColor(chapterTitles.style)
      const titleDur = chapterTitles.duration || 3
      const anim = chapterTitles.animation || 'none'
      // Cap the transition at duration/2 — a 1s fade-in plus 1s
      // fade-out can't fit inside a 1.5s title. Sane minimum 0.05s
      // avoids div-by-zero in the alpha/x/y expressions below.
      const animDur = Math.max(0.05, Math.min(
        chapterTitles.animation_duration ?? 0.5,
        titleDur / 2,
      ))
      const drawCommon = `text='${escapeDrawtext(scene.title)}':fontsize=${fontSize}:fontcolor=${fontColor}:enable='lt(t,${titleDur})':borderw=2:bordercolor=black@0.6`
      let drawXY = `x=(w-text_w)/2:y=${yPos}`
      let drawAlpha = ''
      switch (anim) {
        case 'fade-in-out': {
          // alpha 0→1 over animDur, hold, 1→0 over animDur. The
          // `enable=` gate above kills the drawtext past titleDur so
          // we don't have to worry about negative alpha clamping.
          drawAlpha = `:alpha='if(lt(t,${animDur.toFixed(3)}),t/${animDur.toFixed(3)},if(lt(t,${(titleDur - animDur).toFixed(3)}),1,(${titleDur.toFixed(3)}-t)/${animDur.toFixed(3)}))'`
          break
        }
        case 'slide-from-left': {
          // Start offscreen-left (x = -text_w), lerp to centered.
          // After animDur, hold at center until enable= hides it.
          drawXY = `x='if(lt(t,${animDur.toFixed(3)}),-text_w+((w+text_w)/2)*(t/${animDur.toFixed(3)}),(w-text_w)/2)':y=${yPos}`
          break
        }
        case 'slide-from-right': {
          // Start offscreen-right (x = w), lerp to centered.
          drawXY = `x='if(lt(t,${animDur.toFixed(3)}),w-((w+text_w)/2)*(t/${animDur.toFixed(3)}),(w-text_w)/2)':y=${yPos}`
          break
        }
        case 'slide-up': {
          // Start below the frame (y = h), lerp upward to yPos.
          // yPos may be a literal (e.g. '86') or an expression (e.g.
          // '(h-text_h)/2') — both substitute fine.
          drawXY = `x=(w-text_w)/2:y='if(lt(t,${animDur.toFixed(3)}),h-(h-(${yPos}))*(t/${animDur.toFixed(3)}),${yPos})'`
          break
        }
        case 'none':
        default:
          // No animation — leave drawXY at static center+yPos and
          // drawAlpha empty so the emitted string matches the
          // pre-v1.0.56 output exactly.
          break
      }
      vfParts.push(`drawtext=${drawCommon}:${drawXY}${drawAlpha}`)
    }

    vfParts.push('format=yuv420p')

    // Explicit bt709 color tagging to match prepareTitleClip, prepareOutroClip
    // and commonPostArgs. Without this, scene clips emit "unspecified" color
    // metadata while the post-audio / outro segments emit bt709 — the
    // stream-copy concat into intermediate_video.mp4 then carries a tag
    // switch mid-file, which libx265 rejects at final composition init with
    // exit code 183 / return code -22 (EINVAL). See docs/refactors/
    // fal-model-audit.md? no — investigation trail in plan file.
    const args = [
      '-y', '-loop', '1', '-t', duration.toString(),
      '-i', scene.image_path,
      '-vf', vfParts.join(','),
      '-c:v', 'libx264', '-crf', quality.crf.toString(),
      '-preset', 'ultrafast', '-r', quality.fps.toString(),
      '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
      '-color_range', 'tv', '-colorspace', 'bt709',
      '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-t', duration.toString(),  // Guarantee exact output duration
      '-an',
      clipPath,
    ]

    await runFfmpeg(args)
    clipPaths.push(clipPath)
  }

  return clipPaths
}

// ── Prepare Title Clip ────────────────────────────────────────────────────

async function prepareTitleClip(
  titleImage: VideoTitleImageConfig,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, 'title_scene.mp4')
  const duration = titleImage.duration || 5

  job.output_lines.push(`Preparing title image clip (${duration}s)`)

  // Use the shared `normalizeFrame` chain — same one every other clip in
  // the concat list uses (scene xfade chunks, intro, post-audio). Keeps
  // SAR / pixel-format / colour primaries in lockstep so `concat -c copy`
  // renders the title correctly. Historically this was a hand-rolled chain
  // that hit the FFmpeg 8.1 `pad=…:color=black,setsar=1` adjacency bug and
  // caused the title to silently drop from output. `-r quality.fps` handles output
  // frame rate, so we strip the `fps=` token from the chain (same trick
  // `prepareIntroClip` uses).
  const titleVf = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))

  const args = [
    '-y', '-loop', '1', '-t', duration.toString(),
    '-i', titleImage.image_path,
    '-vf', titleVf.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

// ── Prepare Intro Clip (re-encode to match resolution) ────────────────────

async function prepareOutroClip(
  outro: VideoOutroConfig,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, 'outro.mp4')

  job.output_lines.push('Preparing outro video clip')

  // Same encode pipeline as prepareIntroClip — shared normalizeFrame so the
  // outro slots cleanly into the concat list without SAR / pixel-format
  // drift, and explicit colour tagging matching the post-audio clips.
  const outroFrame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  const args = [
    '-y',
    '-i', outro.video_path,
    '-vf', outroFrame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

/**
 * Normalise a user-supplied timeline clip to match the output resolution,
 * fps, and colour metadata so it can slot into the stream-copy concat list
 * alongside intro/outro/scene clips without SAR / pixel-format / colour
 * mismatches. Effectively the intro/outro prep path generalised for N
 * clips — the `idx` is only used to keep tempDir filenames unique.
 */
async function prepareTimelineClip(
  clip: VideoTimelineClip,
  idx: number,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  // Dispatch by source kind. Static = synthesised from a single image
  // (cheap to encode, ~1% the disk size of an equivalent pre-rendered
  // video). Video = re-encode the user's MP4 (the legacy path).
  if (clip.kind === 'static') {
    return prepareStaticTimelineClip(clip, idx, w, h, quality, tempDir, job)
  }

  const clipPath = path.join(tempDir, `timeline_${clip.anchor}_${idx}.mp4`)

  job.output_lines.push(`Preparing timeline clip [${clip.anchor}] #${idx + 1}`)

  const frame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  const args = [
    '-y',
    '-i', clip.video_path,
    '-vf', frame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

/**
 * Synthesise a timeline clip from a single still image + duration.
 * Replaces the workflow where users pre-rendered multi-hour static
 * MP4s in a video editor and dropped them into the timeline.
 *
 * Speed wins are dramatic for sleep-story-style tails:
 *   - `-loop 1 -i image.jpg -t <dur>` repeats the image at fps from
 *     the encoder's perspective (no per-frame decoding cost).
 *   - `-tune stillimage` tells libx264 to optimise rate-distortion
 *     for unchanging frames — the encoder emits one keyframe and
 *     effectively-empty P-frames.
 *   - The intermediate file ends up tiny (≈10-20 MB for 2 hours of
 *     1080p static, vs ≈2 GB for a re-encoded pre-rendered MP4).
 *   - Wall-clock prep is dominated by output muxing, not encoding.
 *
 * Audio is stripped (`-an`) like every other timeline clip — the
 * post-narration ambient/music tail comes from the separate `music`
 * config which already loops via `-stream_loop -1`.
 */
async function prepareStaticTimelineClip(
  clip: VideoTimelineClipStatic,
  idx: number,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, `timeline_static_${clip.anchor}_${idx}.mp4`)

  const minutes = (clip.duration_sec / 60).toFixed(1)
  job.output_lines.push(
    `Preparing static timeline clip [${clip.anchor}] #${idx + 1} (${minutes} min from single image)`,
  )

  const frame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  // -loop 1 + -t bracket the still image as a duration-bounded source.
  // Putting -t BEFORE -i sets the input duration limit; the muxer then
  // emits exactly that many seconds of frames at -r quality.fps.
  // -tune stillimage is libx264-only — we deliberately don't expose a
  // hardware path here because videotoolbox doesn't accept tune, and
  // libx264 ultrafast on a still image is already near-instant
  // (encoder-bound on output muxing, not ratecontrol).
  const args = [
    '-y',
    '-loop', '1', '-t', clip.duration_sec.toString(), '-i', clip.image_path,
    '-vf', frame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

async function prepareIntroClip(
  intro: VideoIntroConfig,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, 'intro.mp4')

  job.output_lines.push('Preparing intro video clip')

  // Strip audio — all concat clips must be video-only (audio comes from pre-mix).
  // normalizeFrame keeps this chain in lockstep with every other clip's frame
  // shape so concat/xfade don't hit size/SAR mismatches. Intro doesn't need
  // the fps token inside the -vf because `-r quality.fps` downstream sets output fps;
  // dropping the fps token keeps the chain short.
  const introFrame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  // Same bt709 tagging rationale as prepareSceneClips: every segment in the
  // stream-copy concat must agree on colour metadata or libx265 rejects the
  // intermediate at final composition init (EINVAL). prepareTitleClip and
  // prepareOutroClip already emit these; intro is the remaining outlier.
  const args = [
    '-y',
    '-i', intro.video_path,
    '-vf', introFrame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

// ── Prepare Music Track ───────────────────────────────────────────────────

async function prepareMusicTrack(
  music: VideoMusicConfig,
  tempDir: string,
  job: Job,
): Promise<string> {
  // Validate all music files exist
  const validFiles = music.files.filter(f => existsSync(f))
  if (validFiles.length === 0) {
    throw new Error('No valid music files found')
  }

  job.output_lines.push(`Preparing music track (${validFiles.length} file(s))`)

  if (validFiles.length === 1) {
    // Single file — just return it directly, will be looped in final pass
    return validFiles[0]
  }

  // Multiple files — concatenate them into one track with normalized sample rate
  const musicListPath = path.join(tempDir, 'music_list.txt')
  const lines = validFiles.map(f => formatConcatFileLine(f))
  await fs.writeFile(musicListPath, lines.join('\n') + '\n')

  const concatenatedPath = path.join(tempDir, 'music_concat.mp3')
  const args = [
    '-y',
    '-f', 'concat', '-safe', '0',
    '-i', musicListPath,
    '-af', 'aresample=44100',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    concatenatedPath,
  ]

  await runFfmpeg(args)
  return concatenatedPath
}

// ── Prepare Narration with Gaps Between Chapters ─────────────────────────

async function prepareNarrationWithGaps(
  chapterPaths: string[],
  gapSeconds: number,
  tempDir: string,
  job: Job,
): Promise<string> {
  const validChapters = chapterPaths.filter(f => existsSync(f))
  if (validChapters.length === 0) {
    throw new Error('No valid narration chapter files found')
  }

  job.output_lines.push(`Preparing narration: ${validChapters.length} chapters with ${gapSeconds}s gaps`)

  if (validChapters.length === 1 && gapSeconds <= 0) {
    return validChapters[0]
  }

  // Create a silence audio file for the gap
  let silenceFile: string | undefined
  if (gapSeconds > 0) {
    silenceFile = path.join(tempDir, 'chapter_silence.mp3')
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', gapSeconds.toString(),
      '-c:a', 'libmp3lame', '-b:a', '128k',
      silenceFile,
    ])
  }

  // Build concat list: chapter1 → silence → chapter2 → silence → chapter3 ...
  const listPath = path.join(tempDir, 'narration_list.txt')
  const lines: string[] = []
  const esc = formatConcatFileLine

  for (let i = 0; i < validChapters.length; i++) {
    lines.push(esc(validChapters[i]))
    // Insert silence between chapters (not after the last one)
    if (i < validChapters.length - 1 && silenceFile) {
      lines.push(esc(silenceFile))
    }
  }

  await fs.writeFile(listPath, lines.join('\n') + '\n')

  // Concatenate into single narration file
  const outputPath = path.join(tempDir, 'narration_with_gaps.mp3')
  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0',
    '-i', listPath,
    '-af', 'aresample=44100',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outputPath,
  ])

  job.output_lines.push(`Narration assembled: ${validChapters.length} chapters`)
  return outputPath
}

// ── Build Concat List ─────────────────────────────────────────────────────

async function buildConcatList(
  tempDir: string,
  introClipPath: string | undefined,
  titleClipPath: string | undefined,
  sceneClips: string[],
  targetDuration: number,
  narrationDuration: number,
  postAudio: VideoPostAudio,
  recycling: VideoSceneRecycling,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  lastSceneImagePath: string | undefined,
  job: Job,
  /** Optional scene-to-scene transition settings. When the primary id resolves
   * to a real xfade keyword, the scene clips are pre-xfaded into a single
   * intermediate MP4 (replacing N lines in the concat list with one). */
  transitionOpts?: {
    primaryId: string
    pool: string[]
    randomizeMode: 'off' | 'single' | 'per-scene'
    durationSec: number
    seed?: number
  },
  outroClipPath?: string,
  /** User-supplied clips bucketed by anchor. Each bucket is emitted in
   *  order at its named position. Buckets that are empty are no-ops, so
   *  callers that don't use timeline clips can pass `undefined`. */
  timelineClipsByAnchor?: Record<TimelineAnchor, Array<{ path: string; duration: number }>>,
  /** When provided AND `enabled`, scenes are partitioned across the
   *  supplied chapter durations (in order) instead of uniform-cycling
   *  the entire bag. Each chapter's assigned scenes cycle within its
   *  own audio duration so chapter N's narration plays with chapter N's
   *  scene images. Falls back to legacy cycling when missing/disabled. */
  chapterAlignment?: {
    enabled: boolean
    chapterDurations: Array<{ slug: string; duration_s: number }>
  },
  /** Optional per-clip chapter slug — same length & order as
   *  `sceneClips`. When ANY entry is non-empty, the alignment branch
   *  groups by explicit slug (per-scene swap, v1.0.57+) instead of
   *  positional even-split. Entries that are empty/undefined fall
   *  back to positional placement so a half-edited assignment file
   *  still produces a valid render. */
  sceneChapterSlugs?: Array<string | undefined>,
): Promise<{ listPath: string; sceneEndTime: number }> {
  const listPath = path.join(tempDir, 'concat_list.txt')
  const lines: string[] = []
  const esc = formatConcatFileLine

  let accumulatedDuration = 0
  const sceneDuration = recycling.seconds_per_scene || 10

  // Empty default buckets so downstream reads don't have to guard `undefined`.
  const buckets = timelineClipsByAnchor ?? {
    before_intro: [],
    after_intro: [],
    after_scenes: [],
    after_outro: [],
  }

  // Bucket 1 of 4 — before_intro: very start of the video.
  for (const c of buckets.before_intro) {
    lines.push(esc(c.path))
    accumulatedDuration += c.duration
  }

  // Add intro
  if (introClipPath) {
    lines.push(esc(introClipPath))
    const introDur = await getAudioDuration(introClipPath)
    accumulatedDuration += introDur || 5
  }

  // Add title image clip
  if (titleClipPath) {
    lines.push(esc(titleClipPath))
    accumulatedDuration += 5
  }

  // Bucket 2 of 4 — after_intro: after intro/title, before the first scene.
  // Treated as "pre-scene" content that the effect gate must skip over,
  // which is why its duration is added to `accumulatedDuration` (the gate
  // start tracker) — matches how intro/title contribute above.
  for (const c of buckets.after_intro) {
    lines.push(esc(c.path))
    accumulatedDuration += c.duration
  }

  // Filter out excluded scenes — excluded_scenes contains 1-based scene numbers
  const excludedSet = new Set(recycling.excluded_scenes || [])
  const availableClips = sceneClips.filter((_, idx) => !excludedSet.has(idx + 1))
  // Parallel slug array, kept in sync with the same exclusion filter so
  // index `i` of availableClips matches `availableSlugs[i]` even after
  // some scenes are dropped.
  const availableSlugs: Array<string | undefined> = (sceneChapterSlugs || [])
    .filter((_, idx) => !excludedSet.has(idx + 1))

  if (availableClips.length === 0) {
    throw new Error('No scene clips available after applying exclusions')
  }

  const behavior = postAudio.behavior || 'fade-to-black'
  const clipsPerCycle = availableClips.length
  const durationPerCycle = clipsPerCycle * sceneDuration

  // Determine how long scenes should play:
  // - 'continue-cycling': scenes fill the entire target duration (original behavior)
  // - All others: scenes fill up to narration duration, then post-audio fills the rest
  const sceneFillDuration = behavior === 'continue-cycling'
    ? targetDuration - accumulatedDuration
    : Math.max(0, narrationDuration - accumulatedDuration)

  // Build the sequential list of scene clip paths.
  //
  // Two modes:
  //  A) Chapter-aligned (Workstream B): partition scenes across chapter
  //     durations in order. Each chapter's assigned slice cycles within
  //     its own audio duration so chapter N narration plays with
  //     chapter N visuals. Shuffle is intentionally ignored here —
  //     ordering must follow chapter order to preserve the alignment.
  //  B) Legacy uniform cycling: every scene gets the same duration and
  //     the whole bag cycles to fill `sceneFillDuration`.
  const scenePlayOrder: string[] = []
  const chapterAlignActive = !!(chapterAlignment?.enabled
    && chapterAlignment.chapterDurations.length > 0
    && availableClips.length > 0)

  if (chapterAlignActive) {
    const chapters = chapterAlignment!.chapterDurations
    const C = chapters.length
    const S = availableClips.length

    // Two ways to partition. Explicit-slug mode beats positional when
    // ANY scene carries a chapter_slug — assumes the user opened the
    // per-scene swap UI and edited assignments. Positional even-split
    // is the legacy Workstream B behaviour and the safe fallback when
    // no slugs are set.
    const hasExplicitSlugs = availableSlugs.some(s => typeof s === 'string' && s.length > 0)
    type ChapterBucket = { ch: typeof chapters[number]; clips: string[] }
    const buckets: ChapterBucket[] = chapters.map(ch => ({ ch, clips: [] }))
    const bucketIdxBySlug = new Map<string, number>()
    chapters.forEach((ch, i) => bucketIdxBySlug.set(ch.slug, i))

    if (hasExplicitSlugs) {
      // Explicit assignments. For each clip, look up its slug; if it
      // resolves to a known chapter, drop into that bucket. Clips
      // without a slug (or with an unknown one) fall back to positional
      // assignment in their natural index — they get bucketed by the
      // same baseSpc / extra split we use in even-split mode below.
      const baseSpc = Math.floor(S / C)
      const extra = S - baseSpc * C
      const positionalBucket = (clipIdx: number): number => {
        // Reverse the cumulative-sum table so we can map clip index
        // directly to bucket without iterating chapters per clip.
        let acc = 0
        for (let ci = 0; ci < C; ci++) {
          const sz = baseSpc + (ci < extra ? 1 : 0)
          if (clipIdx < acc + sz) return ci
          acc += sz
        }
        return C - 1
      }
      for (let i = 0; i < availableClips.length; i++) {
        const slug = availableSlugs[i]
        let bIdx = -1
        if (slug && bucketIdxBySlug.has(slug)) bIdx = bucketIdxBySlug.get(slug)!
        if (bIdx < 0) bIdx = positionalBucket(i)
        buckets[bIdx]!.clips.push(availableClips[i]!)
      }
      job.output_lines.push(
        `Chapter alignment: ON · explicit per-scene assignments (any unmapped scene falls to positional default)`,
      )
    } else {
      // Positional even-split (legacy Workstream B behaviour).
      const baseSpc = Math.floor(S / C)
      const extra = S - baseSpc * C
      let cursor = 0
      for (let ci = 0; ci < C; ci++) {
        const chapterScenes = baseSpc + (ci < extra ? 1 : 0)
        const sliceClips = availableClips.slice(cursor, cursor + chapterScenes)
        buckets[ci]!.clips.push(...sliceClips)
        cursor += chapterScenes
      }
    }

    // Cycle each bucket within its chapter's audio duration. Empty
    // buckets borrow the previous bucket's last clip so the chapter
    // doesn't render as a silent gap (covers S < C and odd skews).
    let lastNonEmpty: string | null = null
    const chapterPlanLog: string[] = []
    for (let ci = 0; ci < C; ci++) {
      const b = buckets[ci]!
      if (b.clips.length === 0) {
        const fallback = lastNonEmpty
          ?? buckets.find(o => o.clips.length > 0)?.clips[0]
          ?? availableClips[0]!
        b.clips.push(fallback)
      }
      lastNonEmpty = b.clips[b.clips.length - 1]!
      const clipsNeeded = Math.max(1, Math.ceil(b.ch.duration_s / sceneDuration))
      for (let k = 0; k < clipsNeeded; k++) {
        scenePlayOrder.push(b.clips[k % b.clips.length]!)
      }
      chapterPlanLog.push(`${b.ch.slug}: ${b.clips.length} scene(s) × ${clipsNeeded} cycle(s) = ${b.ch.duration_s.toFixed(1)}s`)
    }
    job.output_lines.push(
      `Chapter alignment: ${C} chapter(s), ${S} scene(s) total — ${chapterPlanLog.join(' | ')}`,
    )
  } else {
    const cyclesNeeded = Math.max(1, Math.ceil(sceneFillDuration / durationPerCycle))
    for (let cycle = 0; cycle < cyclesNeeded; cycle++) {
      let cycleClips = [...availableClips]
      if (recycling.shuffle) {
        for (let i = cycleClips.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [cycleClips[i], cycleClips[j]] = [cycleClips[j], cycleClips[i]]
        }
      }
      for (const clip of cycleClips) scenePlayOrder.push(clip)
    }
  }

  const totalClips = scenePlayOrder.length

  // Decide whether to pre-xfade the scenes into a single fused MP4.
  // Pre-xfade runs only when: more than one clip, a primary transition was
  // picked, and that transition resolves to a known xfade keyword.
  const primaryTransition = transitionOpts ? getTransition(transitionOpts.primaryId) : null
  const xfadeEnabled = !!(transitionOpts && primaryTransition && primaryTransition.xfade && totalClips >= 2)

  // Hard limit on how many scene clips we pass to a single FFmpeg xfade
  // invocation. FFmpeg opens one decoder per input, and macOS's soft fd
  // limit caps the process around 256 simultaneous inputs. Long sleep
  // stories can need 300+ clips after cycling to fill narration duration,
  // so we split the xfade into chunks and stream-copy the chunks together.
  //
  // Trade-off: one hard cut per chunk boundary. For a 3h video that's
  // ≤8 hard cuts across 350+ scene boundaries — imperceptible in practice.
  // Tunable via env var for machines with raised ulimits.
  const XFADE_CHUNK_SIZE = Math.max(
    2,
    Math.min(
      parseInt(process.env.STORY_STUDIO_XFADE_CHUNK_SIZE || '48', 10) || 48,
      128,
    ),
  )

  let xfadeHardCuts = 0
  if (xfadeEnabled && transitionOpts) {
    const plan = planTransitions({
      clipCount: totalClips,
      durationSec: transitionOpts.durationSec,
      primaryId: transitionOpts.primaryId,
      pool: transitionOpts.pool,
      randomizeMode: transitionOpts.randomizeMode,
      seed: transitionOpts.seed,
    })

    // Split the play order into chunks of at most XFADE_CHUNK_SIZE clips.
    // Each chunk becomes one FFmpeg invocation with its own filter graph.
    const chunks: string[][] = []
    for (let i = 0; i < scenePlayOrder.length; i += XFADE_CHUNK_SIZE) {
      chunks.push(scenePlayOrder.slice(i, i + XFADE_CHUNK_SIZE))
    }
    xfadeHardCuts = Math.max(0, chunks.length - 1)

    job.output_lines.push(
      `Xfading ${totalClips} scene clips with transition=${transitionOpts.primaryId} ` +
      `(${plan.durationSec}s)` +
      (transitionOpts.randomizeMode !== 'off' ? ` [randomize=${transitionOpts.randomizeMode}]` : '') +
      (chunks.length > 1 ? ` in ${chunks.length} chunks of ≤${XFADE_CHUNK_SIZE} (${xfadeHardCuts} hard cuts)` : '')
    )

    // Walk the global plan, slicing out (chunk.length - 1) keywords per chunk.
    // The 1 keyword between each pair of chunks is consumed by the hard cut
    // at the chunk boundary — not rendered, just skipped in the pointer.
    let keywordCursor = 0
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c]
      const chunkPath = path.join(tempDir, `scenes_xfaded_${String(c).padStart(2, '0')}.mp4`)

      if (chunk.length === 1) {
        // A singleton chunk can't xfade anything. Stream-copy it so the
        // output has a stable filename and the concat list shape is uniform.
        await runFfmpeg(['-y', '-i', chunk[0], '-c:v', 'copy', '-an', chunkPath])
      } else {
        const internalBoundaries = chunk.length - 1
        const keywordsForChunk = plan.xfadeKeywords.slice(keywordCursor, keywordCursor + internalBoundaries)
        const filter = buildXfadeFilterComplex({
          inputCount: chunk.length,
          clipDuration: sceneDuration,
          transitionDuration: plan.durationSec,
          xfadeKeywords: keywordsForChunk,
        })
        const args: string[] = ['-y']
        for (const clip of chunk) args.push('-i', clip)
        args.push('-filter_complex', filter)
        args.push('-map', '[vout]')
        args.push('-c:v', 'libx264', '-crf', quality.crf.toString(), '-preset', 'ultrafast')
        args.push('-r', quality.fps.toString(), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-an', chunkPath)
        await runFfmpeg(args)
      }

      // Cheap pre-flight: if a chunk came out empty, fail loudly here
      // rather than letting the silent zero-frame chunk propagate into
      // the intermediate concat — where the failure is many minutes and
      // hundreds of log lines downstream.
      try {
        await assertValidMedia(chunkPath, {
          label: `scenes_xfaded_${String(c).padStart(2, '0')}.mp4`,
          requireVideo: true,
          minDurationSec: 1,
        })
      } catch (e: any) {
        job.output_lines.push(`Xfade chunk validation failed: ${e.message}`)
        throw e
      }

      lines.push(esc(chunkPath))
      // Skip past this chunk's internal boundaries AND the one cross-chunk
      // boundary that became a hard cut.
      keywordCursor += chunk.length
    }
  } else {
    for (const clip of scenePlayOrder) lines.push(esc(clip))
  }

  // With xfade, the total displayed duration shrinks by transitionDuration
  // at each xfade overlap. With chunking, chunk boundaries are hard cuts
  // (no overlap), so savings = (xfades actually performed) × t.
  // Actual xfades = (totalClips - 1) - hardCuts.
  const xfadeSavings = xfadeEnabled && transitionOpts
    ? Math.max(0, (totalClips - 1 - xfadeHardCuts)) * transitionOpts.durationSec
    : 0
  const sceneEndTime = accumulatedDuration + (totalClips * sceneDuration) - xfadeSavings
  // `cyclesNeeded` only makes sense in legacy uniform-cycling mode. The
  // chapter-aligned path doesn't have a single global cycle count, so
  // we report a derived round-trip number for diagnostics either way.
  const reportedCycles = chapterAlignActive
    ? `${chapterAlignment!.chapterDurations.length}-chapter aligned`
    : `${Math.max(1, Math.ceil(sceneFillDuration / durationPerCycle))} cycle(s)`
  job.output_lines.push(`Scene clips: ${reportedCycles}, ${totalClips} clips (${sceneEndTime.toFixed(0)}s)`)

  // Bucket 3 of 4 — after_scenes: between the last scene cycle and the
  // post-audio fade/hold. These clips are beyond `sceneEndTime`, so the
  // effects gate already excludes them (same rule the outro relies on).
  // Their durations are NOT added to sceneEndTime because the effect gate
  // uses sceneEndTime as the *end* of effects — pushing it out would
  // extend effect playback past the last real scene.
  for (const c of buckets.after_scenes) {
    lines.push(esc(c.path))
  }

  // Handle post-audio section (the gap between narration end and target duration)
  if (behavior !== 'continue-cycling') {
    const postDuration = Math.max(0, targetDuration - sceneEndTime)

    if (postDuration > 0) {
      // Pinning codec/colourspace on every post-audio clip so it can be
      // stream-copied into the same intermediate as the scene clips. The
      // original code would occasionally drift on SAR or color trc, which
      // is what the user reported as "problems with blank screen padding".
      const commonPostArgs = [
        '-c:v', 'libx264', '-crf', quality.crf.toString(), '-preset', 'ultrafast',
        '-r', quality.fps.toString(), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
        '-color_range', 'tv', '-colorspace', 'bt709',
        '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-an',
      ]
      // Single source of truth for clip frame-shape — see animation-filters.ts.
      const normalizeVf = normalizeFrame(w, h, quality.fps).join(',')

      if (behavior === 'black-screen') {
        const blackClip = path.join(tempDir, 'post_black.mp4')
        await runFfmpeg([
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${quality.fps}:d=${postDuration}`,
          '-vf', `${normalizeVf}`,
          ...commonPostArgs, blackClip,
        ])
        lines.push(esc(blackClip))
        job.output_lines.push(`Post-audio: black screen for ${postDuration.toFixed(0)}s`)

      } else if (behavior === 'fade-to-black' && lastSceneImagePath && existsSync(lastSceneImagePath)) {
        const fadeDur = Math.min(postAudio.fade_duration || 5, postDuration)
        const holdDur = Math.max(0, postDuration - fadeDur)

        const fadeClip = path.join(tempDir, 'post_fade.mp4')
        // Normalise via the shared helper, then splice `fade` in BEFORE the
        // final `format=yuv420p` so the fade curve runs on RGB-accurate data
        // and the last token still fixes the pixel format for x264.
        // Direct hand-rolled strings here are what caused the FFmpeg 8.1
        // crash on `post_fade.mp4` previously (see plans/you-are-a-senior-
        // federated-teapot.md for the post-mortem).
        const frame = normalizeFrame(w, h, quality.fps)
        const fadeVf = [
          ...frame.slice(0, -1),                  // everything up to (not incl) `format=yuv420p`
          `fade=t=out:st=0:d=${fadeDur}`,
          frame[frame.length - 1],                // `format=yuv420p`
        ].join(',')
        await runFfmpeg([
          '-y', '-loop', '1', '-t', fadeDur.toString(),
          '-i', lastSceneImagePath,
          '-vf', fadeVf,
          ...commonPostArgs, '-t', fadeDur.toString(), fadeClip,
        ])
        lines.push(esc(fadeClip))

        if (holdDur > 0) {
          const holdBlack = path.join(tempDir, 'post_hold_black.mp4')
          await runFfmpeg([
            '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${quality.fps}:d=${holdDur}`,
            '-vf', `${normalizeVf}`,
            ...commonPostArgs, holdBlack,
          ])
          lines.push(esc(holdBlack))
        }
        job.output_lines.push(`Post-audio: ${fadeDur.toFixed(0)}s fade to black + ${holdDur.toFixed(0)}s hold`)

      } else if (behavior === 'hold-last-scene' && lastSceneImagePath && existsSync(lastSceneImagePath)) {
        const holdClip = path.join(tempDir, 'post_hold.mp4')
        await runFfmpeg([
          '-y', '-loop', '1', '-t', postDuration.toString(),
          '-i', lastSceneImagePath,
          '-vf', `${normalizeVf}`,
          ...commonPostArgs, '-t', postDuration.toString(), holdClip,
        ])
        lines.push(esc(holdClip))
        job.output_lines.push(`Post-audio: hold last scene for ${postDuration.toFixed(0)}s`)
      }
    }
  }

  // Outro clip is appended last. It sits beyond `sceneEndTime` which is what
  // the final composition uses as the effects-gate `endSec` — so the outro
  // is automatically effect-free (branded content stays untouched).
  if (outroClipPath) {
    lines.push(esc(outroClipPath))
    job.output_lines.push('Outro: appended user-supplied clip')
  }

  // Bucket 4 of 4 — after_outro: very end of the video. Same effect-gate
  // story as the outro (beyond sceneEndTime → never graded/vignetted/etc).
  // This is where the user's multi-hour black screen for sleep stories
  // lives — previously hacked into the outro slot.
  for (const c of buckets.after_outro) {
    lines.push(esc(c.path))
  }

  await fs.writeFile(listPath, lines.join('\n') + '\n')
  return { listPath, sceneEndTime }
}

// ── Pre-Mix Audio (Step 1 of 2) ──────────────────────────────────────────
// Combines narration + music + noise into a single audio file
// This avoids complex multi-input filter graphs in the final composition

interface PremixAudioOpts {
  narrationPath: string
  narrationDuration: number
  narrationVolume: number
  musicFilePath?: string
  musicConfig?: VideoMusicConfig
  backgroundNoise?: VideoBackgroundNoise
  targetDuration: number
  tempDir: string
  job: Job
}

async function premixAudio(opts: PremixAudioOpts): Promise<string> {
  const {
    narrationPath, narrationDuration, narrationVolume,
    musicFilePath, musicConfig, backgroundNoise,
    targetDuration, tempDir, job,
  } = opts

  const outputPath = path.join(tempDir, 'premixed_audio.wav')
  const args: string[] = ['-y']
  const filterParts: string[] = []
  let nextIdx = 0

  // Input 0: narration
  args.push('-i', narrationPath)
  const narrIdx = nextIdx++

  // Input 1: music (optional, looped)
  let hasMusic = false
  let musicIdx = -1
  if (musicFilePath && musicConfig?.enabled) {
    args.push('-stream_loop', '-1', '-i', musicFilePath)
    musicIdx = nextIdx++
    hasMusic = true
  }

  // Input 2: noise (optional)
  let hasNoise = false
  let noiseIdx = -1
  if (backgroundNoise?.enabled) {
    if (backgroundNoise.mode === 'custom' && backgroundNoise.custom_file) {
      const avail = checkAssetAvailability(backgroundNoise.custom_file, 'background_noise.custom_file')
      if (avail.status === 'available') {
        args.push('-stream_loop', '-1', '-i', backgroundNoise.custom_file)
        noiseIdx = nextIdx++
        hasNoise = true
      } else {
        job.output_lines.push(`${avail.message} — ambient noise skipped`)
      }
    } else if (backgroundNoise.mode === 'preset') {
      const noiseType = backgroundNoise.preset === 'pink-noise' ? 'pink'
        : backgroundNoise.preset === 'brown-noise' ? 'brown' : 'white'
      args.push('-f', 'lavfi', '-i', `anoisesrc=color=${noiseType}:r=44100:d=${targetDuration}`)
      noiseIdx = nextIdx++
      hasNoise = true
    }
  }

  // Narration: resample, normalize, pad to target duration
  const narrVol = narrationVolume ?? 1.0
  filterParts.push(
    `[${narrIdx}:a]aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${narrVol},apad=whole_dur=${targetDuration}[narr]`
  )

  const audioStreams: string[] = ['[narr]']

  // Music chain
  if (hasMusic && musicConfig) {
    const musicVol = musicConfig.volume || 0.3
    const postNarrVol = musicConfig.post_narration_volume || 0.6
    const fadeIn = musicConfig.fade_in || 0
    const fadeOut = musicConfig.fade_out || 0

    let mf = `[${musicIdx}:a]atrim=0:${targetDuration},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${musicVol}`
    if (fadeIn > 0) mf += `,afade=t=in:d=${fadeIn}`
    if (fadeOut > 0) {
      const fadeStart = Math.max(0, targetDuration - fadeOut)
      mf += `,afade=t=out:st=${fadeStart}:d=${fadeOut}`
    }
    mf += '[bgm]'
    filterParts.push(mf)

    // Boost music volume after narration ends
    const volRatio = postNarrVol / Math.max(musicVol, 0.01)
    filterParts.push(
      `[bgm]volume=enable='gt(t,${narrationDuration})':volume=${volRatio.toFixed(4)}[bgm2]`
    )
    audioStreams.push('[bgm2]')
  }

  // Noise chain
  if (hasNoise && backgroundNoise) {
    const noiseVol = backgroundNoise.volume ?? 0.15
    const noiseFadeIn = backgroundNoise.fade_in || 0
    const noiseFadeOut = backgroundNoise.fade_out || 0

    let nf = `[${noiseIdx}:a]atrim=0:${targetDuration},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${noiseVol}`
    if (noiseFadeIn > 0) nf += `,afade=t=in:d=${noiseFadeIn}`
    if (noiseFadeOut > 0) {
      const fadeStart = Math.max(0, targetDuration - noiseFadeOut)
      nf += `,afade=t=out:st=${fadeStart}:d=${noiseFadeOut}`
    }
    nf += '[amb]'
    filterParts.push(nf)
    audioStreams.push('[amb]')
  }

  // Mix all streams
  if (audioStreams.length > 1) {
    filterParts.push(
      `${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=first:dropout_transition=2,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=44100[aout]`
    )
  } else {
    filterParts.push('[narr]aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=44100[aout]')
  }

  args.push('-filter_complex', filterParts.join(';\n'))
  args.push('-map', '[aout]')
  args.push('-c:a', 'pcm_s16le')  // Uncompressed WAV for maximum compatibility
  args.push('-t', targetDuration.toString())
  args.push(outputPath)

  job.output_lines.push(`Pre-mixing audio: ${audioStreams.length} stream(s) → ${Math.round(targetDuration)}s WAV`)

  await runFfmpeg(args)

  // Validate the premixed WAV before handing off to the final encode. A
  // 0-byte WAV here means the audio filter chain failed silently (rare,
  // but happens when narration is shorter than the music intro and the
  // amix `:duration=first` truncates everything).
  try {
    const info = await assertValidMedia(outputPath, {
      label: 'premixed_audio.wav',
      requireAudio: true,
      minDurationSec: 1,
    })
    job.output_lines.push(`Audio pre-mix complete · ${summarizeMedia(info)}`)
  } catch (e: any) {
    job.output_lines.push(`Premix validation failed: ${e.message}`)
    throw e
  }
  return outputPath
}

// ── Concat to Intermediate (stream-copy all clips into single MP4) ───────

async function concatToIntermediate(
  concatListPath: string, tempDir: string, job: Job,
): Promise<string> {
  const outputPath = path.join(tempDir, 'intermediate_video.mp4')
  job.output_lines.push('Concatenating scene clips into intermediate video...')

  // `-fflags +genpts` synthesises monotonic PTS when chunked xfade outputs
  // each start at PTS=0 — without this the demuxer's stream-copy can emit
  // an MP4 whose PTS jumps backwards at every chunk boundary, making the
  // downstream filter graph drop frames silently. `-avoid_negative_ts
  // make_zero` shifts any negative timestamps so the muxer doesn't reject
  // them. Both flags are no-ops when timestamps are already clean.
  await runFfmpeg([
    '-y',
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-c:v', 'copy', '-an', outputPath,
  ])

  // Validate before handing this off — the next stage is the long final
  // encode, and a broken intermediate here is the dominant failure mode
  // for "Nothing was written into output file" errors at encode time.
  try {
    const info = await assertValidMedia(outputPath, {
      label: 'intermediate_video.mp4',
      requireVideo: true,
      minDurationSec: 1,
    })
    job.output_lines.push(`Intermediate video concat complete · ${summarizeMedia(info)}`)
  } catch (e: any) {
    // Re-throw with the concat list contents so the user can see which
    // input clips fed the broken intermediate. The temp dir is preserved
    // by the caller's try/finally only when DEBUG is on, but the error
    // message itself carries enough to diagnose.
    job.output_lines.push(`Intermediate concat validation failed: ${e.message}`)
    throw e
  }
  return outputPath
}

// ── Run Final Composition (effects + audio on single MP4) ────────────────

interface CompositionOpts {
  videoInputPath: string
  premixedAudioPath: string
  logo?: VideoLogoConfig
  targetDuration: number
  w: number; h: number
  quality: { crf: number; preset: string; fps: number }
  format: string
  outputFile: string
  colorGrading?: VideoColorGrading
  vignette?: VideoVignetteConfig
  chromaKey?: VideoChromaKeyConfig
  /** Multi-layer overlay system. When present, supersedes `chromaKey`. */
  overlays?: VideoOverlaysConfig
  filmGrain?: VideoFilmGrain
  letterbox?: VideoLetterbox
  subtitles?: import('../models/types.js').VideoSubtitleConfig
  excludeIntroFromEffects?: boolean
  /** Seconds of intro+title that should be left untouched by filters when
   *  `excludeIntroFromEffects` is on. Ignored when the flag is false. */
  preSceneDuration?: number
  /** Time (seconds) at which the post-audio segment starts. Effects are
   *  cleared from this point forward so the black/fade tail + optional
   *  outro clip don't get noised/graded/vignetted — which used to blow
   *  up file size dramatically (random noise on flat black doesn't
   *  compress). `undefined` means "no tail gate" (e.g. continue-cycling
   *  mode where scenes fill the whole duration). */
  postAudioStart?: number
  /** Override for x264/x265 preset (ffmpeg's render-effort knob). Decoupled
   *  from `quality.preset` so users can pick a "fast" quality (CRF 28) but
   *  still get the smaller file size that comes from `slow` encoding.
   *  Falls back to `quality.preset` when not provided. */
  encodingEffort?: 'ultrafast' | 'medium' | 'slow' | 'hardware'
  /** Codec selection. `h264` is the universal default. `h265` (HEVC) emits
   *  roughly 30–40 % smaller files at equal visual quality but requires a
   *  modern player. Webm/VP9 stays under `format=webm` instead. */
  codec?: 'h264' | 'h265'
  job: Job
}

async function runFinalComposition(opts: CompositionOpts): Promise<void> {
  const {
    videoInputPath, premixedAudioPath, logo,
    targetDuration, w, h, quality, format, outputFile,
    colorGrading, vignette, chromaKey, overlays, filmGrain, letterbox, subtitles,
    excludeIntroFromEffects,
    preSceneDuration,
    postAudioStart,
    encodingEffort,
    codec,
    job,
  } = opts

  // Time-gate for effects that support FFmpeg's `enable=` expression.
  // Two independent bounds combined into a single `between(t,start,end)`:
  //   - start: intro+title when `excludeIntroFromEffects` is on (opt-in).
  //   - end:   where the post-audio tail begins (unconditional — nobody
  //            wants random noise layered on a black-screen tail).
  // Letterbox stays global below — it changes frame dimensions and must
  // apply to every frame for a consistent output size.
  const startSec = (excludeIntroFromEffects && preSceneDuration && preSceneDuration > 0)
    ? preSceneDuration
    : 0
  const endSec = (postAudioStart != null && postAudioStart > 0 && postAudioStart < targetDuration)
    ? postAudioStart
    : 0
  const gateEnable = buildGateEnable(startSec, endSec)
  if (startSec > 0 || endSec > 0) {
    const parts: string[] = []
    if (startSec > 0) parts.push(`after ${startSec.toFixed(1)}s (intro/title)`)
    if (endSec > 0)   parts.push(`before ${endSec.toFixed(1)}s (post-audio/outro)`)
    job.output_lines.push(`Effects gated: ${parts.join(' + ')}`)
  }

  const args: string[] = ['-y']
  const filterParts: string[] = []
  let nextInputIdx = 0

  // Input 0: intermediate video (pre-concatenated)
  args.push('-i', videoInputPath)
  nextInputIdx++

  // Input 1: pre-mixed audio (narration + music + noise already combined)
  args.push('-i', premixedAudioPath)
  const audioInputIdx = nextInputIdx++

  // Input: logo image (if enabled)
  let hasLogo = false
  let logoInputIdx = -1
  if (logo?.enabled && logo.image_path) {
    const avail = checkAssetAvailability(logo.image_path, 'logo.image_path')
    if (avail.status === 'available') {
      args.push('-i', logo.image_path)
      logoInputIdx = nextInputIdx++
      hasLogo = true
    } else {
      job.output_lines.push(`${avail.message} — logo skipped`)
    }
  }

  // Overlay layers — back-compat: a legacy `chromaKey` synthesises into
  // a single-layer overlay so the rest of the pipeline only handles
  // one shape. New projects use `overlays.layers[]` directly.
  const overlayLayers: VideoOverlay[] = []
  if (overlays?.enabled && Array.isArray(overlays.layers)) {
    for (const l of overlays.layers) {
      if (l.enabled && l.source_path) overlayLayers.push(l)
    }
  } else if (chromaKey?.enabled && chromaKey.source_path) {
    overlayLayers.push({
      id: 'legacy-chromakey',
      enabled: true,
      source_path: chromaKey.source_path,
      chroma_key: {
        color: chromaKey.color || '#00FF00',
        similarity: chromaKey.similarity ?? 0.15,
        blend: chromaKey.blend ?? 0.1,
      },
    })
  }
  // Open one ffmpeg `-i` per layer in array order. -1 marker means the
  // file was missing at availability check time and the layer is dropped
  // from the filter graph below.
  const overlayInputIdxs: number[] = []
  for (const layer of overlayLayers) {
    const avail = checkAssetAvailability(layer.source_path, `overlays[${layer.id}].source_path`)
    if (avail.status !== 'available') {
      job.output_lines.push(`${avail.message} — overlay '${layer.id}' skipped`)
      overlayInputIdxs.push(-1)
      continue
    }
    if (layer.loop !== false) args.push('-stream_loop', '-1')
    args.push('-i', layer.source_path)
    overlayInputIdxs.push(nextInputIdx++)
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  VIDEO FILTER CHAIN (video-only — audio is pre-mixed)
  // ═══════════════════════════════════════════════════════════════════════

  let vLabel = '[0:v]'
  let vIdx = 0
  const vn = () => `[v${vIdx++}]`

  // 1. Reset timestamps (intermediate video is already the correct duration)
  const v1 = vn()
  filterParts.push(`${vLabel}setpts=PTS-STARTPTS${v1}`)
  vLabel = v1

  // 2. Overlay layers (multi-layer; v1.0.53+).
  //    Each layer: scale → optional chroma-key → optional opacity →
  //    composite onto running base. Layers stack in array order — the
  //    first layer is drawn nearest the base, the last sits on top.
  //    The legacy single-slot `chroma_key` field is upgraded into a
  //    one-element `overlayLayers` array above so this loop is the
  //    sole composite path.
  for (let i = 0; i < overlayLayers.length; i++) {
    const layer = overlayLayers[i]!
    const inIdx = overlayInputIdxs[i]!
    if (inIdx < 0) continue   // file missing — skipped at availability check

    // Build per-layer scaled/keyed source label.
    let scaleExpr = ''
    let scaledW = -1   // -1 = unknown (only known when scale_pct is used)
    if (typeof layer.scale_pct === 'number' && layer.scale_pct > 0) {
      // Percentage-of-canvas-width scale (v1.0.63+, compilation foregrounds).
      // Height auto via `-1` to preserve aspect ratio. Even pixel rounding so
      // yuv420p subsampling doesn't reject the chain.
      const targetW = Math.max(2, Math.round(w * Math.min(0.95, layer.scale_pct)))
      const evenW = targetW - (targetW % 2)
      scaleExpr = `scale=${evenW}:-2`
      scaledW = evenW
    } else {
      const scaleMode = layer.scale || 'cover'
      if (scaleMode === 'cover') {
        // Fill canvas, crop overflow. Preserves aspect ratio.
        scaleExpr = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
        scaledW = w
      } else if (scaleMode === 'contain') {
        // Fit inside canvas, transparent letterbox. Useful for frame mattes.
        scaleExpr = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        scaledW = w
      }
      // 'native' = no scale; layer composites at its source dimensions.
    }

    const parts: string[] = []
    if (scaleExpr) parts.push(scaleExpr)
    if (layer.chroma_key) {
      const ck = layer.chroma_key
      const hex = ck.color.startsWith('#') ? '0x' + ck.color.slice(1) : ck.color
      parts.push(`chromakey=color=${hex}:similarity=${ck.similarity ?? 0.15}:blend=${ck.blend ?? 0.1}`)
    }
    const opacity = layer.opacity ?? 1
    if (opacity < 1) {
      // Mix alpha with `aa=`. format=rgba ensures the input has an
      // alpha channel even when the source is yuv420p (no alpha).
      parts.push(`format=rgba,colorchannelmixer=aa=${opacity}`)
    }

    const srcLabel = vn()
    const srcChain = parts.length
      ? `[${inIdx}:v]${parts.join(',')}${srcLabel}`
      : `[${inIdx}:v]null${srcLabel}`
    filterParts.push(srcChain)

    // Composite onto running base. Compose per-layer time range with
    // the global effects gate (intro/post-audio). The two are AND-ed.
    //
    // position_anchor (v1.0.63+) computes x/y from a named region —
    // `(W-w)/2` etc — using FFmpeg overlay-filter shorthands that the
    // engine resolves at draw time against the actual source size.
    // Falls back to `position.x` / `position.y` literals when no
    // anchor is set.
    let x = layer.position?.x ?? '0'
    let y = layer.position?.y ?? '0'
    if (layer.position_anchor) {
      const margin = Math.round(h * 0.04)   // ~4% inset for edge-anchored placements
      switch (layer.position_anchor) {
        case 'center':
          x = '(W-w)/2'; y = '(H-h)/2'
          break
        case 'top-third':
          x = '(W-w)/2'; y = `(H/3-h/2)`
          break
        case 'bottom-third':
          x = '(W-w)/2'; y = `(2*H/3-h/2)`
          break
        case 'lower-right':
          x = `W-w-${margin}`; y = `H-h-${margin}`
          break
        case 'lower-left':
          x = `${margin}`; y = `H-h-${margin}`
          break
      }
    }
    const enableExprs: string[] = []
    if (gateEnable) {
      // Existing gateEnable is `:enable='between(t,a,b)'` — strip wrapper
      // so we can AND it with the per-layer expression.
      const m = /^:enable='([^']+)'$/.exec(gateEnable)
      if (m) enableExprs.push(m[1]!)
    }
    if (layer.time_range) {
      const tr = layer.time_range
      if (tr.end_s != null) enableExprs.push(`between(t,${tr.start_s ?? 0},${tr.end_s})`)
      else if (tr.start_s) enableExprs.push(`gte(t,${tr.start_s})`)
    }
    const layerEnable = enableExprs.length ? `:enable='${enableExprs.join('*')}'` : ''

    const dst = vn()
    filterParts.push(`${vLabel}${srcLabel}overlay=${x}:${y}${layerEnable}${dst}`)
    vLabel = dst
  }

  // 3. Color grading — gateSuffix appended to each sub-filter (eq + colorbalance)
  //    so both time-gate together.
  if (colorGrading?.enabled) {
    const cgFilters = buildColorGradingFilters(colorGrading, gateEnable)
    if (cgFilters) {
      const cg = vn()
      filterParts.push(`${vLabel}${cgFilters}${cg}`)
      vLabel = cg
    }
  }

  // 4. Vignette
  //
  // FFmpeg's `vignette=a=<rad>` expresses the *lens angle*, not strength.
  // Large angles (approaching PI/2) produce a *wider* lens that darkens
  // the whole frame including the center — the exact symptom the user
  // reported ("not getting darker on the side but it just applies to
  // the whole image"). Small angles produce a narrow lens that only
  // darkens the corners.
  //
  // So we invert the mapping and clamp to a useful range:
  //   strength 0.05 → angle ~ 80° (barely visible vignette)
  //   strength 1.0  → angle ~ 30° (strong corner darkening, center preserved)
  if (vignette?.enabled) {
    const strength = Math.max(0, Math.min(vignette.strength ?? 0.7, 1))
    // Map 0..1 onto angle PI/2.25 (weak, ~80°) down to PI/6 (strong, ~30°).
    const minAngle = Math.PI / 6        // strongest — narrowest lens
    const maxAngle = Math.PI / 2.25     // weakest  — widest lens
    const angle = maxAngle - (strength * (maxAngle - minAngle))
    const vg = vn()
    filterParts.push(`${vLabel}vignette=angle=${angle.toFixed(4)}:mode=forward:eval=init${gateEnable}${vg}`)
    vLabel = vg
  }

  // 5. Film grain
  if (filmGrain?.enabled) {
    const str = Math.round(filmGrain.strength ?? 15)
    const fg = vn()
    filterParts.push(`${vLabel}noise=alls=${str}:allf=t+u${gateEnable}${fg}`)
    vLabel = fg
  }

  // 6. Letterbox — NOT gated. scale+pad changes the frame dimensions and
  //    can't be time-gated without producing different-sized frames in
  //    the same output, which breaks encoders. Letterbox applies to the
  //    entire video (intro + title + scenes) by design.
  //
  //    Both `newH` and `padY` are rounded to even values. yuv420p chroma
  //    subsampling requires even dimensions; on FFmpeg 8.1 an odd scale
  //    height (e.g. 817 for 2.35:1) produces a graph that initialises
  //    fine but emits zero packets through libx264/libx265, which the
  //    muxer reports as "Nothing was written into output file". Forcing
  //    even values keeps the encoder happy at the cost of ≤1 px of
  //    visible image.
  if (letterbox?.enabled) {
    const ratioMap: Record<string, number> = { '2.35:1': 2.35, '2.00:1': 2.0, '1.85:1': 1.85 }
    const targetRatio = ratioMap[letterbox.ratio] || 2.35
    const barColor = letterbox.color || 'black'
    const rawNewH = Math.round(w / targetRatio)
    const newH = rawNewH - (rawNewH % 2)  // floor to even
    if (newH < h) {
      const rawPadY = Math.round((h - newH) / 2)
      const padY = rawPadY - (rawPadY % 2)  // floor to even
      const lb = vn()
      filterParts.push(`${vLabel}scale=${w}:${newH},pad=${w}:${h}:0:${padY}:color=${barColor}${lb}`)
      vLabel = lb
    }
  }

  // 6b. Subtitles (libass burn-in). Placed after letterbox so subtitles
  //     sit inside the safe area; placed before the logo so the logo
  //     always renders on top.
  if (subtitles?.enabled && subtitles.srt_path && existsSync(subtitles.srt_path)) {
    const { buildAssStyle } = await import('../lib/subtitle-builder.js')
    const ass = buildAssStyle(subtitles.style).replace(/'/g, "\\'")
    // FFmpeg filter-graph paths escape: backslashes, colons (Windows drive
    // letters), single quotes. Forward slashes are fine even on Windows.
    const escPath = subtitles.srt_path.replace(/\\/g, '/').replace(/:/g, '\\:')
    const st = vn()
    filterParts.push(`${vLabel}subtitles=filename='${escPath}':force_style='${ass}'${gateEnable}${st}`)
    vLabel = st
    job.output_lines.push(`Burning in subtitles: ${path.basename(subtitles.srt_path)}`)
  }

  // 7. Logo overlay
  //
  // Gate precedence: if `excludeIntroFromEffects` is on, the pre-scene gate
  // supersedes the legacy `hide_during_intro` toggle (both hide the logo
  // during intro/title). If only `hide_during_intro` is set, fall back to
  // the legacy 10s hardcode for back-compat with projects that pre-date
  // the exclude-intro feature.
  if (hasLogo && logo) {
    const logoW = Math.round(w * (logo.scale || 0.1))
    const pos = calculateLogoPosition(logo.position, w, h, logoW, 0, logo.margin || 20, logo.custom_x, logo.custom_y)
    const opacity = logo.opacity ?? 1

    const lp = vn()
    filterParts.push(`[${logoInputIdx}:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo]`)

    // If the global dual-sided gate is on (`gateEnable` non-empty), the logo
    // piggybacks on it so intro/title/tail/outro all stay logo-free. Otherwise
    // fall back to the legacy 10s hardcode when the user only toggled
    // `hide_during_intro`. When neither is on, the logo runs every frame.
    let logoEnable = ''
    if (gateEnable) {
      logoEnable = gateEnable
    } else if (logo.hide_during_intro) {
      logoEnable = `:enable='gt(t,10)'`
    }
    filterParts.push(`${vLabel}[logo]overlay=${pos.x}:${pos.y}${logoEnable}${lp}`)
    vLabel = lp
  }

  // Final video label
  filterParts.push(`${vLabel}null[vout]`)

  // Apply filter_complex (video-only filters)
  if (filterParts.length > 0) {
    args.push('-filter_complex', filterParts.join(';\n'))
    args.push('-map', '[vout]')
  } else {
    args.push('-map', '0:v')
  }

  // Map pre-mixed audio directly (no filter needed — already processed)
  args.push('-map', `${audioInputIdx}:a`)

  // Encoding settings. The `preset` (x264/x265) is the user's encoding-effort
  // override if provided; otherwise it falls back to the tier-default from
  // QUALITY_PRESETS (e.g. `compact` → ultrafast, `high` → slow). The `codec`
  // toggle picks between H.264 (libx264, universal) and H.265 (libx265, ~30 %
  // smaller but requires QuickTime 10.4+ / modern browsers). webm/VP9 stays
  // on its own branch because it doesn't share encoder flags.
  const effort = encodingEffort || quality.preset

  // Encoder-specific args isolated in a builder so we can swap codec+retry
  // cleanly if libx265 fails with the EINVAL signature (see the catch block
  // below). `format === 'webm'` short-circuits through its own branch — no
  // H.264 fallback applies there. Delegates to the pure top-level
  // `buildEncoderArgs` so the codec/CRF/preset shape is snapshot-testable
  // without spawning ffmpeg.
  function encoderArgs(useCodec: 'h264' | 'h265'): string[] {
    return buildEncoderArgs({
      codec: useCodec,
      format,
      crf: quality.crf,
      effort,
    })
  }

  const effectiveCodec: 'h264' | 'h265' = (format === 'webm' || codec !== 'h265') ? 'h264' : 'h265'

  // Snapshot the args array BEFORE encoder args are appended so we can
  // rebuild a clean argv for the H.264 retry without dragging H.265 tokens
  // into it. Everything after this point (encoder + -t + outputFile) is
  // codec-dependent.
  const preEncoderArgs = [...args]

  function buildFullArgs(useCodec: 'h264' | 'h265'): string[] {
    return [
      ...preEncoderArgs,
      ...encoderArgs(useCodec),
      '-t', targetDuration.toString(),
      outputFile,
    ]
  }

  function codecLabel(useCodec: 'h264' | 'h265'): string {
    if (format === 'webm') return `VP9 · CRF ${quality.crf}`
    if (effort === 'hardware') return `H.264 · hardware (videotoolbox, q:v ${crfToVideotoolboxQ(quality.crf)})`
    if (useCodec === 'h265') return `HEVC (H.265) · preset ${effort}`
    return `H.264 · preset ${effort}`
  }

  // Helper for the argv-dump, called once per encode attempt. Shell-quoted +
  // chunked so a long filter_complex doesn't get truncated by any downstream
  // log viewer. On failure the user can paste from this line to reproduce.
  function logCmd(attemptArgs: string[], note?: string): void {
    const argvString = attemptArgs
      .map(a => /[\s'";]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)
      .join(' ')
    const fullCmd = `FFmpeg cmd${note ? ' ' + note : ''}: ffmpeg ${argvString}`
    const CHUNK = 1500
    if (fullCmd.length <= CHUNK) {
      job.output_lines.push(fullCmd)
    } else {
      job.output_lines.push(`FFmpeg cmd${note ? ' ' + note : ''} (${fullCmd.length} chars, split):`)
      for (let i = 0; i < fullCmd.length; i += CHUNK) {
        job.output_lines.push(fullCmd.slice(i, i + CHUNK))
      }
    }
  }

  // Run the encode. Wrapped in a helper so we can retry once with H.264
  // if libx265 returns the EINVAL signature — some concat intermediates
  // with mixed colour metadata trigger `return code -22` at x265 init even
  // when every clip individually is valid. Falling back is nicer than
  // failing the whole job outright; the user ends up with an H.264 .mp4
  // rather than no video at all. On any other failure mode, the error
  // propagates (no retry).
  async function runEncode(encodeArgs: string[]): Promise<void> {
    // Resolve the bundled/installed ffmpeg path BEFORE spawning. Packaged Macs
    // without Homebrew's `/opt/homebrew/bin/ffmpeg` in PATH previously hit
    // `spawn ffmpeg ENOENT` at this line — the bundled binary inside
    // `.app/Contents/Resources/ffmpeg/` was never consulted because this
    // caller passed a bare string. All three encode tiers share this helper,
    // so the ENOENT repeated identically across the recovery chain.
    const ffmpegBin = await getFFmpegPath()

    // Wall-clock watchdog. This spawn can take hours on long-form renders
    // (sleep-story channels routinely append 2-3 hours of ambient tail
    // to a 30-min narration), but a pathological input — malformed
    // chapter MP3, CMYK title image, FFmpeg 8 edge case — can also hang
    // it indefinitely. The job queue serialises video jobs, so a stuck
    // encode pins the slot forever and nothing else runs.
    //
    // Scale the watchdog with the actual output `-t` so a 2.5-hour
    // render gets ~3.5h of budget, while a short 5-min clip still has
    // a reasonable safety net. Formula:
    //   floor: 30 min (matches the previous fixed default)
    //   scaled: 1.5× output duration + 5 min buffer
    //   ceiling: 12 hours (truly hung after this much)
    // The env override `STORY_STUDIO_FFMPEG_TIMEOUT_MS` still wins
    // unconditionally — power users with custom workflows can pin a
    // value that ignores the scaling.
    const timeoutMs = computeWatchdogMs(targetDuration, process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS)
    const timeoutMin = Math.round(timeoutMs / 60_000)
    job.output_lines.push(`FFmpeg watchdog: ${timeoutMin} min for ${(targetDuration / 60).toFixed(1)} min output`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegBin, encodeArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Track for cancellation — the final encode pass is the longest ffmpeg
      // run in the entire pipeline (minutes), so this is the most important
      // cancellable child in the app.
      trackChild(proc)

      let stderr = ''

      let watchdogKilled = false
      const termTimer = setTimeout(() => {
        watchdogKilled = true
        try { proc.kill('SIGTERM') } catch { /* exited */ }
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL') } catch { /* exited */ }
        }, 5000)
        proc.once('close', () => clearTimeout(killTimer))
      }, timeoutMs)

      proc.stderr.on('data', (data: Buffer) => {
        const line = data.toString()
        stderr += line

        const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/)
        if (timeMatch) {
          const hours = parseInt(timeMatch[1])
          const minutes = parseInt(timeMatch[2])
          const seconds = parseInt(timeMatch[3])
          const ms = parseInt(timeMatch[4])
          const currentTime = hours * 3600 + minutes * 60 + seconds + ms / 100

          if (targetDuration > 0) {
            const progress = Math.min(99, Math.round((currentTime / targetDuration) * 100))
            job.progress = progress
            const progressLine = `Encoding: ${progress}% (${currentTime.toFixed(1)}s / ${targetDuration.toFixed(1)}s)`
            const lastIdx = job.output_lines.length - 1
            if (lastIdx >= 0 && job.output_lines[lastIdx].startsWith('Encoding:')) {
              job.output_lines[lastIdx] = progressLine
            } else {
              job.output_lines.push(progressLine)
            }
          }
        }
      })

      proc.on('error', (err) => {
        clearTimeout(termTimer)
        reject(new Error(`FFmpeg failed to start: ${err.message}`))
      })

      proc.on('close', (code, signal) => {
        clearTimeout(termTimer)
        if (code === 0) {
          resolve()
          return
        }
        // Watchdog first — distinct message so the job log disambiguates
        // a queue-blocking hang from a user-initiated cancel (which also
        // arrives with signal=SIGTERM). Tag the error so the recovery
        // chain can decide not to retry (a watchdog kill on tier 1 almost
        // certainly means tiers 2/3 will hang the same way).
        if (watchdogKilled) {
          const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
          const lines = stderr.split('\n').filter(l => l.trim())
          const tail = lines.slice(-5).join('\n') || '(no stderr captured)'
          const err = new Error(
            `FFmpeg exceeded ${minutes}-minute wall-clock watchdog — job killed to free the queue. Last stderr: ${tail}`,
          )
          ;(err as any).watchdog = true
          ;(err as any).stderr = stderr
          reject(err)
          return
        }
        // Killed by cancel: surface a clean message, not an exit-code diagnostic.
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          reject(new Error(`FFmpeg killed (${signal})`))
          return
        }
        // Preserve stderr on the Error object so the retry decision can
        // inspect it. Input paths go straight into the job log for repro.
        const lines = stderr.split('\n').filter(l => l.trim())
        const errorLine = lines.slice(-5).join('\n')
        const err = new Error(`FFmpeg exited with code ${code}:\n${errorLine}`)
        ;(err as any).stderr = stderr
        ;(err as any).exitCode = code
        reject(err)
      })
    })
  }

  // ── Recovery chain ─────────────────────────────────────────────────────
  //
  // Earlier this code had a single H.265 → H.264 retry, which only covered
  // one specific failure mode (libx265 EINVAL on colour-metadata drift). In
  // practice the final encode can fail for many other reasons:
  //   - filter graph emits zero packets (any filter rejecting input)
  //   - encoder rejects an odd-dimension scale/pad output
  //   - intermediate has bad PTS that confuses setpts/enable gates
  //   - exit 0 but a 0-byte output file (rare, but happens)
  //
  // The chain below runs each tier in order; the first tier whose output
  // ffprobe can validate wins. Each tier strips more "nice to have"
  // features so the user always ends up with *some* video, even if the
  // film grain or chroma key got dropped in the process. We log clearly
  // which tier ran so a successful render with degraded output isn't
  // silently mistaken for a clean run.
  //
  // The full filter chain is captured in `args` (with `[vout]` mapping)
  // and the audio map is `${audioInputIdx}:a`. Tiers 3+ use a minimal
  // re-build that bypasses filter_complex entirely.
  type AttemptResult = { ok: true } | { ok: false; error: any }
  type Tier = {
    label: string
    note?: string
    build: () => string[]
    /** Optional gate: only run if the previous tier failed in a way this
     *  tier can address. For tier 2 we keep the historical libx265-EINVAL
     *  guard so well-behaved H.265 jobs aren't quietly downgraded to H.264
     *  on unrelated failures. */
    shouldRun?: (prevError: any) => boolean
    /** Human-readable description of what gets dropped at this tier. */
    degraded?: string
  }

  // The "minimal" builder rebuilds argv from scratch with only the safe
  // primitives: copy video stream as-is from the intermediate, map audio,
  // pin the format, encode with libx264. No vignette / grain / grade /
  // chroma / subtitles / logo. Letterbox is skipped too because it can
  // be the trigger.
  function buildMinimalArgs(useCodec: 'h264' | 'h265'): string[] {
    const a: string[] = ['-y', '-i', videoInputPath, '-i', premixedAudioPath]
    a.push('-map', '0:v', '-map', '1:a')
    a.push(...encoderArgs(useCodec))
    a.push('-t', targetDuration.toString())
    a.push(outputFile)
    return a
  }

  const tiers: Tier[] = [
    {
      label: codecLabel(effectiveCodec),
      build: () => buildFullArgs(effectiveCodec),
    },
    {
      label: codecLabel('h264') + ' (fallback)',
      note: '(retry, H.264)',
      degraded: 'codec downgraded to H.264',
      // Original guard: only swap codec when the failure stderr matches
      // the known libx265 EINVAL signature. Other failures aren't fixed
      // by codec swap and should fall through to tier 3.
      shouldRun: (e) => {
        if (effectiveCodec !== 'h265') return false
        const s: string = e?.stderr || ''
        return s.includes('libx265') && s.includes('return code -22')
      },
      build: () => buildFullArgs('h264'),
    },
    {
      label: 'H.264 · no effects (recovery)',
      note: '(recovery, H.264 minimal)',
      degraded: 'all post effects removed (vignette/grain/grade/chroma/subtitles/letterbox/logo)',
      build: () => buildMinimalArgs('h264'),
    },
  ]

  // Validate the output file passed by `ffmpeg exit 0` actually contains
  // a usable video stream. A 0-byte mp4 from a stream-with-no-packets
  // scenario passes the exit-code check but is useless. We re-throw with
  // a stderr-shaped Error so the next tier's `shouldRun` can inspect it.
  async function validateEncodedOutput(): Promise<void> {
    if (!fileExistsNonEmpty(outputFile)) {
      const err: any = new Error(`Encoder exited 0 but output file is missing or empty: ${outputFile}`)
      err.stderr = 'output file empty after encode'
      throw err
    }
    try {
      const info = await getMediaInfo(outputFile)
      if (!info.hasVideo || info.durationSec < 1) {
        const err: any = new Error(
          `Encoder exited 0 but output is unusable: ${summarizeMedia(info)}`
        )
        err.stderr = 'output validation failed'
        throw err
      }
    } catch (e: any) {
      // Re-throw with .stderr so tier shouldRun checks still work.
      if (e?.stderr) throw e
      const err: any = new Error(`ffprobe rejected encoder output: ${e.message}`)
      err.stderr = `ffprobe: ${e.message}`
      throw err
    }
  }

  job.output_lines.push('Running final composition...')
  job.output_lines.push(`Output: ${path.basename(outputFile)}`)

  let lastError: any = null
  let succeededTier: Tier | null = null
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]
    if (i > 0 && tier.shouldRun && !tier.shouldRun(lastError)) continue

    const args = tier.build()
    if (i === 0) {
      job.output_lines.push(`Codec: ${tier.label}`)
    } else {
      const stderrSnippet = (lastError?.stderr || '').split('\n').filter((l: string) => l.trim()).slice(-3).join(' | ')
      job.output_lines.push(
        `⚠ Encode tier ${i} failed (${stderrSnippet || lastError?.message || 'unknown'}). ` +
        `Trying tier ${i + 1}: ${tier.label}` +
        (tier.degraded ? ` — ${tier.degraded}` : '')
      )
    }
    logCmd(args, tier.note)
    const result: AttemptResult = await runEncode(args)
      .then(() => ({ ok: true } as AttemptResult))
      .catch(e => ({ ok: false, error: e } as AttemptResult))

    if (result.ok) {
      try {
        await validateEncodedOutput()
        succeededTier = tier
        break
      } catch (validateErr: any) {
        lastError = validateErr
        continue
      }
    }
    lastError = result.error
  }

  if (!succeededTier) {
    // All tiers failed — emit the full diagnostic trail so the user can
    // file a useful bug report or hand it to support.
    job.output_lines.push(`FFmpeg inputs: videoInputPath=${videoInputPath} premixedAudioPath=${premixedAudioPath}`)
    job.output_lines.push(`✗ All ${tiers.length} encode tiers failed. Last error: ${lastError?.message || 'unknown'}`)
    throw lastError || new Error('Final composition failed at all tiers')
  }

  if (succeededTier !== tiers[0]) {
    job.output_lines.push(`✓ Final video produced via recovery tier — ${succeededTier.degraded || succeededTier.label}`)
  }
}

// ── Color Grading Filter Builder ─────────────────────────────────────────

function buildColorGradingFilters(cg: VideoColorGrading, gateSuffix = ''): string {
  // Start with preset base values, then layer user adjustments.
  //
  // Keep this map 1:1 in sync with `COLOR_PRESET_BASE` in the frontend
  // page `frontend/pages/projects/[slug]/video-assembly.vue` — the live
  // CSS preview reads from there to approximate what we render here.
  // Adding/removing a preset in either spot without updating the other
  // means the UI either silently falls back to `none` (frontend) or
  // misrepresents the look (preview).
  const presets: Record<string, { brightness: number; contrast: number; saturation: number; warmth: number; tint: number }> = {
    'none':              { brightness: 0,    contrast: 1.0,  saturation: 1.0,  warmth:  0,     tint:  0 },
    'warm-night':        { brightness: -0.05, contrast: 1.1,  saturation: 0.9,  warmth:  0.15,  tint:  0 },
    'cool-moonlight':    { brightness:  0.02, contrast: 1.05, saturation: 0.8,  warmth: -0.15,  tint: -0.05 },
    'cinematic':         { brightness: -0.03, contrast: 1.2,  saturation: 0.85, warmth:  0.05,  tint:  0 },
    'vintage':           { brightness:  0.05, contrast: 0.95, saturation: 0.7,  warmth:  0.20,  tint:  0.05 },
    'dreamy-haze':       { brightness:  0.08, contrast: 0.9,  saturation: 0.75, warmth:  0.10,  tint:  0.05 },
    'golden-hour':       { brightness:  0.03, contrast: 1.1,  saturation: 1.1,  warmth:  0.25,  tint:  0.02 },
    'noir':              { brightness: -0.10, contrast: 1.4,  saturation: 0.0,  warmth:  0,     tint:  0 },
    // ── New sleep-story presets (10) — mirror frontend COLOR_PRESET_BASE ──
    'firelight':         { brightness: -0.05, contrast: 1.15, saturation: 1.0,  warmth:  0.30,  tint:  0 },
    'rainy-dusk':        { brightness: -0.02, contrast: 1.0,  saturation: 0.7,  warmth: -0.10,  tint:  0 },
    'lavender-mist':     { brightness:  0.05, contrast: 0.95, saturation: 0.85, warmth: -0.05,  tint:  0.08 },
    'forest-canopy':     { brightness: -0.03, contrast: 1.1,  saturation: 0.95, warmth: -0.05,  tint: -0.05 },
    'desert-twilight':   { brightness:  0.02, contrast: 1.05, saturation: 1.05, warmth:  0.18,  tint:  0.04 },
    'ocean-depths':      { brightness: -0.08, contrast: 1.15, saturation: 0.85, warmth: -0.20,  tint: -0.03 },
    'sepia-dream':       { brightness:  0.0,  contrast: 1.05, saturation: 0.4,  warmth:  0.15,  tint:  0.05 },
    'frosted-glass':     { brightness:  0.15, contrast: 0.85, saturation: 0.65, warmth: -0.05,  tint:  0 },
    'autumn-glow':       { brightness:  0.0,  contrast: 1.1,  saturation: 1.15, warmth:  0.20,  tint:  0.03 },
    'starlit-night':     { brightness: -0.10, contrast: 1.25, saturation: 0.6,  warmth: -0.18,  tint: -0.02 },
    'misty-morning':     { brightness:  0.10, contrast: 0.9,  saturation: 0.7,  warmth: -0.08,  tint:  0.02 },
  }

  const base = presets[cg.preset] || presets['none']

  // Layer user adjustments on top of preset
  const brightness = base.brightness + (cg.brightness || 0)
  const contrast = base.contrast * (cg.contrast ?? 1.0)
  const saturation = base.saturation * (cg.saturation ?? 1.0)
  const warmth = base.warmth + (cg.warmth || 0)
  const tint = base.tint + (cg.tint || 0)

  const parts: string[] = []

  // eq filter for brightness, contrast, saturation
  const eqParts: string[] = []
  if (Math.abs(brightness) > 0.001) eqParts.push(`brightness=${brightness.toFixed(3)}`)
  if (Math.abs(contrast - 1.0) > 0.001) eqParts.push(`contrast=${contrast.toFixed(3)}`)
  if (Math.abs(saturation - 1.0) > 0.001) eqParts.push(`saturation=${saturation.toFixed(3)}`)
  if (eqParts.length > 0) parts.push(`eq=${eqParts.join(':')}${gateSuffix}`)

  // colorbalance for warmth/tint
  if (Math.abs(warmth) > 0.001 || Math.abs(tint) > 0.001) {
    // Warmth: boost red shadows + red midtones, reduce blue
    // Tint: boost/reduce green vs magenta
    const rs = (warmth * 0.3).toFixed(3)
    const gs = (tint * -0.2).toFixed(3)
    const bs = (warmth * -0.3).toFixed(3)
    const rm = (warmth * 0.15).toFixed(3)
    const gm = (tint * -0.1).toFixed(3)
    const bm = (warmth * -0.15).toFixed(3)
    parts.push(`colorbalance=rs=${rs}:gs=${gs}:bs=${bs}:rm=${rm}:gm=${gm}:bm=${bm}${gateSuffix}`)
  }

  if (parts.length === 0) return ''
  return parts.join(',')
}

// ── Logo Position Calculator ──────────────────────────────────────────────

function calculateLogoPosition(
  position: string,
  videoW: number, videoH: number,
  logoW: number, logoH: number,
  margin: number,
  customX?: number, customY?: number,
): { x: string; y: string } {
  if (position === 'custom' && customX !== undefined && customY !== undefined) {
    return { x: customX.toString(), y: customY.toString() }
  }
  const positions: Record<string, { x: string; y: string }> = {
    'top-left':      { x: `${margin}`, y: `${margin}` },
    'top-center':    { x: `(W-w)/2`, y: `${margin}` },
    'top-right':     { x: `W-w-${margin}`, y: `${margin}` },
    'center-left':   { x: `${margin}`, y: `(H-h)/2` },
    'center':        { x: `(W-w)/2`, y: `(H-h)/2` },
    'center-right':  { x: `W-w-${margin}`, y: `(H-h)/2` },
    'bottom-left':   { x: `${margin}`, y: `H-h-${margin}` },
    'bottom-center': { x: `(W-w)/2`, y: `H-h-${margin}` },
    'bottom-right':  { x: `W-w-${margin}`, y: `H-h-${margin}` },
  }
  return positions[position] || positions['bottom-right']
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the episode folder by code, optionally disambiguated by title.
 *
 * Historical gotcha: users who rename an episode after accepting it can
 * end up with TWO folders that both start with the same `{code} - ` prefix
 * (the old title and the new one). Without a title hint, first-match
 * returns the alphabetically earlier one — which may be the stale folder,
 * causing video-assembly to report missing assets even though the real
 * folder has everything. When `titleHint` is provided we require an exact
 * "{code} - {titleHint}" match first, then fall back to any folder
 * starting with the code.
 */
async function findEpisodeDir(
  projectDir: string, code: string, titleHint?: string,
): Promise<string | null> {
  const exactName = titleHint ? `${code} - ${titleHint}` : null
  async function searchRecursive(dir: string, depth: number): Promise<string | null> {
    if (depth > 4) return null
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      // Pass 1: exact match on "{code} - {title}" when we have a title hint.
      if (exactName) {
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (entry.name === exactName) return path.join(dir, entry.name)
        }
      }
      // Pass 2: any folder starting with the code prefix. Preserves the
      // pre-titleHint behaviour for callers that don't supply one.
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.toUpperCase().startsWith(code)) {
          return path.join(dir, entry.name)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const found = await searchRecursive(path.join(dir, entry.name), depth + 1)
        if (found) return found
      }
    } catch { /* skip */ }
    return null
  }
  return searchRecursive(projectDir, 0)
}

async function resolveSubfolder(episodeDir: string, subfolderName: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(episodeDir)
    // Folders can be prefixed with "✅ " when the user marks a step done;
    // strip that when matching so scanEpisodeAssets keeps working after the
    // prefix is added (previously this returned null, causing video-assembly
    // to silently miss merged audio and scene images).
    for (const entry of entries) {
      const clean = entry.replace(/^✅\s*/, '')
      if (clean === subfolderName) return path.join(episodeDir, entry)
    }
  } catch { /* fall through */ }
  const exactPath = path.join(episodeDir, subfolderName)
  if (existsSync(exactPath)) return exactPath
  return null
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

function extractSceneNumber(filename: string): number | null {
  const match = filename.match(/scene[_\s]*(\d+)/i)
  if (match) return parseInt(match[1], 10)
  const thumbMatch = filename.match(/thumb[_\s]*(\d+)/i)
  if (thumbMatch) return parseInt(thumbMatch[1], 10)
  return null
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
}

function getXfadeTransition(transition: string): string {
  const map: Record<string, string> = {
    'crossfade': 'fade',
    'fade-black': 'fadeblack',
    'dissolve': 'dissolve',
    'wipe-left': 'wipeleft',
    'wipe-right': 'wiperight',
    'none': 'fade',
  }
  return map[transition] || 'fade'
}

function getStyleColor(style: string): string {
  const map: Record<string, string> = {
    'gold': 'gold',
    'white': 'white',
    'neon': '00ffcc',
    'minimal': 'white@0.8',
  }
  return map[style] || 'white'
}

function getFontSize(size: string, height: number): number {
  const map: Record<string, number> = {
    'small': height / 25,
    'medium': height / 18,
    'large': height / 12,
  }
  return Math.round(map[size] || map['medium'])
}

function getTextPosition(position: string, height: number): string {
  const map: Record<string, string> = {
    'top': `${Math.round(height * 0.08)}`,
    'center': '(h-text_h)/2',
    'bottom': `${Math.round(height * 0.85)}`,
  }
  return map[position] || map['center']
}

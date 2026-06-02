/**
 * Free-disk-space precheck helpers.
 *
 * Audit finding M3 (audit-reports/09-jobs.md): a 20-episode 1080p/high
 * batch averages 500 MB-1 GB per episode and hours of FFmpeg time. Running
 * on a nearly-full disk fails halfway through and burns the encode cost
 * on episodes that then can't write. docs/operations/qa-checklist.md:12 documents the
 * 5 GB-free rule as manual operator discipline; these helpers move it
 * into code at two gates — the run-batch route (whole batch up front) and
 * each video_assembly job (per-episode, before any FFmpeg spawns).
 *
 * `getFreeBytes` uses `fs.statfs` (Node 18.15+, available on macOS, Linux,
 * Windows). Returns 0 on any error — we want callers to soft-fail open
 * rather than block the user when statfs misbehaves on an exotic FS.
 *
 * `estimateBytesForStep` and `estimateRunBatchBytes` are deliberately
 * pessimistic: they multiply by a safety margin so we leave headroom for
 * temp files (FFmpeg per-clip prep) and for the user's other apps.
 */

import fs from 'fs/promises'

export interface EpisodeEstimateInputs {
  /** Narration / target duration in seconds. Falls back to 1 hr. */
  durationSec?: number
  /** '720p' | '1080p' | '1440p' | '4k' */
  resolution?: string
  /** 'compact' | 'fast' | 'medium' | 'high' */
  quality?: string
  /** Number of Veo clips for the `video` step. */
  clipCount?: number
  /** Narration character count for audio / audio_merge sizing. */
  narrationChars?: number
}

export type EstimateStep =
  | 'script-only'
  | 'introduction-only'
  | 'image_prompts'
  | 'images'
  | 'audio'
  | 'audio_merge'
  | 'metadata'
  | 'video'
  | 'video_assembly'

const RES_MULT: Record<string, number> = {
  '720p':  0.5,
  '1080p': 1,
  '1440p': 2,
  '4k':    4,
}

const QUALITY_MULT: Record<string, number> = {
  compact: 0.5,
  fast:    0.7,
  medium:  1,
  high:    2,
}

/**
 * Bytes-per-second baseline for 1080p/medium video. The cost-estimate
 * route in routes/jobs.ts uses 125 KB/s as the rule of thumb (1 GB for
 * a 60-min narrative at 1080p high), so we anchor here.
 */
const VIDEO_BASE_BYTES_PER_SEC = 125 * 1024

/** Per-Veo-clip approximate file size (10s 1080p mp4 ≈ 50 MB). */
const VIDEO_CLIP_BYTES = 50 * 1024 * 1024

/** ~5000 chars per narration minute, ~1 MB per minute for MP3 / merged WAV. */
const AUDIO_BYTES_PER_MIN = 1 * 1024 * 1024

/** Combined scenes + thumbnails baseline — 9 images × ~3 MB. */
const IMAGES_BYTES = 9 * 3 * 1024 * 1024

/** Per-step floor so tiny steps (script, metadata) still reserve a sliver. */
const TINY_STEP_BYTES = 256 * 1024

/**
 * Estimate the bytes a single step will write for a single episode.
 * Inputs are best-effort — missing values fall back to defensive defaults
 * skewed toward over-estimation rather than under.
 */
export function estimateBytesForStep(step: EstimateStep, inputs: EpisodeEstimateInputs = {}): number {
  switch (step) {
    case 'video_assembly': {
      const r = RES_MULT[inputs.resolution || '1080p'] ?? 1
      const q = QUALITY_MULT[inputs.quality || 'medium'] ?? 1
      const dur = inputs.durationSec && inputs.durationSec > 0 ? inputs.durationSec : 60 * 60
      return Math.ceil(VIDEO_BASE_BYTES_PER_SEC * dur * r * q)
    }
    case 'video': {
      const clips = inputs.clipCount && inputs.clipCount > 0 ? inputs.clipCount : 10
      return clips * VIDEO_CLIP_BYTES
    }
    case 'audio':
    case 'audio_merge': {
      const chars = inputs.narrationChars && inputs.narrationChars > 0 ? inputs.narrationChars : 15000
      const mins = chars / 5000
      return Math.max(TINY_STEP_BYTES, Math.ceil(mins * AUDIO_BYTES_PER_MIN))
    }
    case 'images':
      return IMAGES_BYTES
    case 'script-only':
    case 'introduction-only':
    case 'image_prompts':
    case 'metadata':
      return TINY_STEP_BYTES
    default:
      return TINY_STEP_BYTES
  }
}

/**
 * Estimate the byte footprint of a whole batch (steps × episodes), then
 * multiply by `safetyMargin` (default 1.5) to cover temp-file overhead
 * and the user's other apps.
 */
export function estimateRunBatchBytes(
  steps: EstimateStep[],
  episodes: EpisodeEstimateInputs[],
  safetyMargin = 1.5,
): number {
  let total = 0
  for (const step of steps) {
    for (const ep of episodes) {
      total += estimateBytesForStep(step, ep)
    }
  }
  return Math.ceil(total * safetyMargin)
}

/**
 * Free bytes on the filesystem containing `rootPath`. Uses `fs.statfs`
 * (Node 18.15+). Returns 0 if the path can't be inspected — callers should
 * treat 0 as "unknown, soft-pass" rather than as a hard failure, since a
 * statfs error shouldn't block legitimate work.
 */
export async function getFreeBytes(rootPath: string): Promise<number> {
  try {
    const stat = await (fs as any).statfs(rootPath)
    if (!stat) return 0
    const bsize = Number(stat.bsize) || 0
    const bavail = Number(stat.bavail) || 0
    if (bsize <= 0 || bavail <= 0) return 0
    return bsize * bavail
  } catch {
    return 0
  }
}

/** Format bytes as `1.23 GB` / `45.6 MB` / `780 KB` / `123 B` for error messages. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const decimals = i >= 2 ? 2 : 0
  return `${value.toFixed(decimals)} ${units[i]}`
}

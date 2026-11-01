/**
 * The state of an episode's Shorts, and what would be uploaded from it.
 *
 * TWO FILES, ON PURPOSE
 *
 *   `shorts.json`          the PASSAGES — which parts of the episode became
 *                           Shorts. It is rewritten every time the passages are
 *                           chosen again.
 *   `shorts_upload.json`   the UPLOADS — which Shorts went up to YouTube.
 *                           It is NOT rewritten when the passages change.
 *
 * Keeping them apart is what makes a retry safe: a re-cut of the passages
 * must not erase the record that Short 1 is already on YouTube, or the retry
 * would upload it a second time.
 *
 * EVERY REFUSAL HERE IS A REFUSAL TO UPLOAD, NEVER A FAILED UPLOAD
 *
 * The Shorts themselves are on disk and verified when this file is read. A
 * refusal ("no publish date", "the date has passed", "this Short is not a
 * YouTube Short") means NOTHING was sent — the episode and its Shorts are
 * untouched, and the reason is written in words a person can act on.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { getMediaInfo } from '../lib/ffmpeg-validation.js'
import { verifyShort, type ShortMoment } from './episode-shorts.js'

export type ShortsAutoUploadMode = 'off' | 'private' | 'scheduled'

/**
 * The channel's switch. Absent, unknown or malformed means OFF: an
 * unreadable value must never turn a feature on.
 */
export function shortsAutoUploadMode(config: unknown): ShortsAutoUploadMode {
  const mode = (config as { shorts_auto_upload?: unknown } | null | undefined)?.shorts_auto_upload
  return mode === 'private' || mode === 'scheduled' ? mode : 'off'
}

/** Days between Shorts in 'scheduled' mode. Out of range means the default. */
export function shortsUploadSpacingDays(config: unknown): number {
  const value = (config as { shorts_upload_spacing_days?: unknown } | null | undefined)?.shorts_upload_spacing_days
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 30 ? value : 1
}

/**
 * YouTube's own rules for a Short, so the shape test is not ours to invent:
 * a Short is vertical (taller than wide) or square, and at most three minutes.
 */
export const YOUTUBE_SHORT_MAX_SECONDS = 180

/**
 * Whether a finished Short file qualifies as a YouTube Short.
 *
 * A 16:9 cut is NOT a Short, and this says so plainly rather than uploading
 * something YouTube will treat as an ordinary video.
 */
export function qualifiesAsYouTubeShort(info: {
  width?: number
  height?: number
  durationSec?: number
}): { ok: boolean; reason?: string } {
  const width = info.width || 0
  const height = info.height || 0
  if (!width || !height) return { ok: false, reason: 'its size could not be read' }
  if (height < width) {
    return { ok: false, reason: `it is ${width}x${height}, which is wider than it is tall — YouTube will not treat it as a Short` }
  }
  const duration = info.durationSec
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > YOUTUBE_SHORT_MAX_SECONDS) {
    return { ok: false, reason: `it is ${Math.round(duration)}s long, and a YouTube Short can be at most ${YOUTUBE_SHORT_MAX_SECONDS}s` }
  }
  return { ok: true }
}

/** One Short's upload state. */
export interface ShortUploadRecord {
  /** The Short's file name inside this episode's shorts folder. */
  file: string
  /** The Short's own title, as chosen when the passage was picked. */
  title: string
  state: 'queued' | 'uploaded' | 'failed'
  /** YouTube's video id, once the upload was accepted. */
  video_id?: string
  /** The date YouTube will make it public on, in 'scheduled' mode. */
  publish_at?: string
  uploaded_at?: string
  error?: string
}

export interface ShortsUploadState {
  shorts: Record<string, ShortUploadRecord>
}

export function shortsUploadStatePath(shortsDir: string): string {
  return path.join(shortsDir, 'shorts_upload.json')
}

export async function readShortsUploadState(shortsDir: string): Promise<ShortsUploadState> {
  try {
    const raw = JSON.parse(await fs.readFile(shortsUploadStatePath(shortsDir), 'utf8'))
    if (raw && typeof raw === 'object' && raw.shorts && typeof raw.shorts === 'object') {
      return { shorts: raw.shorts as Record<string, ShortUploadRecord> }
    }
  } catch { /* no state yet: nothing has been uploaded */ }
  return { shorts: {} }
}

/**
 * Write one Short's upload state.
 *
 * Read-modify-write under the file's own lock, so two Shorts of the same
 * episode cannot lose each other's record.
 */
export async function writeShortUploadRecord(
  shortsDir: string,
  file: string,
  record: ShortUploadRecord,
): Promise<void> {
  const target = shortsUploadStatePath(shortsDir)
  await withLock(target, async () => {
    const state = await readShortsUploadState(shortsDir)
    await writeJsonAtomic(target, { shorts: { ...state.shorts, [file]: record } })
  })
}

/**
 * A Short's own identity on YouTube.
 *
 * A Short is a SEPARATE video, so it needs a SEPARATE identity: if it used
 * the episode's code, the "is this episode already on YouTube" check would
 * answer about the episode's final video and refuse a Short that has never
 * been uploaded. The suffix is the Short's number, and the whole string is
 * also this project's file name for the Short's own sidecar.
 */
export function shortIdentity(episodeCode: string, index: number): string {
  return `${episodeCode.toUpperCase()}-S${index + 1}`
}

export interface ShortUploadPlanEntry {
  /** The Short's index, 0-based. */
  index: number
  /** The Short's identity on YouTube. */
  id: string
  /** The Short's file name inside the episode's shorts folder. */
  file: string
  /** The Short's own title, from its stored moment title. */
  title: string
  /** How long the passage is, in seconds. */
  duration: number
  /** When YouTube will make it public. Only in 'scheduled' mode. */
  publish_at?: string
}

export interface ShortUploadPlan {
  mode: ShortsAutoUploadMode
  spacing_days: number
  entries: ShortUploadPlanEntry[]
  /** Why nothing will be uploaded, in words a person can act on. */
  reason?: string
  /** The Shorts that were left out, each with its reason. */
  skipped: Array<{ file: string; title: string; reason: string }>
}

/**
 * What would be uploaded, and why not — decided BEFORE anything is sent.
 */
export async function planShortsUpload(input: {
  code: string
  shortsDir: string
  moments: ShortMoment[]
  mode: ShortsAutoUploadMode
  spacing_days: number
  now?: number
  /** The parent episode's publish date. Required in 'scheduled' mode. */
  parent_publish_at?: string
}): Promise<ShortUploadPlan> {
  const { code, shortsDir, moments, mode, spacing_days, now = Date.now() } = input
  const skipped: ShortUploadPlan['skipped'] = []
  const empty: ShortUploadPlan = { mode, spacing_days, entries: [], skipped }
  if (mode === 'off') {
    return { ...empty, reason: 'Automatic Shorts upload is off for this channel.' }
  }
  if (!moments.length) {
    return { ...empty, reason: `${code} has no Shorts to upload.` }
  }
  const state = await readShortsUploadState(shortsDir)
  const entries: ShortUploadPlanEntry[] = []
  for (const [index, moment] of moments.entries()) {
    const file = `${code.toUpperCase()}-short-${index + 1}.mp4`
    const fullPath = path.join(shortsDir, file)
    const record = state.shorts[file]
    // A Short already recorded as uploaded is skipped — never uploaded twice.
    if (record?.state === 'uploaded') {
      skipped.push({ file, title: moment.title, reason: 'it is already on YouTube' })
      continue
    }
    if (!existsSync(fullPath)) {
      skipped.push({ file, title: moment.title, reason: 'its file is missing' })
      continue
    }
    // A Short that failed verification is never uploaded.
    const duration = moment.end - moment.start
    const problem = await verifyShort(fullPath, duration)
    if (problem) {
      skipped.push({ file, title: moment.title, reason: `it did not pass verification: ${problem}` })
      continue
    }
    // A Short YouTube will not treat as a Short is not uploaded either.
    const shape = await shortQualifies(fullPath)
    if (!shape.ok) {
      skipped.push({ file, title: moment.title, reason: shape.reason || 'it is not a YouTube Short' })
      continue
    }
    let publishAt: string | undefined
    if (mode === 'scheduled') {
      const base = Date.parse(input.parent_publish_at || '')
      if (!Number.isFinite(base)) {
        return {
          ...empty,
          skipped,
          reason: `${code} has no publish date of its own, so its Shorts have no date to go up on. `
            + 'Give the episode a publish time in Publish, then run this again.',
        }
      }
      publishAt = new Date(base + (index + 1) * spacing_days * 86_400_000).toISOString()
      // A date that is not in the future would publish the Short the moment it
      // landed. Refuse instead.
      if (Date.parse(publishAt) <= now) {
        return {
          ...empty,
          skipped,
          reason: `${code}'s publish date is in the past, so Short ${index + 1}'s date (${publishAt}) has already passed. `
            + 'Nothing was uploaded — give the episode a future publish date and run this again.',
        }
      }
    }
    entries.push({
      index,
      id: shortIdentity(code, index),
      file,
      title: moment.title.trim() || `Short ${index + 1}`,
      duration,
      ...(publishAt ? { publish_at: publishAt } : {}),
    })
  }
  if (!entries.length) {
    return {
      ...empty,
      skipped,
      reason: skipped.length && skipped.every(entry => entry.reason === 'it is already on YouTube')
        ? `Every Short of ${code} is already on YouTube.`
        : `None of ${code}'s Shorts can be uploaded.`,
    }
  }
  return { mode, spacing_days, entries, skipped }
}

/** The verified Shorts of an episode, in order, as the Shorts job wrote them. */
export async function readShortsMoments(shortsDir: string): Promise<ShortMoment[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(shortsDir, 'shorts.json'), 'utf8'))
    if (Array.isArray(manifest?.shorts)) return manifest.shorts as ShortMoment[]
  } catch { /* no manifest: no Shorts */ }
  return []
}

/** Whether a finished Short file is a YouTube Short, read from the file itself. */
export async function shortQualifies(file: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const info = await getMediaInfo(file)
    if (!info.hasVideo) return { ok: false, reason: 'it has no video track' }
    return qualifiesAsYouTubeShort({
      width: info.width, height: info.height, durationSec: info.durationSec,
    })
  } catch (error: any) {
    return { ok: false, reason: `it could not be read (${error?.message || error})` }
  }
}

import fs from 'fs/promises'
import { assertValidMedia, getMediaInfo, type MediaInfo } from './ffmpeg-validation.js'
import { runFfmpeg } from './ffmpeg-utils.js'
import { probeVideoStream, sceneClipCompatibilityProblems } from './scene-clip-compat.js'
import { sceneClipEncodeArgs } from './scene-stage.js'

/** Validate provider output before it becomes an active scene clip. Never modifies it. */
export async function assertPlayableSceneClip(filePath: string, expectedSeconds?: number): Promise<number> {
  try {
    const info = await assertValidMedia(filePath, { label: 'Scene clip', requireVideo: true })
    const duration = info.videoDurationSec ?? (!info.hasAudio ? info.durationSec : undefined)
    if (!duration || !Number.isFinite(duration)) throw new Error('Video stream duration could not be measured.')
    if (expectedSeconds !== undefined) {
      if (!Number.isFinite(expectedSeconds) || expectedSeconds <= 0) throw new Error('Requested clip duration is invalid.')
      // Match assembly's tolerance for container/frame rounding.
      if (Math.abs(duration - expectedSeconds) > 0.15) {
        throw new Error(`Requested ${expectedSeconds}s, but the video contains ${duration.toFixed(3)}s.`)
      }
    }
    // Probe metadata alone cannot detect damaged packets. Decode without producing an asset.
    await runFfmpeg(['-v', 'error', '-xerror', '-i', filePath, '-map', '0:v:0', '-an', '-f', 'null', '-'], {
      timeoutMs: Math.min(10 * 60_000, Math.max(120_000, duration * 4_000)),
    })
    return duration
  } catch (error) {
    throw new Error(`Scene clip needs review: ${error instanceof Error ? error.message : String(error)} File preserved: ${filePath}. No replacement was submitted.`)
  }
}

/** A video import the built-in ffmpeg cannot use. The message names the format and the repair. */
export class SceneClipImportRefused extends Error {}

export interface ImportedSceneClip {
  /** Seconds of video in the imported clip, measured from the upload. */
  duration: number
  /** True when the upload already had the render shape and was copied byte for byte. */
  copied: boolean
}

/** Plain words for what ffprobe found, so a refusal names the format instead of calling the file bad. */
function describeFormat(fileName: string | undefined, info?: MediaInfo): string {
  const fromName = fileName ? `"${fileName}"` : 'This file'
  if (!info) return fromName
  const container = info.containerNames.filter(Boolean).join('/') || 'unknown container'
  if (!info.hasVideo) {
    const audio = info.hasAudio ? `, audio ${info.audioCodec || 'unknown'}` : ''
    return `${fromName} (${container}: no video stream${audio})`
  }
  const size = info.width && info.height ? ` ${info.width}x${info.height}` : ''
  return `${fromName} (${container}: ${info.videoCodec || 'unknown codec'}${size})`
}

function importFrameRate(value: number | undefined): number {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return 30
  // A sane ceiling: a 1000-fps screen capture would otherwise cost minutes to convert into
  // a clip assembly re-times anyway.
  return Math.min(60, Math.max(1, Math.round(fps * 1000) / 1000))
}

/**
 * Accept a clip in any container/codec the built-in ffmpeg can decode, and put it in the
 * shape assembly expects — the shape `prepareSceneClips` checks before it copies a clip
 * instead of re-encoding it: H.264 in MP4, `yuv420p`, bt709 colour tags, constant frame
 * rate, no audio (narration comes from the timeline).
 *
 * There is no second encoder here: `sceneClipCompatibilityProblems` decides whether the
 * upload already has that shape (then it is copied unchanged), and `sceneClipEncodeArgs` —
 * the one FFmpeg clip encoder — converts it when it does not. Canvas size and duration
 * belong to assembly, so the clip keeps its own picture size and length.
 *
 * The upload is written to `outPath` only on success, so a refusal cannot replace an
 * accepted clip, and (as before) the original upload is not kept beside it.
 */
export async function normaliseImportedSceneClip(
  sourcePath: string,
  outPath: string,
  fileName?: string,
): Promise<ImportedSceneClip> {
  let info: MediaInfo
  try {
    info = await getMediaInfo(sourcePath)
  } catch (error: any) {
    throw new SceneClipImportRefused(
      `${describeFormat(fileName)} could not be decoded by the built-in ffmpeg (${error?.message || error}). `
      + 'Upload an MP4 (H.264) clip, or convert this file first. Nothing was changed.',
    )
  }
  if (!info.hasVideo) {
    throw new SceneClipImportRefused(
      `${describeFormat(fileName, info)} has no video stream, so there is nothing to play on this scene. `
      + 'Choose a video file. Nothing was changed.',
    )
  }
  const duration = info.videoDurationSec ?? info.durationSec
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new SceneClipImportRefused(
      `${describeFormat(fileName, info)} has no measurable video length. `
      + 'Upload a complete clip. Nothing was changed.',
    )
  }
  const fps = importFrameRate(info.frameRate)
  const expected = { w: Number(info.width), h: Number(info.height), fps, duration }
  const alreadyShaped = expected.w > 0 && expected.h > 0
    && sceneClipCompatibilityProblems(await probeVideoStream(sourcePath), expected).length === 0
  if (alreadyShaped) {
    await fs.copyFile(sourcePath, outPath)
    return { duration, copied: true }
  }
  // crf 18 = the app's "high" quality: assembly cuts the clip once more, so the intermediate
  // must not add its own loss. ultrafast (inside sceneClipEncodeArgs) keeps one file's
  // conversion to seconds.
  try {
    await runFfmpeg([
      '-y',
      '-i', sourcePath,
      '-map', '0:v:0',
      // yuv420p needs even dimensions; an odd export loses at most one pixel of width/height.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...sceneClipEncodeArgs(18, fps, duration),
      outPath,
    ], { timeoutMs: Math.min(10 * 60_000, Math.max(120_000, duration * 4_000)) })
  } catch (error: any) {
    // ffprobe read the container but this build cannot decode the pictures (or the file is
    // damaged). Same plain answer as an unreadable file, naming what it was.
    await fs.unlink(outPath).catch(() => {})
    throw new SceneClipImportRefused(
      `${describeFormat(fileName, info)} could not be decoded by the built-in ffmpeg (${error?.message || error}). `
      + 'Upload an MP4 (H.264) clip, or convert this file first. Nothing was changed.',
    )
  }
  return { duration, copied: false }
}

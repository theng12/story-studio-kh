import { assertValidMedia } from './ffmpeg-validation.js'
import { runFfmpeg } from './ffmpeg-utils.js'

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

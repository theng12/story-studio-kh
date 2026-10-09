// 1.4.266 (mini, 2026-10-09): night-atlas-history EP0001 Video Assembly (333 scenes, reveal effects on,
// Scene Plan timing, crossfade) built a 240.08s intermediate for an 8424s render, then failed every
// encoder tier on every auto-retry (~1 hour). Plan-strict crossfades time each dissolve as if every
// clip runs window + transition; reveal clips were rendered to the window only, so each dissolve
// started exactly where its left clip ended and FFmpeg ended the chunk there. Pinned here with the
// real bundled FFmpeg: a reveal clip carries the tail and a chunk of them keeps its full length; and
// a short intermediate stops once, before encoding, without automatic retries.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { useTempDataDir } from './_helpers.js'

const execFileAsync = promisify(execFile)
const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const { setAppSetting } = await import('../services/app-settings.js')
for (const binary of ['ffmpeg', 'ffprobe'] as const) {
  const bundled = path.join(repoRoot, 'bundled', 'ffmpeg', binary)
  if (existsSync(bundled)) await setAppSetting(`${binary}_path`, bundled)
}
const ffmpegAvailable = existsSync(path.join(repoRoot, 'bundled', 'ffmpeg', 'ffmpeg'))

const { getFFmpegPath } = await import('../services/ffmpeg-manager.js')
const { getMediaInfo } = await import('../lib/ffmpeg-validation.js')
const { renderRevealClip } = await import('../lib/reveal-render.js')
const { buildVariableXfadeFilterComplex } = await import('../lib/transition-filters.js')
const { BUILT_IN_SCENE_REVEALS } = await import('../contracts/scene-reveal-presets.js')
const { assertIntermediateCoversRender } = await import('../generators/video.js')
const { isNonRetryableError } = await import('../services/job-retry-policy.js')

const WINDOW = 6
const T = 1.5

async function reveal(index: number, image: string, tailSeconds: number): Promise<string> {
  const outPath = path.join(temp.dir, `reveal_${tailSeconds}_${index}.mp4`)
  await renderRevealClip({
    imagePath: image, outPath, document: BUILT_IN_SCENE_REVEALS[index % 3]!.document, pace: 'standard',
    windowSeconds: WINDOW, narrationSeconds: WINDOW, width: 320, height: 180, fps: 24, tailSeconds,
  })
  return outPath
}

/** The plan-strict chunk exactly as video.ts builds it: offsets from window + T, capped at ΣD. */
async function chunk(clips: string[], name: string): Promise<number> {
  const out = path.join(temp.dir, name)
  const filter = buildVariableXfadeFilterComplex({
    inputDurations: clips.map(() => WINDOW + T), transitionDuration: T, xfadeKeywords: clips.slice(1).map(() => 'fade'),
  })
  await execFileAsync(await getFFmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y', ...clips.flatMap(clip => ['-i', clip]),
    '-filter_complex', filter, '-map', '[vout]', '-t', String(WINDOW * clips.length),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-r', '24', '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-an', out,
  ])
  return (await getMediaInfo(out)).videoDurationSec!
}

describe('reveal clips in a plan-strict crossfade', { skip: !ffmpegAvailable && 'no bundled FFmpeg' }, () => {
  test('a reveal clip carries the crossfade tail, and a chunk of them keeps every scene', async () => {
    const image = path.join(temp.dir, 'still.png')
    await execFileAsync(await getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360', '-frames:v', '1', image])

    const tailed = [await reveal(0, image, T), await reveal(1, image, T), await reveal(2, image, T)]
    assert.ok(Math.abs((await getMediaInfo(tailed[0]!)).videoDurationSec! - (WINDOW + T)) < 0.1, 'window + tail')
    assert.ok(Math.abs(await chunk(tailed, 'tailed.mp4') - WINDOW * 3) < 0.1, 'the chunk is every window')

    // The 1.4.265 shape: no tail. FFmpeg ends the chunk where the first dissolve should start.
    const bare = [await reveal(0, image, 0), await reveal(1, image, 0), await reveal(2, image, 0)]
    assert.ok(await chunk(bare, 'bare.mp4') < WINDOW + 1, 'without the tail the chunk collapses to its first clip')
  })
})

test('an intermediate far shorter than the render stops before encoding, without auto-retry', () => {
  assert.throws(() => assertIntermediateCoversRender(240.08, 8424.16), (error: unknown) => {
    assert.ok(isNonRetryableError(error))
    assert.match((error as Error).message, /240\.1s but this render needs 8424\.2s/)
    return true
  })
  assert.doesNotThrow(() => assertIntermediateCoversRender(8424.16, 8424.16))
  assert.doesNotThrow(() => assertIntermediateCoversRender(8423.5, 8424.16), 'a frame of rounding is not a failure')
  assert.doesNotThrow(() => assertIntermediateCoversRender(6200.25, 6185.07), 'a longer timeline is trimmed by the encode')
})

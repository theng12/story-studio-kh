/**
 * The closing dissolve: every Sketch Draw reveal ends on the SCENE IMAGE.
 *
 * Before this change the six reveals ended differently. Only "Colour it in" eased its ink out, so
 * its last frame was the picture. The other five ended with bold two-tone ink still sitting on the
 * picture, and the closing hold re-encoded that drawing frame — so the clip ended on a drawing,
 * not on the scene image the customer approved.
 *
 * What these prove:
 *   - all six reveals end on the fitted source picture: the last frame and the whole hold match it
 *     within a small tolerance (H.264 is lossy, so "equal" is measured, not assumed);
 *   - the drawing is still a drawing before the dissolve: the frames ahead of it differ from the
 *     picture, so a reveal cannot pass by never drawing anything;
 *   - the dissolve is the ONLY change to the approved look: every frame before it decodes exactly
 *     as the version-5 helper drew it, frame for frame.
 *
 * The golden frames are rendered at quality 1.0. At the app's own quality (0.7) the H.264 encoder
 * is not bit-exact when other encoders are running at the same time, so a frame-hash golden there
 * is a flake waiting to happen; at 1.0 the same render is bit-exact every time. That is a property
 * of the encoder, not of the drawing, so it changes nothing about what is being measured.
 *
 * What these cannot catch: whether the dissolve LOOKS right. That is the owner's eyes on the
 * samples in `_orchestra/sketch-finish-374-samples/`.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import sharp from 'sharp'

import {
  NATIVE_SCENE_CLIP_VERSION, SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS, renderSketchDraw,
  resolveSceneClipHelperPath, type SketchDrawJob,
} from '../lib/native-scene-clip.js'
import { sceneClipStaleReason } from '../services/scene-media-checkpoint.js'
import { DEFAULT_SKETCH_REVEAL, sketchRevealFingerprint, type SketchRevealSetting, type SketchRevealType } from '../lib/sketch-reveal.js'
import { useTempDataDir } from './_helpers.js'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

const REVEALS: SketchRevealType[] = ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour']

// ── Freshness: nothing already approved goes stale ───────────────────────────

let dir: string
let cleanup: () => Promise<void>
before(async () => { const temp = await useTempDataDir(); dir = temp.dir; cleanup = temp.cleanup })
after(async () => { await cleanup() })

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function settings(reveal: SketchRevealSetting | null) {
  return { fps: 30, width: 1920, height: 1080, pen: { mode: 'none' as const }, penFingerprint: sha('none'),
    hold: { mode: 'auto' as const }, holdFingerprint: sha('auto'),
    reveal, revealFingerprint: sketchRevealFingerprint(reveal ?? DEFAULT_SKETCH_REVEAL) }
}

function scene(revealType: SketchRevealType, over: Record<string, unknown> = {}) {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A',
    visual_prompt: 'A', approved: true, motion_prompt: 'slow push', motion_choice: 'clip' as const,
    clip_source_image_version: 'v1', clip_renderer: 'sketch_draw' as const,
    image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG), clip_scene_window_seconds: 4,
    clip_sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION, fps: 30, frames: 120, width: 1920, height: 1080,
      pen_fingerprint: sha('none'), hold_frames: 60, hold_fingerprint: sha('auto'), reveal_type: revealType },
    ...over,
  }
}

test('a clip receipt from the old helper stays fresh: the ending changes, the clip does not go stale', async () => {
  const file = path.join(dir, 'scene.png')
  await fs.writeFile(file, PNG)

  for (const reveal of REVEALS) {
    const ctx = { slug: 'channel', episodeId: 'EP001', episodeDir: dir, imagePath: file,
      sketchSettings: settings({ style: reveal, mix: [] }), revealScenes: ['scene-1'] }
    for (const helper_version of [2, 3, 4, 5, 6]) {
      const receipt = { ...scene(reveal).clip_sketch, helper_version }
      assert.equal(await sceneClipStaleReason(scene(reveal, { clip_sketch: receipt }), ctx), null,
        `helper ${helper_version} ${reveal} clip stays fresh under helper ${NATIVE_SCENE_CLIP_VERSION}`)
    }
  }
  assert.deepEqual([...SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS], [2, 3, 4, 5, 6])
  assert.ok(SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS.includes(NATIVE_SCENE_CLIP_VERSION))
})

// ── The real helper (only where it is built) ────────────────────────────────

const helper = process.platform === 'darwin' && process.arch === 'arm64' ? resolveSceneClipHelperPath() : null
const FF = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null
const realTest = helper && FF ? test : test.skip

const W = 640, H = 360, FPS = 12, FRAMES = 12, HOLD = 3
const SOURCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="220" fill="#7fa8c8"/>
  <rect y="220" width="${W}" height="140" fill="#8a6a45"/>
  <ellipse cx="320" cy="120" rx="70" ry="85" fill="#e8c39a"/>
  <rect x="255" y="190" width="130" height="150" fill="#3a5a8a"/>
  <circle cx="95" cy="70" r="42" fill="#f0d060"/>
  <rect x="500" y="250" width="100" height="80" fill="#2f4a2f"/>
</svg>`
const DEPTH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/>
  </linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

/**
 * The frames the version-5 helper drew for this exact fixture, before the dissolve: the hash of
 * the first eight decoded frames, per reveal. The version-6 helper must reproduce these exactly —
 * that is what "the approved look is unchanged up to the dissolve" means, measured rather than
 * asserted. Recorded from the version-5 helper on this fixture.
 */
const PRE_FADE_V5: Record<string, string> = {
  line: '873a46ae984a88c0ed89598bac7f9c38',
  buildup: '041e7728f6b47842e0cde1ed569f8b58',
  swipes: '2993dfa3560203edc5a4993e5edffaac',
  patches: '774c4353b4a287ef5cb7c463daf2ff14',
  bloom: '4dbb812ec081a12012bc8de4d24a7ae6',
  colour: '01d12c033ca41a703920d7d977cd4ac9',
}

let work: string
let sourcePath: string
let depthPath: string

before(async () => {
  if (!helper || !FF) return
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-finish-'))
  sourcePath = path.join(work, 'source.png')
  depthPath = path.join(work, 'depth.png')
  await sharp(Buffer.from(SOURCE_SVG)).png().toFile(sourcePath)
  await sharp(Buffer.from(DEPTH_SVG)).greyscale().png().toFile(depthPath)
})
after(async () => { if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined) })

async function render(name: string, reveal: SketchDrawJob['reveal'], quality?: number, mask?: string): Promise<string> {
  const output = path.join(work, `${name}.mp4`)
  await renderSketchDraw({ kind: 'sketch', input: sourcePath, output, width: W, height: H, fps: FPS,
    frames: FRAMES, hold_frames: HOLD, paper: '#ffffff', pen: { mode: 'none' }, reveal,
    ...(quality !== undefined ? { quality } : {}), ...(mask ? { mask } : {}) })
  return output
}

/** Decoded frame digests: the same measure the native clip's own determinism test uses. */
function frameDigests(file: string): string[] {
  const out = spawnSync(FF!, ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout
  return out.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').pop()!.trim())
}

function decoded(file: string, frame: number): Buffer {
  const out = spawnSync(FF!, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(out.status, 0, String(out.stderr))
  assert.equal(out.stdout.length, W * H * 3, `frame ${frame} decoded to ${W}x${H} RGB`)
  return out.stdout
}

/** Mean absolute channel difference, and the 99th percentile, between two RGB buffers. */
function difference(a: Buffer, b: Buffer): { mean: number; p99: number } {
  assert.equal(a.length, b.length)
  const hist = new Uint32Array(256)
  let sum = 0
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]! - b[i]!); hist[d] = hist[d]! + 1; sum += d }
  const want = Math.floor(a.length * 0.99)
  let seen = 0, p99 = 255
  for (let d = 0; d < 256; d++) { seen += hist[d]!; if (seen > want) { p99 = d; break } }
  return { mean: sum / a.length, p99 }
}

realTest('every reveal ends on the scene image: the last frame and the whole hold match the picture', async () => {
  // The fixture is exactly the canvas size, so the helper's contain-fit is the identity and the
  // source picture IS the fitted picture.
  const source = await sharp(sourcePath).removeAlpha().raw().toBuffer()
  assert.equal(source.length, W * H * 3)

  for (const reveal of REVEALS) {
    const file = await render(`finish-${reveal}`, reveal, undefined, reveal === 'colour' ? depthPath : undefined)
    assert.equal(frameDigests(file).length, FRAMES, `${reveal}: the frame budget is structural`)

    // The last frame and every hold frame are the picture.
    for (let frame = FRAMES - HOLD; frame < FRAMES; frame++) {
      const { mean, p99 } = difference(decoded(file, frame), source)
      assert.ok(mean < 4 && p99 <= 20,
        `${reveal}: frame ${frame} must be the source picture (mean ${mean.toFixed(2)}, p99 ${p99})`)
    }
    // ...and the drawing before the dissolve is NOT the picture: the ink really is there.
    const early = difference(decoded(file, Math.floor(FRAMES / 3)), source)
    assert.ok(early.mean > 4, `${reveal}: an early frame is the drawing, not the picture (mean ${early.mean.toFixed(2)})`)
  }
})

realTest('the dissolve is the only change to the approved look: the frames before it are untouched', async () => {
  // 12 frames, 3 of them hold: 9 drawing frames at u = f/8. The dissolve starts at u = 0.88, so
  // frames 0..7 are the approved drawing, unchanged, and frames 8..11 are the dissolve and hold.
  for (const reveal of REVEALS) {
    const file = await render(`golden-${reveal}`, reveal, 1, reveal === 'colour' ? depthPath : undefined)
    const digests = frameDigests(file)
    assert.equal(digests.length, FRAMES, `${reveal}: the frame budget is structural`)
    assert.equal(createHash('md5').update(digests.slice(0, 8).join('\n')).digest('hex'), PRE_FADE_V5[reveal],
      `${reveal}: the frames before the dissolve decode exactly as the version-5 helper drew them`)
  }
})

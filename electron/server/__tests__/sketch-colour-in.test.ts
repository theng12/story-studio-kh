/**
 * "Colour it in" — the sixth Sketch Draw reveal, ported from the approved 2026-10-29 prototype.
 *
 * What these prove:
 *   - the type exists everywhere a reveal is named, and a Mix may hold it;
 *   - the helper accepts its optional depth mask and refuses a relative one;
 *   - accepted clips stay fresh across the helper-version bump (nothing approved goes stale);
 *   - when the helper is built on this Mac: the five approved reveals decode exactly as the
 *     version-4 helper's clips did (frame-for-frame), and the colour reveal is deterministic,
 *     renders its exact frame budget, ends on the SOURCE picture, and uses its depth mask.
 *
 * What these cannot catch: whether the reveal LOOKS right. That is the owner's eyes on
 * `_orchestra/sketch-colour-in-20261029/swift-port/side2-*.mp4`.
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
  NATIVE_SCENE_CLIP_VERSION, SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS, SketchDrawError,
  renderSketchDraw, resolveSceneClipHelperPath, validateSketchDrawJob, type SketchDrawJob,
} from '../lib/native-scene-clip.js'
import {
  DEFAULT_SKETCH_REVEAL, SKETCH_REVEAL_LABELS, SKETCH_REVEAL_MAX_MIX, SKETCH_REVEAL_TYPES,
  parseSketchReveal, resetSketchRevealPlanCache, resolveSketchRevealPlan, sketchRevealFingerprint,
  type SketchRevealSetting, type SketchRevealType,
} from '../lib/sketch-reveal.js'
import { sceneClipStaleReason } from '../services/scene-media-checkpoint.js'
import { useTempDataDir } from './_helpers.js'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

// ── The type, its label and the Mix ─────────────────────────────────────────

test('colour is the sixth reveal type, labelled "Colour it in", and a Mix may hold it', () => {
  assert.deepEqual([...SKETCH_REVEAL_TYPES], ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour'])
  assert.equal(SKETCH_REVEAL_LABELS.colour, 'Colour it in')
  assert.equal(SKETCH_REVEAL_MAX_MIX, 6)
  assert.deepEqual(parseSketchReveal({ style: 'colour', mix: [] }), { ok: true, reveal: { style: 'colour', mix: [] } })
  assert.deepEqual(parseSketchReveal({ style: 'mix', mix: ['line', 'colour'] }),
    { ok: true, reveal: { style: 'mix', mix: ['line', 'colour'] } })
  assert.deepEqual(parseSketchReveal({ style: 'mix', mix: ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour'] }),
    { ok: true, reveal: { style: 'mix', mix: ['line', 'buildup', 'swipes', 'patches', 'bloom', 'colour'] } })
  assert.match((parseSketchReveal({ style: 'mix', mix: ['line', 'sparkle'] }) as { error: string }).error, /Colour it in/)
})

test('a Mix resolves Colour it in deterministically and never twice in a row', () => {
  resetSketchRevealPlanCache()
  const scenes = Array.from({ length: 12 }, (_, i) => `scene-${i + 1}`)
  const mix: SketchRevealSetting = { style: 'mix', mix: ['line', 'colour'] }
  const plan = resolveSketchRevealPlan('EP001', scenes, mix)
  assert.ok([...plan.values()].includes('colour'), 'the new type does appear in a two-style mix')
  for (let i = 1; i < scenes.length; i++) assert.notEqual(plan.get(scenes[i]!), plan.get(scenes[i - 1]!))
  resetSketchRevealPlanCache()
  assert.deepEqual([...resolveSketchRevealPlan('EP001', scenes, mix)], [...plan], 'the same episode plans the same way')
})

// ── The helper contract ─────────────────────────────────────────────────────

const base: SketchDrawJob = {
  kind: 'sketch', input: '/input/scene.png', output: '/output/scene.mp4',
  width: 1920, height: 1080, fps: 30, frames: 247, paper: '#ffffff', pen: { mode: 'none' }, reveal: 'line',
}

test('a colour job may carry an absolute depth mask; a relative one is refused before any run', async t => {
  assert.doesNotThrow(() => validateSketchDrawJob({ ...base, reveal: 'colour' }))
  assert.doesNotThrow(() => validateSketchDrawJob({ ...base, reveal: 'colour', mask: '/episodes/EP001/scene-analysis/scene-1.depth.png' }))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-colour-job-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  let ran = false
  await assert.rejects(
    renderSketchDraw({ ...base, output: path.join(dir, 'a.mp4'), reveal: 'colour', mask: 'relative/depth.png' },
      { run: async () => { ran = true; return { code: 0, stderr: '' } } }),
    (error: unknown) => error instanceof SketchDrawError && error.code === 'bad_job')
  assert.equal(ran, false)
  // The mask reaches the helper in the job JSON.
  const job = { ...base, output: path.join(dir, 'b.mp4'), reveal: 'colour' as const, mask: '/episodes/EP001/scene-analysis/scene-1.depth.png' }
  let seen: any
  await renderSketchDraw(job, { run: async (_helper, file) => {
    seen = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(job.output, 'clip')
    return { code: 0, stderr: '' }
  } })
  assert.equal(seen.mask, job.mask)
  assert.equal(seen.reveal, 'colour')
})

// ── Freshness: nothing approved goes stale on the bump ──────────────────────

let dir: string
let cleanup: () => Promise<void>
before(async () => { const temp = await useTempDataDir(); dir = temp.dir; cleanup = temp.cleanup })
after(async () => { await cleanup() })

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function settings(reveal: SketchRevealSetting | null, fps = 30) {
  return { fps, width: 1920, height: 1080, pen: { mode: 'none' as const }, penFingerprint: sha('none'),
    hold: { mode: 'auto' as const }, holdFingerprint: sha('auto'),
    reveal, revealFingerprint: sketchRevealFingerprint(reveal ?? DEFAULT_SKETCH_REVEAL) }
}

function scene(over: Record<string, unknown> = {}) {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A',
    visual_prompt: 'A', approved: true, motion_prompt: 'slow push', motion_choice: 'clip' as const,
    clip_source_image_version: 'v1', clip_renderer: 'sketch_draw' as const,
    image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG), clip_scene_window_seconds: 4,
    clip_sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION, fps: 30, frames: 120, width: 1920, height: 1080,
      pen_fingerprint: sha('none'), hold_frames: 60, hold_fingerprint: sha('auto'), reveal_type: 'line' as SketchRevealType },
    ...over,
  }
}

async function still(bytes = PNG, name = 'scene.png') {
  const file = path.join(dir, name)
  await fs.writeFile(file, bytes)
  return file
}

function context(imagePath: string, sketchSettings = settings(null)) {
  return { slug: 'channel', episodeId: 'EP001', episodeDir: dir, imagePath, sketchSettings, revealScenes: ['scene-1'] }
}

test('version-4 clips — every clip accepted before this change — stay fresh under helper 5', async () => {
  const file = await still()
  for (const helper_version of [4, 5]) {
    const receipt = { ...scene().clip_sketch, helper_version, reveal_type: 'line' as SketchRevealType }
    assert.equal(await sceneClipStaleReason(scene({ clip_sketch: receipt }), context(file, settings({ style: 'line', mix: [] }))), null,
      `helper ${helper_version} line clip stays fresh while the episode renders Line`)
    const legacy = { ...receipt, reveal_type: undefined }
    assert.equal(await sceneClipStaleReason(scene({ clip_sketch: legacy }), context(file, settings(null))), null,
      'a clip that recorded no type keeps the reveal it was made with')
  }
  assert.deepEqual([...SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS], [2, 3, 4, 5])
  assert.ok(SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS.includes(NATIVE_SCENE_CLIP_VERSION))
  assert.match((await sceneClipStaleReason(scene({ clip_sketch: { ...scene().clip_sketch, helper_version: 1 } }), context(file, settings(null))))!, /renderer/)
})

test('a Line clip is only stale when the episode actually moves to Colour it in', async () => {
  const file = await still()
  const reason = await sceneClipStaleReason(scene(), context(file, settings({ style: 'colour', mix: [] })))
  assert.match(reason!, /^stale reveal style \(line → colour\)$/)
  const colourClip = scene({ clip_sketch: { ...scene().clip_sketch, reveal_type: 'colour' as SketchRevealType } })
  assert.equal(await sceneClipStaleReason(colourClip, context(file, settings({ style: 'colour', mix: [] }))), null)
})

// ── The real helper (only where it is built) ────────────────────────────────

const helper = process.platform === 'darwin' && process.arch === 'arm64' ? resolveSceneClipHelperPath() : null
const FF = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null
const realTest = helper && FF ? test : test.skip

/** What the version-4 helper produced for this exact fixture: decoded-frame hashes, per reveal. */
const GOLDEN_V4: Record<string, string> = {
  line: '9270b8dc25b0bebdd368c372ac0bcbc3',
  buildup: '8d89ee61ada7d97d33e8f94823dd8fef',
  swipes: '06f5ca914c408ba33e740cd4cae0a722',
  patches: '711f49667a2b797c62dbc4f2c3739031',
  bloom: 'c4a51eb64dabe55e51348fa4c11821e1',
}

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

let work: string
let sourcePath: string
let depthPath: string

before(async () => {
  if (!helper || !FF) return
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'sketch-colour-in-'))
  sourcePath = path.join(work, 'source.png')
  depthPath = path.join(work, 'depth.png')
  await sharp(Buffer.from(SOURCE_SVG)).png().toFile(sourcePath)
  await sharp(Buffer.from(DEPTH_SVG)).greyscale().png().toFile(depthPath)
})
after(async () => { if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined) })

async function render(name: string, reveal: SketchDrawJob['reveal'], mask?: string): Promise<string> {
  const output = path.join(work, `${name}.mp4`)
  await renderSketchDraw({ kind: 'sketch', input: sourcePath, output, width: W, height: H, fps: FPS,
    frames: FRAMES, hold_frames: HOLD, paper: '#ffffff', pen: { mode: 'none' }, reveal, ...(mask ? { mask } : {}) })
  return output
}

/** Decoded frame digests: the same measure the native clip's own determinism test uses. */
function frameDigests(file: string): string[] {
  const out = spawnSync(FF!, ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout
  const lines = out.split('\n').filter(line => line && !line.startsWith('#'))
  return lines.map(line => line.split(',').pop()!.trim())
}

function decoded(file: string, frame: number, w = W, h = H): Buffer {
  const out = spawnSync(FF!, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(out.status, 0, String(out.stderr))
  assert.equal(out.stdout.length, w * h * 3, `frame ${frame} decoded to ${w}x${h} RGB`)
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

realTest('the five approved reveals decode exactly as the version-4 helper\'s clips did', async () => {
  for (const [reveal, golden] of Object.entries(GOLDEN_V4)) {
    const file = await render(`golden-${reveal}`, reveal as SketchDrawJob['reveal'])
    const digests = frameDigests(file)
    assert.equal(digests.length, FRAMES, `${reveal}: the frame budget is structural`)
    assert.equal(createHash('md5').update(digests.join('\n')).digest('hex'), golden,
      `${reveal} must decode frame-for-frame as helper 4 did (golden recorded from helper 4 on this fixture)`)
  }
})

realTest('Colour it in renders its exact frame budget, deterministically, and ends on the source picture', async () => {
  const first = await render('colour-a', 'colour', depthPath)
  const second = await render('colour-b', 'colour', depthPath)
  const digests = frameDigests(first)
  assert.equal(digests.length, FRAMES)
  assert.deepEqual(frameDigests(second), digests, 'the same picture and depth map render the same clip')

  // The closing hold is the SOURCE picture — not a drawing. H.264 is lossy, so "equal" is measured.
  const source = await sharp(sourcePath).removeAlpha().raw().toBuffer()
  assert.equal(source.length, W * H * 3)
  for (let frame = FRAMES - HOLD; frame < FRAMES; frame++) {
    const { mean, p99 } = difference(decoded(first, frame), source)
    assert.ok(mean < 4 && p99 <= 20, `hold frame ${frame} must be the source picture (mean ${mean.toFixed(2)}, p99 ${p99})`)
  }
  // ...and the drawing before it is NOT the source: the ink and the colouring really are there.
  const early = difference(decoded(first, Math.floor(FRAMES / 3)), source)
  assert.ok(early.mean > 4, `an early frame is the drawing, not the picture (mean ${early.mean.toFixed(2)})`)

  // The depth map is an input, not decoration: without it the colouring plan differs.
  const plain = await render('colour-no-mask', 'colour')
  assert.notDeepEqual(frameDigests(plain), digests, 'the subject phase changes the clip when a depth map exists')
})

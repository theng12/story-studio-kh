/**
 * The native scene-clip renderer, from the Node side: the contract with the helper, the per-clip
 * fallback to FFmpeg, the concat-compatibility rules, and (when the helper is built on this Mac) a
 * real fixture render pushed through a real xfade.
 *
 * What these cannot catch: whether a native clip LOOKS like FFmpeg's. That is measured, not asserted:
 * `_orchestra/audit-20261001/render-local/` holds the per-move PSNR table and the side-by-side clips.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { defaultSceneMotion, mergeSceneMotion } from '../contracts/scene-effects.js'
import { prepareSceneClips } from '../generators/video.js'
import { resolveSceneMotionDocument } from '../lib/animation-filters.js'
import {
  NATIVE_SCENE_CLIP_VERSION, buildSceneClipJob, probeNativeSceneClip, renderNativeSceneClip,
  resetNativeSceneClipProbe, resolveSceneClipHelperPath,
} from '../lib/native-scene-clip.js'
import { renderRevealClip } from '../lib/reveal-render.js'
import { planStillMotion } from '../lib/scene-motion-plan.js'
import { probeVideoStream, sceneClipCompatibilityProblems, type ProbedVideoStream } from '../lib/scene-clip-compat.js'
import { resolveSceneReveals } from '../lib/reveal-assembly.js'
import { builtInReveal } from '../contracts/scene-reveal-presets.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import { useTempDataDir } from './_helpers.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const PARAMS = { type: 'ken-burns', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 } as const

const scratch: string[] = []
const cleanups: Array<() => Promise<void>> = []
after(async () => {
  await Promise.all(scratch.map(dir => fs.rm(dir, { recursive: true, force: true }).catch(() => {})))
  await Promise.all(cleanups.map(cleanup => cleanup().catch(() => {})))
})
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-scene-clip-'))
  scratch.push(dir)
  return dir
}

// ── The job the helper reads ────────────────────────────────────────────────

test('the job carries the plan, the prepared canvas and the encode settings the helper needs', () => {
  const doc = resolveSceneMotionDocument({ type: 'ken-burns', params: PARAMS as any })
  const plan = planStillMotion(doc, { w: 1920, h: 1080, fps: 24, duration: 2 })
  assert.ok(plan.supported)
  const job = buildSceneClipJob({ imagePath: '/a.png', outPath: '/b.mp4', document: doc, w: 1920, h: 1080, fps: 24, duration: 2 }, plan)
  assert.equal(job.input, '/a.png')
  assert.equal(job.output, '/b.mp4')
  assert.deepEqual([job.width, job.height, job.fps], [1920, 1080, 24])
  assert.deepEqual([job.prepWidth, job.prepHeight], [3840, 2160])
  assert.equal(job.resample, 'lanczos')
  assert.equal(job.matrix, 'bt709')
  assert.equal(job.frames.length, 48)
  assert.deepEqual(Object.keys(job.frames[0]!).sort(), ['blur', 'cx', 'cy', 'gain', 'rot', 'z'])
  const still = planStillMotion(defaultSceneMotion(), { w: 1920, h: 1080, fps: 24, duration: 1 })
  assert.ok(still.supported)
  assert.equal(buildSceneClipJob({ imagePath: 'a', outPath: 'b', document: defaultSceneMotion(), w: 1920, h: 1080, fps: 24, duration: 1 }, still).resample, 'bilinear')
})

// ── renderNativeSceneClip: every way it can say no ───────────────────────────

const camera = resolveSceneMotionDocument({ type: 'ken-burns', params: PARAMS as any })

test('exit 0 is a render; exit 3 is the helper declining the picture; anything else is a failure', async () => {
  const dir = await tempDir()
  const base = { imagePath: path.join(dir, 'a.png'), outPath: path.join(dir, 'a.mp4'), document: camera, w: 128, h: 96, fps: 24, duration: 0.5 }
  const ok = await renderNativeSceneClip({ ...base, run: async () => ({ code: 0, stderr: '' }) })
  assert.deepEqual(ok, { rendered: true, kind: 'camera', frames: 12 })
  const declined = await renderNativeSceneClip({ ...base, run: async () => ({ code: 3, stderr: 'scene-clip: source has an alpha channel' }) })
  assert.equal(declined.rendered, false)
  assert.equal((declined as any).reason, 'unsupported')
  assert.match((declined as any).detail, /alpha channel/)
  const failed = await renderNativeSceneClip({ ...base, run: async () => ({ code: 4, stderr: 'scene-clip: GPU frame 3' }) })
  assert.equal((failed as any).reason, 'failed')
  const crashed = await renderNativeSceneClip({ ...base, run: async () => { throw new Error('spawn EBADARCH') } })
  assert.equal((crashed as any).reason, 'failed')
  assert.match((crashed as any).detail, /EBADARCH/)
  const killed = await renderNativeSceneClip({ ...base, run: async () => ({ code: null, stderr: 'timed out after 600s' }) })
  assert.equal((killed as any).reason, 'failed')
})

test('a scene the plan cannot express never reaches the helper', async () => {
  let spawned = 0
  const run = async () => { spawned++; return { code: 0, stderr: '' } }
  const footage = await renderNativeSceneClip({
    imagePath: 'a', outPath: 'b', w: 128, h: 96, fps: 24, duration: 1, run,
    document: mergeSceneMotion(defaultSceneMotion(), { source: 'footage' }),
  })
  assert.equal((footage as any).reason, 'unsupported')
  const ntsc = await renderNativeSceneClip({ imagePath: 'a', outPath: 'b', document: camera, w: 128, h: 96, fps: 29.97, duration: 1, run })
  assert.equal((ntsc as any).reason, 'unsupported')
  const odd = await renderNativeSceneClip({ imagePath: 'a', outPath: 'b', document: camera, w: 127, h: 96, fps: 24, duration: 1, run })
  assert.equal((odd as any).reason, 'unsupported')
  assert.equal(spawned, 0)
})

test('the job file is written for the helper and removed afterwards, success or not', async () => {
  const dir = await tempDir()
  const jobPath = path.join(dir, 'x.job.json')
  let seen: any
  await renderNativeSceneClip({
    imagePath: 'a.png', outPath: 'b.mp4', document: camera, w: 128, h: 96, fps: 24, duration: 0.5, jobPath,
    run: async (_helper, jobFile) => { seen = JSON.parse(await fs.readFile(jobFile, 'utf8')); return { code: 4, stderr: 'x' } },
  })
  assert.equal(seen.frames.length, 12)
  await assert.rejects(fs.stat(jobPath))
})

// ── Compatibility with the rest of the assembly ──────────────────────────────

const GOOD: ProbedVideoStream = {
  codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '24/1', avg_frame_rate: '24/1',
  time_base: '1/12288', color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', duration: '7.458333',
}

test('a native clip is accepted only if it is the frame shape the xfade and concat stages expect', () => {
  const expected = { w: 1920, h: 1080, fps: 24, duration: 7.44 }
  assert.deepEqual(sceneClipCompatibilityProblems(GOOD, expected), [])
  // FFmpeg's own clips leave primaries/transfer unsignalled; that must stay acceptable.
  assert.deepEqual(sceneClipCompatibilityProblems({ ...GOOD, color_primaries: 'unknown', color_transfer: undefined }, expected), [])
  const bad = (patch: Partial<ProbedVideoStream>) => sceneClipCompatibilityProblems({ ...GOOD, ...patch }, expected)
  assert.match(bad({ width: 1280 }).join(), /width/)
  assert.match(bad({ pix_fmt: 'yuv444p' }).join(), /pix_fmt/)
  assert.match(bad({ r_frame_rate: '30/1' }).join(), /frame rate/)
  assert.match(bad({ time_base: '1/600' }).join(), /time_base/)
  assert.match(bad({ color_space: 'smpte170m' }).join(), /color_space/)
  assert.match(bad({ color_range: 'pc' }).join(), /color_range/)
  assert.match(bad({ color_primaries: 'bt2020' }).join(), /color_primaries/)
  assert.match(bad({ codec_name: 'hevc' }).join(), /codec/)
  assert.match(bad({ duration: '5.0' }).join(), /duration/)
  assert.deepEqual(sceneClipCompatibilityProblems(undefined, expected), ['no video stream'])
  assert.deepEqual(sceneClipCompatibilityProblems({ ...GOOD, duration: '7.45' }, expected), [])   // one frame of slack
})

// ── prepareSceneClips: per-clip fallback ─────────────────────────────────────

interface Harness {
  dir: string
  job: any
  encoded: string[]
  nativeCalls: string[]
  run: (scenes: any[], native: any, extra?: { chapterTitles?: any; canDrawtext?: boolean; durations?: number[] }) => Promise<string[]>
}

async function harness(): Promise<Harness> {
  // prepareSceneClips checkpoints its job; keep that off the real data directory.
  cleanups.push((await useTempDataDir()).cleanup)
  const dir = await tempDir()
  const encoded: string[] = []
  const nativeCalls: string[] = []
  const job: any = {
    job_id: 'native-fixture', project_slug: 'demo', type: 'video_assembly', episode_id: 'EP001', title: 'native',
    status: 'running', created_at: new Date().toISOString(), started_at: null, finished_at: null, error: null,
    output_lines: [], params: {},
  }
  const run = (scenes: any[], native: any, extra: { chapterTitles?: any; canDrawtext?: boolean; durations?: number[] } = {}) =>
    prepareSceneClips(
      scenes, { ...PARAMS } as any, extra.chapterTitles ?? ({ enabled: false } as any),
      128, 96, { crf: 23, preset: 'medium', fps: 5 }, dir, extra.canDrawtext ?? false,
      { seconds_per_scene: 1, shuffle: false, excluded_scenes: [] }, job,
      { pool: [], randomizeMode: 'off', seed: 7, ...(native ? { native } : {}) },
      extra.durations ?? scenes.map(() => 1), 0, [],
      {
        checkpoint: { version: 1, job_id: job.job_id, project_slug: 'demo', episode_id: 'EP001', work_dir: dir, render_fingerprint: 'a'.repeat(64), completed_scene_clips: [] },
        renderFingerprint: 'a'.repeat(64),
        encodeSceneClip: async (args: string[]) => { encoded.push(args.at(-1)!); await fs.writeFile(args.at(-1)!, tinyVideoBytes()) },
      } as any,
    )
  return { dir, job, encoded, nativeCalls, run }
}

async function stills(dir: string, count: number): Promise<any[]> {
  const out = []
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `still_${i}.png`)
    await fs.writeFile(file, ONE_PIXEL_PNG)
    out.push({ image_path: file, duration: 1 })
  }
  return out
}

const available = async () => ({ available: true })
const writes = (h: Harness, result: any = undefined) => async (req: any) => {
  h.nativeCalls.push(path.basename(req.outPath))
  if (result) return result
  await fs.writeFile(req.outPath, tinyVideoBytes())
  return { rendered: true, kind: 'camera', frames: 5 }
}
const compatible = async () => []

test('native on: every still comes from the helper, FFmpeg is not asked for a single scene clip', async () => {
  const h = await harness()
  const clips = await h.run(await stills(h.dir, 2), { enabled: true, probe: available, render: writes(h), verify: compatible })
  assert.equal(clips.length, 2)
  assert.deepEqual(h.nativeCalls, ['scene_0000.mp4', 'scene_0001.mp4'])
  assert.deepEqual(h.encoded, [])
  const log = h.job.output_lines.join('\n')
  assert.match(log, /native renderer on/)
  assert.match(log, /2 native, 0 FFmpeg fallback/)
  assert.match(log, /\[native camera\]/)
})

test('one scene the helper fails on falls back to FFmpeg by itself, the rest stay native, and the log says why', async () => {
  const h = await harness()
  const render = async (req: any) => {
    h.nativeCalls.push(path.basename(req.outPath))
    if (req.outPath.endsWith('scene_0001.mp4')) return { rendered: false, reason: 'failed', detail: 'exit 4: GPU frame 3' }
    await fs.writeFile(req.outPath, tinyVideoBytes())
    return { rendered: true, kind: 'camera', frames: 5 }
  }
  const clips = await h.run(await stills(h.dir, 3), { enabled: true, probe: available, render, verify: compatible })
  assert.equal(clips.length, 3)
  assert.deepEqual(h.encoded, [path.join(h.dir, 'scene_0001.mp4')])
  const log = h.job.output_lines.join('\n')
  assert.match(log, /Scene 2: native renderer skipped \(failed: exit 4: GPU frame 3\) — rendering with FFmpeg/)
  assert.match(log, /2 native, 1 FFmpeg fallback \(1x failed: exit 4: GPU frame 3\)/)
})

test('a helper that throws, or an effect it declines, is the same fallback', async () => {
  const h = await harness()
  let calls = 0
  const render = async (req: any) => {
    calls++
    if (calls === 1) throw new Error('spawn EBADARCH')
    return { rendered: false, reason: 'unsupported', detail: 'source has an alpha channel' }
  }
  await h.run(await stills(h.dir, 2), { enabled: true, probe: available, render, verify: compatible })
  assert.equal(h.encoded.length, 2)
  const log = h.job.output_lines.join('\n')
  assert.match(log, /error: spawn EBADARCH/)
  assert.match(log, /unsupported: source has an alpha channel/)
  assert.match(log, /0 native, 2 FFmpeg fallback/)
})

test('a native clip that is not concat-compatible is discarded and re-rendered by FFmpeg', async () => {
  const h = await harness()
  const clips = await h.run(await stills(h.dir, 1), {
    enabled: true, probe: available, render: writes(h),
    verify: async () => ['time_base 1/600 (want 1/2560)'],
  })
  assert.equal(clips.length, 1)
  assert.deepEqual(h.encoded, [path.join(h.dir, 'scene_0000.mp4')])
  assert.match(h.job.output_lines.join('\n'), /output not concat-compatible: time_base 1\/600/)
})

test('off by default: with native not enabled the helper is never asked, and nothing about FFmpeg changes', async () => {
  const h = await harness()
  await h.run(await stills(h.dir, 2), { enabled: false, probe: available, render: writes(h), verify: compatible })
  await h.run(await stills(h.dir, 1), undefined)
  assert.deepEqual(h.nativeCalls, [])
  assert.equal(h.encoded.length, 3)
  assert.doesNotMatch(h.job.output_lines.join('\n'), /native/)
})

test('an unavailable helper is one log line and the whole stage runs on FFmpeg', async () => {
  const h = await harness()
  await h.run(await stills(h.dir, 2), {
    enabled: true, probe: async () => ({ available: false, reason: 'helper binary not found' }), render: writes(h), verify: compatible,
  })
  assert.deepEqual(h.nativeCalls, [])
  assert.equal(h.encoded.length, 2)
  assert.match(h.job.output_lines.join('\n'), /native renderer unavailable \(helper binary not found\)/)
})

test('scenes that need an FFmpeg filter (chapter title) or are footage never go native', async () => {
  const h = await harness()
  const scenes = await stills(h.dir, 2)
  scenes[0].title = 'Chapter One'
  scenes[0].show_title = true
  const footage = path.join(h.dir, 'broll.mp4')
  await fs.writeFile(footage, tinyVideoBytes())
  scenes.push({ image_path: footage, duration: 1 })
  await h.run(scenes, { enabled: true, probe: available, render: writes(h), verify: compatible }, {
    canDrawtext: true,
    chapterTitles: { enabled: true, font_size: 'medium', position: 'bottom', style: 'white', duration: 3, animation: 'none' },
  })
  assert.deepEqual(h.nativeCalls, ['scene_0001.mp4'], 'only the plain still is rendered natively')
  assert.equal(h.encoded.length, 2)
})

// ── Reveals: native drift, FFmpeg wipes ──────────────────────────────────────

const reveal = builtInReveal('reveal-rows')!.document

function revealInput(dir: string, extra: object) {
  return {
    imagePath: path.join(dir, 'a.png'), outPath: path.join(dir, 'reveal_0000.mp4'), document: reveal, pace: 'standard' as const,
    windowSeconds: 8, width: 1920, height: 1080, fps: 24, ...extra,
  }
}

test('a reveal renders its drift natively and keeps FFmpeg\'s wipes: same timing, one extra input', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'a.png'), ONE_PIXEL_PNG)
  const baseline: string[][] = []
  await renderRevealClip({ ...revealInput(dir, {}), run: async args => { baseline.push(args) } })
  const hybrid: string[][] = []
  let driftReq: any
  const rendered = await renderRevealClip({
    ...revealInput(dir, {}),
    native: {
      driftPath: path.join(dir, 'drift.mp4'),
      render: async req => { driftReq = req; return { rendered: true, kind: 'camera', frames: 1 } },
    },
    run: async args => { hybrid.push(args) },
  })
  assert.equal(rendered.renderer, 'native-drift')
  assert.equal(hybrid.length, 1)
  const args = hybrid[0]!
  assert.equal(args[args.indexOf('-i') + 1], path.join(dir, 'drift.mp4'), 'input 0 is the native drift clip')
  // the camera stage is gone from the graph; the wipe and the clip length are untouched
  const graph = args[args.indexOf('-filter_complex') + 1]!
  const baseGraph = baseline[0]![baseline[0]!.indexOf('-filter_complex') + 1]!
  assert.match(baseGraph, /zoompan/)
  assert.doesNotMatch(graph, /zoompan/)
  assert.match(graph, /xfade=transition=hlslice/)
  assert.equal(args[args.indexOf('-t') + 1], baseline[0]![baseline[0]!.indexOf('-t') + 1])
  assert.deepEqual(args.slice(args.lastIndexOf('-c:v')), baseline[0]!.slice(baseline[0]!.lastIndexOf('-c:v')), 'identical encoder arguments')
  // the drift is the reveal's own camera move, for the picture's own share of the clip
  assert.equal(driftReq.w, 1920)
  assert.ok(Math.abs(driftReq.document.zoom.from_pct - 100) < 1e-9 && Math.abs(driftReq.document.zoom.to_pct - 104) < 1e-9)
  assert.ok(driftReq.duration > 3 && driftReq.duration <= 8)   // the picture's share of the clip: from its own wipe to the last micro-event
})

test('a reveal whose native drift is declined, or whose hybrid graph fails, renders the all-FFmpeg graph', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'a.png'), ONE_PIXEL_PNG)
  const reasons: string[] = []
  const declined: string[][] = []
  const a = await renderRevealClip({
    ...revealInput(dir, {}),
    native: { driftPath: path.join(dir, 'd.mp4'), onFallback: r => reasons.push(r), render: async () => ({ rendered: false, reason: 'unsupported', detail: 'alpha' }) },
    run: async args => { declined.push(args) },
  })
  assert.equal(a.renderer, 'ffmpeg')
  assert.match(declined[0]!.join(' '), /zoompan/)
  assert.match(reasons[0]!, /unsupported: alpha/)

  const attempts: string[][] = []
  const b = await renderRevealClip({
    ...revealInput(dir, {}),
    native: { driftPath: path.join(dir, 'd.mp4'), onFallback: r => reasons.push(r), render: async () => ({ rendered: true, kind: 'camera', frames: 1 }) },
    run: async args => { attempts.push(args); if (attempts.length === 1) throw new Error('FFmpeg exited with code 234: boom') },
  })
  assert.equal(b.renderer, 'ffmpeg')
  assert.equal(attempts.length, 2)
  assert.doesNotMatch(attempts[0]!.join(' '), /zoompan/)
  assert.match(attempts[1]!.join(' '), /zoompan/)
  assert.match(reasons.at(-1)!, /hybrid graph failed: FFmpeg exited with code 234/)
})

test('prepareSceneClips renders a planned reveal through the hybrid and counts it as native', async () => {
  const h = await harness()
  const scenes = await stills(h.dir, 1)
  scenes[0].duration = 4
  const plan = resolveSceneReveals({ scenes: [{ scene_id: 's1', scene_index: 0, window_seconds: 4, narration_seconds: 4 }], settings: { enabled: true, seed: 3, pace: 'standard' } })
  const revealArgs: string[][] = []
  const native = {
    enabled: true, probe: available, verify: compatible,
    render: async (req: any) => { h.nativeCalls.push(path.basename(req.outPath)); return { rendered: true, kind: 'camera', frames: 1 } },
  }
  const clips = await prepareSceneClips(
    scenes, { ...PARAMS } as any, { enabled: false } as any, 128, 96, { crf: 23, preset: 'medium', fps: 5 }, h.dir, false,
    { seconds_per_scene: 1, shuffle: false, excluded_scenes: [] }, h.job,
    { pool: [], randomizeMode: 'off', seed: 7, reveals: plan, crf: 23, native } as any,
    [plan.durations[0]!], 0, [],
    {
      checkpoint: { version: 1, job_id: 'j', project_slug: 'demo', episode_id: 'EP001', work_dir: h.dir, render_fingerprint: 'a'.repeat(64), completed_scene_clips: [] },
      renderFingerprint: 'a'.repeat(64),
      runRevealClip: async (args: string[]) => { revealArgs.push(args); await fs.writeFile(args.at(-1)!, tinyVideoBytes()) },
    } as any,
  )
  assert.match(clips[0]!, /reveal_0000\.mp4$/)
  assert.deepEqual(h.nativeCalls, ['reveal_drift_0000.mp4'])
  assert.equal(revealArgs.length, 1)
  assert.match(h.job.output_lines.join('\n'), /1 native, 0 FFmpeg fallback/)
  assert.match(h.job.output_lines.join('\n'), /native drift/)
})

// ── The real helper (only where it is built) ─────────────────────────────────

const helper = process.platform === 'darwin' && process.arch === 'arm64' ? resolveSceneClipHelperPath() : null
const FF = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null
const realTest = helper && FF ? test : test.skip

realTest('the built helper starts, reports the version the app expects, and the probe accepts it', async () => {
  resetNativeSceneClipProbe()
  const probe = await probeNativeSceneClip()
  assert.equal(probe.available, true, probe.reason)
  assert.equal(probe.path, helper)
  const out = spawnSync(helper!, ['--version'], { encoding: 'utf8' })
  assert.equal(out.stdout.trim(), `scene-clip ${NATIVE_SCENE_CLIP_VERSION}`)
})

realTest('a real fixture render is concat-compatible, deterministic, and survives a real xfade', async () => {
  const dir = await tempDir()
  // a 64x64 gradient PNG made by ffmpeg so the test needs no image library
  const still = path.join(dir, 'still.png')
  assert.equal(spawnSync(FF!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=96x64:c0=0x204080:c1=0xe0a040:d=1', '-frames:v', '1', '-pix_fmt', 'rgb24', still]).status, 0)
  const W = 256, H = 144, FPS = 24, SECONDS = 1
  const doc = resolveSceneMotionDocument({ type: 'ken-burns', params: PARAMS as any })
  const render = (name: string) => renderNativeSceneClip({ imagePath: still, outPath: path.join(dir, name), document: doc, w: W, h: H, fps: FPS, duration: SECONDS })
  const first = await render('a.mp4')
  assert.deepEqual(first, { rendered: true, kind: 'camera', frames: 24 })
  await render('b.mp4')

  const stream = await probeVideoStream(path.join(dir, 'a.mp4'))
  assert.deepEqual(sceneClipCompatibilityProblems(stream, { w: W, h: H, fps: FPS, duration: SECONDS }), [])
  assert.equal(stream?.time_base, `1/${FPS * 512}`)

  // determinism: the same job twice decodes to the same pixels (the container may differ in a timestamp)
  const md5 = (file: string) => spawnSync(FF!, ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout
    .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').pop()!.trim())
  assert.deepEqual(md5(path.join(dir, 'a.mp4')), md5(path.join(dir, 'b.mp4')))
  assert.equal(md5(path.join(dir, 'a.mp4')).length, 24)

  // the next stage: an xfade of a native clip with an x264 clip, in the argument shape the assembly uses
  const x264 = path.join(dir, 'x264.mp4')
  assert.equal(spawnSync(FF!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=s=${W}x${H}:r=${FPS}:d=${SECONDS}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', x264]).status, 0)
  const chunk = path.join(dir, 'chunk.mp4')
  const xfade = spawnSync(FF!, [
    '-y', '-loglevel', 'error', '-i', path.join(dir, 'a.mp4'), '-i', x264, '-i', path.join(dir, 'b.mp4'),
    '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=0.25:offset=0.75[x1];[x1][2:v]xfade=transition=wipeleft:duration=0.25:offset=1.5[vout]',
    '-map', '[vout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-an', chunk,
  ], { encoding: 'utf8' })
  assert.equal(xfade.status, 0, xfade.stderr)
  const out = await probeVideoStream(chunk)
  assert.ok(Math.abs(Number(out?.duration) - 2.5) < 0.1)
})

realTest('the helper declines what it cannot render and says so through the exit code', async () => {
  const dir = await tempDir()
  const bad = path.join(dir, 'not-an-image.png')
  await fs.writeFile(bad, 'not a picture')
  const result = await renderNativeSceneClip({ imagePath: bad, outPath: path.join(dir, 'x.mp4'), document: camera, w: 128, h: 96, fps: 24, duration: 0.5 })
  assert.equal(result.rendered, false)
  assert.equal((result as any).reason, 'unsupported')
  const alpha = path.join(dir, 'alpha.png')
  assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1,format=rgba,geq=r=255:g=0:b=0:a=128', '-frames:v', '1', alpha]).status, 0)
  const withAlpha = await renderNativeSceneClip({ imagePath: alpha, outPath: path.join(dir, 'y.mp4'), document: camera, w: 128, h: 96, fps: 24, duration: 0.5 })
  assert.equal((withAlpha as any).reason, 'unsupported')
  assert.match((withAlpha as any).detail, /alpha/)
  // ...but an RGBA file whose alpha is fully opaque is just a picture, and renders
  const opaque = path.join(dir, 'opaque.png')
  assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1,format=rgba', '-frames:v', '1', opaque]).status, 0)
  const rendered = await renderNativeSceneClip({ imagePath: opaque, outPath: path.join(dir, 'z.mp4'), document: camera, w: 128, h: 96, fps: 24, duration: 0.5 })
  assert.equal(rendered.rendered, true)
})

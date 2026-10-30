/**
 * Label motions — pop, slide, pulse, float — proven on real rendered pixels.
 *
 * A filter-string assertion would pass while nothing moved: AGENTS.md §3 says
 * every gate can be green while the app is visibly broken, and this path fails
 * that way twice over, both verified against the real binary:
 *
 *   - `scale` resolves its output size at init time by default and FFmpeg
 *     REFUSES frame variables there (`Expressions with frame variables 'n', 't',
 *     'pos' are not valid in init eval mode`), so a pop or pulse cue would not
 *     render at all;
 *   - a PNG input yields exactly ONE frame, which `eof_action=repeat` then
 *     holds for the rest of the video — so even with `eval=frame` the motion
 *     evaluates once and freezes.
 *
 * "The motion filter is in the graph" therefore proves nothing about whether
 * anything moved. Every motion is rendered through the SAME builder the
 * composition writes and the pixels are read back: a frame during the motion
 * differs from the frame it settles beside; the output keeps the source's frame
 * count (a looped still must not run the encode on forever, and `shortest=1`
 * must not truncate it); and the label exists on exactly the cue's frames and
 * nowhere else.
 *
 * Also pinned here: a cue with no motion emits byte-for-byte the filter it
 * always has, an unknown motion name fails BY NAME instead of silently drawing
 * a still, and `motion` survives both a cue save and the labels preset.
 *
 * Skips the renders loudly when no overlay-capable FFmpeg is present.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildLabelOverlayFilters, labelOverlayGeometry, labelCueForRender } from '../lib/contextual-cue-filters.js'
import { escapeFilterArgValue } from '../lib/ffmpeg-filter-escape.js'
import { findLabelDesign, renderLabelDesign, renderLabelWipe, renderLeaderLine, writeLabelRevealFrames } from '../lib/label-design-render.js'
import type { ContextualCue } from '../models/types.js'

const run = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WIDTH = 640
const HEIGHT = 360
const FPS = 10
const STRIDE = WIDTH * HEIGHT * 3

// The cue runs 1.0s–4.0s on a render window of 0–5s, so the label's own
// frames sit inside a window with clear background on both sides. That is
// what makes "the motion stays inside the cue's timing" checkable rather than
// assumed.
const START_SEC = 1.0
const END_SEC = 4.0
const WINDOW_SEC = 5.0
const START_IDX = START_SEC * FPS
const END_IDX = END_SEC * FPS

type Motion = NonNullable<ContextualCue['motion']>
/** The motions the renderer can actually perform; `wipe` and `line-draw` were dropped. */
type RenderableMotion = Extract<Motion, 'pop' | 'slide' | 'pulse' | 'float'>
const MOTIONS: RenderableMotion[] = ['pop', 'slide', 'pulse', 'float']

/**
 * The two frames each motion must be caught between.
 *
 * pop and slide enter ONCE, so the cue's first visible frame against the hold
 * it settles into is the honest comparison. pulse and float never settle — they
 * are periodic — so the pair has to straddle their phase (pulse's one-second
 * cycle at peak and trough; float at its two extremes), or the test would
 * compare two moments that genuinely look alike and pass while nothing moved.
 */
const SAMPLE: Record<RenderableMotion, { a: number; b: number }> = {
  pop:   { a: START_IDX, b: START_IDX + 10 },
  slide: { a: START_IDX, b: START_IDX + 10 },
  pulse: { a: 12, b: 17 },
  float: { a: 18, b: 33 },
}

function findFfmpeg(): string | null {
  const candidates = [
    path.join(REPO_ROOT, 'bundled', 'ffmpeg', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]
  for (const bin of candidates) {
    if (!existsSync(bin)) continue
    try {
      const out = execFileSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 20000 })
      if (/^\s*\S+\s+overlay\s/m.test(out)) return bin
    } catch { /* try the next candidate */ }
  }
  return null
}
const FFMPEG = findFfmpeg()

function cue(overrides: Partial<ContextualCue> = {}): ContextualCue {
  return {
    id: 'cue-1', scene_id: 'scene-1', start_sec: START_SEC, end_sec: END_SEC,
    title: 'Berlin', kind: 'location_date', placement: 'top-left',
    template: 'label:location-pin', entrance: 'fade', exit: 'fade',
    status: 'approved', created_at: '', updated_at: '', ...overrides,
  }
}

/**
 * Render one cue through `buildLabelOverlayFilters` — the exact chain
 * `generators/video.ts` writes — and hand back every decoded frame.
 */
async function renderCue(dir: string, motion?: Motion): Promise<{ frames: Buffer; count: number; geometry: ReturnType<typeof labelOverlayGeometry> }> {
  const design = (await findLabelDesign('label:location-pin'))!
  const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
  const theCue = cue(motion ? { motion } : {})
  const geometry = labelOverlayGeometry(theCue, rendered, WIDTH, HEIGHT)

  const png = path.join(dir, `label-${motion ?? 'none'}.png`)
  writeFileSync(png, rendered.png)

  let names = 0
  const plan = buildLabelOverlayFilters(geometry, {
    base: '[0:v]', labelInputIdx: 1, fps: FPS, allocLabel: () => `[v${++names}]`,
  })
  const out = path.join(dir, `out-${motion ?? 'none'}.mp4`)
  await run(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=${WIDTH}x${HEIGHT}:d=${WINDOW_SEC}:r=${FPS}`,
    ...plan.input_args, '-i', png,
    '-filter_complex', [...plan.filters, `${plan.output}null[vout]`].join(';'),
    '-map', '[vout]', '-pix_fmt', 'yuv420p', out,
  ], { maxBuffer: 1024 * 1024 * 16, timeout: 120_000 })

  const raw = path.join(dir, `all-${motion ?? 'none'}.raw`)
  await run(FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { maxBuffer: 1024 * 1024 * 16, timeout: 120_000 })
  const frames = readFileSync(raw)
  return { frames, count: Math.round(frames.length / STRIDE), geometry }
}

const frameAt = (frames: Buffer, i: number): Buffer => frames.subarray(i * STRIDE, (i + 1) * STRIDE)

/**
 * How much of the frame is NOT the red field.
 *
 * The background colour is sampled from the frame's own bottom-right corner —
 * far from every placement this file uses — rather than hard-coded, so an
 * encoder's idea of "red" after a yuv420p round trip can never be mistaken for
 * label pixels, and a label colour nobody anticipated can never be mistaken for
 * background.
 */
function labelPixels(f: Buffer): number {
  let br = 0, bg = 0, bb = 0, n = 0
  for (let y = HEIGHT - 40; y < HEIGHT - 4; y++) {
    for (let x = WIDTH - 120; x < WIDTH - 4; x++) {
      const i = (y * WIDTH + x) * 3
      br += f[i]; bg += f[i + 1]; bb += f[i + 2]; n++
    }
  }
  br /= n; bg /= n; bb /= n
  let count = 0
  for (let i = 0; i < f.length; i += 3) {
    if (Math.abs(f[i] - br) > 40 || Math.abs(f[i + 1] - bg) > 40 || Math.abs(f[i + 2] - bb) > 40) count++
  }
  return count
}

/** Pixels whose colour moved by more than compression noise allows. */
function diffPixels(a: Buffer, b: Buffer): number {
  let n = 0
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i] - b[i]) > 20 || Math.abs(a[i + 1] - b[i + 1]) > 20 || Math.abs(a[i + 2] - b[i + 2]) > 20) n++
  }
  return n
}

/** Frame indices carrying any label at all. */
function labelFrames(frames: Buffer, count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) if (labelPixels(frameAt(frames, i)) > 200) out.push(i)
  return out
}

describe('label motions, verified on rendered pixels', { skip: FFMPEG ? false : 'no overlay-capable ffmpeg found' }, () => {
  for (const motion of MOTIONS) {
    test(`a ${motion} cue moves: one frame differs from the frame beside it`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'label-motion-'))
      try {
        const { frames } = await renderCue(dir, motion)
        const { a, b } = SAMPLE[motion]
        const moved = diffPixels(frameAt(frames, a), frameAt(frames, b))
        assert.ok(moved > 300, `${motion}: frame ${a} and frame ${b} are the same picture — nothing moved (${moved} differing pixels)`)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    test(`a ${motion} cue keeps the output frame count and the cue's own window`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'label-window-'))
      try {
        const { frames, count } = await renderCue(dir, motion)
        assert.equal(count, Math.round(WINDOW_SEC * FPS),
          `${motion}: the still input changed how many frames the encode produced — a looped label must neither run forever nor truncate the video`)

        const expected: number[] = []
        for (let i = START_IDX; i <= END_IDX; i++) expected.push(i)
        const seen = labelFrames(frames, count)
        assert.deepEqual(seen, expected,
          `${motion}: the label must exist on exactly the cue's frames (${START_SEC}s–${END_SEC}s) and nowhere else`)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  }

  for (const motion of ['wipe', 'line-draw'] as const) {
    test(`${motion} reveals and holds at the target`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'label-reveal-'))
      try {
        const design = (await findLabelDesign('label:location-pin'))!
        const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
        const geometry = labelOverlayGeometry(cue({ motion }), rendered, WIDTH, HEIGHT)
        const files: string[] = []
        const label = path.join(dir, 'label.png')
        writeFileSync(label, rendered.png)
        const line = { frame_w: WIDTH, frame_h: HEIGHT, from: { x: geometry.anchor.x / WIDTH, y: geometry.anchor.y / HEIGHT }, to: { x: 0.7, y: 0.7 } }
        const sequence = await writeLabelRevealFrames(path.join(dir, 'frame'), FPS, files, progress => motion === 'wipe'
          ? renderLabelWipe(rendered.png, rendered.width, rendered.height, progress)
          : renderLeaderLine({ ...line, progress }))
        let names = 0
        const plan = buildLabelOverlayFilters(geometry, { base: '[0:v]', labelInputIdx: motion === 'wipe' ? 1 : 2, fps: FPS, allocLabel: () => `[v${++names}]` })
        const out = path.join(dir, `${motion}.mp4`)
        const input = motion === 'wipe' ? [...plan.input_args, '-i', sequence] : ['-framerate', String(FPS), '-i', sequence, '-i', label]
        const prefix = motion === 'line-draw' ? `[1:v]setpts=PTS+${START_SEC}/TB[line];[0:v][line]overlay=x=0:y=0:eof_action=repeat:enable='between(t,${START_SEC},${END_SEC})'[base];` : ''
        if (motion === 'line-draw') plan.filters[0] = plan.filters[0].replace('[0:v]', '[base]')
        await run(FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${WIDTH}x${HEIGHT}:d=${WINDOW_SEC}:r=${FPS}`, ...input, '-filter_complex', prefix + plan.filters.join(';'), '-map', plan.output, '-pix_fmt', 'yuv420p', out], { timeout: 120_000 })
        const raw = path.join(dir, 'out.raw')
        await run(FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { timeout: 120_000 })
        const frames = readFileSync(raw)
        assert.equal(frames.length / STRIDE, WINDOW_SEC * FPS)
        assert.ok(diffPixels(frameAt(frames, START_IDX), frameAt(frames, START_IDX + 3)) > 100, 'entrance must change visible pixels')
        assert.ok(diffPixels(frameAt(frames, START_IDX + 4), frameAt(frames, START_IDX + 10)) < 100, 'final frame must hold')
        if (motion === 'line-draw') {
          const target = ((Math.round(HEIGHT * .7) * WIDTH) + Math.round(WIDTH * .7)) * 3
          assert.ok(frameAt(frames, START_IDX + 4)[target + 1] > 100, 'line must reach the target')
        }
        const evidence = process.env.LABEL_MOTION_EVIDENCE_DIR
        if (evidence) { await fs.mkdir(evidence, { recursive: true }); await fs.copyFile(out, path.join(evidence, `${motion}.mp4`)) }
      } finally { await fs.rm(dir, { recursive: true, force: true }) }
    })
  }

  test('line-draw without a usable target shows a pop and logs why', async () => {
    const design = (await findLabelDesign('label:location-pin'))!
    const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
    for (const [candidate, pointing] of [
      [cue({ motion: 'line-draw' }), true],
      [cue({ motion: 'line-draw', target_x_pct: 70, target_y_pct: 70 }), false],
    ] as const) {
      const messages: string[] = []
      const resolved = labelCueForRender(candidate, pointing, message => messages.push(message))
      assert.equal(resolved.motion, 'pop')
      assert.equal(candidate.motion, 'line-draw')
      assert.match(messages[0]!, /cue-1.*no usable target.*no line was drawn/i)
      assert.ok(labelOverlayGeometry(resolved, rendered, WIDTH, HEIGHT).motion_exprs?.scale)
    }
    const messages: string[] = []
    const valid = cue({ motion: 'line-draw', target_x_pct: 70, target_y_pct: 70 })
    assert.equal(labelCueForRender(valid, true, message => messages.push(message)), valid)
    assert.deepEqual(messages, [])
  })

  test('a cue with no motion emits exactly the filter string it always has', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'label-still-'))
    try {
      const design = (await findLabelDesign('label:location-pin'))!
      const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
      const geometry = labelOverlayGeometry(cue(), rendered, WIDTH, HEIGHT)
      assert.equal(geometry.motion_exprs, undefined, 'a cue that named no motion must carry no motion expression')

      let names = 0
      const plan = buildLabelOverlayFilters(geometry, {
        base: '[0:v]', labelInputIdx: 1, fps: FPS, allocLabel: () => `[v${++names}]`,
      })
      assert.deepEqual(plan.input_args, [], 'a cue with no motion must not loop its still image')
      assert.equal(names, 1, 'a cue with no motion is still one overlay')
      assert.equal(plan.filters.length, 1, 'a cue with no motion is still one filter')
      assert.equal(
        plan.filters[0],
        `[0:v][1:v]overlay=x=${geometry.x}:y=${geometry.y}:eof_action=repeat:enable=${escapeFilterArgValue(geometry.enable)}[v1]`,
        'the no-motion filter string must be byte-for-byte what it was before motions existed',
      )
      assert.ok(!/scale=|shortest=/.test(plan.filters[0]), 'no motion means no scale stage and no shortest=1')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('an unknown motion name fails by name instead of silently rendering a still', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'label-unknown-'))
    try {
      const design = (await findLabelDesign('label:location-pin'))!
      const rendered = await renderLabelDesign({ design, title: 'BERLIN', frame_w: WIDTH, frame_h: HEIGHT })
      assert.throws(
        () => labelOverlayGeometry(cue({ motion: 'spin' as unknown as Motion }), rendered, WIDTH, HEIGHT),
        /"spin"/,
        'a motion nobody declared must name itself, not quietly become a still the customer reads as working',
      )
      // New motions are backed by reveal frames and accepted by geometry.
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// ── Persistence: a motion the customer set must not evaporate ───────────────

const scenePlanFixture = {
  generated_at: '2026-10-01T00:00:00.000Z',
  total_duration_sec: 40,
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 20, transcript_segment: 'The temple stood here.', visual_prompt: 'A temple.' },
    { id: 'scene-2', scene_index: 2, start_sec: 20, end_sec: 40, transcript_segment: 'Its bells rang at dawn.', visual_prompt: 'Bells.' },
  ],
}

function labelFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 4.15, end_sec: 7.65,
    title: 'The temple', kind: 'location_date', placement: 'top-right',
    template: 'label:location-pin', entrance: 'fade', exit: 'dissolve', status: 'approved',
    created_at: 'now', updated_at: 'now', ...overrides,
  }
}

let isolated: { cleanup: () => Promise<void> }
let slug = ''
let episode = ''
let planPath = ''
let app: any
let request: any

before(async () => {
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  isolated = await (await import('./_helpers.js')).useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Label motion fixture', episode_prefix: 'EP', episode_digits: 4 })
  slug = project.slug
  await pm.updateConfig(slug, { contextual_cues: { enabled: true } } as any)
  const [idea] = await ideas.addIdeas(slug, [{ title: 'Motion', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  episode = (await ideas.acceptIdea(slug, idea!.id, false)).episode_code!
  const paths = await utils.resolveEpisodePathsByCodeWithSidecar(slug, episode, 'scene_plan.json')
  planPath = await utils.resolveScenePlanPath(slug, episode, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify(scenePlanFixture))
  ;({ app } = await import('../app.js'))
  ;({ default: request } = await import('supertest'))
})

after(async () => {
  await isolated?.cleanup()
})

describe('a motion is a saved setting, not a value that evaporates', () => {
  test('saving a cue keeps its motion, on disk and back through the read', async () => {
    const put = await request(app)
      .put(`/api/projects/${slug}/sound-and-labels/${episode}/labels`)
      .send({ cues: [labelFixture({ motion: 'pop' })] })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(put.body.timeline.cues[0].motion, 'pop', 'the save response must echo the motion it stored')

    const read = await request(app).get(`/api/projects/${slug}/sound-and-labels/${episode}`)
    assert.equal(read.status, 200, JSON.stringify(read.body))
    assert.equal(read.body.labels.cues[0].motion, 'pop', 'the page must read the motion back')

    const cues = await import('../services/contextual-cues.js')
    const stored = await cues.readContextualCueTimeline(planPath)
    assert.equal(stored?.cues[0]?.motion, 'pop', 'the timeline on disk must still carry the motion')
  })

  test('the labels preset accepts a motion and keeps it', async () => {
    const stored = {
      id: 'preset-pop', name: 'Pop labels', type: 'contextual-cues',
      data: { model: 'gpt', density: 'restrained', placement: 'top-right', auto_approve: false, motion: 'pop' },
    }
    const saved = await request(app)
      .put(`/api/projects/${slug}/settings/config`)
      .send({ contextual_cues_presets: [stored] })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.deepEqual(saved.body.ignored ?? [], [], 'contextual_cues_presets must be an accepted config key')

    const back = await request(app).get(`/api/projects/${slug}/settings/config`)
    assert.equal(back.status, 200, JSON.stringify(back.body))
    const preset = (back.body.contextual_cues_presets ?? []).find((p: any) => p.id === 'preset-pop')
    assert.ok(preset, 'the labels preset must come back at all')
    assert.equal(preset.data.motion, 'pop', 'the preset must keep the motion it was saved with')
  })
})

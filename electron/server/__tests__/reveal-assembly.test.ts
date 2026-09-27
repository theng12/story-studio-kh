/**
 * Reveal effects at assembly time — the plan, the durations, and the pack kind that ships presets.
 *
 * Three things are pinned here, in the order they matter:
 *
 *   1. **The plan is deterministic** and follows the engine's own rules (seed per episode, no
 *      immediate repeats, coherence modes, overrides). A re-render must reproduce the episode, so
 *      the same settings must give the same plan, twice.
 *   2. **The duration is the plan's**, and the pace never shortens a scene the plan already timed.
 *      That second half is the one that would silently eat narration: `planSceneHold` clamps to the
 *      pace band, and a band that tops out below a long scene's window must not trim it.
 *   3. **`kind: 'reveal'` is a real Content Pack kind** — it validates, it may not claim a built-in
 *      preset's id, and a pack whose `category` disagrees with its document's own family is refused
 *      rather than rendered as something nobody chose.
 *
 * Everything runs locally with no FFmpeg: the render branch is exercised through the seam the other
 * scene-clip tests already use.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ContentPackDocumentSchema } from '../content-packs/schemas.js'
import { BUILT_IN_SCENE_REVEALS } from '../contracts/scene-reveal-presets.js'
import { defaultSceneReveal, normalizeSceneReveal } from '../contracts/scene-reveal.js'
import {
  plannedRevealForScene,
  resolveSceneReveals,
  revealSecondsForImage,
} from '../lib/reveal-assembly.js'
import { REVEAL_PACE_SETTINGS } from '../lib/reveal-pacing.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function scenes(count: number, windowSeconds = 12) {
  return Array.from({ length: count }, (_, index) => ({
    scene_id: `scene-${index + 1}`,
    scene_index: index,
    act_index: Math.floor(index / 3),
    window_seconds: windowSeconds,
  }))
}

test('reveals are off unless asked for, and off is not the same as empty', () => {
  const off = resolveSceneReveals({ scenes: scenes(3) })
  assert.equal(off.enabled, false)
  assert.deepEqual(off.scenes, [])
  assert.deepEqual(off.durations, [])

  const on = resolveSceneReveals({ scenes: scenes(3), settings: { enabled: true } })
  assert.equal(on.enabled, true)
  assert.equal(on.scenes.length, 3)
  assert.equal(on.durations.length, 3)
  // Off defaults to the middle of the pace table rather than the fastest or slowest look.
  assert.equal(off.pace, 'standard')
  assert.equal(on.pace, 'standard')
})

test('the same settings give the same plan twice, and a different seed gives a different one', () => {
  const settings = { enabled: true, seed: 4242, coherence: 'scene' as const }
  const first = resolveSceneReveals({ scenes: scenes(12), settings })
  const second = resolveSceneReveals({ scenes: scenes(12), settings })
  assert.deepEqual(first.scenes.map(entry => entry.preset_id), second.scenes.map(entry => entry.preset_id))
  assert.deepEqual(first.durations, second.durations)

  const other = resolveSceneReveals({ scenes: scenes(12), settings: { ...settings, seed: 99 } })
  assert.notDeepEqual(first.scenes.map(entry => entry.preset_id), other.scenes.map(entry => entry.preset_id),
    'a different episode seed must be able to dress the episode differently')
})

test('no immediate repeats, and the pool is what the episode chose', () => {
  const pool = ['reveal-rows', 'reveal-columns', 'reveal-radial']
  const plan = resolveSceneReveals({
    scenes: scenes(20),
    settings: { enabled: true, seed: 3, pool, coherence: 'scene' },
  })
  const picks = plan.scenes.map(entry => entry.preset_id)
  for (let index = 1; index < picks.length; index++) {
    assert.notEqual(picks[index], picks[index - 1], `scene ${index + 1} repeats its predecessor`)
  }
  assert.ok(picks.every(id => pool.includes(id)),
    `every pick must come from the chosen pool, got: ${[...new Set(picks)]}`)
})

test('episode coherence dresses every scene the same; an override survives it', () => {
  const plan = resolveSceneReveals({
    scenes: scenes(6),
    settings: {
      enabled: true,
      seed: 11,
      coherence: 'episode',
      overrides: [{ scene_id: 'scene-4', preset_id: 'reveal-diagonal', reroll: 1 }],
    },
  })
  const picks = plan.scenes.map(entry => entry.preset_id)
  const first = picks[0]
  assert.ok(picks.filter(id => id !== first).length === 1, `one override only, got ${picks}`)
  const overridden = plan.scenes.find(entry => entry.scene_id === 'scene-4')!
  assert.equal(overridden.preset_id, 'reveal-diagonal')
  assert.equal(overridden.source, 'override')
  assert.equal(plan.scenes[0]!.source, 'derived')
})

test('act coherence changes at act boundaries and holds inside one', () => {
  const plan = resolveSceneReveals({
    scenes: scenes(9),
    settings: { enabled: true, seed: 5, coherence: 'act' },
  })
  const byAct = new Map<number, Set<string>>()
  for (const entry of plan.scenes) {
    const act = Math.floor(entry.scene_index / 3)
    const set = byAct.get(act) ?? new Set<string>()
    set.add(entry.preset_id)
    byAct.set(act, set)
  }
  for (const [act, picks] of byAct) {
    assert.equal(picks.size, 1, `act ${act} must hold one look, got ${[...picks]}`)
  }
})

test('a pace never shortens a scene the plan already timed', () => {
  // Documentary has the longest band; Fast the shortest. A 20 s window is longer than every
  // band's ceiling, so the scene must keep its window at each pace.
  const long = [{ scene_id: 'scene-1', scene_index: 0, window_seconds: 20, narration_seconds: 20 }]
  for (const pace of ['fast', 'standard', 'slow', 'documentary'] as const) {
    const plan = resolveSceneReveals({ scenes: long, settings: { enabled: true, seed: 1, pace } })
    assert.equal(plan.durations[0], 20,
      `${pace} trimmed a 20 s narration window to ${plan.durations[0]}`)
    const entry = plan.scenes[0]!
    assert.ok(entry.hold.reveal_seconds <= 20, 'the reveal itself must fit the window')
    assert.ok(Math.abs(entry.hold.reveal_seconds + entry.hold.hold_seconds - 20) < 1e-6,
      'reveal + hold must be exactly the scene, or the clip drifts from the script')
  }
})

test('a short scene takes the pace band, which is how one image carries a longer window', () => {
  const short = [{ scene_id: 'scene-1', scene_index: 0, window_seconds: 4 }]
  const fast = resolveSceneReveals({ scenes: short, settings: { enabled: true, seed: 1, pace: 'fast' } })
  const slow = resolveSceneReveals({ scenes: short, settings: { enabled: true, seed: 1, pace: 'slow' } })
  // The band's floor is what a short scene is raised to: Fast's is below the window so it stays 4 s,
  // Slow's is above it so the scene becomes 9 s. That difference IS the image-count saving.
  assert.equal(fast.durations[0], Math.max(4, REVEAL_PACE_SETTINGS.fast.min_total_seconds))
  assert.equal(slow.durations[0], REVEAL_PACE_SETTINGS.slow.min_total_seconds)
  assert.ok(slow.durations[0]! > fast.durations[0]!,
    'a slower pace is what lets one image carry more of the episode')
})

test('the reveal for a scene is found by index, and a disabled plan finds nothing', () => {
  const plan = resolveSceneReveals({ scenes: scenes(3), settings: { enabled: true, seed: 2 } })
  assert.ok(plannedRevealForScene(plan, 0))
  assert.equal(plannedRevealForScene(plan, 99), undefined)
  assert.equal(plannedRevealForScene(undefined, 0), undefined)
  assert.equal(plannedRevealForScene({ ...plan, enabled: false }, 0), undefined)
  // The document is a real engine document, not a preset id hoping to resolve later.
  const document = plannedRevealForScene(plan, 0)!.document
  assert.deepEqual(document, normalizeSceneReveal(document))
})

// ── The Content Pack kind ────────────────────────────────────────────────

function revealPack(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    kind: 'reveal',
    id: 'com.example.wipe-pack.ocean-rows',
    name: 'Ocean rows',
    description: 'Rows arriving over a deep teal field.',
    category: 'geometric',
    reveal: { ...defaultSceneReveal(), family: 'geometric' },
    ...overrides,
  }
}

test('a reveal pack validates, and normalises through the engine\'s own reader', () => {
  const parsed = ContentPackDocumentSchema.safeParse(revealPack())
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues))
})

test('a reveal pack may not claim a built-in preset id', () => {
  const builtIn = BUILT_IN_SCENE_REVEALS[0]!
  const parsed = ContentPackDocumentSchema.safeParse(revealPack({ id: builtIn.id }))
  assert.equal(parsed.success, false)
  const message = parsed.success ? '' : parsed.error.issues.map(issue => issue.message).join(' ')
  assert.match(message, /built-in reveal/)
})

test('a pack whose category disagrees with its document family is refused', () => {
  const parsed = ContentPackDocumentSchema.safeParse(revealPack({
    category: 'draw-on',
    reveal: { ...defaultSceneReveal(), family: 'geometric' },
  }))
  assert.equal(parsed.success, false)
  const message = parsed.success ? '' : parsed.error.issues.map(issue => issue.message).join(' ')
  assert.match(message, /family/)
})

test('a reveal pack carries no engine field it does not own', () => {
  const parsed = ContentPackDocumentSchema.safeParse(revealPack({ filters: ['xfade=transition=wipeleft'] }))
  assert.equal(parsed.success, false,
    'a pack ships a description, never FFmpeg — an unknown top-level field must be refused')
})

// ── The render branch, through the assembly's own seam ───────────────────

test('a revealed still renders through the reveal engine, and a video scene does not', async () => {
  // The scene-clip path reaches the job store, and a test that writes the real store is refused
  // before it starts — so the fixture claims a temp data dir first, as every job-touching test does.
  const { useTempDataDir } = await import('./_helpers.js')
  const isolated = await useTempDataDir()
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { prepareSceneClips } = await import('../generators/video.js')
  const { tinyVideoBytes } = await import('./fixtures/tiny-video.js')

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-assembly-'))
  const imagePaths: string[] = []
  for (let index = 0; index < 3; index++) {
    const file = path.join(workDir, `still-${index}.png`)
    // A real one-pixel PNG: `prepareSceneClips` decodes every still before it encodes anything (a
    // truncated provider download with a valid header is the defect that preflight exists for), so
    // a fake header is refused before the reveal branch is ever reached.
    await fs.writeFile(file, ONE_PIXEL_PNG)
    imagePaths.push(file)
  }
  const clip = path.join(workDir, 'broll.mp4')
  await fs.writeFile(clip, tinyVideoBytes())

  const plan = resolveSceneReveals({
    scenes: [
      { scene_id: 'scene-1', scene_index: 0, window_seconds: 12, narration_seconds: 12 },
      { scene_id: 'scene-2', scene_index: 1, window_seconds: 12, narration_seconds: 12 },
      { scene_id: 'scene-3', scene_index: 2, window_seconds: 12, narration_seconds: 12 },
    ],
    settings: { enabled: true, seed: 8, pace: 'slow' },
  })

  const revealArgs: string[][] = []
  const sceneArgs: string[][] = []
  const job = {
    job_id: 'reveal-fixture', project_slug: 'demo', type: 'video_assembly', episode_id: 'EP001',
    title: 'reveal', status: 'running', created_at: new Date().toISOString(), started_at: null,
    finished_at: null, error: null, output_lines: [], params: {},
  } as any

  const clips: string[] = await prepareSceneClips(
    [
      { image_path: imagePaths[0], duration: 12 },
      { image_path: imagePaths[1], duration: 12 },
      // A video scene: it already moves, so the plan must not dress it in a wipe. Its window is
      // the fixture clip's real length, so the shipped path's own validation has something true to
      // check.
      { image_path: clip, duration: 1 },
    ] as any,
    { type: 'none', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 },
    { enabled: false } as any,
    128, 96,
    { crf: 23, preset: 'medium', fps: 5 },
    workDir,
    false,
    { seconds_per_scene: 12, shuffle: false, excluded_scenes: [] },
    job,
    { pool: [], randomizeMode: 'off', seed: 7, reveals: plan, crf: 23 },
    // The timeline's numbers: the plan's for the two revealed stills, and the footage clip's own
    // length for the scene the plan does not dress — which is what the assembly does with a video
    // scene whatever the pace says.
    [plan.durations[0]!, plan.durations[1]!, 1],
    0,
    [],
    {
      // The checkpoint is required by the signature; an empty one means nothing is reusable, which
      // is exactly the state this test wants — every scene renders.
      checkpoint: {
        version: 1,
        job_id: job.job_id,
        project_slug: job.project_slug,
        episode_id: job.episode_id,
        work_dir: workDir,
        render_fingerprint: 'a'.repeat(64),
        completed_scene_clips: [],
      },
      renderFingerprint: 'a'.repeat(64),
      runRevealClip: async (args: string[]) => {
        revealArgs.push(args)
        await fs.writeFile(args.at(-1)!, tinyVideoBytes())
      },
      encodeSceneClip: async (args: string[]) => {
        sceneArgs.push(args)
        await fs.writeFile(args.at(-1)!, tinyVideoBytes())
      },
    } as any,
  )

  assert.equal(revealArgs.length, 2, 'both stills are revealed')
  assert.equal(sceneArgs.length, 1, 'the footage scene keeps the shipped crop-fill path')
  assert.match(clips[0]!, /reveal_0000\.mp4$/)
  assert.match(clips[2]!, /scene_0002\.mp4$/)
  // The reveal clip is rendered for the scene's own length, which the timeline was given too.
  const durationArg = revealArgs[0]![revealArgs[0]!.indexOf('-t') + 1]
  assert.equal(Number(durationArg), plan.durations[0])
  assert.ok(job.output_lines.some((line: string) => /reveal reveal-/.test(line) && /hold/.test(line)),
    `the job log must name the reveal and its hold: ${job.output_lines.join(' | ')}`)

  await fs.rm(workDir, { recursive: true, force: true })
  await isolated.cleanup()
})

// ── Snapping: the hold can end where the narration line does ─────────────

test('a hold snaps to a narration line end that is nearly its own length', () => {
  // The scene's window runs 12.4 s; the line inside it ends at 12.1 s. Snapping is a tolerance,
  // not a magnet: 0.3 s away is the line's own rhythm, so the hold takes it.
  const plan = resolveSceneReveals({
    scenes: [{
      scene_id: 'scene-1',
      scene_index: 0,
      window_seconds: 12.4,
      narration_seconds: 12.4,
      snap: { narration_line_ends: [4.2, 8.1, 12.1] },
    }],
    settings: { enabled: true, seed: 4, pace: 'slow' },
  })
  const entry = plan.scenes[0]!
  assert.equal(entry.hold.snapped_to, 'narration-line')
  assert.equal(entry.hold.total_seconds, 12.1)
  assert.ok(Math.abs(entry.hold.reveal_seconds + entry.hold.hold_seconds - 12.1) < 1e-6,
    'reveal + hold must still be exactly the snapped scene')
  assert.equal(plan.durations[0], 12.1)
})

test('a beat is used when no line is near, and nothing is used when neither is', () => {
  const withBeat = resolveSceneReveals({
    scenes: [{
      // At Standard a 9.6 s window lands on the band's 9.0 s ceiling, and a beat 0.2 s away is
      // inside the snap tolerance while the line at 3.9 s is nowhere near it.
      scene_id: 'scene-1', scene_index: 0, window_seconds: 9.6,
      snap: { narration_line_ends: [3.9], beat_seconds: [9.2] },
    }],
    settings: { enabled: true, seed: 4, pace: 'standard' },
  })
  assert.equal(withBeat.scenes[0]!.hold.snapped_to, 'beat')
  assert.equal(withBeat.scenes[0]!.hold.total_seconds, 9.2)

  const nothingNear = resolveSceneReveals({
    scenes: [{
      scene_id: 'scene-1', scene_index: 0, window_seconds: 12.4,
      snap: { narration_line_ends: [1.0, 6.2], beat_seconds: [2.5] },
    }],
    settings: { enabled: true, seed: 4, pace: 'slow' },
  })
  assert.equal(nothingNear.scenes[0]!.hold.snapped_to, 'window',
    'a candidate 3 s away would stretch or crush the scene to hit it — that is the padding the pace exists to avoid')
})

test('snapping moves a hold by the tolerance at most, never to a line it is nowhere near', () => {
  // A short scene at Slow is raised to the band's floor — that is the image-carrying rule, and it
  // is deliberate. What a snap must never do is drag the hold somewhere else entirely: a candidate
  // 11 s past the pace's own choice is not "the line this scene ends on", it is a different moment.
  const plan = resolveSceneReveals({
    scenes: [{
      scene_id: 'scene-1', scene_index: 0, window_seconds: 6.2,
      snap: { narration_line_ends: [20] },
    }],
    settings: { enabled: true, seed: 4, pace: 'slow' },
  })
  const entry = plan.scenes[0]!
  assert.equal(entry.hold.snapped_to, 'window')
  assert.equal(entry.hold.total_seconds, REVEAL_PACE_SETTINGS.slow.min_total_seconds)
  assert.ok(entry.hold.total_seconds < 20 - 5, 'the far line must not have been used')
})

// ── The Image Pool: the pace decides how long one still stays ────────────

test('the pool stays on its own seconds_per_image until reveals are asked for', () => {
  assert.equal(revealSecondsForImage(undefined, 5), 5)
  assert.equal(revealSecondsForImage({ enabled: false }, 5), 5)
})

test('a pace turns one pool image into a longer stay, which is fewer images', () => {
  const fast = revealSecondsForImage({ enabled: true, pace: 'fast', seed: 1 }, 5)
  const slow = revealSecondsForImage({ enabled: true, pace: 'slow', seed: 1 }, 5)
  assert.ok(slow > 5, `Slow must hold a pool image longer than the pool setting, got ${slow}`)
  assert.ok(fast >= 5 && fast < slow, `Fast (${fast}) must not reach Slow (${slow})`)
  // The count that follows is arithmetic on the same number the pool builds its order from.
  assert.ok(Math.ceil(60 / slow) < Math.ceil(60 / 5),
    'a longer stay must need fewer images to cover the same narration')
})

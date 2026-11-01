import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { NATIVE_SCENE_CLIP_VERSION, SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS } from '../lib/native-scene-clip-version.js'
import {
  DEFAULT_SKETCH_REVEAL, parseSketchReveal, resetSketchRevealPlanCache, resolveSketchRevealPlan,
  sketchRevealChoice, sketchRevealFingerprint, sketchRevealForSingleScene, sketchRevealNeedsScenes,
  SKETCH_REVEAL_TYPES, type SketchRevealSetting, type SketchRevealType,
} from '../lib/sketch-reveal.js'
import { auditSceneClipCompletion, revealTypeFor, sceneClipStaleReason } from '../services/scene-media-checkpoint.js'
import { useTempDataDir } from './_helpers.js'
import type { SketchLineWeight } from '../lib/sketch-line-weight.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const SCENES = Array.from({ length: 12 }, (_, i) => `scene-${i + 1}`)

let dir: string
let cleanup: () => Promise<void>
before(async () => { const temp = await useTempDataDir(); dir = temp.dir; cleanup = temp.cleanup })
after(async () => { await cleanup() })

function settings(reveal: SketchRevealSetting | null, fps = 30, lineWeight: SketchLineWeight = 'normal') {
  return { fps, width: 1920, height: 1080, pen: { mode: 'none' as const }, penFingerprint: sha('none'),
    hold: { mode: 'auto' as const }, holdFingerprint: sha('auto'),
    reveal, revealFingerprint: sketchRevealFingerprint(reveal ?? DEFAULT_SKETCH_REVEAL), lineWeight }
}

function scene(over: Record<string, unknown> = {}) {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 4, transcript_segment: 'A',
    visual_prompt: 'A', approved: true, motion_prompt: 'slow push', motion_choice: 'clip' as const,
    clip_source_image_version: 'v1', clip_renderer: 'sketch_draw' as const,
    image_sha256: sha(PNG), clip_source_image_sha256: sha(PNG), clip_scene_window_seconds: 4,
    // 4 s at 30 fps under auto: half the scene (60 frames), since 2.5 s would overrun it.
    clip_sketch: { helper_version: NATIVE_SCENE_CLIP_VERSION, fps: 30, frames: 120, width: 1920, height: 1080,
      pen_fingerprint: sha('none'), hold_frames: 60, hold_fingerprint: sha('auto'), reveal_type: 'line' as SketchRevealType },
    ...over,
  }
}

async function image(bytes = PNG, name = 'scene.png') {
  const file = path.join(dir, name)
  await fs.writeFile(file, bytes)
  return file
}

function context(imagePath: string, sketchSettings = settings(null)) {
  return { slug: 'channel', episodeId: 'EP001', episodeDir: dir, imagePath, sketchSettings, revealScenes: SCENES }
}

describe('Sketch Draw reveal — parsing and identity', () => {
  test('a setting is a style, a mix set and optional pins; unknown keys are ignored', () => {
    assert.deepEqual(parseSketchReveal({ style: 'bloom', extra: 1 }), { ok: true, reveal: { style: 'bloom', mix: [] } })
    assert.deepEqual(parseSketchReveal({ style: 'mix', mix: ['line', 'buildup', 'swipes'] }),
      { ok: true, reveal: { style: 'mix', mix: ['line', 'buildup', 'swipes'] } })
    assert.deepEqual(parseSketchReveal({ style: 'line', mix: [], overrides: { 'scene-2': 'bloom' } }),
      { ok: true, reveal: { style: 'line', mix: [], overrides: { 'scene-2': 'bloom' } } })
  })

  test('a malformed setting is a plain sentence, never a silent default', () => {
    for (const value of [
      null, 'line', [], 3,
      { style: 'sparkle' }, { style: 'mix' }, { style: 'mix', mix: ['line'] },
      { style: 'mix', mix: ['line', 'line'] }, { style: 'mix', mix: ['line', 'nope'] },
      { style: 'mix', mix: ['line', 'buildup', 'swipes', 'patches', 'bloom', 'line'] },
      { style: 'line', mix: 'bloom' },
      { style: 'line', overrides: [] }, { style: 'line', overrides: { '': 'bloom' } },
      { style: 'line', overrides: { 'scene-1': 'sparkle' } },
    ]) {
      const parsed = parseSketchReveal(value)
      assert.equal(parsed.ok, false, `${JSON.stringify(value)} must not parse`)
      if (!parsed.ok) assert.match(parsed.error, /\S/, 'the refusal must say what to fix')
    }
  })

  test('absent means never chosen — which is not the same as the default style', () => {
    assert.equal(sketchRevealChoice(undefined), null)
    assert.equal(sketchRevealChoice(null), null)
    assert.deepEqual(sketchRevealChoice({ style: 'patches', mix: [] }), { style: 'patches', mix: [] })
    // A stored value that does not parse is an error to surface, never replaced by the default.
    assert.throws(() => sketchRevealChoice({ style: 'sparkle' }), /not valid/)
    assert.equal(DEFAULT_SKETCH_REVEAL.style, 'line')
  })

  test('the fingerprint follows the setting and not the key order of its pins', () => {
    const a = sketchRevealFingerprint({ style: 'mix', mix: ['line', 'bloom'], overrides: { 'scene-2': 'swipes', 'scene-1': 'line' } })
    const b = sketchRevealFingerprint({ style: 'mix', mix: ['line', 'bloom'], overrides: { 'scene-1': 'line', 'scene-2': 'swipes' } })
    const c = sketchRevealFingerprint({ style: 'mix', mix: ['bloom', 'line'], overrides: { 'scene-2': 'swipes', 'scene-1': 'line' } })
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.notEqual(sketchRevealFingerprint({ style: 'line', mix: [] }), sketchRevealFingerprint({ style: 'bloom', mix: [] }))
  })
})

describe('Sketch Draw reveal — the per-scene plan', () => {
  test('a single style gives every scene that style, and needs no scene order', () => {
    const reveal: SketchRevealSetting = { style: 'patches', mix: [] }
    assert.equal(sketchRevealNeedsScenes(reveal), false)
    const plan = resolveSketchRevealPlan('EP001', SCENES, reveal)
    for (const id of SCENES) assert.equal(plan.get(id), 'patches')
    assert.equal(sketchRevealForSingleScene(reveal, 'scene-7'), 'patches')
  })

  test('a Mix is deterministic, never repeats next door, and is a set — not per-scene results', () => {
    resetSketchRevealPlanCache()
    const reveal: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }
    const first = resolveSketchRevealPlan('EP001', SCENES, reveal)
    const again = resolveSketchRevealPlan('EP001', SCENES, reveal)
    const afterReset = (resetSketchRevealPlanCache(), resolveSketchRevealPlan('EP001', SCENES, reveal))
    for (const id of SCENES) {
      assert.equal(first.get(id), again.get(id), 'the memoised answer is the answer')
      assert.equal(first.get(id), afterReset.get(id), 'a re-render reproduces the same scene, not a fresh roll')
      assert.ok(SKETCH_REVEAL_TYPES.includes(first.get(id)!))
    }
    for (let i = 1; i < SCENES.length; i++) {
      assert.notEqual(first.get(SCENES[i]), first.get(SCENES[i - 1]), `${SCENES[i]} must not repeat its neighbour`)
    }
    // The set is what a setting carries; nothing anywhere stores which scene got what.
    assert.deepEqual(parseSketchReveal(reveal), { ok: true, reveal })
  })

  test('a two-type Mix alternates without repeating, and one type is a real answer, not a Mix', () => {
    const two = resolveSketchRevealPlan('EP002', SCENES, { style: 'mix', mix: ['line', 'bloom'] })
    for (let i = 1; i < SCENES.length; i++) assert.notEqual(two.get(SCENES[i]), two.get(SCENES[i - 1]))
    assert.equal(sketchRevealNeedsScenes({ style: 'mix', mix: ['line'] }), false)
    assert.equal(sketchRevealForSingleScene({ style: 'mix', mix: ['line'] }, 'scene-3'), 'line')
  })

  test('different episodes are different drawings, and the mix ORDER is part of the setting', () => {
    const reveal: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }
    const a = resolveSketchRevealPlan('EP001', SCENES, reveal)
    const b = resolveSketchRevealPlan('EP009', SCENES, reveal)
    const c = resolveSketchRevealPlan('EP001', SCENES, { style: 'mix', mix: ['buildup', 'line', 'swipes'] })
    assert.notDeepEqual([...a.values()], [...b.values()])
    assert.notDeepEqual([...a.values()], [...c.values()])
  })

  test('a pin wins over the Mix, is answered by the scene alone, and steers its neighbour', () => {
    const reveal: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'swipes'], overrides: { 'scene-3': 'bloom' } }
    const plan = resolveSketchRevealPlan('EP001', SCENES, reveal)
    assert.equal(plan.get('scene-3'), 'bloom')
    assert.equal(sketchRevealForSingleScene(reveal, 'scene-3'), 'bloom')
    // The pinned type is part of the key its neighbour avoids.
    for (let i = 1; i < SCENES.length; i++) assert.notEqual(plan.get(SCENES[i]), plan.get(SCENES[i - 1]))
    // A pin is a deliberate editorial choice: it stays valid after the Mix moves away from it.
    const moved = resolveSketchRevealPlan('EP001', SCENES, { style: 'mix', mix: ['patches', 'bloom'], overrides: { 'scene-3': 'swipes' } })
    assert.equal(moved.get('scene-3'), 'swipes')
  })
})

describe('Sketch Draw reveal — freshness', () => {
  test('a channel that has never chosen keeps every clip it has, recorded reveal or not', async () => {
    const file = await image()
    for (const reveal_type of [undefined, 'bloom' as SketchRevealType]) {
      const receipt = { ...scene().clip_sketch, reveal_type }
      const reason = await sceneClipStaleReason(scene({ clip_sketch: receipt }), context(file, settings(null)))
      assert.equal(reason, null, 'nothing was asked for, so nothing can be wrong')
    }
  })

  test('the recorded style is compared as the type this scene resolves to', async () => {
    const file = await image()
    const chosen = settings({ style: 'line', mix: [] })
    assert.equal(await sceneClipStaleReason(scene(), context(file, chosen)), null, 'line clip, line channel')
    const legacy = { clip_sketch: { ...scene().clip_sketch, reveal_type: undefined } }
    assert.equal(await sceneClipStaleReason(scene(legacy), context(file, chosen)), null, 'a pre-v4 clip is a line reveal')
    const legacyBloom = await sceneClipStaleReason(scene(legacy), context(file, settings({ style: 'bloom', mix: [] })))
    assert.equal(legacyBloom, 'stale reveal style (line → bloom)')
    const moved = await sceneClipStaleReason(scene({ clip_sketch: { ...scene().clip_sketch, reveal_type: 'bloom' } }), context(file, chosen))
    assert.equal(moved, 'stale reveal style (bloom → line)')
  })

  test('editing a Mix stales only the scenes whose type actually moved', async () => {
    const file = await image()
    const before: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }
    const after: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'patches'] }
    const was = resolveSketchRevealPlan('EP001', SCENES, before)
    const now = resolveSketchRevealPlan('EP001', SCENES, after)
    let moved = 0
    for (const id of SCENES) {
      const clip = scene({ id, clip_sketch: { ...scene().clip_sketch, reveal_type: was.get(id) } })
      const reason = await sceneClipStaleReason(clip, context(file, settings(after)))
      if (was.get(id) === now.get(id)) {
        assert.equal(reason, null, `${id} keeps ${was.get(id)} and must stay fresh`)
      } else {
        moved++
        assert.match(reason!, /^stale reveal style \(/)
      }
    }
    assert.ok(moved > 0, 'the replaced style really does move some scenes, or this proves nothing')
  })

  test('version-2 and version-3 clips are complete renders and must never go stale on the bump', async () => {
    const file = await image()
    for (const helper_version of SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS) {
      const receipt = { ...scene().clip_sketch, helper_version }
      // A pre-reveal clip: no reveal_type, and the channel has recorded no style either.
      const legacy = { ...receipt, reveal_type: undefined }
      assert.equal(await sceneClipStaleReason(scene({ clip_sketch: legacy }), context(file, settings(null))), null,
        `helper ${helper_version} stays fresh while the channel has chosen nothing`)
    }
    [2, 3, 4, 5, 6, 7]
    assert.ok(SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS.includes(NATIVE_SCENE_CLIP_VERSION))
    assert.match((await sceneClipStaleReason(scene({ clip_sketch: { ...scene().clip_sketch, helper_version: 1 } }), context(file, settings(null))))!, /renderer/)
  })

  test('a Mix with no scene order to resolve against says so instead of guessing', async () => {
    const file = await image()
    const mix: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup'] }
    const chosen = settings(mix)
    const wanted = resolveSketchRevealPlan('EP001', SCENES, mix).get('scene-1')!
    const clip = scene({ clip_sketch: { ...scene().clip_sketch, reveal_type: wanted } })
    const withoutScenes = { slug: 'channel', episodeId: 'EP001', episodeDir: dir, imagePath: file, sketchSettings: chosen }
    assert.equal(await sceneClipStaleReason(clip, withoutScenes),
      'Sketch Draw cannot check its reveal style here. Open Motion Review and Retry.')
    // With the order supplied, the same clip is judged normally.
    assert.equal(await sceneClipStaleReason(clip, context(file, chosen)), null)
  })

  test('the resolver the generator, freshness and Motion Review share answers the same for one scene', () => {
    const reveal: SketchRevealSetting = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }
    const plan = resolveSketchRevealPlan('EP001', SCENES, reveal)
    const ctx = { slug: 'channel', episodeId: 'EP001', episodeDir: dir, revealScenes: SCENES }
    for (const id of SCENES) assert.equal(revealTypeFor(reveal, ctx, id), plan.get(id))
    // A single style needs no scene order at all.
    assert.equal(revealTypeFor({ style: 'bloom', mix: [] }, { slug: 'channel', episodeId: 'EP001', episodeDir: dir }, 'scene-4'), 'bloom')
  })
})

describe('Sketch Draw reveal — completion is unchanged', () => {
  test('a disagreement about the reveal is an invalid clip by name, never a missing one', async () => {
    const clip = path.join(dir, 'scene-1.mp4')
    await fs.writeFile(clip, Buffer.alloc(2048, 7))
    const planPath = path.join(dir, 'scene_plan.json')
    const chosen = settings({ style: 'line', mix: [] })
    const plan = (reveal_type: SketchRevealType) => ({
      scenes: [{ ...scene({ clip_path: clip }), clip_sketch: { ...scene().clip_sketch, reveal_type } }],
    })
    const auditContext = { slug: 'channel', episodeId: 'EP001', episodeDir: dir, sketchSettings: chosen, revealScenes: ['scene-1'] }
    await fs.writeFile(planPath, JSON.stringify(plan('bloom')))
    const stale = await auditSceneClipCompletion(planPath, ['scene-1'], dir, {}, auditContext)
    assert.equal(stale.expected, 1)
    assert.equal(stale.completed, 0)
    assert.deepEqual(stale.missing, [], 'a clip whose style moved is present but not usable')
    assert.deepEqual(stale.issues, [{ item_id: 'scene-1', state: 'invalid', reason: 'stale reveal style (bloom → line)' }])
  })

  test('a scene id that is not in the plan and one deliberately kept Still still account the same', async () => {
    const planPath = path.join(dir, 'scene_plan.json')
    await fs.writeFile(planPath, JSON.stringify({ scenes: [scene({ id: 'scene-1', motion_choice: 'still' })] }))
    const ctx = { slug: 'channel', episodeId: 'EP001', episodeDir: dir, sketchSettings: settings({ style: 'line', mix: [] }), revealScenes: ['scene-1'] }
    const still = await auditSceneClipCompletion(planPath, ['scene-1'], dir, {}, ctx)
    assert.deepEqual(still, { expected: 1, completed: 1, missing: [], invalid: [], issues: [] })
    const gone = await auditSceneClipCompletion(planPath, ['scene-9'], dir, {}, ctx)
    assert.equal(gone.expected, 1)
    assert.equal(gone.completed, 0)
    assert.deepEqual(gone.invalid, ['scene-9 (missing from scene plan)'])
  })
})

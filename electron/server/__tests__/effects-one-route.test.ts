/**
 * 1.4.282 — Effects & Overlay, one route.
 *
 * - A classic Vignette / Film Grain / Letterbox checkbox migrated into the
 *   Effect Library reaches the renderer as EXACTLY the fields it did before,
 *   on the page path and the batch path, so the filtergraph — and every
 *   pixel — is unchanged.
 * - Misplaced entries (a built-in in the overlay-file list, a pasted catalogue
 *   document, a missing `enabled`) are placed or named, never silently dropped.
 * - An empty `effects_last_preset` is answered, not guessed: the preflight says
 *   what a batch bakes in and where it comes from.
 * - Letterbox keeps the whole picture by default (measured on real pixels).
 * - Twinkling Stars visibly twinkle at their new defaults.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, describe, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { describeEffectStack, duplicatePresetHints, normalizeEffectsLook } from '../contracts/effects-look.js'
import { BUILT_IN_SCENE_MOTIONS, MOTION_FAMILIES, findBuiltInOverlay, findSceneMotion, isHiddenMotion, motionPoolSlots, sceneEffectCatalog } from '../contracts/scene-effect-presets.js'
import { resolveSceneMotionDocument } from '../lib/animation-filters.js'
import { mulberry32 } from '../lib/seeded-random.js'
import { atmosphereLoopShape, normalizeSceneOverlay } from '../contracts/scene-effects.js'
import { createLoopRenderer, loopParticleCount } from '../contracts/effect-loops.js'
import { compileSceneOverlay } from '../lib/scene-effect-compiler.js'
import { createVideoAssemblyExecutionRequest, resolveVideoAssemblySceneAnimation } from '../generators/video.js'
import { flattenVideoAssemblyBundle, videoEffectsAnswer } from '../routes/pipeline.js'

const execFileAsync = promisify(execFile)

/** The fields the final composition reads for these effects — equal fields, equal filtergraph. */
function renderInputs(params: Record<string, any>) {
  const req = createVideoAssemblyExecutionRequest(params as any) as any
  return {
    // The generator reads an absent strength as 0.7 (vignette) and 15 (grain).
    vignette: req.vignette?.enabled ? { ...req.vignette, strength: req.vignette.strength ?? 0.7 } : undefined,
    film_grain: req.film_grain?.enabled ? { ...req.film_grain, strength: req.film_grain.strength ?? 15 } : undefined,
    // The generator reads an absent mode as `fit`.
    letterbox: req.letterbox?.enabled ? { ...req.letterbox, mode: req.letterbox.mode ?? 'fit' } : undefined,
    scene_effects: req.scene_effects,
    aged_archive_film: req.aged_archive_film,
    frame: req.frame,
  }
}

/** What the page sends for an Effects slot (useVideoAssemblyIo.buildPayload, the effect part). */
function pagePayload(slot: Record<string, any>) {
  const out: Record<string, any> = { episode_id: 'E1' }
  for (const key of ['vignette', 'film_grain', 'letterbox', 'aged_archive_film', 'frame'] as const) {
    if (slot[key]?.enabled) out[key] = { ...slot[key] }
  }
  const chosen = (slot.scene_effects?.overlays || []).filter((o: any) => o.enabled)
  if (slot.scene_effects?.enabled && chosen.length) {
    out.scene_effects = { enabled: true, overlays: chosen.map((o: any) => ({ id: o.id, enabled: true, params: { ...(o.params || {}) }, ...(o.legacy_slot ? { legacy_slot: o.legacy_slot } : {}) })) }
  }
  return out
}

const LEGACY_LOOKS: Array<Record<string, any>> = [
  { vignette: { enabled: true, strength: 0.15 } },
  { vignette: { enabled: true } },
  { vignette: { enabled: true, strength: 0 }, film_grain: { enabled: true, strength: 50 } },
  { film_grain: { enabled: true, strength: 15 } },
  { letterbox: { enabled: true, ratio: '2.00:1', color: '#1a1a2e' } },
  { letterbox: { enabled: true, ratio: '1.85:1', color: 'black' } },
  // TerraNash's active look on the mini: vignette with the aged-film treatment.
  { vignette: { enabled: true, strength: 1 }, aged_archive_film: { enabled: true, strength: 45 } },
  // Classic checkbox plus a library effect and a frame; the section was off with a stale pick.
  {
    vignette: { enabled: true, strength: 0.6 }, frame: { enabled: true, inset_pct: 4 },
    scene_effects: { enabled: false, overlays: [{ id: 'rain', enabled: true, params: {} }] },
  },
  {
    film_grain: { enabled: true, strength: 20 },
    scene_effects: { enabled: true, overlays: [{ id: 'vignette-heavy', enabled: true, params: {} }, { id: 'scrim-bottom', enabled: false, params: {} }] },
  },
]

describe('classic checkboxes migrate to the Effect Library without changing a pixel', () => {
  for (const legacy of LEGACY_LOOKS) {
    test(`page and batch render the same inputs: ${JSON.stringify(legacy)}`, () => {
      const { look: migrated } = normalizeEffectsLook(legacy, { migrateLegacy: true }) as { look: any }
      // One home: no classic checkbox is left on.
      for (const key of ['vignette', 'film_grain', 'letterbox']) assert.ok(!migrated[key]?.enabled, key)

      // Page path.
      assert.deepEqual(renderInputs(pagePayload(migrated)), renderInputs(pagePayload(legacy)))
      // Batch path: the Video Assembly preset's saved Effects copy, flattened.
      const flat = (effects: any) => flattenVideoAssemblyBundle({ fallback: { effects } }, 'E1', 'T')
      assert.deepEqual(renderInputs(flat(migrated)), renderInputs(flat(legacy)))
      // And the answer reads the same either way.
      assert.deepEqual(describeEffectStack(flat(migrated)), describeEffectStack(flat(legacy)))
    })
  }

  test('a migrated entry is the library effect it looks like, with the value in its terms', () => {
    const { look } = normalizeEffectsLook({ vignette: { enabled: true, strength: 0.15 }, letterbox: { enabled: true, ratio: '1.85:1', color: 'black' } }, { migrateLegacy: true }) as { look: any }
    assert.deepEqual(look.scene_effects.overlays.map((o: any) => [o.id, o.legacy_slot, o.params]), [
      ['vignette-soft', 'vignette', { intensity: 0.15 }],
      ['letterbox-185', 'letterbox', { ratio: '1.85:1', color: 'black', mode: 'fit' }],
    ])
    // The library and the classic field draw the same vignette filter anyway.
    const doc = normalizeSceneOverlay({ ...findBuiltInOverlay('vignette-soft')!.document, intensity: 0.15 })
    let n = 0
    assert.match(compileSceneOverlay(doc, { input: '[a]', output: '[b]', allocLabel: () => `[x${n++}]`, w: 1920, h: 1080, duration: 10 })![0]!, /vignette=angle=/)
  })

  test('a look that needs nothing is returned unchanged', () => {
    const look = { color_grading: { enabled: true, preset: 'warm' }, scene_effects: { enabled: true, overlays: [{ id: 'rain', enabled: true, params: {} }] } }
    assert.deepEqual(normalizeEffectsLook(look, { migrateLegacy: true }).look, look)
    assert.deepEqual(normalizeEffectsLook({ vignette: { enabled: false, strength: 1 } }, { migrateLegacy: true }).look, { vignette: { enabled: false, strength: 1 } })
  })
})

describe('nothing is dropped silently', () => {
  test('a built-in effect in the overlay-file list moves to the built-in effects', () => {
    const { look, notes } = normalizeEffectsLook({
      overlays: { enabled: true, layers: [{ id: 'film-grain-fine', enabled: true }, { source_path: '/x/fire.mov' }] },
    }) as { look: any; notes: string[] }
    assert.deepEqual(look.overlays.layers, [{ source_path: '/x/fire.mov', enabled: true }])
    assert.deepEqual(look.scene_effects, { enabled: true, overlays: [{ id: 'film-grain-fine', enabled: true, params: {} }] })
    assert.ok(notes.some(n => /moved to the built-in effects/.test(n)))
    assert.ok(notes.some(n => /fire\.mov had no "enabled" flag/.test(n)))
  })

  test('pasted catalogue documents become references (what Story Sprout and Dozing Knight hold today)', () => {
    const layers = [
      { schema_version: 1, timing: { start_sec: 0, end_sec: null, fade_in_sec: 0, fade_out_sec: 0 }, kind: 'film-grain', amount: 12, temporal: true, uniform: true },
      { schema_version: 1, kind: 'atmosphere-loop', variant: 'dust', amount: 35 },
    ]
    const flat = flattenVideoAssemblyBundle({ fallback: { effects: { overlays: { enabled: true, layers } } } }, 'E1', 'T') as any
    assert.deepEqual(flat.scene_effects.overlays.map((o: any) => o.id).sort(), ['dust-motes', 'film-grain-fine'])
    assert.deepEqual(describeEffectStack(flat).sort(), ['Effect: Dust Motes / Pollen (moving loop, slower render)', 'Effect: Fine Film Grain'])
  })

  test('a built-in reference without "enabled" counts as on, an unknown id is named', () => {
    const { look, notes } = normalizeEffectsLook({ scene_effects: { enabled: true, overlays: [{ id: 'snow' }, { id: 'no-such-effect', enabled: true }] } }) as { look: any; notes: string[] }
    assert.equal(look.scene_effects.overlays[0].enabled, true)
    assert.ok(notes.some(n => /"no-such-effect" is not a built-in effect/.test(n)))
    assert.ok(describeEffectStack(look).includes('Effect: no-such-effect (unknown, skipped)'))
  })
})

describe('duplicate presets are flagged, never deleted', () => {
  test('same settings, and the same name give or take a plural', () => {
    const data = { color_grading: { enabled: true, preset: 'lavender-mist' } }
    const hints = duplicatePresetHints([
      { id: 'a', name: 'DK - Effects & Overlays', data },
      { id: 'b', name: 'DK - Effects & Overlays', data: { color_grading: { preset: 'lavender-mist', enabled: true } } },
      { id: 'c', name: 'Story Sprout - Effects & Overlay', data: { x: 1 } },
      { id: 'd', name: 'Story Sprout - Effects & Overlays', data: { x: 2 } },
      { id: 'e', name: 'Unique', data: { x: 3 } },
    ])
    assert.equal(hints.length, 2)
    assert.match(hints[0]!, /"DK - Effects & Overlays", "DK - Effects & Overlays" have identical settings.*nothing is deleted automatically/)
    assert.match(hints[1]!, /"Story Sprout - Effects & Overlay", "Story Sprout - Effects & Overlays" have nearly the same name/)
  })
})

describe('the resolved effect stack, and what an empty pointer means', () => {
  const storySproutBefore = {
    effects_last_preset: '',
    effects_presets: [
      { id: 'p1', name: 'Story Sprout - Effects & Overlay', data: { color_grading: { enabled: true, preset: 'lavender-mist' } } },
      { id: 'p2', name: 'Story Sprout - Effects & Overlays', data: { color_grading: { enabled: true, preset: 'lavender-mist' } } },
    ],
  }
  const bundle = (effectsPresetId: string) => ({
    id: 'va', name: 'Story Sprout - Video Assembly',
    data: {
      effects_preset_id: effectsPresetId,
      fallback: { effects: {
        logo: { enabled: true, image_path: '/a/logo.png', position: 'top-right', opacity: 50, scale: 12 },
        color_grading: { enabled: true, preset: 'forest-canopy' },
        vignette: { enabled: true, strength: 0.15 },
      } },
    },
  })

  test('effects_last_preset "" does not mean "no effects": the bundle copy renders, and the answer says so', () => {
    const answer = videoEffectsAnswer(storySproutBefore, bundle(''))!
    assert.match(answer.source, /"Story Sprout - Video Assembly": the Effects copy saved inside it/)
    assert.deepEqual(answer.effects, ['Colour grade: forest-canopy', 'Vignette (strength 0.15)', 'Logo: top-right, 50% opacity'])
    assert.ok(answer.notes.some(n => /names no Effects preset/.test(n)))
    assert.ok(answer.notes.some(n => /effects_last_preset is empty\). That never switches effects off/.test(n)))
    assert.ok(answer.notes.some(n => /nearly the same name|identical settings/.test(n)))
  })

  test('a bundle naming an Effects preset that has drifted from its copy is flagged, and the copy still renders', () => {
    const answer = videoEffectsAnswer(storySproutBefore, bundle('p2'))!
    assert.ok(answer.effects.includes('Colour grade: forest-canopy'))
    const drift = answer.notes.find(n => /differs from "Story Sprout - Effects & Overlays" now/.test(n))
    assert.ok(drift, answer.notes.join('\n'))
    assert.match(drift!, /only in "Story Sprout - Effects & Overlays": Colour grade: lavender-mist/)
  })
})

describe('preflight answers with the resolved stack', () => {
  let cleanup: () => Promise<void>
  let app: any
  before(async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
    ;({ app } = await import('../app.js'))
  })
  after(async () => { await cleanup() })

  test('POST /pipeline/preflight carries video_effects', async () => {
    const pm = await import('../services/project-manager.js')
    const im = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const project = await pm.createProject({ name: 'Effects answer' })
    await pm.updateConfig(project.slug, {
      effects_last_preset: '',
      video_bundle_presets: [{ id: 'va', name: 'Assembly', data: { fallback: { effects: {
        vignette: { enabled: true, strength: 0.3 },
        scene_effects: { enabled: true, overlays: [{ id: 'twinkling-stars', enabled: true, params: {} }] },
      } } } }],
      video_bundle_last_preset: 'va',
    } as any)
    const [idea] = await im.addIdeas(project.slug, [{ title: 'One', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test-model')
    await im.acceptIdea(project.slug, idea!.id)
    const episodeId = (await im.getIdeas(project.slug, 'accepted'))[0]!.episode_code!
    await fs.mkdir((await resolveEpisodePathsByCode(project.slug, episodeId)).episode_dir, { recursive: true })
    await im.setEpisodeStatusOverrides(project.slug, episodeId, { script: true, merged_audio: true, subtitles: true, scene_plan: true, scene_review: true, video_assembly: true })
    const res = await request(app).post(`/api/projects/${project.slug}/pipeline/preflight`).send({ episode_ids: [episodeId], steps: ['video_assembly'] })
    assert.ok(res.body.video_effects, JSON.stringify(res.body))
    assert.deepEqual(res.body.video_effects.effects, ['Vignette (strength 0.3)', 'Effect: Twinkling Stars (moving loop, slower render)'])
    assert.ok(res.body.video_effects.notes.some((n: string) => /never switches effects off/.test(n)))

    // The menus: families with their strengths, no rotation, no parallax-drift.
    for (const url of ['animations/catalog', 'effects/catalog']) {
      const cat = await request(app).get(`/api/projects/${project.slug}/video-editor/${url}`)
      const ids = (cat.body.animations || cat.body.scene_motions).map((m: any) => m.id)
      assert.ok(ids.includes('ken-burns') && !ids.includes('parallax-drift') && !ids.includes('rotate-cw'), url)
      assert.deepEqual((cat.body.families || cat.body.motion_families).map((f: any) => f.name), ['Zoom in', 'Zoom out', 'Breathe'], url)
    }
  })
})

// ── Real pixels ─────────────────────────────────────────────────────────────

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const ffmpeg = [path.join(repoRoot, 'bundled', 'ffmpeg', 'ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => existsSync(p))

describe('letterbox keeps the whole picture', { skip: !ffmpeg && 'no FFmpeg' }, () => {
  const W = 320, H = 180
  /** A test card: red top edge, blue bottom, green left, yellow right, grey middle. Returns RGB24 of one frame. */
  async function render(mode: 'fit' | 'cover', windowed = false): Promise<Buffer> {
    const doc = normalizeSceneOverlay({ kind: 'letterbox', ratio: '2.35:1', color: 'black', mode, ...(windowed ? { timing: { start_sec: 0, end_sec: 5 } } : {}) })
    let n = 0
    const statements = compileSceneOverlay(doc, { input: '[card]', output: '[out]', allocLabel: () => `[l${n++}]`, w: W, h: H, duration: 5 })!
    const card = `color=c=gray:s=${W}x${H}:d=1,format=rgb24,`
      + `drawbox=x=0:y=0:w=iw:h=8:color=red:t=fill,drawbox=x=0:y=ih-8:w=iw:h=8:color=blue:t=fill,`
      + `drawbox=x=0:y=0:w=8:h=ih:color=green:t=fill,drawbox=x=iw-8:y=0:w=8:h=ih:color=yellow:t=fill[card]`
    const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'letterbox-'))
    const out = path.join(dir, 'frame.rgb')
    await execFileAsync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc', '-filter_complex', `${card};${statements.join(';')}`,
      '-map', '[out]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', out])
    return fs.readFile(out)
  }
  const at = (buf: Buffer, x: number, y: number) => { const i = (y * W + x) * 3; return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const }
  const isRed = ([r, g, b]: readonly number[]) => r > 150 && g < 90 && b < 90
  const isBlue = ([r, g, b]: readonly number[]) => b > 150 && r < 90 && g < 90
  const isGreen = ([r, g, b]: readonly number[]) => g > 90 && r < 90 && b < 90
  const isYellow = ([r, g, b]: readonly number[]) => r > 150 && g > 150 && b < 90
  const isBlack = ([r, g, b]: readonly number[]) => r < 20 && g < 20 && b < 20

  for (const windowed of [false, true]) {
    test(`fit: every edge of the source survives inside the bars${windowed ? ' (timed window)' : ''}`, async () => {
      const f = await render('fit', windowed)
      // 2.35:1 at 320×180: bars of 22, a 136-high band, the picture 240 wide (side bars of 40).
      assert.ok(isBlack(at(f, 160, 5)) && isBlack(at(f, 160, 175)), 'bars top and bottom')
      assert.ok(isBlack(at(f, 10, 90)) && isBlack(at(f, 310, 90)), 'side bars: the picture keeps its ratio')
      assert.ok(isRed(at(f, 160, 24)), `top edge visible: ${at(f, 160, 24)}`)
      assert.ok(isBlue(at(f, 160, 155)), `bottom edge visible: ${at(f, 160, 155)}`)
      assert.ok(isGreen(at(f, 43, 90)), `left edge visible: ${at(f, 43, 90)}`)
      assert.ok(isYellow(at(f, 276, 90)), `right edge visible: ${at(f, 276, 90)}`)
      assert.equal(f.length, W * H * 3, 'the output size never changes')
    })
  }

  test('cover (Cinematic crop) hides the top and bottom edges, as before', async () => {
    const f = await render('cover')
    assert.ok(isBlack(at(f, 160, 4)) && isBlack(at(f, 160, 176)))
    assert.ok(!isRed(at(f, 160, 24)) && !isBlue(at(f, 160, 155)))
  })
})

describe('Twinkling Stars twinkle visibly at their defaults', () => {
  /** Over one loop, how far each lit star pixel's brightness swings (0..255): count and median. */
  function twinkle(shape: ReturnType<typeof atmosphereLoopShape>) {
    const W = 960, H = 540, N = 24
    const renderer = createLoopRenderer(shape, W, H, N)
    const hi = new Uint8Array(W * H), lo = new Uint8Array(W * H).fill(255)
    const f = new Uint8Array(W * H)
    for (let i = 0; i < N; i++) {
      renderer.draw(i, f)
      for (let p = 0; p < f.length; p++) { if (f[p]! > hi[p]!) hi[p] = f[p]!; if (f[p]! < lo[p]!) lo[p] = f[p]! }
    }
    const swings: number[] = []
    for (let p = 0; p < hi.length; p++) if (hi[p]! >= 120) swings.push(hi[p]! - lo[p]!)
    swings.sort((a, b) => a - b)
    return { lit: swings.length, median: swings[swings.length >> 1] ?? 0 }
  }

  test('a few large stars whose brightness swings by a clear amount over the loop', () => {
    const shape = atmosphereLoopShape(findBuiltInOverlay('twinkling-stars')!.document as any)
    assert.ok(loopParticleCount(shape) <= 150, `a few stars, not ${loopParticleCount(shape)}`)
    const now = twinkle(shape)
    const before = twinkle({ ...shape, amount: 30, size: 1, twinkle: 0.5, speed: 1 })
    assert.ok(now.lit > 50, 'stars are bright enough to see')
    assert.ok(now.median >= 100, `median twinkle swing ${now.median}/255 must be clearly visible`)
    assert.ok(now.median >= before.median * 1.5, `now ${now.median} vs the old defaults ${before.median}`)
  })

  test('the drawing maths did not change: a saved value renders as before', () => {
    // 900 stars at the old amount 30 — the same count every earlier release drew.
    assert.equal(loopParticleCount({ ...atmosphereLoopShape(findBuiltInOverlay('twinkling-stars')!.document as any), amount: 30 }), 900)
  })
})

// ── Camera motion families (owner-approved) ─────────────────────────────────


describe('camera motion families trim the menu and delete nothing', () => {
  // What the page sends with every render (its defaults).
  const pageParams = { type: 'ken-burns', zoom_start: 100, zoom_end: 108, parallax_direction: 'right' as const, parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 }

  test('every old id still resolves to exactly its own camera move', () => {
    const zoom = (id: string) => findSceneMotion(id)!.document.zoom
    assert.deepEqual([zoom('slow-push').from_pct, zoom('slow-push').to_pct], [100, 106])
    assert.deepEqual([zoom('ken-burns').from_pct, zoom('ken-burns').to_pct], [100, 108])
    assert.deepEqual([zoom('zoom-in').from_pct, zoom('zoom-in').to_pct], [100, 112])
    assert.deepEqual([zoom('slow-pull').from_pct, zoom('slow-pull').to_pct], [106, 100])
    assert.deepEqual([zoom('ken-burns-reverse').from_pct, zoom('ken-burns-reverse').to_pct], [108, 100])
    assert.deepEqual([zoom('zoom-out').from_pct, zoom('zoom-out').to_pct], [112, 100])
    assert.deepEqual([zoom('breathe').base_pct, zoom('breathe').amplitude_pct], [103, 2])
    assert.deepEqual([zoom('pulse').base_pct, zoom('pulse').amplitude_pct], [105, 4])
    // Parallax Drift is Pan Right's twin, and still renders (honouring an old direction).
    assert.deepEqual(resolveSceneMotionDocument({ type: 'parallax-drift', params: pageParams }), resolveSceneMotionDocument({ type: 'pan-right', params: pageParams }))
    assert.equal(resolveSceneMotionDocument({ type: 'parallax-drift', params: { ...pageParams, parallax_direction: 'left' } }).pan.x, -2)
    // Each old id resolves to the registry document it always did, through the same path the render uses.
    for (const id of ['ken-burns', 'ken-burns-reverse', 'zoom-in', 'zoom-out', 'slow-push', 'slow-pull', 'breathe', 'pulse', 'parallax-drift', 'fade-in', 'fade-out']) {
      assert.ok(findSceneMotion(id), id)
      assert.notEqual(resolveSceneMotionDocument({ type: id, params: pageParams }), undefined)
    }
  })

  test('families name every strength, and the menu hides only parallax-drift and rotation', () => {
    assert.deepEqual(MOTION_FAMILIES.map(f => [f.name, f.members.map(m => `${m.strength}:${m.id}`)]), [
      ['Zoom in', ['gentle:slow-push', 'normal:ken-burns', 'strong:zoom-in']],
      ['Zoom out', ['gentle:slow-pull', 'normal:ken-burns-reverse', 'strong:zoom-out']],
      ['Breathe', ['gentle:breathe', 'strong:pulse']],
    ])
    // The library keeps every motion (old choices must render); the menus filter.
    assert.equal(sceneEffectCatalog().scene_motions.length, BUILT_IN_SCENE_MOTIONS.length)
    assert.deepEqual(sceneEffectCatalog().motion_families, MOTION_FAMILIES)
    const offered = BUILT_IN_SCENE_MOTIONS.filter(m => !isHiddenMotion(m)).map(m => m.id)
    assert.ok(!offered.includes('parallax-drift') && !offered.includes('rotate-cw') && !offered.includes('rotate-ccw'))
    assert.equal(offered.length, BUILT_IN_SCENE_MOTIONS.length - 3)
    assert.deepEqual(BUILT_IN_SCENE_MOTIONS.filter(m => m.category === 'fade').map(m => m.id), ['fade-in', 'fade-out'])
  })

  test('a family is one pick in a random pool, and other pools draw exactly as before', () => {
    const picks = (pool: string[], n = 4000) => resolveVideoAssemblySceneAnimation({
      scene_animation: pageParams, animation_pool: pool, animation_randomize: 'per-scene', animation_seed: 11,
    } as any, n).picks
    // Before: 3 of 4 picks were a zoom-in strength. Now the family and Pan Left share evenly.
    const mixed = picks(['ken-burns', 'zoom-in', 'slow-push', 'pan-left'])
    const zoomShare = mixed.filter(id => id !== 'pan-left').length / mixed.length
    assert.ok(zoomShare > 0.45 && zoomShare < 0.55, `zoom-in family share ${zoomShare}`)
    for (const id of ['ken-burns', 'zoom-in', 'slow-push']) assert.ok(mixed.includes(id), `${id} still picked`)
    // No two strengths of one family: the same sequence as the plain draw.
    const plainPool = ['ken-burns', 'pan-left', 'breathe', 'zoom-out']
    const rnd = mulberry32(11)
    const before = Array.from({ length: 200 }, () => plainPool[Math.floor(rnd() * plainPool.length)])
    assert.deepEqual(picks(plainPool, 200), before)
    assert.deepEqual(motionPoolSlots(['zoom-in', 'pan-left', 'ken-burns', 'pulse']), [['zoom-in', 'ken-burns'], ['pan-left'], ['pulse']])
  })
})

/**
 * The Effects Library page (music format phase 3), from the browser's side.
 *
 * The stack panel must show exactly what the render will draw, in the order it
 * will draw it — so the page's ordering is checked against the render's own
 * resolver on the same file, not against a second copy of the rule.
 *
 * What these cannot catch: layout and the canvas pixels. The 1280/1920 renders
 * in the build report are the visual check; the backend render test proves the
 * shared particle program bakes what the canvas draws.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const lib = await import('../utils/effects-library.js')
const { gradeCssFilter, NOT_DRAWN_LIVE } = await import('../utils/effect-preview-canvas.js')
const { BUILT_IN_OVERLAYS } = await import('../../electron/server/contracts/scene-effect-presets.js')
const { resolveEpisodeEffectStack, normalizeEpisodeEffects } = await import('../../electron/server/services/episode-effects.js')
const { mergeSceneOverlay } = await import('../../electron/server/contracts/scene-effects.js')

const library = BUILT_IN_OVERLAYS as any[]
const scenes = [
  { id: 's1', scene_index: 1, start_sec: 0, end_sec: 60, has_image: true, theme: 'rainy', label: 'Porch' },
  { id: 's2', scene_index: 2, start_sec: 60, end_sec: 120, has_image: true, theme: null, label: 'Kitchen' },
]

function sampleFile() {
  return {
    ...lib.emptyEffectsFile(),
    episode: [{ uid: 'v', id: 'vignette-soft', enabled: true }, { uid: 'g', id: 'colour-grade-look', enabled: true }],
    themes: [{ theme: 'rainy', effects: [{ uid: 'r', id: 'rain', enabled: true }] }],
    scenes: [{ scene_id: 's1', effects: [{ uid: 'f', id: 'fireflies', enabled: true }, { uid: 'm', id: 'ground-mist', enabled: true }] }],
  }
}

describe('the stack panel shows the render order', () => {
  test('for a scene, the page lists the same effects in the same order the render resolves', () => {
    for (const custom of [false, true]) {
      const file = { ...sampleFile(), custom_order: custom }
      const page = lib.stackRowsForTarget(file as any, { kind: 'scene', id: 's1' }, scenes, library).map(r => r.applied.uid)
      const render = resolveEpisodeEffectStack({
        file: normalizeEpisodeEffects(file),
        library: library as any,
        windows: scenes.map(s => ({ scene_id: s.id, start_sec: s.start_sec, end_sec: s.end_sec, theme: s.theme })),
        duration: 120,
      }).entries.filter(e => e.scope !== 'scene' || e.scope_label === 's1').map(e => e.uid)
      assert.deepEqual(page, render, custom ? 'custom order' : 'layer groups')
    }
  })

  test('a scene without the theme does not show the theme\'s effects', () => {
    const rows = lib.stackRowsForTarget(sampleFile() as any, { kind: 'scene', id: 's2' }, scenes, library)
    assert.deepEqual(rows.map(r => r.applied.uid).sort(), ['g', 'v'])
  })

  test('in layer groups an effect cannot be dragged into another group, and the page says why', () => {
    const file = sampleFile()
    const rows = lib.stackRowsForTarget(file as any, { kind: 'scene', id: 's1' }, scenes, library)
    const rain = rows.find(r => r.applied.uid === 'r')!
    const vignette = rows.find(r => r.applied.uid === 'v')!
    const note = lib.moveRow(rows, rain, vignette, false)
    assert.match(note!, /Turn on Custom order/)
    assert.equal(rain.applied.order, undefined)
  })

  test('in custom order a drop places the effect between its new neighbours', () => {
    const file = { ...sampleFile(), custom_order: true }
    const rows = lib.stackRowsForTarget(file as any, { kind: 'scene', id: 's1' }, scenes, library)
    const fireflies = rows.find(r => r.applied.uid === 'f')!
    assert.equal(lib.moveRow(rows, fireflies, rows[0]!, true), null)
    const after = lib.stackRowsForTarget(file as any, { kind: 'scene', id: 's1' }, scenes, library)
    assert.equal(after[0]!.applied.uid, 'f')
  })
})

describe('adding, presets and saving', () => {
  test('a scene effect starts with a crossfade-length fade; the whole episode starts with none', () => {
    const file = lib.emptyEffectsFile()
    const [scene] = lib.addEffects(file, { kind: 'scene', id: 's1' }, [{ id: 'rain' }])
    const [whole] = lib.addEffects(file, { kind: 'episode' }, [{ id: 'rain' }])
    assert.equal(scene!.fade_in_sec, lib.DEFAULT_SCENE_FADE_SEC)
    assert.equal(whole!.fade_in_sec, undefined)
    assert.notEqual(scene!.uid, whole!.uid)
  })

  test('a preset carries ids and changed fields only — never a scene, a window, an order or an id of its own', () => {
    const file = sampleFile() as any
    file.scenes[0].effects[0].params = { amount: 60 }
    file.scenes[0].effects[0].order = 5
    file.scenes[0].effects[0].fade_in_sec = 3
    const rows = lib.stackRowsForTarget(file, { kind: 'scene', id: 's1' }, scenes, library)
    const items = lib.presetItemsFromRows(rows)
    const fireflies = items.find(i => i.id === 'fireflies')!
    assert.deepEqual(fireflies, { id: 'fireflies', params: { amount: 60 } })
    for (const item of items) assert.deepEqual(Object.keys(item).filter(k => k !== 'id' && k !== 'params'), [])
  })

  test('only fields that differ from the library are saved', () => {
    const entry = library.find(e => e.id === 'rain')
    const doc = { ...entry.document, amount: 55 }
    assert.deepEqual(lib.changedParams(entry, doc), { amount: 55 })
  })

  test('empty scene and theme stacks are dropped before saving', () => {
    const file = { ...lib.emptyEffectsFile(), scenes: [{ scene_id: 's1', effects: [] }], themes: [{ theme: 'x', effects: [] }] }
    const compact = lib.compactFile(file)
    assert.deepEqual([compact.scenes, compact.themes], [[], []])
  })

  test('tabs and search narrow the library without losing a pack effect in an unknown category', () => {
    const extra = { ...library[0], id: 'com.example.pack.aurora', name: 'Aurora', category: 'sky' }
    const all = lib.sectionFor([...library, extra], 'all', '')
    assert.ok(all.some(s => s.label === 'More' && s.entries.some(e => e.id === 'com.example.pack.aurora')))
    const weather = lib.sectionFor(library, 'weather', '')
    assert.deepEqual(weather.map(s => s.label), ['Weather'])
    assert.ok(lib.sectionFor(library, 'all', 'firefl').flatMap(s => s.entries).every(e => /firefl/i.test(e.name + e.description)))
  })
})

describe('live preview', () => {
  test('the grade preview reads the backend\'s preset table', () => {
    const filter = gradeCssFilter(mergeSceneOverlay('color-grade', { preset: 'noir' }) as any)
    assert.match(filter, /brightness\(0\.900\) contrast\(1\.400\) saturate\(0\.000\)/)
  })

  test('effects the canvas cannot draw are named, so the page can say so', () => {
    assert.ok(NOT_DRAWN_LIVE.has('heat-shimmer'))
  })
})

describe('the page itself', () => {
  const page = fs.readFileSync(new URL('../pages/projects/[slug]/effects-library.vue', import.meta.url), 'utf-8')
  const canvas = fs.readFileSync(new URL('../utils/effect-preview-canvas.ts', import.meta.url), 'utf-8')

  test('the live preview draws loops with the program that bakes them', () => {
    assert.match(canvas, /createLoopRenderer[\s\S]*from '@shared\/effect-loops'/)
  })

  test('an episode change replaces the stack, never carries it over (AGENTS.md §4)', () => {
    assert.match(page, /watch\(episodeId, \(\) => \{ load\(\) \}\)/)
    assert.match(page, /Object\.assign\(file, emptyEffectsFile\(\)\)/)
    // A save addresses the episode the file was loaded from.
    assert.match(page, /const episode = fileEpisode\.value/)
  })

  test('every action button carries a visible hint', () => {
    for (const label of ['Render Exact 6 s Preview', 'Save as Preset…', 'Save Stack as Preset…']) {
      const at = page.indexOf(label)
      assert.ok(at > 0, label)
      assert.match(page.slice(at, at + 400), /class="hint"/, `${label} has no visible hint beside it`)
    }
  })

  test('the page holds no copy of the effect list', () => {
    for (const entry of library) assert.ok(!page.includes(`'${entry.id}'`), `${entry.id} named in the page`)
  })

  test('the sidebar and the Presets page reach it', () => {
    const layout = fs.readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf-8')
    assert.match(layout, /effects-library`[^>]*>Effects Library</)
    const presets = fs.readFileSync(new URL('../pages/projects/[slug]/presets.vue', import.meta.url), 'utf-8')
    assert.match(presets, /configKey: 'effect_stack'/)
  })
})

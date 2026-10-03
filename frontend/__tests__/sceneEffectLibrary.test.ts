/**
 * The effect library, from the browser's side.
 *
 * Two things are worth pinning here and nowhere else.
 *
 * 1. **A project that never opens the new panel must send a byte-identical
 *    request.** This release is additive; the moment an empty selection starts
 *    emitting `scene_effects`, every saved config and every batch preset has
 *    silently changed what it asks the renderer for.
 *
 * 2. **The picker's control map must cover every overlay kind the backend
 *    ships.** The map is keyed by KIND rather than by effect id precisely so a
 *    new effect of a known kind needs no UI change — but a new KIND does, and
 *    nothing else in the build would notice it was missing. A selected overlay
 *    with no controls is a checkbox that does something the customer cannot
 *    see or adjust.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ref, reactive } from 'vue'

;(globalThis as any).$fetch = async () => ({})

const { useVideoAssemblyIo } = await import('../composables/useVideoAssemblyIo.js')
const { OVERLAY_KINDS } = await import('../../electron/server/contracts/scene-effects.js')
const { BUILT_IN_OVERLAYS } = await import('../../electron/server/contracts/scene-effect-presets.js')

function makeState(sceneEffects?: any) {
  return {
    slug: ref('proj-x'),
    episodeId: ref('EP0001'),
    selectedEpisode: ref<any>(null),
    ffmpegStatus: ref<any>(null),
    scannedAssets: ref<any>({
      merged_audio: [{ path: '/m/merged.mp3' }],
      narration_full: { path: '/m/full.mp3' },
      audio_sections: [{ path: '/m/section-1.mp3' }],
      scenes: [], thumbnails: [],
    }),
    scanning: ref(false),
    scenes: ref([{ image_path: '/i/1.png', filename: '1.png', number: 1, title: 'First', enabled: true }]),
    excludeIntroFromEffects: ref(true),
    logo: reactive({ enabled: false, image_path: '', position: 'top-right', custom_x: 0, custom_y: 0, opacity: 70, scale: 10, margin: 20, hide_during_intro: false }),
    intro: reactive({ enabled: false, video_path: '' }),
    outro: reactive({ enabled: false, video_path: '' }),
    timelineClips: ref<any[]>([]),
    titleImage: reactive({ enabled: false, image_path: '', duration: 5, transition_type: '', transition_duration: 0 }),
    sceneRecycling: reactive({ seconds_per_scene: 10, shuffle: false, excluded_scenes: [] as number[] }),
    transition: reactive({ type: 'fade', duration: 0.5, pool: [], randomize_mode: 'off' }),
    sceneAnimation: reactive({ type: 'ken-burns', zoom_start: 100, zoom_end: 108, pool: [], randomize_mode: 'off' }),
    postAudio: reactive({ behavior: 'fade-to-black', fade_duration: 5 }),
    colorGrading: reactive({ enabled: false, preset: 'none', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 }),
    vignette: reactive({ enabled: false, strength: 0.4 }),
    filmGrain: reactive({ enabled: false, strength: 15 }),
    agedArchiveFilm: reactive({ enabled: false, strength: 45 }),
    letterbox: reactive({ enabled: false, ratio: '2.35:1', color: 'black' }),
    frame: reactive({ enabled: false, inset_pct: 4, border_width: 12, corner_radius: 28, border_color: '#fff', background_color: '#111', fit: 'cover' }),
    chromaKey: reactive({ enabled: false, source_path: '', color: '#00FF00', similarity: 0.15, blend: 0.1 }),
    sceneEffects: reactive(sceneEffects ?? { enabled: false, overlays: [] }),
    titleCard: reactive({ enabled: false, text: 'T', duration: 3, style: 'gold', background: '#000' }),
    chapterTitles: reactive({ enabled: false, style: 'gold', position: 'center', duration: 2.5, font_size: 'medium' }),
    outroCard: reactive({ enabled: false, text: '', duration: 3, style: 'gold' }),
    exportSettings: reactive({ resolution: '1080p', quality: 'high', format: 'mp4' }),
    subtitles: reactive({ enabled: false, source: 'chapters', srt_path: '', style: {} }),
    generating: ref(false),
    jobOutput: ref<string[]>([]),
  }
}

async function payloadFor(sceneEffects?: any): Promise<any> {
  const { generateVideo } = useVideoAssemblyIo(makeState(sceneEffects) as any)
  let body: any = null
  await generateVideo({ post: async (_url, sent) => { body = sent }, videoAssemblyGenerating: ref(false) })
  return body
}

describe('the effect selection reaches the render request', () => {
  let baseline: any

  beforeEach(async () => { baseline = await payloadFor() })

  test('an untouched project sends no scene_effects at all', async () => {
    assert.equal(baseline.scene_effects, undefined,
      'an empty selection must not change the request a pre-v1.2.0 config produces')
  })

  test('the panel switched on but nothing chosen still sends nothing', async () => {
    const body = await payloadFor({ enabled: true, overlays: [] })
    assert.equal(body.scene_effects, undefined)
  })

  test('an overlay that is present but switched off is not sent', async () => {
    const body = await payloadFor({
      enabled: true,
      overlays: [{ id: 'vignette-soft', enabled: false, params: {} }],
    })
    assert.equal(body.scene_effects, undefined)
  })

  test('a chosen overlay is sent as an id plus only its overrides', async () => {
    const body = await payloadFor({
      enabled: true,
      overlays: [
        { id: 'vignette-soft', enabled: true, params: { intensity: 0.9 } },
        { id: 'scrim-bottom', enabled: true, params: {} },
      ],
    })
    assert.deepEqual(body.scene_effects, {
      enabled: true,
      overlays: [
        { id: 'vignette-soft', enabled: true, params: { intensity: 0.9 } },
        { id: 'scrim-bottom', enabled: true, params: {} },
      ],
    })
    // The document itself is never persisted or sent — only the choice. An
    // improved built-in must reach a project that already selected it.
    assert.equal((body.scene_effects.overlays[0] as any).document, undefined)
  })

  test('turning the whole panel off drops the selection from the request', async () => {
    const body = await payloadFor({
      enabled: false,
      overlays: [{ id: 'vignette-soft', enabled: true, params: {} }],
    })
    assert.equal(body.scene_effects, undefined)
  })

  test('nothing else about the request changes when effects are added', async () => {
    const body = await payloadFor({
      enabled: true, overlays: [{ id: 'vignette-soft', enabled: true, params: {} }],
    })
    const { scene_effects: _added, ...rest } = body
    assert.deepEqual(rest, baseline, 'the effect selection must be purely additive')
  })
})

describe('the picker covers the library it is given', () => {
  const source = fs.readFileSync(
    new URL('../components/SceneEffectLibrary.vue', import.meta.url), 'utf-8',
  )

  test('every overlay kind the backend ships has a control group', async () => {
    // v1.5 — the control table is shared with the Effects Library page
    // (`@shared/effect-params`); the picker must read it, and it must cover
    // every kind (and every atmosphere-loop variant).
    const { effectParamFields } = await import('../../electron/server/contracts/effect-params.js')
    const { LOOP_VARIANTS } = await import('../../electron/server/contracts/effect-loops.js')
    assert.match(source, /effectParamFields/, 'the picker must take its controls from the shared table')
    for (const kind of OVERLAY_KINDS) {
      if (kind === 'atmosphere-loop') {
        for (const variant of LOOP_VARIANTS) {
          assert.ok(effectParamFields({ kind, variant } as any).length > 0, `no controls for the ${variant} loop`)
        }
        continue
      }
      assert.ok(effectParamFields({ kind } as any).length > 0, `no controls for the "${kind}" overlay kind`)
    }
  })

  test('the picker holds no copy of the effect list', () => {
    for (const entry of BUILT_IN_OVERLAYS) {
      assert.ok(!source.includes(`'${entry.id}'`),
        `"${entry.id}" is named in the component — the library must come from the catalogue`)
    }
  })

  test('the approximation note is rendered, not just fetched', () => {
    assert.match(source, /entry\.approximation/,
      'an effect that cannot do what its name says must say so in the tile')
    assert.match(source, /supports_text_overlays/,
      'a build that cannot draw text must disable those effects with a reason')
  })
})

/**
 * v1.2.1 — the catalogue can now contain effects from installed Content Packs.
 *
 * Two things must be visible in the tile, and both are about the day the pack
 * goes away rather than the day it arrives.
 */
describe('the picker says where an effect came from', () => {
  const source = fs.readFileSync(
    new URL('../components/SceneEffectLibrary.vue', import.meta.url), 'utf-8',
  )

  test('a pack effect is marked, and names its pack', () => {
    assert.match(source, /entry\.origin\?\.origin === 'content-pack'/,
      'a pack effect must be distinguishable from one that ships with the app')
    assert.match(source, /packLabel/)
    assert.match(source, /pack_id/)
  })

  test('the mark explains what uninstalling the pack does', () => {
    // A built-in is always there. A pack effect an episode still uses stops
    // that render by name — the customer should learn that before choosing it,
    // not from a failed job.
    assert.match(source, /the render stops and names it/i)
  })

  test('a refused pack effect is shown rather than silently missing', () => {
    assert.match(source, /refusals/)
    assert.match(source, /refusal\.reason/)
  })

  test('the picker still holds no copy of the library', () => {
    for (const entry of BUILT_IN_OVERLAYS) {
      assert.ok(!source.includes(`'${entry.id}'`),
        `"${entry.id}" is named in the component — the library must come from the catalogue`)
    }
  })
})

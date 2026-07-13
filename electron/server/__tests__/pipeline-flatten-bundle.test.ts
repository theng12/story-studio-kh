/**
 * Pipeline batch — video_assembly bundle flattening.
 *
 * Locks the contract that batch runs send the SAME flat-shape request
 * to /generate/video-assembly that single-episode runs do. Before
 * v1.0.68 the pipeline route passed bundle slot snapshots through
 * verbatim under nested keys (`params.effects.chroma_key`,
 * `params.timeline.scene_recycling`, …); the generator reads those
 * fields flat at the top level and silently dropped everything inside
 * those nested keys. Result: every batch render lost logos, chroma-key,
 * overlays, ambient tracks, animated chapter titles, compilation
 * layout, and per-scene chapter alignment.
 *
 * Each test exercises one v2 feature so a regression that drops it
 * fails loudly rather than silently shipping wrong renders again.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { flattenVideoAssemblyBundle } from '../routes/pipeline.js'

function bundle(fallback: any) {
  return { fallback }
}

describe('flattenVideoAssemblyBundle', () => {
  test('returns episode_id + title even with empty fallback', () => {
    const out = flattenVideoAssemblyBundle({}, 'EP0042', 'My Episode')
    assert.equal(out.episode_id, 'EP0042')
    assert.equal(out.title, 'My Episode')
  })

  test('flattens export slot fields to top level', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        export: { resolution: '1920x1080', quality: 'high', fps: 30, codec: 'h264', format: 'mp4' },
      }),
      'EP0001',
      '',
    )
    assert.equal(out.resolution, '1920x1080')
    assert.equal(out.quality, 'high')
    assert.equal(out.fps, 30)
    assert.equal(out.codec, 'h264')
    assert.equal(out.format, 'mp4')
  })

  test('flattens timeline slot — scene_recycling, duration, transition, scene_animation', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        timeline: {
          scene_recycling: { seconds_per_scene: 12, shuffle: true, excluded_scenes: [3, 7] },
          duration: { mode: 'auto', min_duration: 0, max_duration: 0 },
          transition: { type: 'fade', duration: 1.5, pool: ['fade', 'wipeleft'], randomize_mode: 'sequence' },
          scene_animation: { type: 'zoom', pool: ['zoom', 'pan'], randomize_mode: 'random' },
        },
      }),
      'EP0001',
      '',
    )
    assert.deepEqual(out.scene_recycling, { seconds_per_scene: 12, shuffle: true, excluded_scenes: [3, 7] })
    assert.equal(out.transition, 'fade')
    assert.equal(out.transition_duration, 1.5)
    assert.deepEqual(out.transition_pool, ['fade', 'wipeleft'])
    assert.equal(out.transition_randomize, 'sequence')
    assert.deepEqual(out.animation_pool, ['zoom', 'pan'])
    assert.equal(out.animation_randomize, 'random')
  })

  test("transition.type='none' forces transition_duration to 0", () => {
    const out = flattenVideoAssemblyBundle(
      bundle({ timeline: { transition: { type: 'none', duration: 9 } } }),
      'EP0001',
      '',
    )
    assert.equal(out.transition, 'none')
    assert.equal(out.transition_duration, 0)
  })

  test('flattens intro/outro slot only when enabled + path set', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        intro: { enabled: true, video_path: '/tmp/intro.mp4', save_as_default: false },
        outro: { enabled: false, video_path: '/tmp/outro.mp4' },
      }),
      'EP0001',
      '',
    )
    assert.deepEqual(out.intro, { enabled: true, video_path: '/tmp/intro.mp4' })
    assert.equal(out.outro, undefined, 'disabled outro should be dropped')
  })

  test('flattens effects slot — chroma_key, overlays, chapter_titles, and frame', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        effects: {
          chroma_key: { enabled: true, source_path: '/tmp/fire.webm', color: '#00ff00', similarity: 0.1, blend: 0.05 },
          overlays: {
            enabled: true,
            layers: [
              { id: 'a', enabled: true, source_path: '/tmp/fireflies.webm', opacity: 0.5 },
              { id: 'b', enabled: false, source_path: '/tmp/grain.webm' },
              { id: 'c', enabled: true, source_path: '' }, // half-configured row
            ],
          },
          chapter_titles: { enabled: true, animation: 'fade', animation_duration: 0.6 },
          frame: { enabled: true, inset_pct: 4, border_width: 12, corner_radius: 28, border_color: '#fff', background_color: '#111' },
          exclude_intro_from_effects: true,
        },
      }),
      'EP0001',
      '',
    )
    assert.equal((out.chroma_key as any).source_path, '/tmp/fire.webm')
    assert.equal((out.overlays as any).enabled, true)
    assert.equal(((out.overlays as any).layers as any[]).length, 1, 'half-configured + disabled layers filtered out')
    assert.equal(((out.overlays as any).layers as any[])[0].id, 'a')
    assert.equal((out.chapter_titles as any).animation, 'fade')
    assert.equal((out.frame as any).corner_radius, 28)
    assert.equal(out.exclude_intro_from_effects, true)
  })

  test('drops effects fields when their `enabled` flag is false (parity with single-episode payload)', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        effects: {
          color_grading: { enabled: false, brightness: 1.2 },
          vignette: { enabled: false, intensity: 0.5 },
          chroma_key: { enabled: false, source_path: '/tmp/fire.webm' },
          overlays: { enabled: false, layers: [] },
        },
      }),
      'EP0001',
      '',
    )
    assert.equal(out.color_grading, undefined)
    assert.equal(out.vignette, undefined)
    assert.equal(out.chroma_key, undefined)
    assert.equal(out.overlays, undefined)
  })

  test('flattens compilation_layout (v1.0.63 BrainWise mode) to video_layout + background_plate + foreground_defaults', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        effects: {
          compilation_layout: {
            layout: 'compilation',
            background_plate: { source_path: '/tmp/stars.mp4', loop: true, opacity: 0.85 },
            foreground_defaults: {
              scale_pct: 0.45,
              position: 'top-third',
              chroma_key: { color: '#00ff00', similarity: 0.1, blend: 0.05 },
            },
          },
        },
      }),
      'EP0001',
      '',
    )
    assert.equal(out.video_layout, 'compilation')
    assert.equal((out.background_plate as any).source_path, '/tmp/stars.mp4')
    assert.equal((out.background_plate as any).enabled, true)
    assert.equal((out.background_plate as any).opacity, 0.85)
    assert.equal((out.foreground_defaults as any).scale_pct, 0.45)
    assert.equal((out.foreground_defaults as any).position, 'top-third')
    assert.equal((out.foreground_defaults as any).chroma_key.color, '#00ff00')
  })

  test('compilation_layout=standard does NOT emit video_layout (single-episode parity: only emits when explicitly opted in)', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({ effects: { compilation_layout: { layout: 'standard' } } }),
      'EP0001',
      '',
    )
    assert.equal(out.video_layout, undefined)
    assert.equal(out.background_plate, undefined)
  })

  test('logo opacity/scale conversion: 0-100 percentage values get divided by 100 (matches buildPayload)', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        effects: {
          logo: { enabled: true, image_path: '/tmp/logo.png', opacity: 80, scale: 25, position: 'lower-right', margin: 24 },
        },
      }),
      'EP0001',
      '',
    )
    const lg = out.logo as any
    assert.equal(lg.opacity, 0.8)
    assert.equal(lg.scale, 0.25)
    assert.equal(lg.position, 'lower-right')
  })

  test('logo opacity/scale already in 0-1 range pass through unchanged', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        effects: {
          logo: { enabled: true, image_path: '/tmp/logo.png', opacity: 0.7, scale: 0.2 },
        },
      }),
      'EP0001',
      '',
    )
    const lg = out.logo as any
    assert.equal(lg.opacity, 0.7)
    assert.equal(lg.scale, 0.2)
  })

  test('subtitles slot omits srt_path (regenerated per episode)', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        subtitles: {
          enabled: true,
          source: 'whisper',
          srt_path: '/should/be/dropped.srt',
          style: { font_size: 22 },
        },
      }),
      'EP0001',
      '',
    )
    const subs = out.subtitles as any
    assert.equal(subs.enabled, true)
    assert.equal(subs.srt_path, undefined, 'srt_path is episode-specific, must be regenerated')
    assert.deepEqual(subs.style, { font_size: 22 })
  })

  test('disabled subtitles slot is dropped', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({ subtitles: { enabled: false, source: 'whisper', style: {} } }),
      'EP0001',
      '',
    )
    assert.equal(out.subtitles, undefined)
  })

  test('legacy bundle (no v2 fields) yields a clean request without any v2 keys', () => {
    const out = flattenVideoAssemblyBundle(
      bundle({
        timeline: { scene_recycling: { seconds_per_scene: 10, shuffle: false, excluded_scenes: [] } },
        export: { resolution: '1280x720', quality: 'medium' },
      }),
      'EP0001',
      'Legacy run',
    )
    // No v2 features should leak through when the bundle didn't ship them
    assert.equal(out.video_layout, undefined)
    assert.equal(out.background_plate, undefined)
    assert.equal(out.foreground_defaults, undefined)
    assert.equal(out.overlays, undefined)
    assert.equal(out.chroma_key, undefined)
    // But the legacy fields it did ship should be present
    assert.deepEqual(out.scene_recycling, { seconds_per_scene: 10, shuffle: false, excluded_scenes: [] })
    assert.equal(out.resolution, '1280x720')
  })

  // ── Legacy preset passthrough (v1.0.69+, Issue B-5) ──────────────────────
  //
  // Pre-v1.0.64 video_assembly presets stored fields flat at the top of
  // `data` — no `fallback` block. Earlier versions of this function would
  // have returned only {episode_id, title} for those, silently dropping
  // every effect. The legacy-shape detection now passes the flat fields
  // straight through so users with old saved presets keep their effects
  // when they trigger a batch run.
  describe('legacy flat preset passthrough', () => {
    test('flat preset with logo + color_grading is passed through verbatim', () => {
      const out = flattenVideoAssemblyBundle(
        {
          // No `fallback` block — this is the pre-v1.0.64 shape.
          logo: { enabled: true, image_path: '/tmp/logo.png', opacity: 0.7 },
          color_grading: { enabled: true, brightness: 1.05 },
          resolution: '1920x1080',
        },
        'EP0001',
        'Legacy preset run',
      )
      assert.equal(out.episode_id, 'EP0001')
      assert.equal(out.title, 'Legacy preset run')
      assert.deepEqual(out.logo, { enabled: true, image_path: '/tmp/logo.png', opacity: 0.7 })
      assert.deepEqual(out.color_grading, { enabled: true, brightness: 1.05 })
      assert.equal(out.resolution, '1920x1080')
    })

    test('flat preset with v2 effects (chroma_key + overlays) is passed through', () => {
      const out = flattenVideoAssemblyBundle(
        {
          chroma_key: { enabled: true, source_path: '/tmp/fire.webm', color: '#00ff00' },
          overlays: { enabled: true, layers: [{ id: 'a', enabled: true, source_path: '/tmp/grain.webm' }] },
          video_layout: 'compilation',
        },
        'EP0001',
        '',
      )
      assert.equal((out.chroma_key as any).source_path, '/tmp/fire.webm')
      assert.equal((out.overlays as any).enabled, true)
      assert.equal(out.video_layout, 'compilation')
    })

    test('empty bundle data still returns just episode_id + title (no false legacy detection)', () => {
      const out = flattenVideoAssemblyBundle({}, 'EP0042', 'Empty')
      assert.equal(out.episode_id, 'EP0042')
      assert.equal(out.title, 'Empty')
      // Should NOT have triggered legacy passthrough — bundle was empty,
      // not legacy.
      assert.equal(Object.keys(out).length, 2)
    })

    test('bundle with `fallback` ignores legacy passthrough even if top-level looks flat', () => {
      // Belt-and-braces: a malformed preset with BOTH a fallback block and
      // top-level keys (shouldn't happen in practice but tests don't
      // hurt). The presence of `fallback` means this is the new shape;
      // legacy passthrough must not fire.
      const out = flattenVideoAssemblyBundle(
        {
          fallback: { export: { resolution: '4096x2160' } },
          logo: { enabled: true, image_path: '/should-not-leak.png' },
        },
        'EP0001',
        '',
      )
      assert.equal(out.resolution, '4096x2160')
      assert.equal(out.logo, undefined, 'top-level logo must not leak when fallback is present')
    })
  })
})

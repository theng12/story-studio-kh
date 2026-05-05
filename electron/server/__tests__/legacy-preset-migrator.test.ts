/**
 * Legacy video_assembly preset migrator (v1.0.71+).
 *
 * Pre-v1.0.64 presets stored fields flat at the top of `data`. v1.0.68+
 * uses bundle shape with five slot snapshots under `data.fallback`. The
 * runtime passthrough in `flattenVideoAssemblyBundle` handles legacy
 * shapes for batch runs, but presets stay in the old shape until
 * explicitly migrated. These tests lock the bundlification contract:
 *   - detection of legacy vs bundle shape
 *   - slot assignment per generator field
 *   - preservation of unknown keys (forward-compat)
 *   - non-mutation of input
 *   - bulk-scan + bulk-migrate output shape
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLegacyVideoAssemblyPreset,
  bundlifyLegacyVideoAssemblyPreset,
  scanForLegacyVideoAssemblyPresets,
  migrateAllLegacyVideoAssemblyPresets,
} from '../services/legacy-preset-migrator.js'

describe('isLegacyVideoAssemblyPreset', () => {
  test('detects flat-shape preset with logo + transition keys', () => {
    const p = { id: 'p1', name: 'Old', data: { logo: { enabled: true }, transition: { type: 'fade' } } }
    assert.equal(isLegacyVideoAssemblyPreset(p), true)
  })

  test('returns false for bundle-shape preset (has fallback)', () => {
    const p = { id: 'p2', name: 'Bundle', data: { fallback: { export: { resolution: '1920x1080' } } } }
    assert.equal(isLegacyVideoAssemblyPreset(p), false)
  })

  test('returns false for empty / preset with no data', () => {
    assert.equal(isLegacyVideoAssemblyPreset({ id: '', name: '' } as any), false)
    assert.equal(isLegacyVideoAssemblyPreset(undefined), false)
  })

  test('returns false for preset whose data has only unknown keys', () => {
    // Defensive: a preset with only unknown top-level keys isn't legacy
    // (it might be a future shape we don't recognise). Falls through.
    const p = { id: 'p3', name: 'Mystery', data: { something_unknown: 1 } }
    assert.equal(isLegacyVideoAssemblyPreset(p), false)
  })
})

describe('bundlifyLegacyVideoAssemblyPreset', () => {
  test('groups export fields under fallback.export', () => {
    const p = { id: 'p1', name: 'Old', data: { resolution: '1920x1080', quality: 'high', fps: 30 } }
    const out = bundlifyLegacyVideoAssemblyPreset(p)!
    assert.equal(out.id, 'p1')
    assert.equal(out.name, 'Old')
    assert.deepEqual(out.data.fallback.export, { resolution: '1920x1080', quality: 'high', fps: 30 })
    // Top-level keys should be GONE — moved into fallback
    assert.equal(out.data.resolution, undefined)
  })

  test('groups timeline fields under fallback.timeline', () => {
    const p = { id: 'p1', name: 'Old', data: {
      transition: { type: 'fade', duration: 1 },
      scene_recycling: { seconds_per_scene: 10 },
      scene_animation: { type: 'zoom' },
    }}
    const out = bundlifyLegacyVideoAssemblyPreset(p)!
    assert.deepEqual(out.data.fallback.timeline.transition, { type: 'fade', duration: 1 })
    assert.deepEqual(out.data.fallback.timeline.scene_recycling, { seconds_per_scene: 10 })
    assert.deepEqual(out.data.fallback.timeline.scene_animation, { type: 'zoom' })
  })

  test('groups effects fields under fallback.effects (logo, color_grading, chroma_key, overlays)', () => {
    const p = { id: 'p1', name: 'Old', data: {
      logo: { enabled: true, image_path: '/tmp/logo.png' },
      color_grading: { enabled: true, brightness: 1.05 },
      chroma_key: { enabled: true, source_path: '/tmp/fire.webm' },
      overlays: { enabled: true, layers: [] },
    }}
    const out = bundlifyLegacyVideoAssemblyPreset(p)!
    assert.equal(out.data.fallback.effects.logo.image_path, '/tmp/logo.png')
    assert.equal(out.data.fallback.effects.color_grading.brightness, 1.05)
    assert.equal(out.data.fallback.effects.chroma_key.source_path, '/tmp/fire.webm')
    assert.equal(out.data.fallback.effects.overlays.enabled, true)
  })

  test('preserves unknown keys at the top level (forward-compat)', () => {
    const p = { id: 'p1', name: 'Old', data: {
      logo: { enabled: true, image_path: '/tmp/logo.png' },
      // Unknown key — must NOT be dropped
      future_field: { something: 'preserved' },
    }}
    const out = bundlifyLegacyVideoAssemblyPreset(p)!
    assert.equal(out.data.future_field?.something, 'preserved')
    assert.equal(out.data.fallback.effects.logo.image_path, '/tmp/logo.png')
  })

  test('does not mutate the input', () => {
    const p = { id: 'p1', name: 'Old', data: { logo: { enabled: true } } }
    const before = JSON.stringify(p)
    bundlifyLegacyVideoAssemblyPreset(p)
    assert.equal(JSON.stringify(p), before, 'input preset must be untouched')
  })

  test('returns null when input is already bundle-shaped', () => {
    const p = { id: 'p2', name: 'Bundle', data: { fallback: { export: { resolution: '4k' } } } }
    assert.equal(bundlifyLegacyVideoAssemblyPreset(p), null)
  })

  test('round-trip: bundlified preset produces non-empty fallback', () => {
    // Belt-and-braces: a real-ish legacy preset survives migration
    // and ends up with content in every slot it had data for.
    const p = { id: 'p1', name: 'Real', data: {
      resolution: '1920x1080',
      transition: { type: 'crossfade', duration: 1.5 },
      logo: { enabled: true, image_path: '/x.png' },
      subtitles: { enabled: true, source: 'whisper' },
    }}
    const out = bundlifyLegacyVideoAssemblyPreset(p)!
    assert.ok(out.data.fallback.export.resolution)
    assert.ok(out.data.fallback.timeline.transition)
    assert.ok(out.data.fallback.effects.logo)
    assert.ok(out.data.fallback.subtitles.enabled)
  })
})

describe('scanForLegacyVideoAssemblyPresets', () => {
  test('counts both shapes correctly', () => {
    const config = {
      video_bundle_presets: [
        { id: 'a', name: 'Old', data: { logo: { enabled: true } } },
        { id: 'b', name: 'New', data: { fallback: { export: { resolution: '1080' } } } },
        { id: 'c', name: 'Old2', data: { transition: { type: 'fade' } } },
      ],
    }
    const r = scanForLegacyVideoAssemblyPresets(config)
    assert.equal(r.total_presets, 3)
    assert.equal(r.legacy_presets.length, 2)
    assert.deepEqual(r.legacy_presets.map(p => p.id), ['a', 'c'])
  })

  test('returns empty list when no presets', () => {
    assert.deepEqual(scanForLegacyVideoAssemblyPresets({}), { total_presets: 0, legacy_presets: [] })
  })
})

describe('migrateAllLegacyVideoAssemblyPresets', () => {
  test('rewrites only legacy entries; leaves bundle entries untouched', () => {
    const config = {
      video_bundle_presets: [
        { id: 'a', name: 'Old', data: { logo: { enabled: true, image_path: '/x.png' } } },
        { id: 'b', name: 'New', data: { fallback: { export: { resolution: '1080' } } } },
      ],
    }
    const { config: next, result } = migrateAllLegacyVideoAssemblyPresets(config)
    assert.deepEqual(result.migrated.map(m => m.id), ['a'])
    assert.equal(result.skipped.length, 0)
    // Old → bundle
    const a = next.video_bundle_presets[0]
    assert.equal(a.data.fallback.effects.logo.image_path, '/x.png')
    assert.equal(a.data.logo, undefined)
    // New → unchanged
    const b = next.video_bundle_presets[1]
    assert.equal(b.data.fallback.export.resolution, '1080')
  })

  test('preserves preset order in the list', () => {
    const config = {
      video_bundle_presets: [
        { id: 'first', name: '', data: { logo: { enabled: true } } },
        { id: 'second', name: '', data: { fallback: {} } },
        { id: 'third', name: '', data: { transition: { type: 'fade' } } },
      ],
    }
    const { config: next } = migrateAllLegacyVideoAssemblyPresets(config)
    assert.deepEqual(next.video_bundle_presets.map((p: any) => p.id), ['first', 'second', 'third'])
  })

  test('returns empty result when no legacy presets', () => {
    const config = { video_bundle_presets: [
      { id: 'b', name: 'New', data: { fallback: {} } },
    ]}
    const { result } = migrateAllLegacyVideoAssemblyPresets(config)
    assert.equal(result.migrated.length, 0)
    assert.equal(result.skipped.length, 0)
  })
})

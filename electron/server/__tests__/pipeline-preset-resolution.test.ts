/**
 * Preset resolution for the batch-pipeline route.
 *
 * The real-world state that triggered this bug: a user's config had typed
 * `script_presets` saved (with `type: 'script'` / `type: 'introduction'`)
 * but no `script_last_preset_script` / `script_last_preset_introduction`
 * pointers, and the legacy `script_last_preset` pointed at a preset id
 * that was no longer in the list. Without the type-based fallback, both
 * the pipeline UI and the batch runner would refuse to start the run.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { findActivePreset } from '../routes/pipeline.js'

describe('findActivePreset — script-only / introduction-only', () => {
  test('typed active pointer wins when it resolves', () => {
    const config = {
      script_presets: [
        { id: 'a', name: 'Chapter A', type: 'script' },
        { id: 'b', name: 'Chapter B', type: 'script' },
      ],
      script_last_preset_script: 'a',
      script_last_preset: 'b', // legacy is ignored when typed resolves
    }
    const r = findActivePreset(config, 'script-only')
    assert.equal(r.preset?.id, 'a')
    assert.equal(r.missingReason, null)
  })

  test('falls back to legacy untyped pointer when typed is missing', () => {
    const config = {
      script_presets: [{ id: 'b', name: 'Chapter B', type: 'script' }],
      script_last_preset: 'b',
    }
    const r = findActivePreset(config, 'script-only')
    assert.equal(r.preset?.id, 'b')
  })

  test('type-based fallback when NEITHER pointer resolves (stale active id)', () => {
    // Mirrors the user's on-disk state: typed presets saved, but
    // script_last_preset_script is missing and script_last_preset points
    // at an id no longer in the list.
    const config = {
      script_presets: [
        { id: 'p1', name: 'Old legacy', type: 'script' },
        { id: 'p2', name: 'Newer script preset', type: 'script' },
        { id: 'p3', name: 'My intro', type: 'introduction' },
      ],
      script_last_preset: 'preset-deleted-long-ago',
    }
    const r = findActivePreset(config, 'script-only')
    assert.equal(r.preset?.id, 'p2', 'picks the most recent script-typed preset')
    assert.equal(r.missingReason, null)
  })

  test('introduction-only resolves its own type', () => {
    const config = {
      script_presets: [
        { id: 'p1', name: 'Chapter A', type: 'script' },
        { id: 'p2', name: 'My intro', type: 'introduction' },
      ],
      // No active pointers at all — type fallback is the only path.
    }
    const r = findActivePreset(config, 'introduction-only')
    assert.equal(r.preset?.id, 'p2')
  })

  test('returns missingReason when list has no matching-type preset', () => {
    const config = {
      script_presets: [
        { id: 'p2', name: 'My intro', type: 'introduction' },
      ],
    }
    const r = findActivePreset(config, 'script-only')
    assert.equal(r.preset, null)
    assert.match(r.missingReason || '', /No active preset/)
  })

  test('untyped legacy preset still resolves via the legacy pointer', () => {
    // Projects saved before typing existed: presets have no `type` field
    // and the untyped pointer is the only one set.
    const config = {
      script_presets: [{ id: 'legacy', name: 'Old Untyped' /* no type */ }],
      script_last_preset: 'legacy',
    }
    const r = findActivePreset(config, 'script-only')
    assert.equal(r.preset?.id, 'legacy')
  })

  test('ignores non-matching types in the type fallback', () => {
    // script-only asks for type=script; we must not accidentally pick an
    // introduction-typed preset.
    const config = {
      script_presets: [{ id: 'intro1', name: 'Intro', type: 'introduction' }],
      script_last_preset: 'stale-id',
    }
    const r = findActivePreset(config, 'script-only')
    assert.equal(r.preset, null)
  })
})

describe('findActivePreset — non-script steps unchanged', () => {
  test('image_prompts resolves via its single active key', () => {
    const config = {
      image_prompts_presets: [{ id: 'ip1', name: 'My prompts preset' }],
      image_prompts_last_preset: 'ip1',
    }
    const r = findActivePreset(config, 'image_prompts')
    assert.equal(r.preset?.id, 'ip1')
  })

  test('image_prompts returns missingReason without type fallback', () => {
    // No type-based fallback for non-script steps — they don't use typed
    // presets, so a stale pointer should still surface as a missing config.
    const config = {
      image_prompts_presets: [{ id: 'ip1', name: 'a' }],
      image_prompts_last_preset: 'ip-stale',
    }
    const r = findActivePreset(config, 'image_prompts')
    assert.equal(r.preset, null)
    assert.match(r.missingReason || '', /not found/)
  })
})

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
import { findActivePreset, resolveStepParams } from '../routes/pipeline.js'

describe('resolveStepParams — Scene Review approval automation', () => {
  test('old presets keep generated-image approval off', () => {
    const params = resolveStepParams('scene_review', 'EP0001', 'Episode', {
      id: 'scene-review-old',
      name: 'Old scene review preset',
      data: { model: 'image-model', aspect_ratio: '16:9' },
    })
    assert.equal(params.auto_approve_generated, false)
  })

  test('explicit preset choice enables verified generated-image approval', () => {
    const params = resolveStepParams('scene_review', 'EP0001', 'Episode', {
      id: 'scene-review-auto',
      name: 'Auto approval preset',
      data: { model: 'image-model', auto_approve_generated: true },
    })
    assert.equal(params.auto_approve_generated, true)
  })
})

describe('findActivePreset — script-only / introduction-only', () => {
  test('script params preserve the preset POV and narrator style', () => {
    const params = resolveStepParams(
      'script-only',
      'EP0016',
      'Volcanic Winter',
      {
        id: 'bw-script',
        name: 'BW - Script',
        type: 'script',
        data: {
          form: {
            episode_id: 'EP0012',
            title: 'Stale preset title',
            model: 'deepseek-v4-flash',
            style: 'A',
            perspective: 'second-immersive',
            custom_perspective: 'Keep the viewer inside the scene.',
            chapters: 5,
            words_per_chapter: 500,
          },
        },
      },
    )
    assert.equal(params.episode_id, 'EP0016')
    assert.equal(params.title, 'Volcanic Winter')
    assert.equal(params.perspective, 'second-immersive')
    assert.equal(params.custom_perspective, 'Keep the viewer inside the scene.')
    assert.equal(params.style, 'A')
  })

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

  test('a stale pointer never heals to the newest matching preset', () => {
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
    assert.equal(r.preset, null)
    assert.match(r.missingReason || '', /selected.*missing|deleted/i)
  })

  test('introduction-only requires an exact pointer in its own pool', () => {
    // This resolution is inert in practice: `introduction-only` sits in
    // NO_PRESET_STEPS, so preflight never asks. It is kept correct anyway,
    // because the failure mode if it were ever asked is silent — the old
    // mapping pointed at `script_presets`, so a channel with a Script preset
    // and no Introduction preset would have had a SCRIPT preset's fields
    // handed to its opening and nothing would have said so.
    const config: any = {
      script_presets: [{ id: 'p1', name: 'Chapter A', type: 'script' }],
      introduction_presets: [{ id: 'p2', name: 'My intro', type: 'introduction' }],
      // No active pointer: the presence or ordering of records grants no authority.
    }
    const r = findActivePreset(config, 'introduction-only')
    assert.equal(r.preset, null)
    assert.match(r.missingReason || '', /No active preset/)

    config.introduction_last_preset_introduction = 'p2'
    assert.equal(findActivePreset(config, 'introduction-only').preset?.id, 'p2')

    const scriptOnly = { script_presets: [{ id: 'p1', name: 'Chapter A', type: 'script' }] }
    assert.equal(findActivePreset(scriptOnly, 'introduction-only').preset, null,
      'a Script preset is not an Introduction preset, whatever the pool is called')
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

describe('findActivePreset — thumbnail-only prompt and image preset pools', () => {
  test('image_prompts resolves from the thumbnail prompt pool', () => {
    const config = {
      thumbnail_prompts_presets: [{ id: 'tp1', name: 'Thumbnail prompt preset' }],
      thumbnail_prompts_last_preset: 'tp1',
    }
    const r = findActivePreset(config, 'image_prompts')
    assert.equal(r.preset?.id, 'tp1')
  })

  test('image_prompts does not fall back to the scene prompt pool', () => {
    const config = {
      thumbnail_prompts_presets: [{ id: 'tp1', name: 'Old thumbnail prompt preset' }],
      scene_prompts_presets: [{ id: 'sp1', name: 'Scene prompt preset' }],
      thumbnail_prompts_last_preset: 'tp-stale',
      scene_prompts_last_preset: 'sp1',
    }
    const r = findActivePreset(config, 'image_prompts')
    assert.equal(r.preset, null)
    assert.match(r.missingReason || '', /was deleted/)
  })

  test('image_prompts ignores the legacy unified prompt pool', () => {
    const config = {
      image_prompts_presets: [{ id: 'ip1', name: 'My prompts preset' }],
      image_prompts_last_preset: 'ip1',
    }
    const r = findActivePreset(config, 'image_prompts')
    assert.equal(r.preset, null)
  })

  test('image_prompts returns missingReason when all active ids are stale', () => {
    const config = {
      thumbnail_prompts_presets: [{ id: 'tp1', name: 'a' }],
      scene_prompts_presets: [{ id: 'sp1', name: 'b' }],
      thumbnail_prompts_last_preset: 'tp-stale',
    }
    const r = findActivePreset(config, 'image_prompts')
    assert.equal(r.preset, null)
    assert.match(r.missingReason || '', /was deleted/)
  })

  test('thumb_images resolves from thumbnail_generator presets only', () => {
    const config = {
      thumbnail_generator_presets: [{ id: 'tg1', name: 'Thumb render preset' }],
      scene_generator_presets: [{ id: 'sg1', name: 'Scene render preset' }],
      image_generator_presets: [{ id: 'ig1', name: 'Legacy render preset' }],
      thumbnail_generator_last_preset: 'tg1',
      image_generator_last_preset: 'ig1',
    }
    const r = findActivePreset(config, 'thumb_images')
    assert.equal(r.preset?.id, 'tg1')
  })

})

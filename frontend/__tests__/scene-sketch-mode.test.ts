/**
 * The optional scene-type Sketch Draw mode — Motion Review's half (batch 386, item 11).
 *
 * Owner, 2026-11-05: the mode is OFF by default with no type-to-look mappings approved; scene-type
 * rules key on the 13 approved type ids (channel-level configuration, so a preset may carry them)
 * while per-scene pins stay episode state and never ride a preset. These tests pin the draft
 * helpers the page edits through: OFF by default, round-trip, the preset apply trap (a preset with
 * no stored rules must not wipe the live ones), and loud errors for half-built rules.
 *
 * The page half is pinned by source analysis (it needs the Nuxt runtime to mount).
 * Not run here by instruction — the lead coordinates suite runs.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyRevealPreset, effectiveSceneTypes, revealForPreset, SCENE_TYPE_CHOICES,
  sceneTypeRuleDrafts, sceneTypeRulesFromDrafts, sceneTypesEqual,
  type SceneTypeRuleDraft, type SceneTypeRules, type SketchReveal,
} from '../utils/sketch-reveal.ts'

const emptyDrafts = () => sceneTypeRuleDrafts(null)

describe('scene-type drafts are OFF by default', () => {
  test('a fresh editor is disabled with one empty row per approved type', () => {
    const drafts = emptyDrafts()
    assert.equal(SCENE_TYPE_CHOICES.length, 13)
    assert.equal(Object.keys(drafts).length, 13)
    for (const choice of SCENE_TYPE_CHOICES) {
      const draft = drafts[choice.id]
      assert.ok(draft, `missing row for ${choice.id}`)
      assert.equal(draft.reveal, '')
      assert.equal(draft.hold, '')
    }
    const built = sceneTypeRulesFromDrafts(false, drafts)
    assert.ok(built.ok)
    assert.equal(built.scene_types.enabled, false)
    assert.deepEqual(built.scene_types.rules, {})
    // What a channel that never touched the control stores: nothing — the key is absent, not "off".
    assert.ok(sceneTypesEqual(built.scene_types, { enabled: false, rules: {} }))
    const plain = revealForPreset({ style: 'line', mix: [] })
    assert.ok(plain)
    assert.equal('scene_types' in plain, false)
    assert.equal(effectiveSceneTypes(null, null), null)
  })

  test('drafts round-trip: settings -> drafts -> settings', () => {
    const stored: SceneTypeRules = {
      enabled: true,
      rules: {
        interior: { reveal: { style: 'colour', mix: [] }, hold: { mode: 'fixed', seconds: 2 } },
        landscape: { reveal: { style: 'mix', mix: ['line', 'bloom'] } },
        event_action: { hold: { mode: 'range', min_seconds: 1, max_seconds: 3 } },
      },
    }
    const drafts = sceneTypeRuleDrafts(stored)
    assert.equal(drafts.interior.reveal, 'colour')
    assert.equal(drafts.interior.hold, 'fixed')
    assert.equal(drafts.interior.holdDrafts.fixed, '2')
    assert.equal(drafts.landscape.reveal, 'mix')
    assert.deepEqual(drafts.landscape.mix, ['line', 'bloom'])
    assert.equal(drafts.event_action.hold, 'range')
    assert.equal(drafts.event_action.reveal, '')
    const rebuilt = sceneTypeRulesFromDrafts(true, drafts)
    assert.ok(rebuilt.ok)
    assert.ok(sceneTypesEqual(rebuilt.scene_types, stored))
  })

  test('a half-built rule is an error, never a half-saved setting', () => {
    const drafts = emptyDrafts()
    drafts.interior.reveal = 'mix'
    drafts.interior.mix = ['line']
    const failed = sceneTypeRulesFromDrafts(true, drafts)
    assert.equal(failed.ok, false)
    assert.ok(!failed.ok && failed.error.length > 0)

    const holdDrafts = emptyDrafts()
    holdDrafts.interior.hold = 'fixed'
    holdDrafts.interior.holdDrafts.fixed = '0'
    const failedHold = sceneTypeRulesFromDrafts(true, holdDrafts)
    assert.equal(failedHold.ok, false)
  })

  test('empty rows drop out, so "no rule" stays no rule', () => {
    const drafts = emptyDrafts()
    const built = sceneTypeRulesFromDrafts(true, drafts)
    assert.ok(built.ok)
    assert.deepEqual(built.scene_types.rules, {})
  })

  test('sceneTypesEqual ignores key order but notices a moved value', () => {
    const a: SceneTypeRules = { enabled: true, rules: { interior: { hold: { mode: 'auto' } }, landscape: {} } }
    const b: SceneTypeRules = { enabled: true, rules: { landscape: {}, interior: { hold: { mode: 'auto' } } } }
    const c: SceneTypeRules = { enabled: true, rules: { interior: { hold: { mode: 'off' } }, landscape: {} } }
    assert.ok(sceneTypesEqual(a, b))
    assert.ok(!sceneTypesEqual(a, c))
    assert.ok(!sceneTypesEqual(a, { ...a, enabled: false }))
    assert.ok(sceneTypesEqual(null, null))
  })
})

describe('presets and channel defaults carry rules, never pins', () => {
  const live: SketchReveal = {
    style: 'mix',
    mix: ['line', 'bloom'],
    overrides: { s1: 'rough' },
    scene_types: { enabled: true, rules: { interior: { reveal: { style: 'colour', mix: [] } } } },
  }

  test('revealForPreset keeps the reusable rules and drops the episode pins', () => {
    const preset = revealForPreset(live)!
    assert.equal(preset.style, 'mix')
    assert.deepEqual(preset.mix, ['line', 'bloom'])
    assert.ok(preset.scene_types)
    assert.equal(preset.scene_types!.enabled, true)
    assert.equal(preset.scene_types!.rules.interior.reveal?.style, 'colour')
    assert.equal('overrides' in preset, false)
  })

  test('a preset with no stored rules keeps the live ones (the §5 apply trap)', () => {
    const presetOnlyLook = { style: 'line', mix: [] }
    const next = applyRevealPreset(presetOnlyLook, live)
    assert.ok(next)
    assert.equal(next!.style, 'line')
    assert.deepEqual(next!.overrides, { s1: 'rough' })
    assert.ok(sceneTypesEqual(next!.scene_types!, live.scene_types!))
  })

  test('a preset that stores rules applies them, and a preset without pins keeps the live pins', () => {
    const withRules: SketchReveal = {
      style: 'buildup',
      mix: [],
      scene_types: { enabled: false, rules: { landscape: { hold: { mode: 'off' } } } },
    }
    const next = applyRevealPreset(withRules, live)
    assert.ok(next)
    assert.equal(next!.style, 'buildup')
    assert.ok(sceneTypesEqual(next!.scene_types!, withRules.scene_types!))
    assert.deepEqual(next!.overrides, { s1: 'rough' })
  })

  test('a corrupt preset leaves the live reveal alone', () => {
    assert.equal(applyRevealPreset({ style: 'nonsense', mix: [] }, live), live)
    assert.equal(applyRevealPreset(null, live), live)
  })

  test('effectiveSceneTypes reads the episode first, then the channel', () => {
    const channel: SketchReveal = { style: 'line', mix: [], scene_types: { enabled: true, rules: { interior: {} } } }
    const episode: SketchReveal = { style: 'line', mix: [], scene_types: { enabled: false, rules: { landscape: {} } } }
    assert.equal(effectiveSceneTypes(episode, channel)?.enabled, false)
    assert.equal(effectiveSceneTypes(null, channel)?.enabled, true)
    assert.equal(effectiveSceneTypes(null, null), null)
  })
})

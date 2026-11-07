/**
 * The optional scene-type Sketch Draw mode (batch 386, item 11).
 *
 * Owner, 2026-11-05 (`scene-type-sketch-reveal-and-hold-rules`): reuse the 13 approved scene types
 * for editable per-channel rules — one reveal or an allowed Mix pool, plus Auto/Off/Fixed/Range
 * closing hold. The follow-up (`scene-type-sketch-rules-optional-after-383`) makes the mode an
 * optional extra, OFF by default, with no type-to-look mappings approved. These tests pin exactly
 * that contract: absent means the old behaviour byte-for-byte, pins still win, resolution stays
 * deterministic, holds still clamp inside the scene, and a malformed rule is loud.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_SKETCH_REVEAL, parseSketchReveal, resetSketchRevealPlanCache, resolveSketchRevealPlan,
  sceneTypeHoldFor, sceneTypeRevealFor, sceneTypeRulesFor, sketchRevealFingerprint,
  sketchRevealForSingleScene, sketchRevealNeedsScenes,
  type SketchRevealSetting,
} from '../lib/sketch-reveal.js'
import { parseSketchHold, resolveSketchHoldFrames, type SketchHoldSetting } from '../lib/sketch-hold.js'

const OFF_DEFAULT: SketchRevealSetting = { style: 'line', mix: [] }

const rulesOn = (rules: Record<string, unknown>, enabled = true): SketchRevealSetting =>
  ({ ...OFF_DEFAULT, scene_types: { enabled, rules } } as SketchRevealSetting)

describe('scene-type mode is OFF by default', () => {
  test('a stored reveal with no scene_types resolves exactly as before', () => {
    assert.equal(sceneTypeRulesFor(OFF_DEFAULT), null)
    assert.equal(sceneTypeRulesFor(DEFAULT_SKETCH_REVEAL), null)
    assert.equal(sceneTypeRulesFor(null), null)
    assert.equal(sceneTypeRevealFor(OFF_DEFAULT, 'interior'), null)
    assert.equal(sceneTypeHoldFor(OFF_DEFAULT, 'interior'), null)
    assert.equal(sketchRevealNeedsScenes(OFF_DEFAULT), false)
    assert.equal(sketchRevealForSingleScene(OFF_DEFAULT, 's1', 'interior'), 'line')
  })

  test('parse ignores a legacy object with no scene_types key and adds none', () => {
    const parsed = parseSketchReveal({ style: 'buildup', mix: [] })
    assert.ok(parsed.ok)
    assert.equal('scene_types' in parsed.reveal, false)
  })

  test('rules present but enabled:false still resolve as off', () => {
    const setting = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }, false)
    assert.equal(sceneTypeRulesFor(setting), null)
    assert.equal(sceneTypeRevealFor(setting, 'interior'), null)
    assert.equal(sceneTypeHoldFor(setting, 'interior'), null)
  })

  test('without scene kinds the plan is the pre-mode plan, even with rules on', () => {
    resetSketchRevealPlanCache()
    const withRules = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } })
    const sceneIds = ['a', 'b', 'c']
    const before = resolveSketchRevealPlan('EP1', sceneIds, OFF_DEFAULT)
    const after = resolveSketchRevealPlan('EP1', sceneIds, withRules)
    assert.deepEqual([...after.entries()], [...before.entries()])
    assert.equal(after.get('a'), 'line')
  })
})

describe('scene-type rules parse', () => {
  test('a valid rule set round-trips through parse', () => {
    const parsed = parseSketchReveal(rulesOn({
      interior: { reveal: { style: 'colour', mix: [] }, hold: { mode: 'fixed', seconds: 2 } },
      landscape: { reveal: { style: 'mix', mix: ['line', 'bloom'] } },
      event_action: { hold: { mode: 'range', min_seconds: 1, max_seconds: 3 } },
    }))
    assert.ok(parsed.ok)
    const rules = parsed.reveal.scene_types
    assert.ok(rules)
    assert.equal(rules.enabled, true)
    assert.equal(rules.rules.interior.reveal?.style, 'colour')
    assert.deepEqual(rules.rules.interior.hold, { mode: 'fixed', seconds: 2 })
    assert.deepEqual(rules.rules.landscape.reveal?.mix, ['line', 'bloom'])
    assert.deepEqual(rules.rules.event_action.hold, { mode: 'range', min_seconds: 1, max_seconds: 3 })
    // JSON round-trip is what the episode file and the channel config store.
    const again = parseSketchReveal(JSON.parse(JSON.stringify(parsed.reveal)))
    assert.ok(again.ok)
    assert.deepEqual(again.reveal, parsed.reveal)
  })

  test('an empty rule object is a rule with no effect, not an error', () => {
    const parsed = parseSketchReveal(rulesOn({ interior: {} }))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.reveal.scene_types?.rules.interior, {})
    assert.equal(sceneTypeRevealFor(parsed.reveal, 'interior'), null)
    assert.equal(sceneTypeHoldFor(parsed.reveal, 'interior'), null)
  })

  test('malformed rules fail loudly with a plain sentence', () => {
    const bad = [
      { scene_types: 'nope' },
      { scene_types: { enabled: true, rules: [] } },
      { scene_types: { enabled: true, rules: { '': { reveal: { style: 'line', mix: [] } } } } },
      { scene_types: { enabled: true, rules: { interior: 'nope' } } },
      { scene_types: { enabled: true, rules: { interior: { reveal: { style: 'nonsense', mix: [] } } } } },
      { scene_types: { enabled: true, rules: { interior: { reveal: { style: 'mix', mix: ['line'] } } } } },
      { scene_types: { enabled: true, rules: { interior: { hold: { mode: 'fixed', seconds: 999 } } } } },
      { scene_types: { enabled: true, rules: { interior: { hold: { mode: 'auto', seconds: 3 } } } } },
    ]
    for (const value of bad) {
      const parsed = parseSketchReveal({ ...OFF_DEFAULT, ...value })
      assert.equal(parsed.ok, false, `expected rejection: ${JSON.stringify(value)}`)
    }
  })

  test('an invalid hold inside a rule names the hold problem', () => {
    const parsed = parseSketchReveal(rulesOn({ interior: { hold: { mode: 'range', min_seconds: 5, max_seconds: 1 } } }))
    assert.equal(parsed.ok, false)
    assert.ok(!parsed.ok && /shortest|longest|range/i.test(parsed.error))
  })
})

describe('scene-type resolution precedence', () => {
  const kinds: Record<string, string | undefined> = { s1: 'interior', s2: 'landscape', s3: 'event_action', s4: undefined }

  test('a type rule beats the episode style; a pin beats the type rule', () => {
    resetSketchRevealPlanCache()
    const withRules: SketchRevealSetting = {
      style: 'line',
      mix: [],
      overrides: { s2: 'rough' },
      scene_types: { enabled: true, rules: {
        interior: { reveal: { style: 'colour', mix: [] } },
        landscape: { reveal: { style: 'bloom', mix: [] } },
        event_action: { reveal: { style: 'chalkboard', mix: [] } },
      } },
    }
    const plan = resolveSketchRevealPlan('EP-PRE', ['s1', 's2', 's3', 's4'], withRules, kinds)
    assert.equal(plan.get('s1'), 'colour')   // type rule
    assert.equal(plan.get('s2'), 'rough')    // pin wins over the landscape rule
    assert.equal(plan.get('s3'), 'chalkboard')
    assert.equal(plan.get('s4'), 'line')     // no kind supplied -> falls through to the style
  })

  test('resolution is deterministic across runs and cache resets', () => {
    const setting = rulesOn({ interior: { reveal: { style: 'mix', mix: ['line', 'bloom', 'colour'] } } })
    const sceneIds = ['x1', 'x2', 'x3', 'x4', 'x5']
    const kinds: Record<string, string | undefined> = { x1: 'interior', x2: 'interior', x3: 'interior', x4: 'interior', x5: 'interior' }
    const first = resolveSketchRevealPlan('EP-DET', sceneIds, setting, kinds)
    resetSketchRevealPlanCache()
    const second = resolveSketchRevealPlan('EP-DET', sceneIds, setting, kinds)
    assert.deepEqual([...first.entries()], [...second.entries()])
    for (const [, type] of first) assert.ok(['line', 'bloom', 'colour'].includes(type))
  })

  test('a disabled mode never matches a kind, whatever the rules say', () => {
    resetSketchRevealPlanCache()
    const off = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }, false)
    const plan = resolveSketchRevealPlan('EP-OFF', ['s1'], off, { s1: 'interior' })
    assert.equal(plan.get('s1'), 'line')
  })

  test('the single-scene answer honours a type rule and needs scenes only for a real mix', () => {
    const single = rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } })
    assert.equal(sketchRevealForSingleScene(single, 's1', 'interior'), 'colour')
    assert.equal(sketchRevealForSingleScene(single, 's1', 'landscape'), 'line')
    assert.equal(sketchRevealForSingleScene(single, 's1'), 'line')
    const pooled = rulesOn({ interior: { reveal: { style: 'mix', mix: ['line', 'bloom'] } } })
    assert.equal(sketchRevealForSingleScene(pooled, 's1', 'interior'), null) // >1 in pool: needs the plan
    assert.equal(sketchRevealNeedsScenes(pooled), true)
    const pinned: SketchRevealSetting = { ...pooled, overrides: { s1: 'rough' } }
    assert.equal(sketchRevealForSingleScene(pinned, 's1', 'interior'), 'rough')
  })

  test('the fingerprint moves when a rule moves, so plans and freshness notice', () => {
    const base = sketchRevealFingerprint(OFF_DEFAULT)
    const a = sketchRevealFingerprint(rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }))
    const b = sketchRevealFingerprint(rulesOn({ interior: { reveal: { style: 'bloom', mix: [] } } }))
    const c = sketchRevealFingerprint(rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } }, false))
    assert.notEqual(a, base)
    assert.notEqual(a, b)
    assert.notEqual(a, c)
    assert.equal(
      sketchRevealFingerprint(rulesOn({ interior: { reveal: { style: 'colour', mix: [] } } })),
      a,
      'key order of equal rules must not move the fingerprint',
    )
  })
})

describe('scene-type hold rules', () => {
  test('a type hold is returned only for its kind, else null falls through', () => {
    const setting = rulesOn({ interior: { hold: { mode: 'fixed', seconds: 2 } } })
    assert.deepEqual(sceneTypeHoldFor(setting, 'interior'), { mode: 'fixed', seconds: 2 })
    assert.equal(sceneTypeHoldFor(setting, 'landscape'), null)
    assert.equal(sceneTypeHoldFor(null, 'interior'), null)
    assert.equal(sceneTypeHoldFor(setting, ''), null)
  })

  test('a type hold still clamps inside the scene, never past half of it', () => {
    const hold = sceneTypeHoldFor(rulesOn({ interior: { hold: { mode: 'fixed', seconds: 30 } } }), 'interior') as SketchHoldSetting
    // 4 s scene at 30 fps = 120 frames; half the scene bounds every hold.
    const resolved = resolveSketchHoldFrames(hold, { episodeId: 'EP1', sceneId: 's1', frames: 120, fps: 30 })
    assert.ok(resolved <= 60, `hold must stay inside the scene, got ${resolved} frames`)
    assert.equal(resolveSketchHoldFrames(hold, { episodeId: 'EP1', sceneId: 's1', frames: 10, fps: 30 }), 5)
    // off inside a rule is still a real answer: the last frame only.
    const off = sceneTypeHoldFor(rulesOn({ interior: { hold: { mode: 'off' } } }), 'interior') as SketchHoldSetting
    assert.equal(resolveSketchHoldFrames(off, { episodeId: 'EP1', sceneId: 's1', frames: 120, fps: 30 }), 1)
  })

  test('the hold parser a rule embeds is the same hold parser the hold field uses', () => {
    const viaRule = sceneTypeHoldFor(rulesOn({ interior: { hold: { mode: 'auto' } } }), 'interior')
    const viaHold = parseSketchHold({ mode: 'auto' })
    assert.ok(viaHold.ok)
    assert.deepEqual(viaRule, viaHold.hold)
  })
})

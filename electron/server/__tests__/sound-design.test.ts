import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SOUND_DESIGN_SETTINGS,
  assertSoundDesignReadiness,
  normalizeSoundDesignSettings,
  resolveRenderableSoundCues,
  validateSoundDesignTimeline,
} from '../services/sound-design.js'
import { buildSoundDesignMixArgs } from '../lib/sound-design-mixer.js'
import type { ScenePlan, SoundDesignTimeline } from '../models/types.js'

const plan = { generated_at: '2026-07-26T00:00:00.000Z', scenes: [{ id: 'scene-1', start_sec: 0, end_sec: 70 }] } as ScenePlan
function timeline(cues: SoundDesignTimeline['cues']): SoundDesignTimeline {
  return { schema_version: 1, generated_at: 'now', source_scene_plan_generated_at: plan.generated_at, settings: { ...DEFAULT_SOUND_DESIGN_SETTINGS }, cues }
}
function cue(overrides: Partial<SoundDesignTimeline['cues'][number]> = {}): SoundDesignTimeline['cues'][number] {
  return { id: 'sound-1', kind: 'spot', label: 'door close', start_sec: 10, clip: 'door.wav', pool_id: 'local', gain_db: -12, status: 'approved', created_at: 'now', updated_at: 'now', ...overrides }
}

describe('Sound Design contract', () => {
  test('is disabled by default and settings stay in a safe range', () => {
    assert.deepEqual(normalizeSoundDesignSettings({}), DEFAULT_SOUND_DESIGN_SETTINGS)
    assert.equal(normalizeSoundDesignSettings({ max_spots_per_minute: 99, default_spot_gain_db: 10 }).max_spots_per_minute, 12)
    assert.equal(normalizeSoundDesignSettings({ default_spot_gain_db: 10 }).default_spot_gain_db, -3)
  })

  test('an unreviewed cue is SILENCE plus a note, never a refused render', () => {
    // v1.4.365 — owner, 2026-10-28: "a missing/unapproved optional sound =
    // silence and a stated note". Before this the whole episode refused to
    // assemble over one cue nobody had approved.
    const current = timeline([cue({ status: 'matched' })])
    const issues = validateSoundDesignTimeline(current, plan, current.settings, { requireResolved: true })
    assert.match(issues[0]!.detail, /approval or exclusion/)
    assert.equal(issues[0]!.severity, 'warning', 'it must not block the render')
    const resolved = resolveRenderableSoundCues({ enabled: true }, current, plan)
    assert.deepEqual(resolved.cues, [])
    assert.equal(resolved.skipped.length, 1)
    assert.deepEqual(assertSoundDesignReadiness({ enabled: false }, current, plan), [])
  })

  test('approved sounds mix while the unreviewed ones are skipped and stated', () => {
    const current = timeline([
      cue({ id: 'ok', status: 'approved', start_sec: 10 }),
      cue({ id: 'waiting', status: 'proposed', start_sec: 30 }),
    ])
    const resolved = resolveRenderableSoundCues({ enabled: true }, current, plan)
    assert.deepEqual(resolved.cues.map(row => row.id), ['ok'])
    assert.equal(resolved.skipped.length, 1)
    assert.equal(resolved.skipped[0]!.cue_id, 'waiting')
  })

  test('rejects unsafe overlaps, density, missing assets, and out-of-range cues', () => {
    const current = timeline([
      cue({ id: 'bed-1', kind: 'bed', start_sec: 0, end_sec: 30 }),
      cue({ id: 'bed-2', kind: 'bed', start_sec: 25, end_sec: 50 }),
      cue({ id: 'spot-1', start_sec: 12, clip: '', pool_id: undefined }),
      cue({ id: 'spot-2', start_sec: 12.5 }),
      cue({ id: 'spot-3', start_sec: 71 }),
    ])
    const issues = validateSoundDesignTimeline(current, plan, current.settings, { requireResolved: true })
    assert.ok(issues.some(issue => /overlaps/.test(issue.detail)))
    assert.ok(issues.some(issue => /sound chosen/.test(issue.detail)))
    assert.ok(issues.some(issue => /0.75 seconds/.test(issue.detail)))
    assert.ok(issues.some(issue => /outside/.test(issue.detail)))
    // Only the mixing DEFECT still refuses; an unapproved or out-of-range row
    // is skipped with its reason and the rest of the episode still renders.
    const resolved = resolveRenderableSoundCues({ enabled: true }, current, plan)
    assert.ok(resolved.skipped.some(issue => /overlaps/.test(issue.detail)))
    assert.ok(resolved.skipped.some(issue => /0.75 seconds/.test(issue.detail)))
  })

  test('an excluded cue with stale times never refuses a save any more', () => {
    // The 422 that made an excluded row impossible to edit or delete: every
    // rule applied to a cue the customer had already turned off.
    const current = timeline([cue({ status: 'excluded', start_sec: 999, gain_db: 0, label: '' })])
    assert.deepEqual(validateSoundDesignTimeline(current, plan, current.settings), [])
  })

  // Same defect as Contextual Cues, found by auditing for the shape rather than
  // by waiting for a second report: the absence of a timeline was returned as a
  // validation issue, so switching an OPTIONAL feature on refused Final Video
  // on every episode that had never added a cue.
  test('an episode that never added a cue renders — nothing exists to resolve', () => {
    assert.deepEqual(validateSoundDesignTimeline(null, plan, DEFAULT_SOUND_DESIGN_SETTINGS, { requireResolved: true }), [])
    assert.deepEqual(assertSoundDesignReadiness({ enabled: true }, null, plan), [])
    // …and the other half holds: an unresolved cue is silence plus a stated
    // note, and the render goes ahead.
    const pending = timeline([cue({ status: 'proposed' })])
    assert.deepEqual(assertSoundDesignReadiness({ enabled: true }, pending, plan), [])
    assert.equal(resolveRenderableSoundCues({ enabled: true }, pending, plan).skipped.length, 1)
    assert.deepEqual(assertSoundDesignReadiness({ enabled: true }, timeline([]), plan), [])
  })

  test('an older plan is a WARNING that names the rows, and an unknown state still refuses', () => {
    // v1.4.365 — this used to be an ERROR, so every Scene Plan re-run left the
    // whole sound timeline unsaveable. It is now a warning, and only for cues
    // that carry no scene anchor (a v1 cue, which cannot follow its scene).
    const stale = timeline([cue({ status: 'approved' })])
    stale.source_scene_plan_generated_at = 'older-plan'
    const issues = validateSoundDesignTimeline(stale, plan, stale.settings, { requireResolved: true })
    const older = issues.find(issue => /Scene Plan was rebuilt/.test(issue.detail))
    assert.ok(older, 'the older plan is still reported')
    assert.equal(older!.severity, 'warning', 'but it must not refuse the save')

    // An ANCHORED cue on the same old plan has nothing to report: it follows
    // its scene by construction.
    const anchored = timeline([cue({ status: 'approved', scene_id: 'scene-1', anchor_word: 'temple' })])
    anchored.source_scene_plan_generated_at = 'older-plan'
    assert.equal(validateSoundDesignTimeline(anchored, plan, anchored.settings).filter(issue => /rebuilt/.test(issue.detail)).length, 0)

    // An unknown state is a real defect and still refuses.
    const unknown = timeline([cue({ status: 'unknown' as any })])
    assert.ok(validateSoundDesignTimeline(unknown, plan, unknown.settings).some(issue => /unknown review status/.test(issue.detail)))
  })
})

test('Sound Design mix dynamically ducks beds and keeps exact spot timing', () => {
  const args = buildSoundDesignMixArgs({
    basePath: '/audio/base.wav', outPath: '/audio/mixed.mp3', ducking_profile: 'standard',
    cues: [
      { kind: 'bed', path: '/audio/room.wav', gain_db: -20, start_sec: 0, end_sec: 20 },
      { kind: 'spot', path: '/audio/door.wav', gain_db: -12, start_sec: 12.4 },
    ],
  })
  const graph = args[args.indexOf('-filter_complex') + 1]!
  assert.match(graph, /sidechaincompress=threshold=0\.045:ratio=5/)
  assert.match(graph, /adelay=12400:all=1/)
  assert.match(graph, /amix=inputs=3:duration=first:normalize=0/)
})

/**
 * v1.4.198 — an unmeasurable plan length is not a length of zero.
 *
 * `planDuration` was `Math.max(0, ...plan.scenes.map(s => Number(s.end_sec) || 0))`,
 * which answers 0 for a plan with no scenes. That 0 then acted as an authority:
 * every cue satisfies `start_sec >= 0`, so a good timeline was rejected with
 * "Cue start is outside the episode timeline" — a message that blames the cue
 * for a missing Scene Plan. AGENTS.md §6.
 */
describe('Sound Design when the Scene Plan supplies no length', () => {
  const emptyPlan = { generated_at: plan.generated_at, scenes: [] } as unknown as ScenePlan
  const unmeasuredPlan = {
    generated_at: plan.generated_at,
    scenes: [{ id: 'scene-1', start_sec: 0, end_sec: 0 }],
  } as unknown as ScenePlan

  test('an empty Scene Plan names the plan, not the cue', () => {
    const current = timeline([cue({ start_sec: 10 })])
    const issues = validateSoundDesignTimeline(current, emptyPlan, current.settings)

    assert.ok(
      issues.some(issue => /no measured scene timings/i.test(issue.detail)),
      'the missing length must be reported as the Scene Plan\'s problem',
    )
    assert.ok(
      !issues.some(issue => /outside the episode timeline/i.test(issue.detail)),
      'a valid cue must not be blamed for a Scene Plan that has no length',
    )
  })

  test('scene ends that are present but unmeasured are the same case', () => {
    const current = timeline([cue({ start_sec: 10 })])
    const issues = validateSoundDesignTimeline(current, unmeasuredPlan, current.settings)
    assert.ok(issues.some(issue => /no measured scene timings/i.test(issue.detail)))
    assert.ok(!issues.some(issue => /outside the episode timeline/i.test(issue.detail)))
  })

  test('a real length still rejects a cue past the end', () => {
    // Pins the non-zero case: a fix must not simply stop checking.
    const current = timeline([cue({ start_sec: 71 })])
    const issues = validateSoundDesignTimeline(current, plan, current.settings)
    assert.ok(issues.some(issue => /outside the episode timeline/i.test(issue.detail)))
    assert.ok(!issues.some(issue => /no measured scene timings/i.test(issue.detail)))
  })
})

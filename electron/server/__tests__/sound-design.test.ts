import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SOUND_DESIGN_SETTINGS,
  assertSoundDesignReadiness,
  normalizeSoundDesignSettings,
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

  test('requires every enabled cue to be approved or excluded', () => {
    const current = timeline([cue({ status: 'matched' })])
    const issues = validateSoundDesignTimeline(current, plan, current.settings, { requireResolved: true })
    assert.match(issues[0]!.detail, /approval or exclusion/)
    assert.throws(() => assertSoundDesignReadiness({ enabled: true }, current, plan), /Sound Design needs review/)
    assert.deepEqual(assertSoundDesignReadiness({ enabled: false }, current, plan), [])
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
    assert.ok(issues.some(issue => /local-library clip/.test(issue.detail)))
    assert.ok(issues.some(issue => /0.75 seconds/.test(issue.detail)))
    assert.ok(issues.some(issue => /outside/.test(issue.detail)))
  })

  // Same defect as Contextual Cues, found by auditing for the shape rather than
  // by waiting for a second report: the absence of a timeline was returned as a
  // validation issue, so switching an OPTIONAL feature on refused Final Video
  // on every episode that had never added a cue.
  test('an episode that never added a cue renders — nothing exists to resolve', () => {
    assert.deepEqual(validateSoundDesignTimeline(null, plan, DEFAULT_SOUND_DESIGN_SETTINGS, { requireResolved: true }), [])
    assert.deepEqual(assertSoundDesignReadiness({ enabled: true }, null, plan), [])
    // …and the other half still holds: a real timeline with an unresolved cue
    // is still someone's outstanding decision.
    const pending = timeline([cue({ status: 'proposed' })])
    assert.throws(() => assertSoundDesignReadiness({ enabled: true }, pending, plan), /Sound Design needs review/)
    assert.deepEqual(assertSoundDesignReadiness({ enabled: true }, timeline([]), plan), [])
  })

  test('rejects stale timelines and unknown cue states instead of silently mixing them', () => {
    const stale = timeline([cue({ status: 'unknown' as any })])
    stale.source_scene_plan_generated_at = 'older-plan'
    const issues = validateSoundDesignTimeline(stale, plan, stale.settings, { requireResolved: true })
    assert.ok(issues.some(issue => /older Scene Plan/.test(issue.detail)))
    assert.ok(issues.some(issue => /unknown review status/.test(issue.detail)))
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

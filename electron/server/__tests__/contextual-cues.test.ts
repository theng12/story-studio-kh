import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertContextualCueReadiness,
  autoApproveEligibleCues,
  normalizeContextualCueConfig,
  normalizeContextualCueProposalSettings,
  validateContextualCueTimeline,
} from '../services/contextual-cues.js'

const plan = {
  generated_at: '2026-07-26T00:00:00.000Z',
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6, transcript_segment: '', visual_prompt: '' },
    { id: 'scene-2', scene_index: 2, start_sec: 6, end_sec: 12, transcript_segment: '', visual_prompt: '' },
  ],
} as any

function cue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 0.2, end_sec: 3.5,
    title: 'Berlin', subtitle: '1919', kind: 'location_date', placement: 'top-right',
    template: 'documentary-label', entrance: 'fade', exit: 'dissolve', status: 'approved',
    created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z', ...overrides,
  } as any
}

describe('Contextual Cues contract', () => {
  test('disabled projects normalize to a zero-impact safe default', () => {
    assert.deepEqual(normalizeContextualCueConfig(undefined), {
      enabled: false,
      auto_approve_cues: false,
    })
  })

  test('auto_approve_cues normalizes to an explicit opt-in, never inferred', () => {
    assert.equal(normalizeContextualCueConfig({ enabled: true }).auto_approve_cues, false)
    assert.equal(normalizeContextualCueConfig({ enabled: true, auto_approve_cues: true }).auto_approve_cues, true)
    assert.equal(normalizeContextualCueConfig({ enabled: true, auto_approve_cues: 'true' }).auto_approve_cues, false)
  })

  test('proposal controls use their own safe defaults instead of Scene Plan settings', () => {
    assert.deepEqual(normalizeContextualCueProposalSettings(undefined), {
      model: '', density: 'restrained', placement: 'top-right', auto_approve: false,
    })
    assert.deepEqual(normalizeContextualCueProposalSettings({
      model: 'genstudio-current-text', density: 'editorial', placement: 'top-left', auto_approve: true,
    }), {
      model: 'genstudio-current-text', density: 'editorial', placement: 'top-left', auto_approve: true,
    })
  })

  test('enabled projects reject unresolved proposals before assembly', () => {
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [cue({ status: 'proposed' })] } as any
    assert.throws(() => assertContextualCueReadiness({ enabled: true, auto_approve_cues: false }, timeline, plan), /needs review/i)
  })

  test('pacing validator rejects overlap and subtitle-region collision', () => {
    const timeline = {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [cue({ placement: 'bottom-right' }), cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 3.8, end_sec: 7, title: 'Next' })],
    } as any
    const issues = validateContextualCueTimeline(timeline, plan, { subtitles: { enabled: true }, requireResolved: true } as any)
    assert.ok(issues.some(issue => /Bottom-corner/.test(issue.detail)))
    assert.ok(issues.some(issue => /overlaps or crowds/.test(issue.detail)))
  })

  test('all reviewed visual treatments are accepted, while unknown treatments are rejected', () => {
    for (const template of ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate']) {
      assert.equal(validateContextualCueTimeline({
        schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
        cues: [cue({ template })],
      } as any, plan).length, 0)
    }
    assert.ok(validateContextualCueTimeline({
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [cue({ template: 'mystery-template' })],
    } as any, plan).some(issue => /treatment is invalid/i.test(issue.detail)))
  })

  test('disabled feature does not block Video Assembly', () => {
    assert.deepEqual(assertContextualCueReadiness({ enabled: false, auto_approve_cues: false }, null, plan), [])
  })
})

describe('Automatic cue approval (auto_approve_cues)', () => {
  test('approves a candidate that clears every structural rule', () => {
    const candidate = cue({ status: 'proposed' }) // 0.2–3.5s in scene-1: valid duration, in-scene, fields.
    const result = autoApproveEligibleCues([candidate], [], plan)
    assert.equal(result.holds.length, 0)
    assert.equal(result.approvedCount, 1)
    assert.equal(result.cues[0]!.status, 'approved')
  })

  test('holds back a candidate whose duration fails the 2.25–4.5s readability rule', () => {
    const tooShort = cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 6.1, end_sec: 7.1, status: 'proposed' }) // 1.0s
    const tooLong = cue({ id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 0, end_sec: 5, status: 'proposed' }) // 5.0s
    for (const candidate of [tooShort, tooLong]) {
      const result = autoApproveEligibleCues([candidate], [], plan)
      assert.equal(result.approvedCount, 0)
      assert.equal(result.cues[0]!.status, 'proposed', 'stays proposed, never silently dropped')
      assert.equal(result.holds.length, 1)
      assert.equal(result.holds[0]!.cue_id, candidate.id)
      assert.ok(/readable for 2\.25.?4\.5 seconds/.test(result.holds[0]!.reasons.join(' ')))
    }
  })

  test('holds back a candidate whose timing falls outside its own scene', () => {
    // scene-2 spans 6–12s; this candidate starts before the scene begins.
    const candidate = cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 5, end_sec: 8.5, status: 'proposed' })
    const result = autoApproveEligibleCues([candidate], [], plan)
    assert.equal(result.approvedCount, 0)
    assert.equal(result.cues[0]!.status, 'proposed')
    assert.equal(result.holds[0]!.cue_id, candidate.id)
    assert.ok(/inside its scene timing/.test(result.holds[0]!.reasons.join(' ')))
  })

  test('holds back a candidate that crowds an already-approved cue from a prior run', () => {
    const protectedCue = cue({ status: 'approved' }) // scene-1, 0.2–3.5s, approved earlier.
    // Otherwise perfectly valid (in-scene, readable duration) but starts only
    // 0.1s after the protected cue ends — inside the required 0.5s gap.
    const candidate = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const result = autoApproveEligibleCues([candidate], [protectedCue], plan)
    assert.equal(result.approvedCount, 0)
    assert.equal(result.cues[0]!.status, 'proposed')
    assert.ok(/overlaps or crowds/.test(result.holds[0]!.reasons.join(' ')))
  })

  test('within one batch, an earlier-approved candidate can still block a later crowding one', () => {
    const first = cue({ status: 'proposed' }) // scene-1, 0.2–3.5s.
    const second = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const result = autoApproveEligibleCues([first, second], [], plan)
    assert.equal(result.approvedCount, 1)
    assert.equal(result.cues.find(c => c.id === first.id)!.status, 'approved')
    assert.equal(result.cues.find(c => c.id === second.id)!.status, 'proposed')
    assert.equal(result.holds.length, 1)
    assert.equal(result.holds[0]!.cue_id, second.id)
  })

  test('a disabled cue from a prior run never counts toward crowding', () => {
    const disabledCue = cue({ status: 'disabled' }) // scene-1, 0.2–3.5s, excluded from rendering.
    const candidate = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const result = autoApproveEligibleCues([candidate], [disabledCue], plan)
    assert.equal(result.holds.length, 0)
    assert.equal(result.cues[0]!.status, 'approved')
  })

  test('readiness no longer waits on a cue an automatic pass held back, but every other rule still applies', () => {
    // Structurally clean in every respect except that no one has approved or
    // excluded it yet — the one thing requireResolved checks for.
    const held = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const approved = cue({ status: 'approved' })
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [approved, held] } as any

    // Manual review (default: auto_approve_cues false) still requires resolution — unchanged.
    assert.throws(() => assertContextualCueReadiness({ enabled: true, auto_approve_cues: false }, timeline, plan), /needs review/i)

    // With auto_approve_cues on, the leftover 'proposed' cue no longer blocks Video Assembly...
    const ready = assertContextualCueReadiness({ enabled: true, auto_approve_cues: true }, timeline, plan)
    assert.deepEqual(ready, [approved])

    // ...but a cue with an unrelated structural problem still blocks it either way.
    const brokenTimeline = { ...timeline, cues: [approved, cue({ id: 'cue-broken', scene_id: 'scene-2', start_sec: 6, end_sec: 6.5, status: 'proposed' })] } as any
    assert.throws(() => assertContextualCueReadiness({ enabled: true, auto_approve_cues: true }, brokenTimeline, plan), /readable for/i)
  })
})

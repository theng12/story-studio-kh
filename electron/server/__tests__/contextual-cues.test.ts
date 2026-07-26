import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertContextualCueReadiness,
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
    })
  })

  test('proposal controls use their own safe defaults instead of Scene Plan settings', () => {
    assert.deepEqual(normalizeContextualCueProposalSettings(undefined), {
      model: '', density: 'restrained', placement: 'top-right',
    })
    assert.deepEqual(normalizeContextualCueProposalSettings({
      model: 'genstudio-current-text', density: 'editorial', placement: 'top-left',
    }), {
      model: 'genstudio-current-text', density: 'editorial', placement: 'top-left',
    })
  })

  test('enabled projects reject unresolved proposals before assembly', () => {
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [cue({ status: 'proposed' })] } as any
    assert.throws(() => assertContextualCueReadiness({ enabled: true }, timeline, plan), /needs review/i)
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

  test('disabled feature does not block Video Assembly', () => {
    assert.deepEqual(assertContextualCueReadiness({ enabled: false }, null, plan), [])
  })
})

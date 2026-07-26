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

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContinuityConfig, defaultContinuityConfig } from '../routes/continuity.js'

describe('continuity episode settings', () => {
  test('new state keeps legacy uniform pacing and defaults motion off at gentle level', () => {
    const config = defaultContinuityConfig()
    assert.deepEqual(config.pacing, { min_sec: 1, max_sec: 3 })
    assert.deepEqual(config.motion_scope, { mode: 'off' })
    assert.equal(config.motion_level, 2)
  })

  test('normalizes saved variable pacing and episode motion settings', () => {
    const config = buildContinuityConfig({
      schema_version: 1,
      pacing: {
        mode: 'variable',
        min_sec: 40,
        max_sec: 50,
        periods: [
          { start_sec: 0, end_sec: 30, min_sec: 1, max_sec: 3 },
          { start_sec: 30, end_sec: null, min_sec: 5, max_sec: 10 },
        ],
      },
      motion_scope: { mode: 'selected', scene_ids: ['scene-b', 'scene-b', 'scene-a'] },
      motion_level: 4,
    } as any)

    assert.deepEqual(config.pacing, {
      mode: 'variable',
      min_sec: 1,
      max_sec: 3,
      periods: [
        { start_sec: 0, end_sec: 30, min_sec: 1, max_sec: 3 },
        { start_sec: 30, end_sec: null, min_sec: 5, max_sec: 10 },
      ],
    })
    assert.deepEqual(config.motion_scope, { mode: 'selected', scene_ids: ['scene-b', 'scene-a'] })
    assert.equal(config.motion_level, 4)
  })

  test('rejects malformed explicitly supplied pacing, motion scope, and motion level', () => {
    assert.throws(
      () => buildContinuityConfig({ schema_version: 1, pacing: { min_sec: 0, max_sec: 3 } } as any),
      /pacing\.min_sec must be between 1 and 60 seconds/,
    )
    assert.throws(
      () => buildContinuityConfig({ schema_version: 1, motion_scope: { mode: 'opening', end_sec: 0 } } as any),
      /Motion scope needs a positive opening time/,
    )
    assert.throws(
      () => buildContinuityConfig({ schema_version: 1, motion_level: 5 } as any),
      /motion_level must be a whole number from 1 to 4/,
    )
  })
})

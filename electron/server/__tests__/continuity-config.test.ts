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

  test('v1.4.358 — a 2,751-character style_bible round-trips through buildContinuityConfig unchanged (production defect MANU2-NATIVE-20261025T115324Z-092ce216)', async () => {
    // AGENTS.md §1: a limit must come from the selected model's published
    // max_prompt_characters, never a Story Studio constant. The fixed 2,000
    // cap was removed from buildContinuityConfig. The real ceiling is
    // enforced at prompt assembly time by promptBudget() in scene-plan.ts.
    const longStyleBible = 'x'.repeat(2751)
    const longNegative = 'y'.repeat(1500)
    const config = buildContinuityConfig({
      schema_version: 1,
      style_bible: longStyleBible,
      negative_prompt: longNegative,
    } as any)
    assert.equal(config.style_bible, longStyleBible,
      'style_bible must survive the save boundary unchanged — silent truncation was the production defect')
    assert.equal(config.style_bible!.length, 2751)
    assert.equal(config.negative_prompt, longNegative,
      'negative_prompt must also survive unchanged — it had a 1,000-char cap too')
    assert.equal(config.negative_prompt!.length, 1500)
  })

  test('v1.4.358 — whitespace-only style_bible is trimmed but not otherwise truncated', () => {
    const config = buildContinuityConfig({
      schema_version: 1,
      style_bible: '  some style text  ',
      negative_prompt: '  bad things  ',
    } as any)
    assert.equal(config.style_bible, 'some style text')
    assert.equal(config.negative_prompt, 'bad things')
  })

  test('v1.4.358 — non-string style_bible becomes empty string, never coerced', () => {
    const config = buildContinuityConfig({
      schema_version: 1,
      style_bible: 42,
      negative_prompt: ['array'],
    } as any)
    assert.equal(config.style_bible, '')
    assert.equal(config.negative_prompt, '')
  })
})

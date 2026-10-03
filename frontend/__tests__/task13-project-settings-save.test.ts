import assert from 'node:assert/strict'
import test from 'node:test'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

test('publishing save serializes Use app default as an explicit inherit sentinel', () => {
  const plan = projectSettingsSavePlan('publishing', {
    category_id: 0,
  } as any, 0)

  assert.deepEqual(plan.config, {
    category_id: undefined,
    mark_as_ai_generated: null,
  })
  assert.equal(JSON.parse(JSON.stringify(plan.config)).mark_as_ai_generated, null)
})

test('publishing save keeps explicit AI-disclosure overrides intact', () => {
  for (const expected of [true, false]) {
    const plan = projectSettingsSavePlan('publishing', {
        mark_as_ai_generated: expected,
    }, 0)
    assert.equal(plan.config?.mark_as_ai_generated, expected)
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import { resolveMotionProfile } from '../services/motion-profiles.js'
import { resolveRecencyStrategy } from '../services/recency-strategies.js'

describe('Content Pack app-owned behavior registries', () => {
  test('resolves scripture-references to the current Prayer extraction and instruction behavior', async () => {
    const prayer = JSON.parse(await readFile(new URL('../niches/prayer.json', import.meta.url), 'utf8'))
    const strategy = resolveRecencyStrategy('scripture-references')
    assert.deepEqual(strategy.extractPatterns, prayer.recencyAvoidance.extractPatterns)
    assert.equal(strategy.instructionTemplate, prayer.recencyAvoidance.instructionTemplate)
  })

  test('resolves each Pastoral Scripture mode to its own legacy recency behavior', async () => {
    for (const [id, legacyId] of [
      ['pastoral-daily-reflection-scripture', 'devotional'],
      ['pastoral-expository-teaching-scripture', 'preaching'],
    ] as const) {
      const legacy = JSON.parse(await readFile(new URL(`../niches/${legacyId}.json`, import.meta.url), 'utf8'))
      const strategy = resolveRecencyStrategy(id)
      assert.deepEqual(strategy.extractPatterns, legacy.recencyAvoidance.extractPatterns)
      assert.equal(strategy.instructionTemplate, legacy.recencyAvoidance.instructionTemplate)
    }
  })

  test('resolves ambient-documentary to the current Deep Time motion profile', async () => {
    const deepTime = JSON.parse(await readFile(new URL('../niches/deep-time-documentary.json', import.meta.url), 'utf8'))
    assert.deepEqual(resolveMotionProfile('ambient-documentary'), deepTime.scriptStructure.motionProfile)
  })

  test('fails closed for unregistered behavior IDs', () => {
    assert.throws(() => resolveRecencyStrategy('unknown-strategy'), /unknown recency strategy/i)
    assert.throws(() => resolveMotionProfile('unknown-motion'), /unknown motion profile/i)
  })
})

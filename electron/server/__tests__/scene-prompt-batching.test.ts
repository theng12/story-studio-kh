import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  parseScenePromptPackSetting,
  parseScenePromptTokenSetting,
  maxSafeScenePromptPackSize,
  resolveScenePromptPackSize,
  resolveScenePromptTokenBudget,
} from '../services/scene-prompt-batching.js'

describe('adaptive scene prompt batching', () => {
  test('uses the live GenStudio output allowance, not legacy provider tiers', () => {
    assert.equal(maxSafeScenePromptPackSize(4_096), 10)
    assert.equal(maxSafeScenePromptPackSize(8_192), 20)
    assert.equal(maxSafeScenePromptPackSize(16_384), 40)
    assert.equal(maxSafeScenePromptPackSize(32_768), 50)
    assert.equal(resolveScenePromptPackSize(8_192, 'auto'), 20)
    assert.equal(resolveScenePromptPackSize(4_096, 30), 10)
    assert.equal(resolveScenePromptPackSize(16_384, 30), 30)
    assert.equal(resolveScenePromptPackSize(8_192, 12), 12)
  })

  test('uses the model maximum automatically and never requests more than it publishes', () => {
    assert.equal(resolveScenePromptTokenBudget(4_096, 'auto'), 4096)
    assert.equal(resolveScenePromptTokenBudget(8_192, 'auto'), 8192)
    assert.equal(resolveScenePromptTokenBudget(8_192, 16_384), 8192)
    assert.equal(resolveScenePromptTokenBudget(16_384, 6144), 6144)
  })

  test('accepts every supported cloud preset and safe custom values', () => {
    for (const size of [1, 3, 5, 10, 15, 20, 25, 30, 50]) {
      assert.equal(parseScenePromptPackSetting(size), size)
    }
    assert.equal(parseScenePromptPackSetting('12'), 12)
  })

  test('invalid persisted settings self-heal to auto', () => {
    assert.equal(parseScenePromptPackSetting(100), 'auto')
    assert.equal(parseScenePromptPackSetting(0), 'auto')
    assert.equal(parseScenePromptPackSetting(7.5), 'auto')
    assert.equal(parseScenePromptPackSetting('20'), 20)
    assert.equal(parseScenePromptTokenSetting(0), 'auto')
    assert.equal(parseScenePromptTokenSetting(-1), 'auto')
    assert.equal(parseScenePromptTokenSetting(8_192.5), 'auto')
    assert.equal(parseScenePromptTokenSetting('nonsense'), 'auto')
    assert.equal(parseScenePromptTokenSetting(32768), 32768)
    assert.equal(parseScenePromptTokenSetting('8192'), 8192)
  })

  /**
   * An allowance is NOT validated against a fixed ladder any more. It used to
   * be, and that quietly discarded any value the ladder had not anticipated —
   * including every allowance only a large product can offer. What is legal
   * belongs to the SELECTED product, so parsing keeps any positive whole
   * number and `resolveScenePromptTokenBudget` clamps it to the live maximum.
   */
  test('an off-ladder allowance is kept and clamped, not thrown away', () => {
    assert.equal(parseScenePromptTokenSetting(32_000), 32_000)
    assert.equal(parseScenePromptTokenSetting(128_000), 128_000)
    // Usable in full on a product that publishes at least that much…
    assert.equal(resolveScenePromptTokenBudget(128_000, 128_000), 128_000)
    assert.equal(resolveScenePromptTokenBudget(1_050_000, 128_000), 128_000)
    // …and clamped down, never rejected, on one that publishes less.
    assert.equal(resolveScenePromptTokenBudget(32_768, 128_000), 32_768)
  })

  test('no 32,768 ceiling survives: a big product is asked for its full allowance', () => {
    assert.equal(resolveScenePromptTokenBudget(128_000, 'auto'), 128_000)
    assert.equal(resolveScenePromptTokenBudget(65_536, 'auto'), 65_536)
  })
})

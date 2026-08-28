import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SCENE_PROMPT_PACK_TUNING_DEFAULTS,
  automaticScenePromptPackSize,
  describeScenePromptPackSize,
  parseScenePromptPackSetting,
  parseScenePromptPackTuning,
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

  test('accepts every offered preset and any safe custom value', () => {
    for (const size of [1, 5, 10, 25, 50, 100, 250, 500]) {
      assert.equal(parseScenePromptPackSetting(size), size)
    }
    assert.equal(parseScenePromptPackSetting('12'), 12)
  })

  test('an absent setting is auto; nothing else is guessed at', () => {
    assert.equal(parseScenePromptPackSetting(undefined), 'auto')
    assert.equal(parseScenePromptPackSetting(null), 'auto')
    assert.equal(parseScenePromptPackSetting(''), 'auto')
    assert.equal(parseScenePromptPackSetting('auto'), 'auto')
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

/**
 * The defect this suite exists to hold shut.
 *
 * `maxSafeScenePromptPackSize` derived a correct number from the model's
 * published output allowance and then ran it through
 * `Math.min(SCENE_PROMPT_PACK_MAX, …)` with `SCENE_PROMPT_PACK_MAX = 50`. That
 * clamp bound for any model publishing 20,000 output tokens or more — every
 * serious model — so the panel's "Model-aware" badge was decoration.
 *
 * The numbers below are not guesses. Across 85,411 real scene prompts in 447
 * episodes and 8 channels, one emitted scene object costs a median 149 tokens,
 * p90 229, p95 260, p99 330, worst-ever 561. Fifty scenes is 3% of a
 * 384,000-token allowance, and the library recorded zero "provider hit its
 * output limit" events. The cap was never protecting anything.
 */
describe('the 50-scene cap is gone and cannot come back', () => {
  test('a large-output model gets its full derived batch, not 50', () => {
    // 384,000 × 0.75 ÷ 300 = 960. The old code returned 50 here.
    assert.equal(maxSafeScenePromptPackSize(384_000), 960)
    assert.equal(maxSafeScenePromptPackSize(128_000), 320)
    assert.equal(maxSafeScenePromptPackSize(1_000_000), 2_500)
    // The clamp bound from ~20,000 tokens upward, which is why it was invisible
    // in the old suite: every case it tested sat under the threshold.
    assert.ok(maxSafeScenePromptPackSize(32_768) > 50)
  })

  test('a value above the old ceiling is honoured, not rewritten', () => {
    assert.equal(parseScenePromptPackSetting(51), 51)
    assert.equal(parseScenePromptPackSetting(250), 250)
    assert.equal(parseScenePromptPackSetting(960), 960)
    assert.equal(parseScenePromptPackSetting(5_000), 5_000)
    // …and it survives resolution against a model that can return it.
    assert.equal(resolveScenePromptPackSize(384_000, 250), 250)
    assert.equal(resolveScenePromptPackSize(384_000, 900), 900)
  })

  test('an unusable value is reported, never silently replaced', () => {
    for (const bad of [0, -5, 7.5, 'nonsense', {}, [], true]) {
      assert.throws(
        () => parseScenePromptPackSetting(bad),
        /Scenes per request must be "auto" or a whole number/,
        `expected ${JSON.stringify(bad)} to be reported`,
      )
    }
    // The old behaviour: 100 became 'auto', which resolved back to 50, and the
    // caller was told nothing at all.
    assert.throws(() => parseScenePromptPackSetting(0), /Nothing was substituted/)
  })

  test('an explicit choice larger than the model allows is reduced OUT LOUD', () => {
    // The reduction itself is legitimate — exceeding it truncates the JSON —
    // but it is described rather than performed in silence.
    assert.equal(resolveScenePromptPackSize(8_192, 900), 20)
    const line = describeScenePromptPackSize(8_192, 900)
    assert.match(line, /900 was requested/)
    assert.match(line, /can only return 20 complete/)
    // No reduction, no complaint.
    assert.match(describeScenePromptPackSize(384_000, 250), /250 scenes per request \(requested/)
  })
})

/**
 * The owner's two-field pattern: an allowance he edits, and a dial with no code
 * maximum. Defaults reproduce today's behaviour exactly; every one of them is
 * a project-config key he can change without a release.
 */
describe('batch tuning is the owner\'s data, not a constant', () => {
  test('defaults match the documented numbers', () => {
    assert.deepEqual({ ...SCENE_PROMPT_PACK_TUNING_DEFAULTS }, {
      tokensPerScene: 300,
      safetyFraction: 0.75,
      batchSize: 250,
    })
    assert.deepEqual(parseScenePromptPackTuning(undefined), { ...SCENE_PROMPT_PACK_TUNING_DEFAULTS })
    assert.deepEqual(parseScenePromptPackTuning({}), { ...SCENE_PROMPT_PACK_TUNING_DEFAULTS })
  })

  /**
   * 250 is a WALL-CLOCK judgement, not a token limit: the arithmetic permits
   * 960, but a 220,000-token response must sustain ~185 tok/s to land inside
   * the 20-minute GenStudio submit timeout, and that throughput is unverified.
   */
  test('automatic is the owner default of 250, not the derived 960', () => {
    assert.equal(maxSafeScenePromptPackSize(384_000), 960)
    assert.equal(automaticScenePromptPackSize(384_000), 250)
    assert.equal(resolveScenePromptPackSize(384_000, 'auto'), 250)
    // A model that cannot reach 250 falls back to what it CAN return.
    assert.equal(automaticScenePromptPackSize(8_192), 20)
    assert.equal(resolveScenePromptPackSize(8_192, 'auto'), 20)
  })

  test('each field is read from project config independently', () => {
    assert.deepEqual(parseScenePromptPackTuning({ scene_prompt_batch_size: 900 }), {
      tokensPerScene: 300, safetyFraction: 0.75, batchSize: 900,
    })
    assert.deepEqual(parseScenePromptPackTuning({ scene_prompt_tokens_per_scene: 229 }), {
      tokensPerScene: 229, safetyFraction: 0.75, batchSize: 250,
    })
    assert.deepEqual(parseScenePromptPackTuning({ scene_prompt_output_safety_fraction: 0.9 }), {
      tokensPerScene: 300, safetyFraction: 0.9, batchSize: 250,
    })
    // An unusable field falls back to its own default and leaves the rest alone.
    assert.deepEqual(parseScenePromptPackTuning({
      scene_prompt_batch_size: 'nonsense',
      scene_prompt_output_safety_fraction: 4,
      scene_prompt_tokens_per_scene: 500,
    }), { tokensPerScene: 500, safetyFraction: 0.75, batchSize: 250 })
  })

  test('there is no code maximum on anything the owner sets', () => {
    const wideOpen = parseScenePromptPackTuning({ scene_prompt_batch_size: 100_000 })
    assert.equal(wideOpen.batchSize, 100_000)
    // Raising the batch default alone raises what Automatic sends, up to what
    // the chosen model can actually return complete.
    assert.equal(automaticScenePromptPackSize(384_000, wideOpen), 960)
    // Lowering the per-scene reservation raises the derived ceiling with it.
    const measured = parseScenePromptPackTuning({ scene_prompt_tokens_per_scene: 229 })
    assert.equal(maxSafeScenePromptPackSize(384_000, measured), 1_257)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_AUDIO_MODELS } from '../models/defaults.js'

const expectedPrices: Record<string, number> = {
  eleven_v3: 0.10,
  eleven_multilingual_v2: 0.10,
  eleven_turbo_v2_5: 0.05,
  eleven_flash_v2_5: 0.05,
  'turbo-v2.5': 0.05,
  'multilingual-v2': 0.10,
  'eleven-v3': 0.10,
  'genaipro-multilingual-v2': 0.022,
  'genaipro-turbo-v2.5': 0.022,
  'genaipro-flash-v2.5': 0.022,
  'genaipro-v3': 0.022,
  'kie-eleven-turbo-v2.5': 0.03,
  'kie-eleven-multilingual-v2': 0.06,
  'kie-eleven-v3': 0.07,
}

describe('recorded TTS model pricing', () => {
  for (const [modelId, expectedPrice] of Object.entries(expectedPrices)) {
    it(`${modelId} costs $${expectedPrice} per 1K characters`, () => {
      assert.equal(DEFAULT_AUDIO_MODELS[modelId]?.cost_per_1k_chars, expectedPrice)
    })
  }
})

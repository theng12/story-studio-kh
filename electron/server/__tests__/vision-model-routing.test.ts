import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isBrollVisionModelSupported } from '../lib/vision-client.js'

describe('B-Roll vision model routing', () => {
  test('accepts the supported OpenAI vision families', () => {
    for (const model of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-5',
      'gpt-5-mini',
    ]) {
      assert.equal(isBrollVisionModelSupported(model), true, model)
    }
  })

  test('accepts dynamically discovered LM Studio models', () => {
    assert.equal(isBrollVisionModelSupported('lmstudio:qwen2.5-vl-7b'), true)
  })

  test('rejects text-only and reasoning model selections', () => {
    for (const model of [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-openrouter',
      'o3',
      'o4-mini',
      '',
    ]) {
      assert.equal(isBrollVisionModelSupported(model), false, model)
    }
  })
})

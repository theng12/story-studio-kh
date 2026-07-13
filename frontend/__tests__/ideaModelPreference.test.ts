import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  latestGeneratedIdeaModel,
  resolveInitialIdeaModel,
} from '../utils/idea-model-preference.js'

describe('Ideas Generator model preference', () => {
  test('the last explicit choice wins across projects', () => {
    assert.equal(resolveInitialIdeaModel({
      rememberedModel: 'chatstudio:provider:deepseek-v4-flash',
      ideas: [{ model_used: 'claude-sonnet-4-6', batch_id: 'batch-2' }],
      legacyProjectModel: 'gpt-4o',
    }), 'chatstudio:provider:deepseek-v4-flash')
  })

  test('real generation history heals the polluted GPT-4o project default', () => {
    assert.equal(resolveInitialIdeaModel({
      ideas: [
        { model_used: 'gpt-4.1', batch_id: 'batch-1' },
        { model_used: 'paste-import', batch_id: 'batch-2' },
        { model_used: 'deepseek-v4-flash', batch_id: 'batch-3' },
      ],
      legacyProjectModel: 'gpt-4o',
    }), 'deepseek-v4-flash')
  })

  test('imports and manual additions do not masquerade as model choices', () => {
    assert.equal(latestGeneratedIdeaModel([
      { model_used: 'deepseek-v4-flash', batch_id: 'batch-1' },
      { model_used: 'paste-import', batch_id: 'batch-2' },
      { model_used: 'manual', batch_id: 'batch-3' },
      { model_used: 'claude-sonnet-4-6', batch_id: 'imported' },
    ]), 'deepseek-v4-flash')
  })

  test('GPT-4o is never revived solely from the old hardcoded default', () => {
    assert.equal(resolveInitialIdeaModel({ legacyProjectModel: 'gpt-4o' }), '')
  })

  test('a non-polluted legacy choice remains a valid migration fallback', () => {
    assert.equal(resolveInitialIdeaModel({
      legacyProjectModel: 'lmstudio:gemma-4-e2b-it-mlx',
    }), 'lmstudio:gemma-4-e2b-it-mlx')
  })
})

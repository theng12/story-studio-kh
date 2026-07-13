import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  parseScenePromptPackSetting,
  parseScenePromptTokenSetting,
  resolveScenePromptCostTier,
  resolveScenePromptPackSize,
  resolveScenePromptTokenBudget,
} from '../services/scene-prompt-batching.js'

describe('adaptive scene prompt batching', () => {
  test('classifies known local and cloud model ids conservatively', () => {
    assert.equal(resolveScenePromptCostTier('chatstudio:mlx-community/model', 'paid'), 'local')
    assert.equal(resolveScenePromptCostTier('chatstudio:provider:openrouter:model'), 'free')
    assert.equal(resolveScenePromptCostTier('chatstudio:provider:openrouter:model', 'paid'), 'paid')
    assert.equal(resolveScenePromptCostTier('openai:gpt-5'), 'paid')
  })

  test('defaults to 10 local/free and 20 paid with tier-specific hard caps', () => {
    assert.equal(resolveScenePromptPackSize('local', 'auto'), 10)
    assert.equal(resolveScenePromptPackSize('free', 'auto'), 10)
    assert.equal(resolveScenePromptPackSize('paid', 'auto'), 20)
    assert.equal(resolveScenePromptPackSize('local', 30), 10)
    assert.equal(resolveScenePromptPackSize('free', 20), 10)
    assert.equal(resolveScenePromptPackSize('paid', 30), 30)
  })

  test('uses adaptive output budgets and protects larger paid packs', () => {
    assert.equal(resolveScenePromptTokenBudget('local', 'auto', 10), 4096)
    assert.equal(resolveScenePromptTokenBudget('free', 'auto', 10), 4096)
    assert.equal(resolveScenePromptTokenBudget('paid', 'auto', 20), 8192)
    assert.equal(resolveScenePromptTokenBudget('paid', 4096, 20), 8192)
    assert.equal(resolveScenePromptTokenBudget('paid', 6144, 10), 6144)
  })

  test('invalid persisted settings self-heal to auto', () => {
    assert.equal(parseScenePromptPackSetting(100), 'auto')
    assert.equal(parseScenePromptPackSetting('20'), 20)
    assert.equal(parseScenePromptTokenSetting(32000), 'auto')
    assert.equal(parseScenePromptTokenSetting('8192'), 8192)
  })
})

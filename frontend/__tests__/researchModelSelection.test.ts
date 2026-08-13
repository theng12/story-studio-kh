import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveResearchModelForRun } from '../utils/research-model-selection.ts'

test('model-knowledge research cannot run without its explicit model selection', () => {
  assert.deepEqual(resolveResearchModelForRun('model-knowledge', '', 'web-economy'), {
    model: null,
    reason: 'Choose a research model',
  })
})

test('web research cannot run without its separate explicit model selection', () => {
  assert.deepEqual(resolveResearchModelForRun('web-search', 'chat-economy', ''), {
    model: null,
    reason: 'Choose a web-research model',
  })
})

test('research submits only the active mode model', () => {
  assert.deepEqual(resolveResearchModelForRun('model-knowledge', ' chat-economy ', 'web-premium'), {
    model: 'chat-economy',
    reason: '',
  })
  assert.deepEqual(resolveResearchModelForRun('web-search', 'chat-premium', ' web-economy '), {
    model: 'web-economy',
    reason: '',
  })
})

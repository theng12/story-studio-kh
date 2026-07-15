import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCreativeParameters } from '../routes/ideas.js'
import type { GenerateIdeasRequest } from '../models/types.js'

function request(overrides: Partial<GenerateIdeasRequest> = {}): GenerateIdeasRequest {
  return {
    genre: '',
    audience: '',
    mood: '',
    count: 5,
    model: 'test-model',
    ...overrides,
  }
}

describe('Ideas creative brief prompt', () => {
  test('blank refinements do not restore restrictive genre or mood defaults', () => {
    const block = buildCreativeParameters(request())
    assert.match(block, /Genre: model chooses freely/)
    assert.match(block, /Mood\/tone: model chooses freely/)
    assert.match(block, /Target audience: model chooses freely/)
    assert.doesNotMatch(block, /fantasy|calming|adults/i)
  })

  test('uses channel audience context while leaving other choices open', () => {
    const block = buildCreativeParameters(request(), 'curious general audience')
    assert.match(block, /Target audience: curious general audience/)
    assert.match(block, /Theme: model chooses freely/)
  })

  test('adds deduplicated creative lenses as inspiration rather than rules', () => {
    const block = buildCreativeParameters(request({
      creative_lenses: ['Challenge the obvious angle', 'Challenge the obvious angle', 'Human-first stakes'],
    }))
    assert.match(block, /Creative lenses \(use as inspiration, not a formula\)/)
    assert.equal(block.match(/Challenge the obvious angle/g)?.length, 1)
    assert.match(block, /Human-first stakes/)
  })
})

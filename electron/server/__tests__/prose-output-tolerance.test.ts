/**
 * Prose workflows (Idea Campaign, Metadata, Research, Scene Planner helpers) must
 * not throw away an answer GenStudio already completed and charged for.
 *
 * Regression: v1.0.758 failed a real Idea Campaign run with "GenStudio prose output
 * did not match its safe response wrapper." The product (Gemini 3.1 Flash-Lite)
 * answered correctly but did not wrap its prose in the {"text": ...} envelope. That
 * envelope is transport packaging required by the language-product endpoint, not a
 * requirement of the workflow — prose has no schema, so any readable answer is valid.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { validateStructuredOutput, type TextOutputContract } from '../lib/json-output-contract.js'

const PROSE: TextOutputContract = { mode: 'prose' }

function proseText(raw: string): string {
  return (validateStructuredOutput(raw, PROSE) as { text: string }).text
}

describe('prose output tolerance', () => {
  test('unwraps the {"text": ...} envelope when the product supplies it', () => {
    assert.equal(proseText(JSON.stringify({ text: 'Five idea titles.' })), 'Five idea titles.')
  })

  test('ignores extra keys alongside the envelope rather than rejecting the answer', () => {
    assert.equal(
      proseText(JSON.stringify({ text: 'Kept.', note: 'chatter the product added' })),
      'Kept.',
    )
  })

  test('accepts plain prose the product returned without any envelope', () => {
    // The exact shape that broke the real Idea Campaign run.
    assert.equal(proseText('Just some prose about deep time.'), 'Just some prose about deep time.')
  })

  test('accepts markdown prose', () => {
    assert.equal(proseText('## Ideas\n1. Something'), '## Ideas\n1. Something')
  })

  test('accepts well-formed JSON that is not the envelope, as literal text', () => {
    assert.equal(proseText('[{"a":1}]'), '[{"a":1}]')
  })

  test('trims surrounding whitespace', () => {
    assert.equal(proseText('  spaced out  '), 'spaced out')
  })

  test('still fails an genuinely empty response', () => {
    assert.throws(() => validateStructuredOutput('   ', PROSE), /empty response/i)
  })

  test('the empty-response error never claims the request was uncharged', () => {
    // This failure happens AFTER the product completed the request.
    try {
      validateStructuredOutput('', PROSE)
      assert.fail('expected a throw')
    } catch (error) {
      assert.doesNotMatch(
        (error as Error).message,
        /no request or credit charge|uncharged|not charged|without charge/i,
      )
    }
  })

  test('structured contracts are unaffected and still enforce their schema', () => {
    const contract: TextOutputContract = {
      mode: 'json_object',
      name: 'demo',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    }
    assert.deepEqual(validateStructuredOutput(JSON.stringify({ title: 'ok' }), contract), { title: 'ok' })
    assert.throws(() => validateStructuredOutput('plain prose', contract), /invalid JSON/i)
    assert.throws(() => validateStructuredOutput(JSON.stringify({ wrong: 1 }), contract), /did not match/i)
  })
})

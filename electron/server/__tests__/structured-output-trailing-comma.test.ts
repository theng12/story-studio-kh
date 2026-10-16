/**
 * A completed Gateway answer with a trailing comma must be usable (DM0008, 2026-10-16).
 *
 * The pool answered a complete 18-chapter outline (finish_reason "stop", 3,925 tokens) with ONE
 * `],\n    }` after chapter 2. `parseJsonOutput` is the first gate every JSON-contract answer
 * passes, and it was strict, so the whole answer was rejected locally. Every retry then replayed
 * the same Gateway job by its idempotency key and was rejected the same way, while the lenient
 * `parseStructuredJson` further down was never reached.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { outlineOutputContract } from '../lib/story-output-contracts.js'
import { parseJsonOutput, validateStructuredOutput } from '../lib/json-output-contract.js'

const chapter = (n: number) => ({ n, title: `Chapter ${n}`, synopsis: 'A short plan.', key_beats: ['a', 'b', 'c'] })
const outline = Array.from({ length: 18 }, (_, i) => chapter(i + 1))

describe('trailing commas in a completed structured answer', () => {
  test('the DM0008 shape: a trailing comma closing an array and an object is accepted', () => {
    const body = JSON.stringify({ chapters: outline }, null, 2)
    // Break chapter 1's key_beats / object closers the way the model did.
    const damaged = body.replace('"c"\n      ]\n    },', '"c"\n      ],\n    },')
    assert.notEqual(damaged, body)
    assert.throws(() => JSON.parse(damaged))
    const value = validateStructuredOutput(damaged, outlineOutputContract(18, 36)) as { chapters: unknown[] }
    assert.equal(value.chapters.length, 18)
  })

  test('only commas outside strings are dropped', () => {
    assert.deepEqual(parseJsonOutput('{"a": "x,] and ,}", "b": [1, 2,],}'), { a: 'x,] and ,}', b: [1, 2] })
  })

  test('a truncated answer is still rejected, never completed', () => {
    assert.throws(() => parseJsonOutput('{"chapters": [{"n": 1},'), /invalid JSON/)
  })

  test('other malformed JSON is still rejected', () => {
    assert.throws(() => parseJsonOutput('{"a": 1 "b": 2}'), /invalid JSON/)
    assert.throws(() => parseJsonOutput('{"a": 1,, "b": 2}'), /invalid JSON/)
  })

  test('the schema still decides after the repair', () => {
    assert.throws(
      () => validateStructuredOutput('{"chapters": [{"n": 1,},]}', outlineOutputContract(18, 36)),
      /did not match the story_outline response schema/,
    )
  })
})

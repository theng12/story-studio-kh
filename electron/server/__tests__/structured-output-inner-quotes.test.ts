/**
 * A completed Gateway answer whose string values carry UNESCAPED double quotes must be usable
 * (Nature EP0013, 2026-10-19).
 *
 * The pool answered the `story_thumbnail_prompts` contract (3 thumbnails) with `finish_reason`
 * "stop" and a complete object, but every `prompt` put the episode's headline in bare quotes:
 * `render the headline "OLD ROOFLINE" printed once`. That is not valid JSON, so `parseJsonOutput`
 * rejected the whole paid answer — and because the chat idempotency key is derived from request
 * content, every retry replayed the same Gateway job and was rejected the same way until the
 * retry budget ran out (3/3). Same loop as DM0008.
 *
 * The repair is deliberately narrow: a `"` inside a string can only be the terminator when the
 * next non-whitespace character is `,`, `}`, `]` or `:` — the only tokens JSON allows after a
 * string — so any other `"` there is an unescaped inner quote. A document with no inner quotes
 * comes back byte-identical.
 *
 * The `REAL_ANSWER` fixture below is the verbatim production text for the first thumbnail
 * (job 72570b56, Gateway key story-chat-b9559ad8…), with only the second and third entries and
 * the array/object closers removed.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseJsonOutput, validateStructuredOutput } from '../lib/json-output-contract.js'

const REAL_ANSWER = `{
  "thumbnails": [
    {
      "number": 1,
      "title": "OLD ROOFLINE",
      "prompt": "Create a wide 16:9 landscape format cinematic illustration. On the left third, place the defining focal subject: a large, detailed close-up of an eighteenth-century farmhouse roofline in Shropshire, showing weathered grey stone tiles and heavy oak timbers against the dusk. In the upper-right corner, feature a soft map of the Shropshire rolling pastureland and river valley with no labels or arrows. In the narrow lower-right strip, depict a calm scene of the stream flowing through the bottom of the meadow with fine white mist rising. In the lower-left title zone, render the headline "OLD ROOFLINE" printed once, spelled exactly letter for letter, large bold letters about one sixth of the image height. Soft dreamy painterly fantasy illustration, storybook gouache and watercolour textures, gentle pastel moonlight and warm luminous lantern glow, hazy atmosphere, cosy and peaceful, calm composition, muted lavender, indigo and warm amber palette, no harsh contrast."
    }
  ]
}`

const contract = { mode: 'json_object', name: 'story_thumbnail_prompts', schema: { type: 'object' } } as const

describe('unescaped quotes inside a completed structured answer', () => {
  test('the EP0013 answer parses, with the headline text intact', () => {
    assert.throws(() => JSON.parse(REAL_ANSWER), 'the real answer is not valid JSON')
    const value = parseJsonOutput(REAL_ANSWER) as { thumbnails: Array<{ title: string; prompt: string }> }
    assert.equal(value.thumbnails.length, 1)
    assert.equal(value.thumbnails[0]!.title, 'OLD ROOFLINE')
    assert.match(value.thumbnails[0]!.prompt, /render the headline "OLD ROOFLINE" printed once/)
    // The whole prompt survives — nothing was truncated at the first inner quote.
    assert.match(value.thumbnails[0]!.prompt, /no harsh contrast\.$/)
  })

  test('the same answer is accepted through the full contract gate', () => {
    const value = validateStructuredOutput(REAL_ANSWER, contract) as { thumbnails: unknown[] }
    assert.equal(value.thumbnails.length, 1)
  })

  test('valid JSON is never touched', () => {
    assert.deepEqual(parseJsonOutput('{"a": "x", "b": [1, 2]}'), { a: 'x', b: [1, 2] })
    // A `"` followed by `:` is a key's terminator, not an inner quote.
    assert.deepEqual(parseJsonOutput('{"a": {"b": "c"}}'), { a: { b: 'c' } })
    // An already-escaped quote stays escaped.
    assert.deepEqual(parseJsonOutput('{"a": "say \\"hi\\""}'), { a: 'say "hi"' })
  })

  test('an inner quote right before a comma is still refused, never silently mis-split', () => {
    // `"stop"` here is followed by `,`, which the repair cannot tell from a real terminator.
    // The mis-split produces a document that will not parse, so the answer is rejected rather
    // than rewritten into something the model did not say.
    assert.throws(() => parseJsonOutput('{"a": "he said "stop", then left."}'), /invalid JSON/)
  })

  test('other malformed JSON is still rejected', () => {
    assert.throws(() => parseJsonOutput('{"thumbnails": [{"number": 1},'), /invalid JSON/)
    assert.throws(() => parseJsonOutput('{"a": 1 "b": 2}'), /invalid JSON/)
  })

  test('trailing commas are still forgiven, and the schema still decides after both repairs', () => {
    assert.deepEqual(parseJsonOutput('{"a": "x,] and ,}", "b": [1, 2,],}'), { a: 'x,] and ,}', b: [1, 2] })
    assert.throws(
      () => validateStructuredOutput('{"thumbnails": [{"title": "bare "quote""}],}', {
        mode: 'json_object',
        name: 'story_thumbnail_prompts',
        schema: { type: 'object', required: ['thumbnails', 'missing_key'] },
      } as never),
      /did not match the story_thumbnail_prompts response schema/,
    )
  })
})

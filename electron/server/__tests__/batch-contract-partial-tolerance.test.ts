/**
 * The three batch contracts that still demanded `minItems === maxItems` after
 * the scene prompt pack was fixed (060ac5e) — and what each of them should do
 * about it, which is NOT the same answer three times.
 *
 * The defect class: an atomic local check on a batch of independently usable
 * items. One malformed row voids every correct row in a response GenStudio has
 * already completed and charged for. For EP0067 that turned 332 good scene
 * prompts into 0. The fix is never "loosen the schema" on its own — it is
 * "loosen the ENVELOPE, once the per-item guarantee is enforced somewhere a
 * failure can be surgical". Where that guarantee does not exist, it is added
 * first; where a partial result is not meaningful, nothing is loosened at all.
 *
 *   THUMBNAILS — loosened. The model never addresses a slot: `targetNumbers` is
 *   computed locally and stamped onto the returned rows, so a row can only land
 *   on a slot this run asked for. Completeness is enforced after the merge, and
 *   `fill_gaps` re-requests exactly the missing slots. Also fixes a guaranteed
 *   rejection: the prompt showed the model a `"number"` key the schema forbade.
 *
 *   VIDEO PROMPTS — loosened, but only after the guard was BUILT. `number` here
 *   is model-supplied and load-bearing (it pairs a prompt with a start image and
 *   names the output file), and nothing downstream checked it.
 *   `normalizeVideoPromptScenes` is that check.
 *
 *   OUTLINE — deliberately left strict. Asserted here so it stays that way.
 *
 * ZERO paid calls. Fixtures are shaped from GenStudio's stored
 * `chat_requests.output_text`; the truncated outline below is a real one
 * (finish_reason `error`, 534 characters).
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { explainJsonSchemaMismatch, validateStructuredOutput } from '../lib/json-output-contract.js'
import {
  outlineOutputContract,
  thumbnailPromptsOutputContract,
  videoPromptsOutputContract,
} from '../lib/story-output-contracts.js'
import { normalizeVideoPromptScenes } from '../routes/ai-video.js'
import { buildThumbnailPrompt, normalizeGeneratedPromptItems } from '../generators/image-prompts.js'

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
}

// ── 1. Thumbnails ─────────────────────────────────────────────────────────

describe('thumbnail prompt batch', () => {
  test('the prompt and the contract no longer contradict each other', () => {
    // buildThumbnailPrompt shows the model `{"number": N, "title": …, "prompt": …}`
    // and says "return entries for thumbnail numbers 2, 5, 7 in that order".
    // The contract used to declare only title+prompt under
    // `additionalProperties: false`, so obeying the prompt was a rejection.
    const prompt = buildThumbnailPrompt({
      episodeId: 'EP0067', title: 'The First Quarantine', storyContext: '', castBlock: '',
      count: 3, styleTag: 'documentary', aspectRatio: '16:9', thumbnailDirective: '',
      targetNumbers: [2, 5, 7],
    })
    assert.match(prompt, /"number"/, 'the prompt asks for a number')

    const contract = thumbnailPromptsOutputContract(3)
    assert.equal(contract.mode, 'json_object')
    if (contract.mode !== 'json_object') return
    const item = (contract.schema!.properties as any).thumbnails.items
    assert.ok('number' in item.properties, 'so the contract must declare it')
    assert.equal(item.additionalProperties, false, 'and still forbid keys nobody asked for')

    // A prompt-compliant row now validates instead of voiding the batch.
    const obedient = {
      thumbnails: [2, 5, 7].map(number => ({ number, title: 'Hook', prompt: `Thumbnail ${number}.` })),
    }
    assert.equal(explainJsonSchemaMismatch(obedient, contract.schema!), null)
  })

  test('a short batch survives, and the slots it missed are still reported', () => {
    const contract = thumbnailPromptsOutputContract(3)
    const short = JSON.stringify({
      thumbnails: [
        { number: 1, title: 'One', prompt: 'A lit corridor.' },
        { number: 2, title: 'Two', prompt: 'A sealed ward door.' },
      ],
    })
    // Asked for three; two is what arrived.
    assert.notEqual(explainJsonSchemaMismatch(JSON.parse(short), (contract as any).schema), null)
    // Accepted anyway — the envelope is what Story Studio can use.
    const value = validateStructuredOutput(short, contract) as any
    assert.equal(value.thumbnails.length, 2)

    // The slot guarantee: numbering is assigned locally, never read from the
    // response, so a returned row cannot land outside the requested slots.
    const targetNumbers = [1, 2, 3]
    const generated = normalizeGeneratedPromptItems(value.thumbnails, targetNumbers.length)
      .map((row: any, index: number) => ({ ...row, number: targetNumbers[index] }))
    assert.deepEqual(generated.map((row: any) => row.number), [1, 2])
    const missing = targetNumbers.filter(n => !generated.some((row: any) => row.number === n))
    assert.deepEqual(missing, [3], 'the third slot is repairable, not silently dropped')
  })

  test('a row that lies about its slot cannot reach a slot the run did not ask for', () => {
    // fill_gaps: slots 2 and 5 are outstanding, 1/3/4 are already on disk.
    const targetNumbers = [2, 5]
    const generated = normalizeGeneratedPromptItems([
      { number: 99, title: 'Forged', prompt: 'A slot this run never requested.' },
      { number: 4, title: 'Also forged', prompt: 'A slot already verified on disk.' },
    ], targetNumbers.length).map((row: any, index: number) => ({ ...row, number: targetNumbers[index] }))
    assert.deepEqual(generated.map((row: any) => row.number), [2, 5])
  })

  test('an over-long batch cannot overflow the requested slots', () => {
    const normalized = normalizeGeneratedPromptItems(
      Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, prompt: `P${i}` })), 3,
    )
    assert.equal(normalized.length, 3)
  })

  test('a batch with nothing usable is still refused, loudly', () => {
    const contract = thumbnailPromptsOutputContract(3)
    assert.throws(
      () => validateStructuredOutput('{"thumbnails":[]}', contract),
      /\$\.thumbnails: has 0 item\(s\), minimum 1/,
    )
    assert.throws(
      () => validateStructuredOutput('{"variations":[]}', contract),
      /missing required key "thumbnails"/,
    )
  })
})

// ── 2. Video prompts ──────────────────────────────────────────────────────

describe('video clip prompt batch', () => {
  test('the envelope is accepted, so one bad row no longer voids the batch', () => {
    const contract = videoPromptsOutputContract(4)
    // Row 3 wrote `scene` where the contract says `number` — the EP0067 shape.
    const raw = JSON.stringify({
      scenes: [
        { number: 1, title: 'Arrival', prompt: 'Slow dolly toward a lit gate.' },
        { number: 2, title: 'Ward', prompt: 'Static shot down a hospital corridor.' },
        { scene: 3, title: 'Harbour', prompt: 'Pan across a closed harbour.' },
        { number: 4, title: 'Ledger', prompt: 'Push in on an open ledger.' },
      ],
    })
    assert.notEqual(explainJsonSchemaMismatch(JSON.parse(raw), (contract as any).schema), null)
    const value = validateStructuredOutput(raw, contract) as any
    const { scenes, missing } = normalizeVideoPromptScenes(value.scenes, 4)
    assert.deepEqual(scenes.map(s => s.number), [1, 2, 4], 'three usable prompts kept, not zero')
    assert.deepEqual(missing, [3], 'and the one genuinely missing scene is named')
  })

  test('a prompt can only ever address a scene the request asked for', () => {
    // This is the guarantee the exact-count check never actually provided:
    // `generators/ai-video.ts` finds a clip's start image by scene number.
    const { scenes, missing } = normalizeVideoPromptScenes([
      { number: 0, title: 'Below', prompt: 'Out of range low.' },
      { number: 7, title: 'Above', prompt: 'Out of range high.' },
      { number: 2.5, title: 'Fractional', prompt: 'Not an integer.' },
      { number: '2', title: 'Stringly typed', prompt: 'Coerces to 2.' },
      { number: 1, title: 'First', prompt: 'A real one.' },
    ], 3)
    assert.deepEqual(scenes.map(s => s.number), [1, 2])
    assert.deepEqual(missing, [3])
  })

  test('a duplicated scene number cannot overwrite an earlier clip', () => {
    const { scenes, missing } = normalizeVideoPromptScenes([
      { number: 1, title: 'First', prompt: 'The kept one.' },
      { number: 1, title: 'Second', prompt: 'The dropped one.' },
      { number: 2, title: 'Two', prompt: 'Fine.' },
    ], 2)
    assert.equal(scenes.length, 2)
    assert.equal(scenes[0]!.prompt, 'The kept one.')
    assert.deepEqual(missing, [])
  })

  test('rows with no usable prompt are dropped and counted as missing', () => {
    const { scenes, missing } = normalizeVideoPromptScenes([
      { number: 1, title: 'Blank', prompt: '   ' },
      { number: 2, title: '', prompt: 'Real text.' },
    ], 2)
    assert.deepEqual(scenes.map(s => s.number), [2])
    assert.equal(scenes[0]!.title, 'Scene 2', 'a missing title falls back, it does not void the row')
    assert.deepEqual(missing, [1])
  })

  test('scenes come back in scene order regardless of response order', () => {
    const { scenes } = normalizeVideoPromptScenes([
      { number: 3, title: 'C', prompt: 'c' },
      { number: 1, title: 'A', prompt: 'a' },
      { number: 2, title: 'B', prompt: 'b' },
    ], 3)
    assert.deepEqual(scenes.map(s => s.number), [1, 2, 3])
  })

  test('an empty batch is still refused, loudly', () => {
    assert.throws(
      () => validateStructuredOutput('{"scenes":[]}', videoPromptsOutputContract(3)),
      /\$\.scenes: has 0 item\(s\), minimum 1/,
    )
  })

  test('the route rejects a batch with no addressable prompt rather than saving it', () => {
    const route = source('routes/ai-video.ts')
    assert.match(route, /normalizeVideoPromptScenes\(parsed\?\.scenes, nClips\)/)
    assert.match(route, /if \(!scenes\.length\)/)
    assert.match(route, /res\.json\(\{\s*\n\s*scenes,/)
  })
})

// ── 3. Outline — deliberately NOT loosened ────────────────────────────────

describe('outline', () => {
  test('the outline contract stays strict, and declares no accept envelope', () => {
    const contract = outlineOutputContract(10)
    assert.equal(contract.mode, 'json_object')
    if (contract.mode !== 'json_object') return
    assert.equal(contract.accept, undefined, 'a partial outline is a wrong answer, not partial work')
    const chapters = (contract.schema!.properties as any).chapters
    assert.equal(chapters.minItems, 10)
    assert.equal(chapters.maxItems, 10)
  })

  test('a truncated outline is refused before a whole expansion run is paid for', () => {
    // The real stored failure mode for this stage: not "39 good rows and one
    // bad", but a generation that stopped (finish_reason `error`) one chapter
    // in. Accepting it would pad chapters 2-10 with content-free placeholders
    // that every downstream completion audit reports as complete.
    const truncated = JSON.stringify({
      chapters: [{
        n: 1,
        title: 'The Golden Key and the Empty Ledger',
        synopsis: 'High occupancy does not mean high profit.',
        key_beats: ['A 90 percent occupancy rate can still run a cash-flow deficit'],
      }],
    })
    assert.throws(
      () => validateStructuredOutput(truncated, outlineOutputContract(10)),
      /\$\.chapters: has 1 item\(s\), minimum 10/,
    )
  })

  test('the padding that strictness protects against is announced when it happens', () => {
    // JSON Schema cannot say "these n values are distinct and cover 1..N", so a
    // full-LENGTH outline numbered 1..9,9 passes the contract and is padded.
    // That path is the one way a partial outline reaches disk, so it is named.
    const degenerate = {
      chapters: [...Array(9)].map((_, i) => ({ n: i + 1, title: `C${i + 1}` }))
        .concat([{ n: 9, title: 'Repeat' }]),
    }
    assert.equal(explainJsonSchemaMismatch(degenerate, (outlineOutputContract(10) as any).schema), null)

    const outline = source('lib/chunked-narration.ts')
    assert.match(outline, /const synthesized: number\[\] = \[\]/)
    assert.match(outline, /had no plan and will expand as unanchored filler/)
    assert.match(outline, /The model repeated \$\{t\.singular\.toLowerCase\(\)\} number\(s\)/)
  })

  test('the compact listicle prompt asks for the key the contract requires', () => {
    // `topic_title` under `additionalProperties: false` made every compact
    // listicle outline a guaranteed local rejection, twice over.
    const outline = source('lib/chunked-narration.ts')
    const fieldHints = outline.match(/Each entry: \{[^}]*\}/g) || []
    assert.equal(fieldHints.length, 4, 'narrative + listicle, compact and full')
    for (const hint of fieldHints) {
      assert.match(hint, /"title"/, hint)
      assert.doesNotMatch(hint, /"topic_title"/, hint)
    }
    const required = ((outlineOutputContract(3) as any).schema.properties.chapters.items.required) as string[]
    assert.deepEqual(required, ['n', 'title'])
  })
})

// ── 4. Every local rejection names what failed and why ────────────────────

describe('local rejection messages', () => {
  test('each contract names the failing path, the reason, and itself', () => {
    const cases: Array<{ contract: any; raw: string; expect: RegExp }> = [
      {
        contract: thumbnailPromptsOutputContract(2),
        raw: '{"thumbnails":[]}',
        expect: /story_thumbnail_prompts response schema — \$\.thumbnails: has 0 item\(s\), minimum 1/,
      },
      {
        contract: videoPromptsOutputContract(2),
        raw: '{"scenes":"not an array"}',
        expect: /story_video_prompts response schema — \$\.scenes: expected array, got string/,
      },
      {
        contract: outlineOutputContract(3),
        raw: '{"chapters":[{"n":1,"title":"One","topic_title":"Extra"},{"n":2,"title":"Two"},{"n":3,"title":"Three"}]}',
        expect: /story_outline response schema — \$\.chapters\[0\]: unexpected key "topic_title"/,
      },
      {
        contract: outlineOutputContract(3),
        raw: '{"chapters":[{"n":1},{"n":2},{"n":3}]}',
        expect: /\$\.chapters\[0\]: missing required key "title" \(present: \["n"\]\)/,
      },
      {
        contract: outlineOutputContract(3),
        raw: '{"chapters":[{"n":9,"title":"A"},{"n":2,"title":"B"},{"n":3,"title":"C"}]}',
        expect: /\$\.chapters\[0\]\.n: 9 is above the maximum 3/,
      },
    ]
    for (const { contract, raw, expect } of cases) {
      assert.throws(() => validateStructuredOutput(raw, contract), expect, raw)
      // Never claims nothing was requested or charged.
      try {
        validateStructuredOutput(raw, contract)
      } catch (error: any) {
        assert.match(error.message, /GenStudio completed the request/)
        assert.doesNotMatch(error.message, /the output did not match the response schema\./)
      }
    }
  })

  test('the thumbnail reader names the shape it got instead of "no JSON object"', () => {
    const generator = source('generators/image-prompts.ts')
    assert.doesNotMatch(generator, /'LLM returned no JSON object'/)
    assert.match(generator, /has no "thumbnails" array \(present: \$\{JSON\.stringify\(Object\.keys\(parsed\)\)\}\)/)
  })

  test('the outline reader names the keys it got instead of a bare shape complaint', () => {
    const outline = source('lib/chunked-narration.ts')
    assert.doesNotMatch(outline, /lastErr = 'JSON object has no chapters array'/)
    assert.match(outline, /the JSON object has no "chapters" array \(present:/)
  })
})

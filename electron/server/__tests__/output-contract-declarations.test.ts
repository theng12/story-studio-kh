/**
 * Every language request asks for the SHAPE it actually parses.
 *
 * THE BUG THIS GUARDS (v1.0.787)
 * ------------------------------
 * `genstudio-client.ts` defaults an undeclared request to PROSE. Eight call
 * sites instructed the model to answer in JSON, parsed the answer with
 * JSON.parse, and never declared a contract. They worked only because
 * GenStudio forced every language response to JSON regardless of what was
 * asked. The moment that forcing was removed they would have received ordinary
 * writing: five would throw, two would degrade, and metadata template
 * extraction would have filled every placeholder with an empty string and
 * published it to YouTube without an error anywhere.
 *
 * Nothing asserted the shape being REQUESTED, which is precisely why the gap
 * survived. So this file asserts it in both directions:
 *
 *   1. the eight (nine, counting the migrated vision call) declare a contract;
 *   2. the contracts accept the payload their own reader expects, and reject
 *      prose;
 *   3. the prose call sites still declare NOTHING, so a future sweep cannot
 *      quietly "fix" a chapter of narration into a JSON object.
 *
 * ZERO paid calls: no request is made here. Group 1 reads source text, group 2
 * runs the local validator over fixtures, group 3 reads source text.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { JSON_OBJECT_OUTPUT_CONTRACT, validateStructuredOutput, type TextOutputContract } from '../lib/json-output-contract.js'
import {
  ideaBatchOutputContract,
  ideaCampaignOutputContract,
  imagePoolPromptsOutputContract,
  metadataPlaceholderOutputContract,
  singleImagePromptOutputContract,
} from '../lib/story-output-contracts.js'
import { parseExtractionResponse } from '../lib/metadata-template.js'
import { parsePlannerJson } from '../services/scene-planner.js'
import { parseArray } from '../generators/idea-campaign.js'
import { parseIdeas } from '../routes/ideas.js'
import { parseSinglePromptResponse } from '../routes/image-prompts-edit.js'
import { parseSuggestedPrompts } from '../routes/broll-project.js'

const SERVER_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function source(relative: string): string {
  return fs.readFileSync(path.join(SERVER_DIR, relative), 'utf8')
}

/**
 * The full text of one call, from `anchor` to the parenthesis that closes it.
 * Paren-balanced so a nested call or an options object cannot end the region
 * early, which is what keeps the negative assertions below honest.
 */
function callRegion(relative: string, anchor: string): string {
  const text = source(relative)
  const start = text.indexOf(anchor)
  assert.ok(start >= 0, `${relative}: call site anchor is gone — "${anchor}"`)
  assert.equal(
    text.indexOf(anchor, start + 1), -1,
    `${relative}: anchor is no longer unique — "${anchor}"`,
  )
  let open = text.indexOf('(', start)
  while (open >= 0) {
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') {
        depth -= 1
        if (depth === 0) {
          // A policy can select the caller first, then invoke it:
          // `(opts.callAi || callAi)(...)`. Keep tracing through the actual
          // invocation so its context remains covered by these assertions.
          if (text[i + 1] === '(') {
            open = i + 1
            break
          }
          return text.slice(start, i + 1)
        }
      }
    }
    if (depth !== 0) break
  }
  throw new Error(`${relative}: unbalanced call at "${anchor}"`)
}

/** Round-trip exactly as the client does: validate, then hand the reader the
 *  re-serialised value (`parseLanguageOutput` returns `JSON.stringify(value)`). */
function throughContract(payload: unknown, contract: TextOutputContract): string {
  return JSON.stringify(validateStructuredOutput(JSON.stringify(payload), contract))
}

// ── 1. The declarations ────────────────────────────────────────────────

describe('the JSON call sites declare their contract', () => {
  const sites: Array<{ what: string; file: string; anchor: string; declares: string }> = [
    {
      what: '1 · scene planning window pass',
      file: 'services/scene-planner.ts',
      // A Pipeline policy injects its selected-product caller here. The
      // planner's JSON contract remains the call-site responsibility.
      anchor: 'const raw = await (opts.callAi || callAi)(opts.model, system, user, apiKeys, false, {',
      declares: 'outputContract: JSON_OBJECT_OUTPUT_CONTRACT',
    },
    {
      what: '6 · metadata template placeholder extraction',
      file: 'generators/metadata.ts',
      // Metadata's policy-aware caller delegates to callAiWithRetry when no
      // policy is selected; the per-request contract still travels here.
      anchor: "const raw = await callMetadataAi('', extractPrompt, false,",
      declares: 'outputContract: metadataPlaceholderOutputContract(llmKeys)',
    },
    {
      what: '7 · single image/thumbnail prompt regeneration',
      file: 'routes/image-prompts-edit.ts',
      anchor: "const raw = await callAiWithRetry(model, '', llmPrompt,",
      declares: 'outputContract: singleImagePromptOutputContract()',
    },
    {
      what: '8 · image pool prompt suggestions',
      file: 'routes/broll-project.ts',
      anchor: 'const raw = await callAiWithRetry(model, system, user, {}, false, {',
      declares: 'outputContract: imagePoolPromptsOutputContract()',
    },
    {
      what: '9 · thumbnail reference vision analysis',
      file: 'routes/vision.ts',
      anchor: 'const result = await callChatWithGenStudio(apiKey, {',
      declares: 'outputContract: JSON_OBJECT_OUTPUT_CONTRACT',
    },
  ]

  for (const site of sites) {
    test(site.what, () => {
      const region = callRegion(site.file, site.anchor)
      assert.ok(
        region.includes(site.declares),
        `${site.file}: this request is parsed as JSON but no longer declares ${site.declares}`,
      )
    })
  }

  // 1.4.320 — an idea campaign sizes its batches adaptively (one call or more,
  // capped at 100) and freezes each batch's request — prompt, model, budget and
  // CONTRACT — before dispatch, so a restart replays the exact body it was bound
  // to. The contract is still declared at the site that owns the request, but the
  // call reads it back rather than naming it inline: either in the context itself
  // (freeform, where the caller's captured contract wins on a replay) or from the
  // batch record this file builds. What must not change is that the request
  // declares the shape it parses instead of leaving the client to default to
  // prose.
  const ideaSites: Array<{ file: string; carried: RegExp; declared?: RegExp }> = [
    {
      file: 'services/freeform-idea-generation.ts',
      carried: /outputContract: input\.outputContract \?\? ideaBatchOutputContract\(/,
    },
    {
      file: 'generators/idea-campaign.ts',
      carried: /outputContract: batchRecord\.outputContract/,
      declared: /outputContract: ideaCampaignOutputContract\(/,
    },
  ]

  for (const site of ideaSites) {
    test(`${site.file}: the writing call carries the JSON contract`, () => {
      const text = source(site.file)
      const start = text.indexOf('const context: CallAiContext = {')
      const end = text.indexOf('const raw =', start)
      assert.ok(start >= 0 && end > start, 'shared request context must precede dispatch')
      assert.match(text.slice(start, end), site.carried,
        `${site.file}: the request no longer carries a JSON contract`)
      if (site.declared) {
        assert.match(text, site.declared,
          `${site.file}: the contract the call carries is no longer declared here`)
      }
      assert.match(callRegion(site.file, 'await callAiWithRetry('), /, context\)$/,
        'callAiWithRetry must receive the context declaring the JSON contract')
    })
  }

  test('the deprecated jsonObject flag is gone from the vision call', () => {
    const region = callRegion('routes/vision.ts', 'const result = await callChatWithGenStudio(apiKey, {')
    assert.ok(!/jsonObject\s*:/.test(region), 'one mechanism, not two')
  })
})

// ── 2. The contracts match what each reader expects ─────────────────────

describe('each contract accepts its own payload and refuses prose', () => {
  test('1 · scene planning window', () => {
    const raw = throughContract({
      scenes: [{ start_sec: 0, end_sec: 8.5, transcript_segment: 'text', visual_prompt: 'a wide shot', boundary_reason: 'beat' }],
    }, JSON_OBJECT_OUTPUT_CONTRACT)
    assert.equal(parsePlannerJson(raw).scenes?.length, 1)
    assert.throws(() => validateStructuredOutput('Here are the scenes you asked for.', JSON_OBJECT_OUTPUT_CONTRACT))
  })

  const IDEA = {
    title: 'The Lighthouse That Moved',
    logline: 'A coastal town wakes to find its lighthouse a mile inland.',
    themes: ['coast', 'mystery'],
    suggested_chapters: 10,
    suggested_length: '60',
    mood: 'calm, curious',
  }

  test('4 · idea generation — the wrapper survives the reader', () => {
    const contract = ideaBatchOutputContract()
    const raw = throughContract({ ideas: [IDEA, { ...IDEA, title: 'Second' }] }, contract)
    const ideas = parseIdeas(raw)
    assert.equal(ideas.length, 2)
    assert.equal(ideas[0].title, IDEA.title)
    // The wrapper is why the contract can exist at all — a bare array cannot be
    // asked for through a json_object contract, so it must not be accepted here.
    assert.throws(() => validateStructuredOutput(JSON.stringify([IDEA]), contract), /one JSON object/)
    assert.throws(() => validateStructuredOutput('Here are ten ideas: 1. The Lighthouse…', contract))
  })

  test('5 · idea campaign — keys are held to the reserved assignments', () => {
    const contract = ideaCampaignOutputContract(['k1', 'k2'])
    const raw = throughContract({ ideas: [{ idea_key: 'k1', ...IDEA }] }, contract)
    const parsed = parseArray(raw)
    assert.equal(parsed[0].idea_key, 'k1')
    assert.throws(
      () => validateStructuredOutput(JSON.stringify({ ideas: [{ idea_key: 'k9', ...IDEA }] }), contract),
      /did not match/,
    )
    assert.throws(() => validateStructuredOutput('Idea one: The Lighthouse That Moved.', contract))
  })

  test('6 · metadata placeholders — every requested key is required', () => {
    const contract = metadataPlaceholderOutputContract(['topic', 'summary'])
    const raw = throughContract({ topic: 'Deep Sea Cables', summary: 'Two sentences.' }, contract)
    assert.deepEqual(parseExtractionResponse(raw, ['topic', 'summary']), {
      topic: 'Deep Sea Cables', summary: 'Two sentences.',
    })
    assert.throws(
      () => validateStructuredOutput(JSON.stringify({ topic: 'Deep Sea Cables' }), contract),
      /did not match/,
      'a missing placeholder is published as an empty title — it must not validate',
    )
    assert.throws(() => validateStructuredOutput(JSON.stringify({ topic: '', summary: 'x' }), contract), /did not match/)
    assert.throws(() => validateStructuredOutput('The episode is about deep sea cables.', contract))
  })

  test('7 · single image prompt', () => {
    const contract = singleImagePromptOutputContract()
    const raw = throughContract({ title: 'Harbour at Dawn', prompt: 'A wide shot of a harbour at dawn.' }, contract)
    const parsed = parseSinglePromptResponse(raw, { number: 3, title: 'old', prompt: 'old' })
    assert.equal(parsed.title, 'Harbour at Dawn')
    assert.ok(parsed.prompt.startsWith('A wide shot'))
    assert.throws(() => validateStructuredOutput(JSON.stringify({ title: 'x' }), contract), /did not match/)
    assert.throws(() => validateStructuredOutput('A wide shot of a harbour at dawn.', contract))
  })

  test('8 · image pool prompt suggestions', () => {
    const contract = imagePoolPromptsOutputContract()
    const raw = throughContract({ prompts: ['first image', 'second image'] }, contract)
    assert.deepEqual(parseSuggestedPrompts(raw, 10), ['first image', 'second image'])
    assert.throws(() => validateStructuredOutput(JSON.stringify(['first image']), contract), /one JSON object/)
    assert.throws(() => validateStructuredOutput('1. first image\n2. second image', contract))
  })
})

// ── 3. Metadata extraction no longer blanks a field in silence ──────────

describe('metadata template extraction fails loudly', () => {
  const keys = ['topic', 'summary']

  test('an answer with no JSON object throws instead of returning blanks', () => {
    assert.throws(
      () => parseExtractionResponse('This episode is about deep sea cables.', keys),
      /\{topic\}, \{summary\}/,
    )
  })

  test('unparseable JSON throws instead of returning blanks', () => {
    assert.throws(() => parseExtractionResponse('{"topic": "Cables",', keys), /Nothing was saved/)
  })

  test('a missing or empty value throws, naming only the failed placeholder', () => {
    assert.throws(() => parseExtractionResponse('{"topic": "Cables"}', keys), /\{summary\}/)
    assert.throws(() => parseExtractionResponse('{"topic": "Cables", "summary": "   "}', keys), /\{summary\}/)
  })

  test('a complete answer still parses, fences and preamble included', () => {
    assert.deepEqual(
      parseExtractionResponse('```json\n{"topic": "Cables", "summary": "Two sentences."}\n```', keys),
      { topic: 'Cables', summary: 'Two sentences.' },
    )
  })
})

// ── 4. The prose call sites still declare nothing ───────────────────────

describe('the prose call sites are left alone', () => {
  test('chapter expansion asks for no contract — narrative, listicle and repair', () => {
    const text = source('lib/chunked-narration.ts')
    const contexts = text.split('const ctx = {').slice(1).map(part => part.slice(0, part.indexOf('}')))
    assert.equal(contexts.length, 3, 'expected the outline, narrative batch and listicle batch contexts')
    for (const ctx of contexts) {
      assert.ok(!ctx.includes('outputContract'), 'chapter expansion output is markdown, never JSON')
    }
    // v1.4.359 — the narrative repair became two call sites: a saved-identity
    // recovery repair and the truncation repair. Both are prose, so both are
    // checked; the old single anchor matched neither.
    for (const anchor of [
      'const recoveredRepairText = await withChosenModel(',
      'repairText = await withChosenModel(',
    ]) {
      assert.ok(!callRegion('lib/chunked-narration.ts', anchor).includes('outputContract'), anchor)
    }
    // The one JSON call expansion depends on keeps its contract, passed as its
    // own argument rather than on the shared ctx above.
    //
    // v1.4.36 — matched by shape rather than by exact text. This asserted the
    // literal `outlineOutputContract(params.totalChapters)` and so failed the
    // moment the owner's headroom ceiling became a second argument. What it is
    // actually guarding is unchanged and is what is checked here: the outline
    // call still declares a contract, that contract is still driven by the
    // requested chapter count, and it still travels as its own argument instead
    // of leaking onto the shared ctx that the prose calls use.
    assert.match(text, /outlineOutputContract\(params\.totalChapters(, [A-Za-z][\w.]*)?\)/,
      'the outline call must still declare its contract from the requested chapter count')
  })

  test('metadata description, titles and tags ask for no contract', () => {
    for (const anchor of ["const descRaw = await callMetadataAi('', descPrompt, false,", "const titleRaw = await callMetadataAi('', titlePromptWithAvoidance, false,", "const tagRaw = await callMetadataAi('', tagPrompt, false,"]) {
      assert.ok(!callRegion('generators/metadata.ts', anchor).includes('outputContract'), anchor)
    }
  })

  test('single-scene visual and motion prompt regeneration ask for no contract', () => {
    const text = source('services/scene-planner.ts')
    const calls = [...text.matchAll(
      /const raw = await \(opts\.callAi \|\| callAi\)\(opts\.model, system, user, opts\.apiKeys, false, \{([\s\S]*?)\}\)/g,
    )]
    assert.equal(calls.length, 2, 'expected the visual and motion single-scene calls')
    for (const call of calls) {
      assert.ok(!call[0].includes('outputContract'), 'single-scene prompt regeneration returns prose')
      assert.match(call[0], /requestIdentity:\s*opts\.request_identity/,
        'single-scene prompt regeneration retains its explicit-action identity')
    }
  })

  const untouched = [
    'generators/episode.ts',              // legacy generateEpisode script + prompt paths
    'routes/scripts.ts',                  // interactive metadata routes
  ]
  for (const file of untouched) {
    test(`${file} declares no contract at all`, () => {
      assert.ok(!source(file).includes('outputContract'))
    })
  }

  test('sound design is not a language call site', () => {
    for (const file of ['services/sound-design.ts', 'services/sound-design-resolver.ts', 'routes/sound-design.ts']) {
      const text = source(file)
      assert.ok(!text.includes('callAi'), `${file} must stay deterministic`)
      assert.ok(!text.includes('callChatWithGenStudio'), `${file} must stay deterministic`)
    }
  })

  test('both research adapters keep the contract they already had', () => {
    for (const file of ['services/research/genstudio.ts', 'services/research/genstudio-web.ts']) {
      assert.ok(source(file).includes('outputContract: JSON_OBJECT_OUTPUT_CONTRACT'), file)
    }
  })
})

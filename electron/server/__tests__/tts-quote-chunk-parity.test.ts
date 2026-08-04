/**
 * The property this whole feature rests on: THE QUOTED UNITS ARE THE SUBMITTED
 * UNITS.
 *
 * A long narration is submitted as N separate GenStudio TTS jobs, each billed
 * on its own and each carrying the model's published per-job `minimum_credits`.
 * Quoting is therefore N quotes added up. That total is only true if the pieces
 * quoted are byte-for-byte the pieces submitted — a different normalization, a
 * different boundary, or joining the sections before splitting all produce a
 * plausible-looking number for work nobody does.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { GenStudioApiError } from '../lib/genstudio-client.js'
import { splitGenStudioApiRequests } from '../lib/genstudio-client.js'
import { quoteNarrationRequests } from '../services/tts-narration-quote.js'
import {
  TTS_REQUEST_SAFETY_MARGIN,
  flattenTtsRequestPlan,
  normalizeSectionsForTts,
  planGenStudioTtsRequests,
  resolveTtsRequestBudget,
  selectNarrationSections,
} from '../services/tts-request-plan.js'

/** A published boundary, supplied by the caller exactly as the catalogue does. */
const PUBLISHED_MAX_CHARACTERS = 900

function sentence(index: number): string {
  return `Sentence ${index} carries an em dash — and a “smart quote” so normalization has real work to do.`
}

function narrationFixture() {
  return [
    { slug: 'intro', label: 'Introduction', text: Array.from({ length: 12 }, (_, i) => sentence(i)).join(' ') },
    { slug: 'ch01', label: 'Chapter 01', text: Array.from({ length: 40 }, (_, i) => sentence(i)).join('\n\n') },
    { slug: 'ch02', label: 'Chapter 02', text: Array.from({ length: 25 }, (_, i) => sentence(i)).join('\n\n') },
  ]
}

/**
 * Exactly what generators/audio.ts does before it starts submitting: normalize
 * every parsed section, select the requested ones, then plan the requests. The
 * generator's own loop reads `plan[sectionIndex].parts[i]` and writes each one
 * to `_part{i+1}.mp3`, so this array IS its submission list.
 */
function generatorSubmissionTexts(sectionsParam: string, maxCharacters: number): string[] {
  const sections = narrationFixture()
  normalizeSectionsForTts(sections)
  const selected = selectNarrationSections(sections, sectionsParam)
  const plan = planGenStudioTtsRequests(selected, maxCharacters)
  const submitted: string[] = []
  for (const [sectionIndex] of selected.entries()) {
    for (const part of plan[sectionIndex]!.parts) submitted.push(part)
  }
  return submitted
}

/** Exactly what the quote route does before it starts asking for prices. */
function quotedTexts(sectionsParam: string, maxCharacters: number): string[] {
  const sections = narrationFixture()
  normalizeSectionsForTts(sections)
  const selected = selectNarrationSections(sections, sectionsParam)
  return flattenTtsRequestPlan(planGenStudioTtsRequests(selected, maxCharacters)).map(request => request.text)
}

test('the quoted requests are byte-for-byte the requests generation submits', () => {
  for (const sectionsParam of ['all', 'intro', 'ch01,ch02', '1']) {
    assert.deepEqual(
      quotedTexts(sectionsParam, PUBLISHED_MAX_CHARACTERS),
      generatorSubmissionTexts(sectionsParam, PUBLISHED_MAX_CHARACTERS),
      `quoted units diverged from submitted units for sections='${sectionsParam}'`,
    )
  }
})

test('a narration long enough to split really is quoted as several requests', () => {
  const texts = quotedTexts('all', PUBLISHED_MAX_CHARACTERS)
  assert.ok(texts.length > 3, 'the fixture must actually split, or this proves nothing')
  for (const text of texts) {
    assert.ok(text.length <= PUBLISHED_MAX_CHARACTERS, 'a submitted request exceeded the published boundary')
  }
})

test('the parts of a section reassemble into exactly the text that section submits', () => {
  const sections = narrationFixture()
  normalizeSectionsForTts(sections)
  for (const entry of planGenStudioTtsRequests(sections, PUBLISHED_MAX_CHARACTERS)) {
    const rejoined = entry.parts.join(' ')
    // Splitting drops the whitespace it split ON, never a character of speech.
    assert.equal(
      rejoined.replace(/\s+/g, ' ').trim(),
      entry.section.text.replace(/\s+/g, ' ').trim(),
      `section ${entry.section.slug} lost or gained words when split`,
    )
  }
})

test('quoting the joined script — the wrong way — would price requests nobody submits', () => {
  const sections = narrationFixture()
  normalizeSectionsForTts(sections)
  const joined = sections.map(section => section.text).join('\n\n')
  const wholeScriptSplit = splitGenStudioApiRequests(joined, PUBLISHED_MAX_CHARACTERS)
  // Sections are submitted independently — one audio file each — so a split of
  // the joined script produces different bodies. This is the failure the
  // per-part quote exists to prevent; if these ever match, the fixture stopped
  // exercising the case.
  assert.notDeepEqual(wholeScriptSplit, quotedTexts('all', PUBLISHED_MAX_CHARACTERS))
})

test('the boundary follows the model: a different published cap yields different requests', () => {
  assert.notDeepEqual(
    quotedTexts('all', PUBLISHED_MAX_CHARACTERS),
    quotedTexts('all', PUBLISHED_MAX_CHARACTERS * 2),
  )
})

test('splitting refuses to invent a boundary when the model published none', () => {
  assert.throws(() => planGenStudioTtsRequests(narrationFixture(), 0), /maximum_input_characters/)
})

test('GenStudio is asked to price each submitted request, and the total is the sum of its answers', async () => {
  const requests = flattenTtsRequestPlan(
    planGenStudioTtsRequests((() => {
      const sections = narrationFixture()
      normalizeSectionsForTts(sections)
      return sections
    })(), PUBLISHED_MAX_CHARACTERS),
  )
  const asked: string[] = []
  const result = await quoteNarrationRequests({
    requests,
    quoteEnabled: true,
    quoteRequest: async (text) => {
      asked.push(text)
      // A per-job minimum is exactly why every job is quoted separately: a
      // single whole-text calculation would count this once instead of N times.
      return {
        voice_id: 'voice', voice_tier: '', billable_characters: text.length, speed: 1,
        controls: {},
        estimated_duration_ms: 0, maximum_input_characters: PUBLISHED_MAX_CHARACTERS,
        credits: Math.max(5, text.length / 100), credits_per_1000_characters: 10,
        price_version: 'v1', output_format: 'mp3', chargeable: true,
        generation_enabled: true, notice: '',
      }
    },
  })

  assert.equal(result.quotable, true)
  // The bodies GenStudio priced are the bodies that will be submitted.
  assert.deepEqual(asked, requests.map(request => request.text))
  assert.equal(result.parts.length, requests.length)
  assert.equal(result.part_count, requests.length)
  assert.equal(result.total_credits, result.parts.reduce((sum, part) => sum + part.credits, 0))
  assert.equal(
    result.total_billable_characters,
    result.parts.reduce((sum, part) => sum + part.billable_characters, 0),
  )
  // Every part keeps its own returned figure, so the reader can see the N jobs.
  assert.ok(result.parts.every(part => part.credits > 0))
})

test('a voice GenStudio publishes as not quotable is reported, not priced locally', async () => {
  const result = await quoteNarrationRequests({
    requests: [{ section_slug: 'intro', section_label: 'Introduction', part: 1, part_count: 1, text: 'hi', characters: 2 }],
    quoteEnabled: false,
    quoteRequest: async () => { throw new Error('must not ask') },
  })
  assert.equal(result.quotable, false)
  assert.equal(result.unavailable_reason, 'quote_disabled')
  assert.equal(result.total_credits, null)
})

test('a generation unit the quote endpoint refuses is surfaced, never sub-split to force a quote', async () => {
  const requests = flattenTtsRequestPlan(
    planGenStudioTtsRequests(narrationFixture(), PUBLISHED_MAX_CHARACTERS),
  )
  const asked: string[] = []
  const result = await quoteNarrationRequests({
    requests,
    quoteEnabled: true,
    quoteRequest: async (text) => {
      asked.push(text)
      // The live contract mismatch: the quote endpoint rejects a body the TTS
      // model itself publishes as acceptable. Story Studio learns the limit by
      // being told no — it never carries the number.
      throw new GenStudioApiError(422, 'text: ensure this value has at most N characters')
    },
  })

  assert.equal(result.quotable, false)
  assert.equal(result.unavailable_reason, 'generation_unit_rejected')
  assert.equal(result.unavailable_status, 422)
  assert.equal(result.unquotable_characters, requests[0]!.characters)
  assert.equal(result.total_credits, null)
  // It stopped at the refusal instead of quoting smaller pieces to get a number.
  assert.equal(asked.length, 1)
  assert.equal(result.parts.length, 0)
  // The refusal is relayed in GenStudio's own words.
  assert.match(result.unavailable_detail, /at most/)
})

test('one shared planner decides the requests — the generator and the quote route cannot drift', () => {
  const generator = readFileSync(new URL('../generators/audio.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('../services/tts-request-plan.ts', import.meta.url), 'utf8')

  // Both go through the planner, with a budget both resolve the same way from
  // the same live catalogue row — the margin cannot apply to one side only.
  assert.match(generator, /resolveTtsRequestBudget\(ttsModel\)/)
  assert.match(route, /resolveTtsRequestBudget\(ttsModel\)/)
  assert.match(generator, /planGenStudioTtsRequests\(sections, requestBudget\.effective\)/)
  assert.match(generator, /selectNarrationSections\(allSections, sectionsParam\)/)
  assert.match(generator, /normalizeSectionsForTts\(allSections\)/)
  assert.match(route, /planGenStudioTtsRequests\(sections, requestBudget\.effective\)/)
  assert.match(route, /selectNarrationSections\(allSections/)
  assert.match(route, /normalizeSectionsForTts\(allSections\)/)

  // …and neither re-implements the split or the normalization for itself.
  assert.doesNotMatch(generator, /splitGenStudioApiRequests/)
  assert.doesNotMatch(route, /splitGenStudioApiRequests/)
  assert.doesNotMatch(route, /normalizeForTts/)
  assert.match(planner, /splitGenStudioApiRequests\(section\.text, maxInputCharacters\)/)

  // The quote route quotes the plan as-is: no trimming, no filtering, no
  // sub-splitting of a body the generator would submit whole.
  assert.doesNotMatch(route, /\.filter\(request => request\.text/)
})

// ── The effective request budget ────────────────────────────────────────────
// Both sides now split at `resolveTtsRequestBudget(model).effective` — the
// model's published boundary less Story Studio's safety margin. These pin the
// two properties that keeps it honest: the base stays live and per-model, and
// the reduced budget is used by BOTH planners or by neither.

/** A catalogue row, exactly as `/v1/tts/models` publishes one. */
function ttsModelRow(maximumInputCharacters: number) {
  return { maximum_input_characters: maximumInputCharacters }
}

test('the budget is the live published boundary less the margin, per model', () => {
  for (const published of [900, 2_500, 12_000, 65_536, 100_001]) {
    const budget = resolveTtsRequestBudget(ttsModelRow(published))
    assert.equal(budget.published, published, 'the published figure is reported unmodified')
    assert.equal(
      budget.effective,
      Math.floor(published * (1 - TTS_REQUEST_SAFETY_MARGIN)),
      'the margin must be applied to the published base, floored',
    )
    assert.ok(budget.effective < published, 'the budget must leave head-room')
    assert.equal(budget.safety_margin, TTS_REQUEST_SAFETY_MARGIN)
  }
})

test('the budget recomputes when the model changes — nothing is carried over', () => {
  const small = resolveTtsRequestBudget(ttsModelRow(900))
  const large = resolveTtsRequestBudget(ttsModelRow(120_000))
  assert.notEqual(small.effective, large.effective)
  // Switching back yields the first figure again: no cache, no drift.
  assert.deepEqual(resolveTtsRequestBudget(ttsModelRow(900)), small)
  // And a model publishing nothing yields no boundary rather than a guess.
  assert.equal(resolveTtsRequestBudget(ttsModelRow(0)).effective, 0)
  assert.throws(
    () => planGenStudioTtsRequests(narrationFixture(), resolveTtsRequestBudget(ttsModelRow(0)).effective),
    /maximum_input_characters/,
  )
})

test('the margin multiplies a live base — it can never behave as a fixed cap', () => {
  // Doubling what the model publishes doubles what Story Studio plans at. A
  // constant ceiling smuggled in behind the margin would break this.
  const base = resolveTtsRequestBudget(ttsModelRow(10_000)).effective
  assert.equal(resolveTtsRequestBudget(ttsModelRow(20_000)).effective, base * 2)
  // Every distinct published boundary yields a distinct budget, including ones
  // far above the quote endpoint's own fixed body limit.
  const budgets = [10_000, 40_000, 90_000, 250_000].map(max => resolveTtsRequestBudget(ttsModelRow(max)).effective)
  assert.equal(new Set(budgets).size, budgets.length)
  // A tiny published boundary is reduced but never to zero, and never raised.
  const tiny = resolveTtsRequestBudget(ttsModelRow(1))
  assert.ok(tiny.effective >= 1 && tiny.effective <= tiny.published)
})

test('the model publishes the ONLY request ceiling — the quote cap is gone', () => {
  // `TTSQuoteRequest.text` used to carry a fixed `maxLength` that no catalogue
  // field mirrored, so the budget resolved the smaller of two ceilings.
  // GenStudio removed it; the model's own figure is now the only one, and the
  // machinery that reconciled the two went with it rather than lingering as
  // dead shape. Nothing on the planning path may reintroduce a second ceiling.
  const planner = readFileSync(new URL('../services/tts-request-plan.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(planner, /maximum_quote_characters|quote_limited|quoteLimited/)
  const budget = resolveTtsRequestBudget({ maximum_input_characters: 100_000 })
  assert.equal(budget.published, 100_000)
  assert.equal(budget.effective, Math.floor(100_000 * (1 - TTS_REQUEST_SAFETY_MARGIN)))
  // An extra field GenStudio does not publish cannot narrow the budget.
  assert.deepEqual(
    resolveTtsRequestBudget({ maximum_input_characters: 100_000, maximum_quote_characters: 30_000 } as any),
    budget,
  )
})

test('parity holds under the reduced budget: quoted units are still submitted units', () => {
  for (const published of [900, 2_048, 12_000]) {
    const budget = resolveTtsRequestBudget(ttsModelRow(published))
    for (const sectionsParam of ['all', 'intro', 'ch01,ch02', '1']) {
      assert.deepEqual(
        quotedTexts(sectionsParam, budget.effective),
        generatorSubmissionTexts(sectionsParam, budget.effective),
        `the margin moved the quote boundary away from the generation boundary (${published}, ${sectionsParam})`,
      )
    }
    // Every part sits inside the budget, and therefore inside what the model
    // publishes — which is the point of the head-room.
    for (const text of quotedTexts('all', budget.effective)) {
      assert.ok(text.length <= budget.effective)
      assert.ok(text.length <= budget.published)
    }
  }
})

test('the discovered-refusal cache is gone — every ask reaches GenStudio', async () => {
  // The cache remembered, per model and per process, the smallest body the
  // quote endpoint had already refused, so a repeat ask could skip the round
  // trip. Its only reason to exist was the quote endpoint's own undiscoverable
  // cap; that cap is gone, so the memory of it is too. What remains is the
  // refusal HANDLING, which is defence and must still work every time.
  const budget = resolveTtsRequestBudget(ttsModelRow(PUBLISHED_MAX_CHARACTERS))
  const requests = flattenTtsRequestPlan(planGenStudioTtsRequests(narrationFixture(), budget.effective))
  let asked = 0
  const refuse = async () => {
    asked += 1
    throw new GenStudioApiError(413, 'text: ensure this value has at most N characters')
  }

  const first = await quoteNarrationRequests({ requests, quoteEnabled: true, quoteRequest: refuse })
  assert.equal(first.unavailable_reason, 'generation_unit_rejected')
  assert.equal(first.unavailable_status, 413)
  assert.equal(first.unquotable_characters, requests[0]!.characters)
  assert.equal(asked, 1)

  // Asked again, it asks again: no remembered size short-circuits it.
  const again = await quoteNarrationRequests({ requests, quoteEnabled: true, quoteRequest: refuse })
  assert.equal(again.unavailable_reason, 'generation_unit_rejected')
  assert.equal(asked, 2, 'the removed cache must not have grown back')

  const service = readFileSync(new URL('../services/tts-narration-quote.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(service, /refusedQuoteSizes|knownQuoteRefusal|rememberQuoteRefusal|forgetQuoteRefusals/)
  // Nothing was persisted then, and nothing is now.
  assert.doesNotMatch(service, /writeFile|readFile|localStorage|app-settings/)
  assert.doesNotMatch(service, /planGenStudioTtsRequests|resolveTtsRequestBudget/)
})

test('the margin is annotated as Story Studio policy, not a catalogue value', () => {
  const planner = readFileSync(new URL('../services/tts-request-plan.ts', import.meta.url), 'utf8')
  assert.match(planner, /model-drift-allow: a Story Studio safety margin/)
  // It is declared as a fraction, so the base it multiplies stays live.
  assert.match(planner, /TTS_REQUEST_SAFETY_MARGIN = 0\.1\b/)
  assert.match(planner, /published \* \(1 - TTS_REQUEST_SAFETY_MARGIN\)/)
  // The reason is written down where the next reader will find it.
  assert.match(planner, /billable_characters/)
  assert.match(planner, /character_rule_version/)
})

test('the enforced budget is reported to the page, beside the published figure', () => {
  const route = readFileSync(new URL('../routes/audio.ts', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../routes/app-settings.ts', import.meta.url), 'utf8')
  assert.match(route, /planned_request_characters: requestBudget\.effective/)
  assert.match(route, /maximum_input_characters: ttsModel\.maximum_input_characters/)
  // The catalogue route computes it per row, so the page never re-derives it.
  assert.match(settings, /planned_request_characters: resolveTtsRequestBudget\(model\)\.effective/)
})

test('no endpoint limit is hardcoded anywhere on the quote path', () => {
  for (const url of [
    new URL('../services/tts-request-plan.ts', import.meta.url),
    new URL('../services/tts-narration-quote.ts', import.meta.url),
    new URL('../routes/audio.ts', import.meta.url),
  ]) {
    const source = readFileSync(url, 'utf8')
    assert.doesNotMatch(source, /40[_,]?000/, `${url.pathname} embeds the quote endpoint's own maximum`)
  }
})

/**
 * ── S1: a failed quote is a failed quote, never a claim about what GenStudio
 * published ────────────────────────────────────────────────────────────────
 *
 * The quote parser used to coerce five published numerics with `?? 0`. That
 * collapsed "absent from the payload", "this was not a quote at all" and
 * "genuinely zero" into one indistinguishable number, and the zero then reached
 * the boundary guards, which reported *GenStudio published no
 * maximum_input_characters* — a sentence manufactured entirely inside Story
 * Studio, about a field GenStudio publishes 40000 for on every TTS model and
 * cannot return null for. It cost two wrong diagnoses.
 *
 * `credits` was the worse half: a silent 0 there reads as FREE.
 */

/** The exact phrase that may only appear when the field really was unpublished. */
const PUBLICATION_CLAIM = /published no maximum_input_characters/i

function quoteFixture(overrides: Record<string, unknown> = {}) {
  return {
    voice_id: 'voice', voice_tier: '', controls: {},
    billable_characters: 100, speed: 1, estimated_duration_ms: 1_000,
    maximum_input_characters: PUBLISHED_MAX_CHARACTERS,
    credits: 5, credits_per_1000_characters: 10,
    price_version: 'v1', output_format: 'mp3', chargeable: true,
    generation_enabled: true, notice: '',
    ...overrides,
  } as any
}

function oneRequest() {
  return flattenTtsRequestPlan(planGenStudioTtsRequests(
    [{ slug: 'intro', label: 'Introduction', text: 'A short line of narration.' }],
    PUBLISHED_MAX_CHARACTERS,
  ))
}

test('a 422 from the quote endpoint surfaces the status and GenStudio\'s own detail', async () => {
  const detail = 'model_id: field required'
  const result = await quoteNarrationRequests({
    requests: oneRequest(),
    quoteEnabled: true,
    quoteRequest: async () => { throw new GenStudioApiError(422, detail) },
  })

  // The acceptance criterion, in full.
  assert.equal(result.unavailable_status, 422)
  assert.equal(result.unavailable_detail, detail)
  assert.doesNotMatch(result.unavailable_detail, PUBLICATION_CLAIM)
  assert.equal(result.quotable, false)
  assert.equal(result.total_credits, null)
})

test('the status GenStudio answered with reaches the reader, not just the log', () => {
  const page = readFileSync(new URL('../../../frontend/pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  // The note the page renders when a quote is unavailable carries the status
  // beside GenStudio's words. Without it a transport failure and a publication
  // gap read identically, which is how this whole class of bug hides.
  assert.match(page, /HTTP \$\{result\.unavailable_status\}/)
  assert.match(page, /result\.unavailable_detail/)
})

test('a non-200 quote never becomes a quote object full of zeros', () => {
  const client = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  // `readJson` throws GenStudioApiError for every non-2xx, carrying the real
  // status and the server's `detail`, so the parse below it only ever runs on a
  // 200. That is the property the whole S1 fix rests on.
  assert.match(client, /if \(!response\.ok\) \{[\s\S]{0,400}throw new GenStudioApiError\(response\.status, detail/)
})

test('an absent published figure stays absent through the quote parse — no `?? 0`', () => {
  const client = readFileSync(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf8')
  const quoteParse = client.slice(client.indexOf('export async function requestGenStudioTtsQuote'))
    .slice(0, client.slice(client.indexOf('export async function requestGenStudioTtsQuote')).indexOf('\n}\n'))
  for (const field of [
    'billable_characters', 'estimated_duration_ms', 'maximum_input_characters',
    'credits', 'credits_per_1000_characters',
  ]) {
    assert.match(
      quoteParse,
      new RegExp(`${field}: optionalCount\\(payload\\?\\.${field}\\) \\?\\? null`),
      `${field} must stay null when GenStudio's 200 quote did not publish it`,
    )
  }
  // Comments stripped: the block above explains the `?? 0` it is there to stop.
  const code = quoteParse.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /\?\? 0\b/, 'the quote parse must not default any published figure to 0')
})

test('a 200 quote that omits `credits` is reported, never totalled as free', async () => {
  const result = await quoteNarrationRequests({
    requests: oneRequest(),
    quoteEnabled: true,
    quoteRequest: async () => quoteFixture({ credits: null }),
  })

  assert.equal(result.quotable, false)
  assert.equal(result.unavailable_reason, 'quote_failed')
  assert.match(result.unavailable_detail, /credits/)
  assert.doesNotMatch(result.unavailable_detail, PUBLICATION_CLAIM)
  // The one outcome that must never happen: a total of 0 presented as a quote.
  assert.equal(result.total_credits, null)
  assert.equal(result.parts.length, 0)
})

test('a 200 quote that omits `billable_characters` is reported the same way', async () => {
  const result = await quoteNarrationRequests({
    requests: oneRequest(),
    quoteEnabled: true,
    quoteRequest: async () => quoteFixture({ billable_characters: null }),
  })
  assert.equal(result.quotable, false)
  assert.match(result.unavailable_detail, /billable_characters/)
  assert.equal(result.total_billable_characters, null)
})

test('the boundary guards distinguish "published nothing" from "published something unusable"', () => {
  // Absent — the claim is true, and the original wording is kept.
  assert.throws(() => splitGenStudioApiRequests('narration', null), PUBLICATION_CLAIM)
  assert.throws(() => splitGenStudioApiRequests('narration', undefined), PUBLICATION_CLAIM)
  // Published, but not a usable boundary. GenStudio published SOMETHING here,
  // so saying it published nothing would be the same false claim in reverse.
  assert.throws(() => splitGenStudioApiRequests('narration', 0), /published maximum_input_characters as 0/)
  assert.doesNotThrow(() => {
    try { splitGenStudioApiRequests('narration', 0) } catch (error: any) {
      assert.doesNotMatch(error.message, PUBLICATION_CLAIM)
      return
    }
    throw new Error('expected a refusal')
  })
})

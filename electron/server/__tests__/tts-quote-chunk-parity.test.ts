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
  flattenTtsRequestPlan,
  normalizeSectionsForTts,
  planGenStudioTtsRequests,
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

  // Both go through the planner…
  assert.match(generator, /planGenStudioTtsRequests\(sections, genStudioMaxCharacters\)/)
  assert.match(generator, /selectNarrationSections\(allSections, sectionsParam\)/)
  assert.match(generator, /normalizeSectionsForTts\(allSections\)/)
  assert.match(route, /planGenStudioTtsRequests\(sections, ttsModel\.maximum_input_characters\)/)
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

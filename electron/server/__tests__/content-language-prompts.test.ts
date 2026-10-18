/**
 * The audience-language boundary in prompt bytes.
 *
 * Proves both halves of the contract at the prompt itself:
 *   - unset is EXACTLY the pre-feature output, compared against frozen
 *     fixtures copied from base commit 44601361 (not against the builder
 *     itself, which would pass for any implementation), and
 *   - en/km add exactly the shared directive, in the right position.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Format } from '../models/types.js'

let episode: typeof import('../generators/episode.js')
let ideas: typeof import('../routes/ideas.js')
let metadataPrompt: typeof import('../lib/metadata-prompt.js')
let cl: typeof import('../lib/content-language.js')

before(async () => {
  episode = await import('../generators/episode.js')
  ideas = await import('../routes/ideas.js')
  metadataPrompt = await import('../lib/metadata-prompt.js')
  cl = await import('../lib/content-language.js')
})

const format = {
  productionStandardsAddendum: '',
  script: {
    systemPromptRole: 'You are a story narrator.',
    additionalRules: ['Stay on tone.'],
    chapterCountRange: [1, 10],
    lengthMinutesRange: [5, 60],
    defaultChapterCount: 5,
    defaultLengthMinutes: 30,
    defaultNarratorStyleId: 'a',
    narratorStyles: [{ id: 'a', description: 'Calm', label: 'Calm' }],
  },
  idea: {
    systemPromptRole: 'You generate story ideas.',
    guidanceText: 'Keep every idea distinct.',
    exampleIdeas: undefined,
  },
  metadata: {},
} as unknown as Format

// ── Frozen base-commit fixtures (44601361) ────────────────────────────────
// These are the literal strings the builders produced before the language
// boundary existed, for the fixture above. A change to any byte fails.
const LEGACY_TTS_GUIDANCE = `Write for the EAR — this script is read aloud by a text-to-speech voice:
- Use ONLY simple, spoken punctuation: periods, commas, and question marks. Do NOT use em dashes or en dashes (—, –), semicolons, ellipses (...), parentheses, asterisks, or any markdown/special symbols — speech engines read them unnaturally. Use a comma or start a new sentence instead.
- Favour natural, speakable sentences with varied length. Avoid long, clause-stacked or piled-up appositive phrasing (e.g. "the old light in his eyes, a sentinel, a friend") that sounds artificial when spoken aloud.
- Keep EVERY sentence under 220 characters (about 35 words). The voice is rendered a few sentences at a time, and a longer sentence has to be cut in the middle. When a thought runs long, end the sentence and start a new one (for example "...across the black water. And the old fisherman watched...").
- Spell things as they should be said (e.g. "Doctor" not "Dr.", "and" not "&").
- Write ordinary numbers as words in the narration. Use conventional spoken years: 1871 is "eighteen seventy-one", 2001 is "two thousand one", and 2010 is "twenty ten". Write dates, quantities, percentages, and currency exactly as the voice should say them. Keep digits only when they are intentionally exact identifiers, URLs, citations, equations, model names, file names, addresses, or other technical literals. Required structural headings must retain their requested chapter or section numbers as digits.`

const LEGACY_SCRIPT_PROMPT = 'You are a story narrator.\n\n\n\n'
  + 'Additional rules:\n- Stay on tone.\n\n'
  + LEGACY_TTS_GUIDANCE

const LEGACY_PASTE_PROMPT = `You generate story ideas.
Return a JSON array of idea objects ONLY — no prose before or after. If your
client insists on markdown fences, use \`\`\`json ... \`\`\` — the importer strips them.

Each idea MUST match this shape, with these exact keys:

  {
    "title":              "string — 5 to 10 words, evocative, on-tone for the format above",
    "logline":            "string — 1 to 2 sentences, 20 to 60 words, one concrete image",
    "themes":             ["array of 2 to 4 short thematic keywords"],
    "suggested_chapters": 5,
    "suggested_length":   "30 min",
    "mood":               "string — 2 to 6 words describing the emotional arc, commas allowed"
  }

Rules:
- Keep every idea distinct.
- Each idea should have a distinct angle / subject / emotional arc within this format's voice.
- suggested_chapters is an integer between 1 and 10 (format default 5).
- suggested_length is any minutes-string between "5 min" and "60 min" (format default "30 min").
- Don't invent extra keys — the importer only reads the six above.
- If you're unsure about a field, leave the idea out rather than guessing.
- Honour the format's voice above. Don't bring in tropes from other genres.

Produce N ideas. (Replace N with however many you want, e.g. 10.)

Example of a valid response:

[
  // (no examples in this format — match the shape above)
]
`

const LEGACY_DESCRIPTION_PROMPT = `Generate a YouTube description for a story episode.

Episode: EP0001 — Title

Story context:
Context

Include these sections IN THIS ORDER:


Use separator lines (──────) between major sections.
Total length must stay under 5,000 bytes of UTF-8 — about 5,000 characters of English, or about 1,666 characters of Khmer or another non-Latin script. Keep every chapter mark; shorten the prose instead.
Output ONLY the description text, ready to copy-paste. No meta-commentary.`

describe('episode system prompt (outline / chapters / introduction)', () => {
  test('unset is exactly the frozen base-commit prompt', () => {
    assert.equal(episode.systemPrompt(format, ''), LEGACY_SCRIPT_PROMPT)
  })

  test('English and Khmer carry the shared directive', () => {
    assert.match(episode.systemPrompt(format, '', cl.languageDirective('en')), /Write ALL audience-facing text in English\./)
    const khmer = episode.systemPrompt(format, '', cl.languageDirective('km'))
    assert.match(khmer, /Khmer \(Khmer script\)/)
    assert.ok(khmer.indexOf('Khmer') < khmer.indexOf('Additional rules:'),
      'the language instruction precedes the format rules it governs')
  })
})

describe('idea paste prompt', () => {
  test('unset is exactly the frozen base-commit prompt', () => {
    assert.equal(ideas.buildPastePrompt(format), LEGACY_PASTE_PROMPT)
  })

  test('the directive follows the role line', () => {
    const prompt = ideas.buildPastePrompt(format, undefined, '', cl.languageDirective('km'))
    assert.match(prompt, /Khmer \(Khmer script\)/)
    assert.ok(prompt.indexOf('Khmer') < prompt.indexOf('Return a JSON array'),
      'the language instruction precedes the shape rules')
  })
})

describe('YouTube description prompt', () => {
  test('unset is exactly the frozen base-commit prompt', () => {
    assert.equal(
      metadataPrompt.buildDescriptionPrompt('EP0001', 'Title', 'Context', [], 5000, null),
      LEGACY_DESCRIPTION_PROMPT,
    )
  })

  test('the directive sits before the byte/length rule', () => {
    const prompt = metadataPrompt.buildDescriptionPrompt(
      'EP0001', 'Title', 'Context', [], 5000, null, cl.languageDirective('en'),
    )
    assert.match(prompt, /Write ALL audience-facing text in English\./)
    assert.ok(prompt.indexOf('Write ALL audience-facing text') < prompt.indexOf('Total length must stay under'),
      'the directive must be read before the shortening rule')
  })
})

/**
 * The owner set a symbolic-split recipe and an impasto art style, and got the
 * whole episode title — "The Psychology of the Weight of Invisible Chains" —
 * in gold serif across the frame:
 *
 *   "im using the thumbnail format and the impasto style but the text is not as
 *    the thumbnail. so this is where my frustation lies ... since i let LLM
 *    decide right here. there's no proper control."
 *
 * There were two modes and the RECIPE chose between them. He named three he
 * wanted straight away — the title, a curious idea, and two-or-three words —
 * and said there would be more.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import {
  DEFAULT_HEADLINE_MODE, PREFERRED_NEW_HEADLINE_MODE, HEADLINE_MODES, HEADLINE_MODE_IDS,
  headlineInstruction, headlineMode,
} from '../models/thumbnail-headlines.js'
import { buildThumbnailDirective } from '../generators/image-prompts.js'

describe('the modes the owner asked for exist', () => {
  test('his three, by name', () => {
    for (const id of ['episode-title', 'curiosity-hook', 'short-hook']) {
      assert.ok(HEADLINE_MODE_IDS.includes(id), `${id} is missing`)
    }
  })

  test('every mode states an exact word budget, or renders no words', () => {
    // A mode without a length is an invitation to write a sentence, which is
    // how a "curiosity hook" became a full title across the frame.
    for (const mode of HEADLINE_MODES) {
      if (mode.id === 'episode-title' || mode.id === 'none') continue
      assert.match(mode.instruction, /at most \d+ words|limit: \d+ words/,
        `${mode.id} does not bound its length`)
    }
  })

  test('every invented mode returns its words for review', () => {
    // Otherwise the only place the chosen words appear is inside the picture,
    // which is exactly the loss of control being fixed.
    for (const mode of HEADLINE_MODES.filter(row => row.invents)) {
      assert.match(mode.instruction, /"title" field/, `${mode.id} hides its chosen words`)
    }
  })

  test('every mode has a label a non-native speaker can act on', () => {
    for (const mode of HEADLINE_MODES) {
      assert.ok(mode.label.length > 3 && mode.summary.length > 10, `${mode.id} is not explained`)
      assert.doesNotMatch(mode.label, /hook mode|headline_mode|CTA/i, `${mode.id} uses jargon`)
    }
  })
})

describe('the customer chooses, not the recipe', () => {
  const recipeWantsTitle = { headlineMode: 'episode-title' } as never

  test('an explicit choice beats the recipe default', () => {
    const directive = buildThumbnailDirective({
      thumbs: 3, title: 'The Psychology of the Weight of Invisible Chains',
      fmt: recipeWantsTitle, headlineModeId: 'short-hook',
    })
    assert.match(directive, /Hard limit: 3 words/)
    assert.doesNotMatch(directive, /render this exact title/)
  })

  test('with no choice, the recipe still supplies one', () => {
    const directive = buildThumbnailDirective({
      thumbs: 3, title: 'A Title', fmt: recipeWantsTitle,
    })
    assert.match(directive, /render this exact title/)
  })

  test('with neither, an existing recipe still behaves exactly as it did', () => {
    // Deliberately NOT changed to the short default. A recipe that never asked
    // for a hook has not consented to one, and moving this constant would
    // silently rewrite what every channel already produces. The owner's
    // preference lives in the picker's starting value instead.
    const directive = buildThumbnailDirective({ thumbs: 3, title: 'A Very Long Episode Title Indeed' })
    assert.equal(DEFAULT_HEADLINE_MODE, 'episode-title')
    assert.match(directive, /render this exact title/)
  })

  test('but a new run on the page starts on the short option', () => {
    assert.equal(PREFERRED_NEW_HEADLINE_MODE, 'short-hook')
    assert.match(headlineMode(PREFERRED_NEW_HEADLINE_MODE).instruction, /Hard limit: 3 words/)
  })

  test('"no text at all" really asks for none', () => {
    const directive = buildThumbnailDirective({ thumbs: 1, title: 'A Title', headlineModeId: 'none' })
    assert.match(directive, /render no words, letters, captions/)
    assert.doesNotMatch(directive, /render this exact title/)
  })

  test('an unknown mode falls back to the default rather than rendering nothing', () => {
    assert.equal(headlineMode('not-a-mode').id, DEFAULT_HEADLINE_MODE)
  })

  test('the title is substituted, never left as a placeholder', () => {
    const instruction = headlineInstruction('episode-title', 'Real Title Here')
    assert.match(instruction, /"Real Title Here"/)
    assert.doesNotMatch(instruction, /\{\{TITLE\}\}/)
  })
})

// Dreamlands E2E (2026-10-03): the page's default "two or three words" mode got
// "…typography reading \"STARLIT CLOUD LINEN\"" from the model and then a bolted-on
// "Render the exact title \"Weaving the Starlit Cloud Linen\"" — two texts in one image.
describe('every inventing mode keeps its own words end to end', () => {
  test('the enforcement clause never asks for the full title on an inventing mode', async () => {
    const { enforceThumbnailPromptElements } = await import('../generators/image-prompts.js')
    for (const mode of HEADLINE_MODES.filter(m => m.invents)) {
      const out = enforceThumbnailPromptElements('A weaver at a loom, 16:9 thumbnail, text "STARLIT LINEN".', {
        aspectRatio: '16:9', title: 'STARLIT LINEN', headlineMode: mode.id,
      })
      assert.doesNotMatch(out, /Render the exact title/, `${mode.id} was told to render the full title`)
    }
  })

  test('"no text at all" gets no title clause bolted on', async () => {
    const { enforceThumbnailPromptElements } = await import('../generators/image-prompts.js')
    const out = enforceThumbnailPromptElements('A quiet loom at dusk, 16:9 thumbnail.', {
      aspectRatio: '16:9', title: 'Weaving the Starlit Cloud Linen', headlineMode: 'none',
    })
    assert.doesNotMatch(out, /Render the exact/)
  })

  test('a text style of "none" gets no title clause and no gold lettering (Manu, 2026-10-25)', async () => {
    const { enforceThumbnailPromptElements } = await import('../generators/image-prompts.js')
    const body = 'A diplomat on a ship deck at golden hour, Angkor on the horizon.'
    const out = enforceThumbnailPromptElements(body, { aspectRatio: '16:9', title: 'អ្វីដែលទូតចិនបានឃើញ', textStyle: 'none' })
    assert.doesNotMatch(out, /Render the exact/)
    assert.doesNotMatch(out, /display text|legible/i, "no lettering instruction of any kind")
    const lettered = enforceThumbnailPromptElements(body, { aspectRatio: '16:9', title: 'អ្វីដែលទូតចិនបានឃើញ', textStyle: 'gold' })
    assert.match(lettered, /Render the exact title/, 'a real treatment still letters the title')
  })

  test('the generator turns text style "none" into the no-text headline, over a recipe default', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../generators/image-prompts.ts', import.meta.url), 'utf8')
    assert.match(src, /const textFree = req\.thumb_text_style === 'none'\n\s+let headlineMode: string = textFree\n\s+\? 'none'/)
    assert.match(src, /if \(!req\.thumb_headline_mode && !textFree && recipe\?\.headlineMode\)/)
  })

  test('the authoring brief asks inventing modes for their own words, not the episode title', async () => {
    const { buildThumbnailPrompt } = await import('../generators/image-prompts.js')
    const base = { episodeId: 'EP0001', title: 'Weaving the Starlit Cloud Linen', storyContext: 'x', castBlock: '', count: 3, styleTag: '', aspectRatio: '16:9', thumbnailDirective: '', targetNumbers: [1, 2, 3] }
    assert.doesNotMatch(buildThumbnailPrompt({ ...base, headlineMode: 'short-hook' }), /4\. Render the exact episode title/)
    assert.match(buildThumbnailPrompt({ ...base, headlineMode: 'episode-title' }), /4\. Render the exact episode title/)
    assert.match(buildThumbnailPrompt({ ...base, headlineMode: 'none' }), /4\. Render no words/)
  })

  test('the single-row reprompt route accepts every published mode', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../routes/image-prompts-edit.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(src, /headline_mode: z\.enum\(\['episode-title', 'curiosity-hook'\]\)/)
    assert.match(src, /HEADLINE_MODE_IDS\.includes\(id\)/)
  })
})

test('the generator hands the ROW\'s hook (not the episode title) to the enforcement pass', async () => {
  // Seen live after the first fix: title saved as "ANCIENT IRON KEY", clause still said
  // Render the exact thumbnail hook "The Bioluminescent Glasshouse at Midnight".
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../generators/image-prompts.ts', import.meta.url), 'utf8')
  assert.match(src, /title: headlineInvents\(headlineMode\) \? String\(item\.title \|\| ''\)\.trim\(\) \|\| title : title,\n\s+textStyle:/)
})

/**
 * The free-form "Custom…" lettering option must actually reach the prompt.
 *
 * The Image Prompts page collects `thumb_font_style_custom` and
 * `thumb_text_style_custom`, and `resolveFontStyle` / `resolveTextStyle` have
 * always accepted a `customText` argument — but nothing ever sent it. Choosing
 * "Custom…" and typing a description therefore resolved to the built-in serif
 * (font) or gold treatment (text) and the customer's own words were silently
 * ignored, while the UI kept showing what they typed.
 *
 * These pin the resolver contract the plumbing now satisfies, the blank-input
 * fallback that must not change, and the two generator call sites that carry the
 * text from the job request into the builders.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { buildThumbnailDirective, enforceThumbnailPromptElements } from '../generators/image-prompts.js'
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'

const FONT_CUSTOM = 'chiselled art-deco slab serif with a thin brass inlay'
const TEXT_CUSTOM = 'frosted glass with a faint blue internal glow'

const generatorSource = readFileSync(
  fileURLToPath(new URL('../generators/image-prompts.ts', import.meta.url)),
  'utf8',
)

describe('a custom lettering choice reaches the directive', () => {
  test('the customer’s own font description is used, not the built-in serif', () => {
    const directive = buildThumbnailDirective({
      thumbs: 2,
      title: 'A measured probe',
      fontStyle: 'custom',
      fontCustomText: FONT_CUSTOM,
      fmt: null,
    })
    assert.ok(directive.includes(FONT_CUSTOM), 'the typed description must be what the image model is told to draw')
    assert.ok(!directive.includes(FONT_STYLES.serif!), 'the built-in serif is the silent fallback this fixes')
  })

  test('the customer’s own treatment description is used, not the built-in gold', () => {
    const directive = buildThumbnailDirective({
      thumbs: 2,
      title: 'A measured probe',
      textStyle: 'custom',
      textCustomText: TEXT_CUSTOM,
      fmt: null,
    })
    assert.ok(directive.includes(TEXT_CUSTOM))
    assert.ok(!directive.includes(TEXT_STYLES.gold!))
  })

  test('both custom choices travel together', () => {
    const directive = buildThumbnailDirective({
      thumbs: 1,
      title: 'A measured probe',
      fontStyle: 'custom',
      fontCustomText: FONT_CUSTOM,
      textStyle: 'custom',
      textCustomText: TEXT_CUSTOM,
      fmt: null,
    })
    assert.ok(directive.includes(FONT_CUSTOM))
    assert.ok(directive.includes(TEXT_CUSTOM))
  })

  test('the enforcement clause names the custom choice too', () => {
    const prompt = enforceThumbnailPromptElements('A cover with no title instruction yet.', {
      aspectRatio: '16:9',
      title: 'A measured probe',
      fontStyle: 'custom',
      fontCustomText: FONT_CUSTOM,
      textStyle: 'custom',
      textCustomText: TEXT_CUSTOM,
      textPosition: 'bottom',
    })
    assert.ok(prompt.includes(FONT_CUSTOM), 'the appended clause must carry the typed description')
    assert.ok(prompt.includes(TEXT_CUSTOM))
    assert.ok(!prompt.includes('a font chosen to suit the concept'),
      'a deliberate custom choice must not be described as unchosen')
  })
})

describe('the blank custom case is unchanged', () => {
  test('an empty custom description still falls back to the built-in defaults', () => {
    const blankFont = buildThumbnailDirective({ thumbs: 1, title: 'T', fontStyle: 'custom', fmt: null })
    assert.ok(blankFont.includes(FONT_STYLES.serif!), 'a `custom` with nothing typed has no phrase to use')

    const blankText = buildThumbnailDirective({ thumbs: 1, title: 'T', textStyle: 'custom', fmt: null })
    assert.ok(blankText.includes(TEXT_STYLES.gold!))
  })

  test('a built-in id ignores stray custom text rather than letting it override the choice', () => {
    const directive = buildThumbnailDirective({
      thumbs: 1,
      title: 'T',
      fontStyle: 'display',
      fontCustomText: FONT_CUSTOM,
      fmt: null,
    })
    assert.ok(directive.includes(FONT_STYLES.display!))
    assert.ok(!directive.includes(FONT_CUSTOM))
  })
})

describe('the job request carries the typed text into both builders', () => {
  test('the generator passes both custom fields at both call sites', () => {
    const directiveCall = generatorSource.slice(
      generatorSource.indexOf('const thumbnailDirective = buildThumbnailDirective('),
      generatorSource.indexOf('const thumbnailDirective = buildThumbnailDirective(') + 900,
    )
    assert.match(directiveCall, /fontCustomText: req\.thumb_font_style_custom/,
      'the directive must receive the typed font description')
    assert.match(directiveCall, /textCustomText: req\.thumb_text_style_custom/,
      'and the typed treatment description')

    const enforceCall = generatorSource.slice(
      generatorSource.indexOf('prompt: enforceThumbnailPromptElements('),
      generatorSource.indexOf('prompt: enforceThumbnailPromptElements(') + 700,
    )
    assert.match(enforceCall, /fontCustomText: req\.thumb_font_style_custom/)
    assert.match(enforceCall, /textCustomText: req\.thumb_text_style_custom/)
  })

  test('the request type declares the two fields', () => {
    assert.match(generatorSource, /thumb_text_style_custom\?: string/)
    assert.match(generatorSource, /thumb_font_style_custom\?: string/)
  })
})

/**
 * The owner cannot choose a font from a phrase: "i don't know all the english
 * font names ... all just words i don't know. i'm not a native speaker so i
 * prefer visual." These pin the two properties that make a swatch sheet
 * legible rather than decorative.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import {
  allLetteringStyles, findLetteringStyle, letteringStyles, swatchStyleTag,
  swatchVariantId, SWATCH_FRAMING, SWATCH_WORD,
} from '../lib/lettering-swatches.js'
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'

describe('every style the picker offers can be shown', () => {
  test('one swatch per catalogue entry, no more and no fewer', () => {
    // A style with no swatch is a word the owner still cannot read.
    assert.equal(letteringStyles('font').length, Object.keys(FONT_STYLES).length)
    assert.equal(letteringStyles('text').length, Object.keys(TEXT_STYLES).length)
    assert.equal(allLetteringStyles().length, Object.keys(FONT_STYLES).length + Object.keys(TEXT_STYLES).length)
  })

  test('a swatch shows the phrase the generator really injects, not a paraphrase', () => {
    const gothic = findLetteringStyle('font', 'gothic')!
    assert.equal(gothic.phrase, FONT_STYLES.gothic)
    assert.match(swatchStyleTag(gothic), new RegExp(FONT_STYLES.gothic!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('an unknown style is refused rather than generated', () => {
    assert.equal(findLetteringStyle('font', 'not-a-style'), null)
  })
})

describe('one variable per swatch', () => {
  test('a font swatch varies the letterform and holds the treatment plain', () => {
    const tag = swatchStyleTag(findLetteringStyle('font', 'stencil')!)
    assert.match(tag, /^Letterform: /)
    assert.match(tag, /Treatment: clean solid white fill with a soft drop shadow$/)
  })

  test('a text swatch varies the treatment and holds the letterform plain', () => {
    const tag = swatchStyleTag(findLetteringStyle('text', 'neon')!)
    assert.match(tag, /^Letterform: a heavy bold sans-serif\./)
    assert.match(tag, /Treatment: neon glow/)
  })

  test('font and text swatches never collide in the cache', () => {
    // 'script' and 'handwritten' exist in BOTH catalogues. Without separate
    // variant ids the font swatch and the text swatch of the same name would
    // share a cache entry and one would silently show the other.
    assert.ok('script' in FONT_STYLES && 'script' in TEXT_STYLES)
    assert.notEqual(swatchVariantId('font'), swatchVariantId('text'))
    assert.notEqual(
      swatchStyleTag(findLetteringStyle('font', 'script')!),
      swatchStyleTag(findLetteringStyle('text', 'script')!),
    )
  })
})

describe('the shared framing keeps swatches comparable', () => {
  test('the same word appears in every swatch, spelled out for the model', () => {
    assert.match(SWATCH_FRAMING, new RegExp(`"${SWATCH_WORD}"`))
    assert.match(SWATCH_FRAMING, /spelled exactly S-T-O-R-Y/)
  })

  test('the frame holds nothing but the word', () => {
    // A scene would make two swatches differ by their scene rather than their
    // lettering, which is the whole thing being compared.
    for (const forbidden of ['no scene', 'no objects', 'no people', 'no extra words', 'no decoration']) {
      assert.match(SWATCH_FRAMING, new RegExp(forbidden))
    }
  })
})

/**
 * A font pack has to be SELLABLE, not an in-app convenience:
 *
 *   "you built a wrong thing. i don't want to generate it once in app and use
 *    it forever. i want it to be packages i can sell. font package with image
 *    generated."
 *
 * Before this, `FONT_STYLES` and `TEXT_STYLES` were hardcoded maps, so a pack
 * could not add a lettering style at all and there was nothing to sell whatever
 * else was built. These pin the two rules that make a pack style real and safe:
 * it joins the same picker as a built-in, and it can never take a built-in's id.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { ContentPackDocumentSchema, ContentPackItemKindSchema } from '../content-packs/schemas.js'
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'

function letteringDocument(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'lettering-style',
    schema_version: 1,
    id: 'com.example.lettering.molten-brass',
    name: 'Molten Brass',
    description: 'Poured metal letterforms with a hot rim light.',
    axis: 'text',
    phrase: 'molten brass fill, hot rim light along every edge, dark cooling shadow',
    preview_assets: ['assets/molten-brass.webp'],
    ...overrides,
  }
}

describe('a pack can ship a lettering style at all', () => {
  test('lettering-style is a content pack item kind', () => {
    assert.equal(ContentPackItemKindSchema.safeParse('lettering-style').success, true)
  })

  test('a well-formed lettering style validates', () => {
    const parsed = ContentPackDocumentSchema.safeParse(letteringDocument())
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
  })

  test('a style with no swatch is refused', () => {
    // A lettering style without a picture is a name, and a name is exactly what
    // the owner cannot buy from: "all just words i don't know".
    const parsed = ContentPackDocumentSchema.safeParse(letteringDocument({ preview_assets: [] }))
    assert.equal(parsed.success, false)
  })

  test('only the two axes the prompt builder actually has', () => {
    assert.equal(ContentPackDocumentSchema.safeParse(letteringDocument({ axis: 'font' })).success, true)
    assert.equal(ContentPackDocumentSchema.safeParse(letteringDocument({ axis: 'outline' })).success, false)
  })

  test('an empty phrase is refused — the phrase is the product', () => {
    assert.equal(ContentPackDocumentSchema.safeParse(letteringDocument({ phrase: '' })).success, false)
  })
})

describe('a pack may never shadow a built-in style', () => {
  test('claiming a built-in font id is refused by name', () => {
    // A buyer would otherwise pay for a style that silently loses a lookup —
    // or worse, changes what every existing thumbnail prompt means.
    const parsed = ContentPackDocumentSchema.safeParse(letteringDocument({ axis: 'font', id: 'gothic' }))
    assert.equal(parsed.success, false)
    assert.match(JSON.stringify(parsed.error?.issues), /may never replace or shadow a built-in/)
  })

  test('claiming a built-in treatment id is refused too', () => {
    assert.ok('neon' in TEXT_STYLES && 'gothic' in FONT_STYLES)
    assert.equal(ContentPackDocumentSchema.safeParse(letteringDocument({ id: 'neon' })).success, false)
  })

  test('a namespaced id of its own is fine', () => {
    assert.equal(ContentPackDocumentSchema.safeParse(letteringDocument({ id: 'com.example.lettering.neon-two' })).success, true)
  })
})

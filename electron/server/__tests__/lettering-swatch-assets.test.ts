/**
 * Every built-in lettering style ships a bundled swatch.
 *
 * The owner opened the lettering picker and saw thirty-five English typography
 * terms and no pictures: "i only see text description, no visual image." He is
 * not a native speaker and cannot evaluate "blackletter gothic calligraphy"
 * from the words, which is the whole point of a picker.
 *
 * The swatches are bundled with the frontend build rather than seeded into the
 * content-hash style-preview cache, because that cache lives in per-machine
 * userData — seeding it would fix one Mac and leave every customer looking at
 * bare words. This mirrors how the built-in VISUAL styles carry preview_image.
 *
 * This test is the guard that keeps them in step: add a built-in lettering
 * style without adding its swatch and the picker would render a broken image,
 * so this fails first instead.
 */
import { existsSync, statSync } from 'node:fs'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'
import { letteringCatalogue } from '../services/lettering-catalogue.js'

// Resolved from this file, not from cwd: the backend runner and a bare
// `node --test` invocation do not agree on a working directory.
const SWATCH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../frontend/public/builtin-lettering-swatches',
)

describe('built-in lettering swatches are bundled with the app', () => {
  test('every built-in font and text style has a swatch file on disk', () => {
    const expected = [
      ...Object.keys(FONT_STYLES).map(id => `font-${id}.webp`),
      ...Object.keys(TEXT_STYLES).map(id => `text-${id}.webp`),
    ]
    assert.equal(expected.length, 35, 'the built-in lettering catalogue is 16 font + 19 text')

    for (const filename of expected) {
      const path = resolve(SWATCH_DIR, filename)
      assert.equal(existsSync(path), true, `missing bundled swatch: ${filename}`)
      // A flat grey field with white letters compresses very small — the
      // smallest real swatch is ~5 KB — so this floor only catches a
      // zero-byte or truncated placeholder, not an honestly tiny image.
      assert.ok(statSync(path).size > 3_000, `${filename} looks like an empty placeholder`)
    }
  })

  test('the catalogue points every built-in at its bundled swatch', async () => {
    const rows = await letteringCatalogue()
    const builtIns = rows.filter(row => row.source === 'built-in')
    assert.equal(builtIns.length, 35)

    for (const row of builtIns) {
      assert.equal(
        row.previewUrl,
        `/builtin-lettering-swatches/${row.axis}-${row.id}.webp`,
        `${row.axis}:${row.id} preview url`,
      )
    }
  })

  test('no built-in is left for the paid generate path to fill in', async () => {
    const rows = await letteringCatalogue()
    const unswatched = rows.filter(row => row.source === 'built-in' && !row.previewUrl)
    assert.deepEqual(unswatched, [], 'a built-in without a swatch would bill the owner to render one')
  })
})

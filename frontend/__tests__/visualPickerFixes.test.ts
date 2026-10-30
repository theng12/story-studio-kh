/**
 * Two text-only pickers made visual, with the data the app already had.
 *
 * Owner's standing rule, 2026-10-30: "everything that can be a visual option,
 * must be a visual option." The cast picker already had each character's
 * portrait on this Mac and showed only names; the caption font picker showed
 * font names as words.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const cast = read('../components/CharacterPicker.vue')
const subtitles = read('../components/SubtitleStylePicker.vue')

describe('the cast picker shows faces it already has', () => {
  test('each row renders the first reference image through the roster endpoint', () => {
    assert.match(cast, /class="cast-portrait"/)
    assert.match(cast, /function portrait\(character: Character\)/)
    assert.match(cast, /\/api\/character-library\//)
    assert.match(cast, /reference-image\//)
  })

  test('a character with no picture, or a picture that will not load, falls back to a letter', () => {
    assert.match(cast, /@error="portraitFailed\.add\(c\.id\)"/)
    assert.match(cast, /cast-portrait-fallback/)
  })

  test('the checkbox and the selection behaviour are untouched', () => {
    assert.match(cast, /type="checkbox"/)
    assert.match(cast, /@change="toggle\(c\.id\)"/)
  })
})

describe('the caption font picker shows the face, not only its name', () => {
  test('a specimen is drawn in the selected font family', () => {
    assert.match(subtitles, /class="font-specimen"/)
    assert.match(subtitles, /fontFamily: style\.typography\.font_family/)
  })

  test('the font field opens the shared popup rather than listing names in a select', () => {
    // Owner, 2026-10-30: a font choice has to be visual. The panel's other
    // selects (wrap, animation, word mode) are not choices among pictures and
    // stay native; the font list was the one that had to change.
    assert.match(subtitles, /<FontPicker/)
    assert.match(subtitles, /@select="onFontSelect"/)
    assert.doesNotMatch(subtitles, /<select[^>]*>[\s\S]{0,160}?value="__custom__"/)
    assert.match(subtitles, /__custom__/)
  })

  test('the caption looks gallery is open by default — it was never hidden', () => {
    // The audit that produced this claim was wrong; this pins the real state.
    assert.match(subtitles, /const galleryOpen = ref\(true\)/)
  })
})

/**
 * Tests for the pronunciation lexicon helper (lib/pronunciation.ts).
 *
 * Pure function — no I/O. Cover the match semantics + edge cases the
 * audio generator relies on.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applyLexicon, formatSubstitutionsLog } from '../lib/pronunciation.js'
import type { BrandPronunciation } from '../models/types.js'

describe('applyLexicon', () => {
  test('returns text unchanged when lexicon is empty / null / undefined', () => {
    assert.deepEqual(applyLexicon('hello', null), { text: 'hello', substitutions: [] })
    assert.deepEqual(applyLexicon('hello', undefined), { text: 'hello', substitutions: [] })
    assert.deepEqual(applyLexicon('hello', []), { text: 'hello', substitutions: [] })
  })

  test('returns text unchanged when text is empty', () => {
    const lex: BrandPronunciation[] = [{ term: 'X', alt_spelling: 'Y' }]
    assert.deepEqual(applyLexicon('', lex), { text: '', substitutions: [] })
  })

  test('skips entries without alt_spelling (only field wired today)', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Sokhom', ipa: '/sɔːkˈhɔːm/' },          // no alt_spelling — skip
      { term: 'Aria', ssml: '<phoneme ph="…">Aria</phoneme>' },  // ssml-only — skip
    ]
    const out = applyLexicon('Sokhom met Aria.', lex)
    assert.equal(out.text, 'Sokhom met Aria.')
    assert.deepEqual(out.substitutions, [])
  })

  test('skips identity substitutions (term === alt_spelling)', () => {
    const lex: BrandPronunciation[] = [{ term: 'Sokhom', alt_spelling: 'Sokhom' }]
    const out = applyLexicon('Sokhom and friends.', lex)
    assert.equal(out.text, 'Sokhom and friends.')
    assert.deepEqual(out.substitutions, [])
  })

  test('replaces a simple ASCII term, case-insensitive by default', () => {
    const lex: BrandPronunciation[] = [{ term: 'Sokhom', alt_spelling: 'Soh-Khohm' }]
    const out = applyLexicon('Sokhom went home. sokhom slept.', lex)
    assert.equal(out.text, 'Soh-Khohm went home. Soh-Khohm slept.')
    assert.deepEqual(out.substitutions, [{ term: 'Sokhom', replacement: 'Soh-Khohm', count: 2 }])
  })

  test('honours word boundaries for ASCII terms (does not match inside other words)', () => {
    const lex: BrandPronunciation[] = [{ term: 'Sok', alt_spelling: 'Sohk' }]
    const out = applyLexicon('Sok ate at Sokhom\'s place.', lex)
    // "Sok" matches the standalone word, not the prefix in "Sokhom"
    assert.equal(out.text, 'Sohk ate at Sokhom\'s place.')
    assert.deepEqual(out.substitutions, [{ term: 'Sok', replacement: 'Sohk', count: 1 }])
  })

  test('case_sensitive: true matches only exact case', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Read', alt_spelling: 'Reed', case_sensitive: true },
    ]
    const out = applyLexicon('Read the book. I read it. READ all about it.', lex)
    assert.equal(out.text, 'Reed the book. I read it. READ all about it.')
    assert.deepEqual(out.substitutions, [{ term: 'Read', replacement: 'Reed', count: 1 }])
  })

  test('substring match for terms with non-ASCII characters (Khmer)', () => {
    // Khmer text — \b doesn't recognize Khmer characters as word chars,
    // so we fall back to substring match. The characters used here
    // ("ស្រី" — "lady") have no Latin word-boundary semantics.
    const lex: BrandPronunciation[] = [{ term: 'ស្រី', alt_spelling: 'srey' }]
    const out = applyLexicon('ស្រី is on the page', lex)
    assert.equal(out.text, 'srey is on the page')
    assert.deepEqual(out.substitutions, [{ term: 'ស្រី', replacement: 'srey', count: 1 }])
  })

  test('escapes regex metacharacters in the term', () => {
    const lex: BrandPronunciation[] = [{ term: 'St. Paul', alt_spelling: 'Saint Paul' }]
    const out = applyLexicon('Visit St. Paul today.', lex)
    assert.equal(out.text, 'Visit Saint Paul today.')
    assert.deepEqual(out.substitutions, [{ term: 'St. Paul', replacement: 'Saint Paul', count: 1 }])
  })

  test('applies multiple lexicon entries in order, tracks each', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Sokhom', alt_spelling: 'Soh-Khohm' },
      { term: 'Aria', alt_spelling: 'Ah-ree-ah' },
      { term: 'unused', alt_spelling: 'never' },
    ]
    const out = applyLexicon('Sokhom met Aria. Aria laughed.', lex)
    assert.equal(out.text, 'Soh-Khohm met Ah-ree-ah. Ah-ree-ah laughed.')
    assert.deepEqual(out.substitutions, [
      { term: 'Sokhom', replacement: 'Soh-Khohm', count: 1 },
      { term: 'Aria', replacement: 'Ah-ree-ah', count: 2 },
    ])
  })

  test('skips invalid entries without throwing', () => {
    const lex: any[] = [
      null,
      { term: '', alt_spelling: 'never' },             // empty term
      undefined,
      { term: 'OK', alt_spelling: 'Yes' },             // valid — should still apply
    ]
    const out = applyLexicon('OK then.', lex)
    assert.equal(out.text, 'Yes then.')
    assert.deepEqual(out.substitutions, [{ term: 'OK', replacement: 'Yes', count: 1 }])
  })
})

describe('applyLexicon with ssmlSupported', () => {
  test('uses explicit ssml string when provider supports SSML', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Sokhom', alt_spelling: 'Soh-Khohm', ssml: '<phoneme alphabet="ipa" ph="sɔːkˈhɔːm">Sokhom</phoneme>' },
    ]
    const out = applyLexicon('Sokhom went home.', lex, { ssmlSupported: true })
    assert.equal(out.text, '<phoneme alphabet="ipa" ph="sɔːkˈhɔːm">Sokhom</phoneme> went home.')
    assert.equal(out.substitutions[0]!.replacement, '<phoneme alphabet="ipa" ph="sɔːkˈhɔːm">Sokhom</phoneme>')
  })

  test('wraps ipa in <phoneme> when provider supports SSML and no explicit ssml', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Aria', alt_spelling: 'Ah-ree-ah', ipa: 'ˈɑːriə' },
    ]
    const out = applyLexicon('Hello Aria.', lex, { ssmlSupported: true })
    assert.equal(out.text, 'Hello <phoneme alphabet="ipa" ph="ˈɑːriə">Aria</phoneme>.')
  })

  test('escapes XML metacharacters in ipa + term when wrapping', () => {
    const lex: BrandPronunciation[] = [
      { term: 'A&B', ipa: 'q"<>' },
    ]
    const out = applyLexicon('A&B met.', lex, { ssmlSupported: true })
    assert.equal(
      out.text,
      '<phoneme alphabet="ipa" ph="q&quot;&lt;&gt;">A&amp;B</phoneme> met.',
    )
  })

  test('falls through to alt_spelling when ssmlSupported is false', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Sokhom', alt_spelling: 'Soh-Khohm', ssml: '<phoneme>x</phoneme>', ipa: 'x' },
    ]
    const out = applyLexicon('Sokhom went home.', lex, { ssmlSupported: false })
    assert.equal(out.text, 'Soh-Khohm went home.')
  })

  test('skips entry that only has ssml/ipa when provider does not support SSML', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Aria', ipa: 'ˈɑːriə' },                    // ipa-only
      { term: 'Sokhom', ssml: '<phoneme>x</phoneme>' },   // ssml-only
    ]
    const out = applyLexicon('Aria met Sokhom.', lex, { ssmlSupported: false })
    assert.equal(out.text, 'Aria met Sokhom.', 'no usable replacement → no substitution')
    assert.deepEqual(out.substitutions, [])
  })

  test('default options behaves like ssmlSupported: false', () => {
    const lex: BrandPronunciation[] = [
      { term: 'Aria', ipa: 'ˈɑːriə' },
    ]
    const out = applyLexicon('Aria met.', lex) // no options arg
    assert.equal(out.text, 'Aria met.')
  })
})

describe('formatSubstitutionsLog', () => {
  test('returns null for empty list', () => {
    assert.equal(formatSubstitutionsLog([]), null)
  })

  test('formats single substitution without count parens', () => {
    const out = formatSubstitutionsLog([{ term: 'A', replacement: 'B', count: 1 }])
    assert.equal(out, 'Lexicon: A → B')
  })

  test('formats multi-occurrence with count', () => {
    const out = formatSubstitutionsLog([{ term: 'A', replacement: 'B', count: 5 }])
    assert.equal(out, 'Lexicon: A → B (5×)')
  })

  test('joins multiple substitutions with commas', () => {
    const out = formatSubstitutionsLog([
      { term: 'A', replacement: 'B', count: 2 },
      { term: 'C', replacement: 'D', count: 1 },
    ])
    assert.equal(out, 'Lexicon: A → B (2×), C → D')
  })
})

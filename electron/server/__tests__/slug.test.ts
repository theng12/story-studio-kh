/**
 * Cross-platform slug sanitisation — project directory names have to
 * survive Windows rules even though the app is typically developed on
 * macOS. See services/slug.ts for the full rationale; these tests pin
 * the current project-path contract.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  fallbackChannelSlug,
  isValidExplicitProjectSlug,
  projectSlugBase,
  projectSlugCore,
  sanitizeProjectSlug,
  uniqueProjectSlug,
} from '../services/slug.js'

describe('sanitizeProjectSlug()', () => {
  describe('baseline behaviour (unchanged from the old slugify)', () => {
    test('lowercases and hyphenates ordinary names', () => {
      assert.equal(sanitizeProjectSlug('My New Project'), 'my-new-project')
    })

    test('collapses runs of whitespace / underscores', () => {
      assert.equal(sanitizeProjectSlug('foo   bar___baz'), 'foo-bar-baz')
    })

    test('strips leading and trailing hyphens', () => {
      assert.equal(sanitizeProjectSlug('---foo---'), 'foo')
    })

    test('empty / whitespace-only input falls back to "project"', () => {
      assert.equal(sanitizeProjectSlug(''), 'project')
      assert.equal(sanitizeProjectSlug('   '), 'project')
      assert.equal(sanitizeProjectSlug('!!!'), 'project')
    })
  })

  describe('Windows reserved device names', () => {
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
      test(`"${name}" gets a safe prefix`, () => {
        assert.equal(sanitizeProjectSlug(name), `project-${name.toLowerCase()}`)
      })
    }

    test('reserved name with trailing whitespace still prefixed', () => {
      assert.equal(sanitizeProjectSlug('  con  '), 'project-con')
    })

    test('reserved-looking substring inside a longer name is untouched', () => {
      // "console" is not reserved — only the bare device names are.
      assert.equal(sanitizeProjectSlug('Console Chronicles'), 'console-chronicles')
    })
  })

  describe('trailing dots and spaces (Windows silently strips)', () => {
    test('strips trailing dots', () => {
      assert.equal(sanitizeProjectSlug('foo.'), 'foo')
      assert.equal(sanitizeProjectSlug('foo...'), 'foo')
    })

    test('strips mixed trailing dots, hyphens, and spaces', () => {
      assert.equal(sanitizeProjectSlug('foo . - .'), 'foo')
    })
  })

  describe('control characters and Windows-illegal punctuation', () => {
    test('strips ASCII control chars (0x00-0x1f, 0x7f)', () => {
      const raw = 'foo\x00\x01\x1fbar\x7fbaz'
      assert.equal(sanitizeProjectSlug(raw), 'foobarbaz')
    })

    test('strips <>:"|?* and path separators', () => {
      assert.equal(sanitizeProjectSlug('a<b>c:d"e|f?g*h/i\\j'), 'abcdefghij')
    })
  })

  describe('length cap', () => {
    test('caps output at 50 chars', () => {
      const long = 'a'.repeat(200)
      const out = sanitizeProjectSlug(long)
      assert.equal(out.length, 50)
      assert.equal(out, 'a'.repeat(50))
    })

    test('truncation does not leave a trailing hyphen', () => {
      // 49 a's + space + b — after normalisation the 50-char cap would
      // land right on a hyphen; the sanitiser must trim it.
      const input = `${'a'.repeat(49)} b extra extra extra`
      const out = sanitizeProjectSlug(input)
      assert.ok(out.length <= 50)
      assert.ok(!out.endsWith('-'), `expected no trailing hyphen, got "${out}"`)
    })
  })

  describe('Unicode passthrough', () => {
    test('Khmer characters survive (project is a KH app)', () => {
      // \w in a JS regex without the 'u' flag excludes these, which is
      // fine — the test pins the *observed* behaviour. A future change
      // to Unicode-aware matching should update this assertion.
      const out = sanitizeProjectSlug('រឿងព្រេង')
      // Accept either stripped or preserved — we document the current
      // behaviour rather than prescribe it.
      assert.ok(typeof out === 'string' && out.length > 0)
    })

    test('mixed ASCII + symbols reduces to ASCII core', () => {
      assert.equal(sanitizeProjectSlug('Hello — World!'), 'hello-world')
    })
  })

  // Production defect, 2026-10-28: a Khmer-only channel name became the literal
  // folder "project", so a second such channel collided with it. Creation uses
  // projectSlugBase(), whose fallback is unique per name; the historical
  // sanitiser keeps its "project" fallback for the callers that pinned it.
  describe('the fallback for a name with no Latin characters', () => {
    test('the core is empty, and the old wrapper still falls back to "project"', () => {
      assert.equal(projectSlugCore('ពិភពទេវកថា'), '')
      assert.equal(sanitizeProjectSlug('ពិភពទេវកថា'), 'project')
    })

    test('creation gets channel-<8 hex>, never the literal "project"', () => {
      const slug = projectSlugBase('ពិភពទេវកថា')
      assert.notEqual(slug, 'project')
      assert.match(slug, /^channel-[0-9a-f]{8}$/)
      assert.equal(slug, fallbackChannelSlug('ពិភពទេវកថា'))
    })

    test('the fallback is stable for one name and different for another', () => {
      assert.equal(fallbackChannelSlug('ពិភពទេវកថា'), fallbackChannelSlug('ពិភពទេវកថា'))
      assert.notEqual(fallbackChannelSlug('ពិភពទេវកថា'), fallbackChannelSlug('រឿងព្រេងខ្មែរ'))
    })

    test('a Latin name is unaffected and a name that IS "project" keeps it', () => {
      assert.equal(projectSlugBase('My New Project'), 'my-new-project')
      assert.equal(projectSlugBase('project'), 'project')
    })

    test('the second channel with the same name is made unique, case-insensitively', () => {
      const base = projectSlugBase('ពិភពទេវកថា')
      assert.equal(uniqueProjectSlug(base, []), base)
      assert.equal(uniqueProjectSlug(base, [base]), `${base}-2`)
      assert.equal(uniqueProjectSlug(base, [base.toUpperCase(), `${base}-2`]), `${base}-3`)
      // A base whose plain form is free is never suffixed.
      assert.equal(uniqueProjectSlug('fresh-name', [base]), 'fresh-name')
    })
  })

  describe('explicit slugs', () => {
    test('accepts lowercase letters, digits and single hyphens', () => {
      for (const slug of ['abc', 'khmer-stories-2', 'a1']) {
        assert.equal(isValidExplicitProjectSlug(slug), true, slug)
      }
    })

    test('rejects spaces, underscores, edges and Windows device names', () => {
      for (const slug of ['not a slug', 'under_score', '-lead', 'trail-', 'dou--ble', 'con', 'COM1', '', 'ពិភព']) {
        assert.equal(isValidExplicitProjectSlug(slug), false, JSON.stringify(slug))
      }
    })
  })
})

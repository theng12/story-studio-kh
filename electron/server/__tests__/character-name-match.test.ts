/**
 * Tests for the auto-detect character name matcher used by Phase 8
 * image-generation reference-image wiring.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { findReferencedCharacters } from '../lib/character-name-match.js'

const cast = [
  { name: 'Aria' },
  { name: 'Aria the Knight' },
  { name: 'Brick' },
  { name: 'Mr. Brick' },
  { name: 'C-3PO' },
]

describe('findReferencedCharacters', () => {
  test('matches a single name as a whole word', () => {
    const m = findReferencedCharacters('Aria walks east at dawn.', [{ name: 'Aria' }])
    assert.equal(m.length, 1)
    assert.equal(m[0].name, 'Aria')
  })

  test('case-insensitive', () => {
    const m = findReferencedCharacters('ARIA WALKS EAST.', [{ name: 'Aria' }])
    assert.equal(m.length, 1)
  })

  test('does NOT match as a substring of another word', () => {
    // "Aria" should NOT match "Marian" or "Arianna"
    const m = findReferencedCharacters('Marian and Arianna stood there.', [{ name: 'Aria' }])
    assert.equal(m.length, 0)
  })

  test('matches multi-word names as a phrase', () => {
    const m = findReferencedCharacters(
      'Aria the Knight raised her shield.',
      [{ name: 'Aria the Knight' }],
    )
    assert.equal(m.length, 1)
    assert.equal(m[0].name, 'Aria the Knight')
  })

  test('returns multiple characters when multiple names appear', () => {
    const m = findReferencedCharacters(
      'Aria and Brick met at the well.',
      [{ name: 'Aria' }, { name: 'Brick' }, { name: 'Cara' }],
    )
    assert.deepEqual(m.map(c => c.name).sort(), ['Aria', 'Brick'])
  })

  test('handles names with internal punctuation (Mr. Brick, C-3PO)', () => {
    const m = findReferencedCharacters(
      'Mr. Brick led the parade with C-3PO at his side.',
      [{ name: 'Mr. Brick' }, { name: 'C-3PO' }, { name: 'Brick' }],
    )
    // Both Mr. Brick AND Brick appear (Brick is a substring of Mr. Brick by
    // word-boundary rules — "Mr. Brick" has a space before "Brick" which
    // counts as a non-alphanumeric boundary). That's intentional: the user
    // who names two characters "Brick" and "Mr. Brick" gets both refs when
    // either appears, which is usually what they want for shared cast.
    const names = m.map(c => c.name).sort()
    assert.ok(names.includes('Mr. Brick'))
    assert.ok(names.includes('C-3PO'))
  })

  test('empty inputs return []', () => {
    assert.deepEqual(findReferencedCharacters('', cast), [])
    assert.deepEqual(findReferencedCharacters('Aria', []), [])
  })

  test('characters without a name are skipped silently', () => {
    const m = findReferencedCharacters(
      'Aria stands here.',
      [{ name: '' }, { name: 'Aria' }, { name: undefined as unknown as string }],
    )
    assert.equal(m.length, 1)
    assert.equal(m[0].name, 'Aria')
  })

  test('preserves cast order in the returned array', () => {
    const orderedCast = [{ name: 'Zeb' }, { name: 'Aria' }, { name: 'Mab' }]
    const m = findReferencedCharacters('Aria, Zeb, and Mab approach.', orderedCast)
    assert.deepEqual(m.map(c => c.name), ['Zeb', 'Aria', 'Mab'])
  })
})

/**
 * v1.0.499 — leadWithStyle: the art style is prepended to the FRONT of a scene
 * description (image models weight leading tokens more, so a trailing style
 * clause gets under-applied — especially by smaller/local models).
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

let leadWithStyle: (description: string, style: string | undefined) => string

before(async () => {
  ;({ leadWithStyle } = await import('../services/scene-planner.js'))
})

describe('leadWithStyle()', () => {
  test('prepends the style clause to the front', () => {
    assert.equal(
      leadWithStyle('A deer stands in a misty forest.', 'Soft watercolor illustration'),
      'Soft watercolor illustration. A deer stands in a misty forest.',
    )
  })

  test('does not add a second period when the style already ends in punctuation', () => {
    assert.equal(
      leadWithStyle('A castle at dawn.', 'Cinematic 3D render.'),
      'Cinematic 3D render. A castle at dawn.',
    )
    assert.equal(
      leadWithStyle('A castle at dawn.', 'Anime, vibrant,'),
      'Anime, vibrant, A castle at dawn.',
    )
  })

  test('no-ops when the description already opens with the style (no duplication)', () => {
    const out = leadWithStyle('Soft watercolor illustration of a deer in the mist.', 'Soft watercolor illustration')
    assert.equal(out, 'Soft watercolor illustration of a deer in the mist.')
  })

  test('returns the description unchanged when there is no style', () => {
    assert.equal(leadWithStyle('A deer in a forest.', ''), 'A deer in a forest.')
    assert.equal(leadWithStyle('A deer in a forest.', undefined), 'A deer in a forest.')
    assert.equal(leadWithStyle('  A deer.  ', '   '), 'A deer.')
  })
})

/**
 * v1.0.527 — Image Studio endpoint identity guard.
 *
 * A sibling Pinokio modal (Voice Studio / Chat Studio) mistyped into the Image
 * Studio endpoint pool answers /api/health with the SAME `{ ok: true }` shape,
 * passes the liveness probe, then 404s (`{"detail":"Not Found"}`) on every
 * image submit because it has no /api/generate/* routes. `detectSiblingStudio`
 * reads the app-dir path from the health payload (hf_home / hub_dir) and
 * flags known non-image siblings so the preflight probe fails them over.
 * It fails OPEN: a real Image Studio (or an unknown/custom dir) is never
 * rejected.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { detectSiblingStudio } from '../lib/imagestudio-client.js'

describe('detectSiblingStudio', () => {
  test('flags a Voice Studio modal by its install dir', () => {
    assert.equal(
      detectSiblingStudio('/Users/kt-m1-macmini/pinokio/api/voicestudio-mac.git/cache/HF_HOME'),
      'Voice Studio',
    )
  })

  test('flags a Chat Studio modal by its install dir', () => {
    assert.equal(
      detectSiblingStudio('/Users/x/pinokio/api/chatstudio-mac/cache/HF_HOME'),
      'Chat Studio',
    )
  })

  test('allows a real Image Studio modal through', () => {
    assert.equal(
      detectSiblingStudio('/build/pinokio/api/imagestudio-mac/cache/HF_HOME'),
      null,
    )
  })

  test('fails OPEN for an unknown / custom HF_HOME (never over-rejects)', () => {
    assert.equal(detectSiblingStudio('/mnt/models/cache'), null)
    assert.equal(detectSiblingStudio(undefined, null), null)
    assert.equal(detectSiblingStudio(''), null)
  })

  test('an imagestudio dir wins even if another token appears elsewhere', () => {
    // Defensive: a path that mentions imagestudio is authoritative.
    assert.equal(
      detectSiblingStudio('/Users/x/pinokio/api/imagestudio-mac', '/tmp/voicestudio-scratch'),
      null,
    )
  })

  test('reads either hf_home or hub_dir (whichever the modal reports)', () => {
    assert.equal(detectSiblingStudio(undefined, '/x/voicestudio-mac.git/hub'), 'Voice Studio')
  })
})

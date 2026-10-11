/**
 * E1 (1.4.287) golden: with none of the new effects chosen, every effect that existed before
 * compiles to exactly what 1.4.285 compiled — FFmpeg filters, native camera jobs, xfade graphs,
 * stored documents (preview cache keys and render fingerprints are built from them), the resolved
 * Effects Library stack and the look description. Captured by `_effects-e1-golden.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { captureGolden } from './_effects-e1-golden.js'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/effects-e1-off-golden.json', import.meta.url), 'utf8'))

test('every pre-E1 effect, transition and stack renders exactly as in 1.4.285', () => {
  const now = captureGolden({
    motions: Object.keys(fixture.motions),
    overlays: Object.keys(fixture.overlays),
    transitions: Object.keys(fixture.transitions),
  })
  assert.equal(Object.keys(now.motions).length, Object.keys(fixture.motions).length, 'no pre-E1 motion was removed')
  assert.equal(Object.keys(now.overlays).length, Object.keys(fixture.overlays).length, 'no pre-E1 effect was removed')
  assert.equal(Object.keys(now.transitions).length, Object.keys(fixture.transitions).length, 'no pre-E1 transition was removed')
  for (const key of ['motions', 'footage', 'overlays', 'transitions', 'pool', 'stack', 'look'] as const) {
    assert.deepEqual(JSON.parse(JSON.stringify(now[key])), fixture[key], `${key} changed`)
  }
})

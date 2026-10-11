/**
 * E2–E4 (1.4.288) golden: with none of the picture-aware effects chosen and scene analysis off,
 * every effect that existed in 1.4.287 compiles to exactly what it compiled then — FFmpeg filters,
 * native camera jobs, xfade graphs, stored documents (preview cache keys and render fingerprints
 * are built from them), the resolved Effects Library stack and the look description. Captured from
 * 20e6fd7b with `_effects-e1-golden.ts` into `fixtures/effects-e2e4-off-golden.json`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { captureGolden } from './_effects-e1-golden.js'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/effects-e2e4-off-golden.json', import.meta.url), 'utf8'))

test('every 1.4.287 effect, transition and stack renders exactly as in 1.4.287', () => {
  const now = captureGolden({
    motions: Object.keys(fixture.motions),
    overlays: Object.keys(fixture.overlays),
    transitions: Object.keys(fixture.transitions),
  })
  assert.equal(Object.keys(now.motions).length, Object.keys(fixture.motions).length, 'no 1.4.287 motion was removed')
  assert.equal(Object.keys(now.overlays).length, Object.keys(fixture.overlays).length, 'no 1.4.287 effect was removed')
  assert.equal(Object.keys(now.transitions).length, Object.keys(fixture.transitions).length, 'no 1.4.287 transition was removed')
  for (const key of ['motions', 'footage', 'overlays', 'transitions', 'pool', 'stack', 'look'] as const) {
    assert.deepEqual(JSON.parse(JSON.stringify(now[key])), fixture[key], `${key} changed`)
  }
})

/**
 * Contextual cue placement, from the review screen's point of view (v1.3.0).
 *
 * Two jobs here.
 *
 * The first is the geometry contract the page draws its preview from. The
 * preview doubles as the drag pad, so if it disagrees with the renderer the
 * customer is placing labels against a lie. Both sides import
 * `@shared/contextual-cue-position`, and these assertions pin what that module
 * promises.
 *
 * The second is a source sweep, and it is the more important of the two. The
 * defect this release fixes was never a wrong calculation — every layer
 * computed all four corners correctly. It was that SIX independent places each
 * decided for themselves which corners were offered, and half of them said
 * two. No unit test could see that, because each layer was individually right.
 * The sweep below fails if any of them starts hardcoding a corner menu again,
 * in the same spirit as `characterSheetWorkspace.test.ts` sweeping for a
 * literal pacing pair.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONTEXTUAL_CUE_CORNERS,
  CUE_SAFE_MARGIN_PCT,
  clampCuePct,
  hasPreciseCuePosition,
  isContextualCueCorner,
  nearestCueCorner,
  resolveContextualCuePosition,
} from '../../electron/server/contracts/contextual-cue-position.ts'

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..')

describe('contextual cue placement contract', () => {
  test('all four corners are the offered set, in a stable order', () => {
    assert.deepEqual([...CONTEXTUAL_CUE_CORNERS], ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
    for (const corner of CONTEXTUAL_CUE_CORNERS) assert.ok(isContextualCueCorner(corner))
    assert.ok(!isContextualCueCorner('middle'))
    assert.ok(!isContextualCueCorner(undefined))
  })

  test('a corner cue resolves to the safe band, not the frame edge', () => {
    const at = (placement: any) => resolveContextualCuePosition({ placement })
    assert.deepEqual(at('top-left'), { xPct: CUE_SAFE_MARGIN_PCT, yPct: CUE_SAFE_MARGIN_PCT, custom: false })
    assert.deepEqual(at('bottom-right'), { xPct: 100 - CUE_SAFE_MARGIN_PCT, yPct: 100 - CUE_SAFE_MARGIN_PCT, custom: false })
    assert.deepEqual(at('bottom-left'), { xPct: CUE_SAFE_MARGIN_PCT, yPct: 100 - CUE_SAFE_MARGIN_PCT, custom: false })
    assert.deepEqual(at('top-right'), { xPct: 100 - CUE_SAFE_MARGIN_PCT, yPct: CUE_SAFE_MARGIN_PCT, custom: false })
  })

  test('a precise anchor wins, and only when both axes are present', () => {
    const both = resolveContextualCuePosition({ placement: 'top-right', position_x_pct: 30, position_y_pct: 70 })
    assert.deepEqual(both, { xPct: 30, yPct: 70, custom: true })
    // Half an anchor falls back to the corner rather than sliding one axis.
    const half = resolveContextualCuePosition({ placement: 'top-right', position_x_pct: 30, position_y_pct: null })
    assert.equal(half.custom, false)
    assert.equal(half.xPct, 100 - CUE_SAFE_MARGIN_PCT)
    assert.equal(hasPreciseCuePosition({ placement: 'top-right', position_x_pct: 30 }), false)
    assert.equal(hasPreciseCuePosition({ placement: 'top-right', position_x_pct: 30, position_y_pct: 70 }), true)
  })

  test('an anchor dragged past the edge is pulled back into the safe band', () => {
    const out = resolveContextualCuePosition({ placement: 'top-left', position_x_pct: -20, position_y_pct: 140 })
    assert.equal(out.xPct, CUE_SAFE_MARGIN_PCT)
    assert.equal(out.yPct, 100 - CUE_SAFE_MARGIN_PCT)
    assert.equal(clampCuePct(50), 50)
    assert.equal(clampCuePct(0), CUE_SAFE_MARGIN_PCT)
    assert.equal(clampCuePct(100), 100 - CUE_SAFE_MARGIN_PCT)
  })

  test('a dragged cue keeps an honest corner underneath it', () => {
    // So that dropping the precise anchor later falls back to where the cue
    // actually was, not the corner it was originally proposed with.
    assert.equal(nearestCueCorner(10, 10), 'top-left')
    assert.equal(nearestCueCorner(90, 10), 'top-right')
    assert.equal(nearestCueCorner(10, 90), 'bottom-left')
    assert.equal(nearestCueCorner(90, 90), 'bottom-right')
  })
})

describe('no layer may narrow the corner menu on its own', () => {
  /**
   * The exact regression, by file. Each of these once decided the corner set
   * for itself and three of them said "top only"; the customer's logo was
   * covered for four months as a result.
   */
  // v1.4.365 — the page is `sound-and-labels.vue`; the placement route moved
  // with it into `routes/sound-and-labels.ts`. The contract this sweeps for is
  // unchanged: no layer may decide the corner set on its own.
  const GUARDED = [
    'pages/projects/[slug]/sound-and-labels.vue',
    '../electron/server/services/contextual-cues.ts',
    '../electron/server/routes/pipeline.ts',
    '../electron/server/routes/sound-and-labels.ts',
  ]

  test('no guarded file collapses placement to the two top corners', () => {
    for (const relative of GUARDED) {
      const source = readFileSync(path.join(FRONTEND_ROOT, relative), 'utf8')
      // The precise shape that caused this: a ternary choosing between the two
      // top corners and nothing else.
      assert.ok(
        !/===\s*'top-left'\s*\?\s*'top-left'\s*:\s*'top-right'/.test(source),
        `${relative} collapses any non-top-left placement to top-right again`,
      )
    }
  })

  test('the review page builds its corner menus from the shared list', () => {
    const page = readFileSync(path.join(FRONTEND_ROOT, 'pages/projects/[slug]/sound-and-labels.vue'), 'utf8')
    assert.ok(
      page.includes("from '@shared/contextual-cue-position'"),
      'the page must take its corners from the shared contract, not a local copy',
    )
    // Two menus — the per-cue one and the proposal default — and neither may
    // enumerate its own options.
    const hardcodedOptions = page.match(/<option value="(?:top|bottom)-(?:left|right)"/g) || []
    assert.equal(
      hardcodedOptions.length, 0,
      `the page hardcodes ${hardcodedOptions.length} corner <option>(s); render them from CONTEXTUAL_CUE_CORNERS instead`,
    )
  })

  test('the shared contract is reachable from the frontend build', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(FRONTEND_ROOT, 'tsconfig.json'), 'utf8'))
    assert.ok(
      tsconfig.compilerOptions.paths['@shared/contextual-cue-position'],
      'the @shared alias must resolve or the page falls back to a duplicated copy',
    )
    assert.ok(
      readFileSync(path.join(REPO_ROOT, 'electron/server/contracts/contextual-cue-position.ts'), 'utf8').length > 0,
    )
  })
})

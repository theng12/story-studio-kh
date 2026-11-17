/**
 * One stuck final-render row must not freeze the others (owner, 2026-11-16).
 *
 * EP0105's `video_assembly` ran about 11.5 hours for an 885-second video with
 * progress and bytes null. The reconciler walked its rows one after another
 * (`runShared` was single-flight), so a request that never answered held the
 * whole pass — every other final-render row on that Mac went quiet with it. The
 * pass now bounds each row's turn by a phase ceiling and runs the rows
 * independently.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  _setFinalRenderReconcileForTesting,
  _resetFinalRenderReconcilerForTesting,
  runFinalRenderReconcilePassForTesting,
} from '../services/final-render-reconciler.js'

const STUCK = { project_slug: 'stuck-project', job_id: 'stuck-row' }
const HEALTHY = { project_slug: 'healthy-project', job_id: 'healthy-row' }

test('a row that never answers does not block a row that can finish', async () => {
  const finished: string[] = []
  _setFinalRenderReconcileForTesting({
    phaseStallMs: 50,
    candidates: [STUCK, HEALTHY],
    reconcileOne: async identity => {
      if (identity.job_id === STUCK.job_id) return await new Promise<boolean>(() => {}) // never settles
      finished.push(identity.job_id)
      return true
    },
  })
  try {
    // The stuck row's ceiling ends its turn; the healthy row's work still lands.
    await runFinalRenderReconcilePassForTesting(Date.now())
    assert.deepEqual(finished, [HEALTHY.job_id], 'the healthy row must be reconciled in the same pass')
  } finally {
    await _resetFinalRenderReconcilerForTesting()
  }
})

test('the same row is skipped while its ceiling backoff is still running', async () => {
  let turns = 0
  _setFinalRenderReconcileForTesting({
    phaseStallMs: 30,
    candidates: [STUCK],
    reconcileOne: async () => {
      turns += 1
      return await new Promise<boolean>(() => {})
    },
  })
  try {
    const now = Date.now()
    await runFinalRenderReconcilePassForTesting(now)
    assert.equal(turns, 1)
    // A second pass inside the backoff window must not start another doomed turn.
    await runFinalRenderReconcilePassForTesting(now + 100)
    assert.equal(turns, 1, 'the row backs off after its stall instead of retrying in a tight loop')
  } finally {
    await _resetFinalRenderReconcilerForTesting()
  }
})

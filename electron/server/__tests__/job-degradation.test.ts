/**
 * A render that silently discards requested output must not report a clean
 * success.
 *
 * Regression origin (v1.0.798): when the full filter graph failed, the final
 * encode's tier-3 recovery path rebuilt the argv without `filter_complex` at
 * all. That produced a complete, playable video with every text overlay
 * missing — not just the contextual cues that triggered the failure, but the
 * burned-in subtitles too — and the job reported `done` with `error: null`
 * and no warning anywhere the user would see. The owner would have published
 * a video missing two features he explicitly asked for.
 *
 * The fallback itself is correct and stays: a complete video with missing
 * overlays beats a failed render. What was wrong is that it lied about it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  declareJobDegraded,
  requireJobCompletion,
  assertJobDidNotDeclareIncomplete,
  DEGRADED_LINE_PREFIX,
} from '../services/job-completion.js'
import type { Job } from '../models/types.js'

function job(): Job {
  return { output_lines: [], status: 'running', error: null } as unknown as Job
}

const REQUESTED = ['burned-in subtitles', '10 contextual cue(s)', 'logo']

describe('degraded render reporting', () => {
  test('a fallback that dropped requested features says so in the job result', () => {
    const j = job()
    declareJobDegraded(j, {
      tier: 'H.264 · no effects (recovery)',
      reason: 'filter graph rejected',
      requested: REQUESTED,
      survived: [],
      dropped: REQUESTED,
    })

    const degraded = j.result?.degraded
    assert.ok(degraded, 'result must carry a machine-readable degradation record')
    assert.deepEqual(degraded.requested, REQUESTED, 'must record what was requested')
    assert.deepEqual(degraded.survived, [], 'must record what survived')
    assert.deepEqual(degraded.dropped, REQUESTED, 'must record what was dropped')
    assert.equal(degraded.tier, 'H.264 · no effects (recovery)')
    assert.match(degraded.reason, /filter graph rejected/)
  })

  test('the loss is stated in output_lines, naming each missing feature', () => {
    const j = job()
    declareJobDegraded(j, {
      tier: 'H.264 · no effects (recovery)',
      reason: 'filter graph rejected',
      requested: REQUESTED,
      survived: [],
      dropped: REQUESTED,
    })
    const text = j.output_lines.join('\n')
    assert.ok(text.includes(DEGRADED_LINE_PREFIX), 'must carry the degraded marker')
    for (const feature of REQUESTED) {
      assert.ok(text.includes(feature), `output must name the dropped feature: ${feature}`)
    }
  })

  test('a clean run is never marked degraded', () => {
    const j = job()
    declareJobDegraded(j, {
      tier: 'H.264 · libx264 (hardware fallback, full effects)',
      reason: 'videotoolbox unavailable',
      requested: REQUESTED,
      survived: REQUESTED,
      dropped: [],
    })
    assert.equal(j.result?.degraded, undefined, 'nothing dropped ⇒ no degradation record')
    assert.deepEqual(j.output_lines, [], 'and no scary warning for a full-fidelity retry')
  })

  test('degradation does not fail the job, so the usable video is kept', () => {
    // The deliberate design call: `complete` stays true and the status stays
    // `done`. Declaring incomplete would make the queue throw and convert this
    // into an `error` job — destroying the one watchable file we chose to keep.
    const j = job()
    declareJobDegraded(j, {
      tier: 'H.264 · no effects (recovery)',
      reason: 'filter graph rejected',
      requested: REQUESTED,
      survived: [],
      dropped: REQUESTED,
    })
    requireJobCompletion(j, { label: 'Final video assembly', expected: 1, completed: 1 })

    assert.equal(j.result?.complete, true)
    assert.doesNotThrow(() => assertJobDidNotDeclareIncomplete(j))
    // …and the completion audit must not have erased the degradation record.
    assert.ok(j.result?.degraded, 'requireJobCompletion must preserve result.degraded')
    assert.deepEqual(j.result.degraded.dropped, REQUESTED)
  })

  test('a degraded result is distinguishable from a clean one by result alone', () => {
    // The actual bug was that these two were indistinguishable without reading
    // the full scrolling log.
    const clean = job()
    requireJobCompletion(clean, { label: 'Final video assembly', expected: 1, completed: 1 })

    const lossy = job()
    declareJobDegraded(lossy, {
      tier: 'H.264 · no effects (recovery)',
      reason: 'filter graph rejected',
      requested: REQUESTED, survived: [], dropped: REQUESTED,
    })
    requireJobCompletion(lossy, { label: 'Final video assembly', expected: 1, completed: 1 })

    assert.equal(clean.result?.complete, lossy.result?.complete, 'both are complete renders')
    assert.notDeepEqual(
      clean.result?.degraded, lossy.result?.degraded,
      'but the degraded one must be identifiable from result without parsing logs',
    )
  })
})

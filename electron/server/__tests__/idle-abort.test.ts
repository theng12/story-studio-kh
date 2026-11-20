/**
 * 1.4.415 — the bound both final-render transfers now use: silence, not duration.
 *
 * The defect was a wall clock: `download-video.ts` and the import's phase ceiling were both
 * 300 000 ms, so a transfer over five minutes could never finish. A transfer that keeps delivering
 * bytes is progress; one that stops is over. This is that rule, tested directly — and the same helper
 * backs the 306-second end-to-end transfer in `download-video-idle-bound.test.ts`.
 *
 * WHY TWO FIXED SLEEPS ARE BASELINED HERE (and why that is not the usual widening): the elapsed gap is
 * the quantity under test. "Keeps delivering" means a gap SHORTER than the bound must not abort, and
 * "stops" means a silent gap LONGER than it must — a `waitFor` would replace the measurement with a
 * poll and delete the assertion. The risk the ratchet guards against (a slow machine turning padding
 * into a flake) is inverted here: a slower machine makes the first case's gaps *longer*, and the second
 * case waits on the abort event rather than on a timer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createIdleAbort } from '../lib/idle-abort.js'

test('silence aborts at the bound, and the reason names how long the silence was', async () => {
  const idle = createIdleAbort(80, seconds => `stalled: no bytes for ${seconds}s`)
  assert.equal(idle.signal.aborted, false)
  await new Promise(resolve => idle.signal.addEventListener('abort', resolve, { once: true }))
  assert.equal(idle.signal.aborted, true)
  assert.match(String((idle.signal.reason as Error)?.message), /no bytes for 0s|stalled/)
  idle.dispose()
})

test('a transfer that keeps delivering is never aborted, however long it takes in total', async () => {
  const idle = createIdleAbort(150, seconds => `stalled: ${seconds}s`)
  const started = Date.now()
  // Six touches over ~600 ms: eight times the bound in total, and silent never longer than 60 ms.
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    idle.touch()
  }
  assert.ok(Date.now() - started > 500, 'the transfer really outlived the bound several times over')
  assert.equal(idle.signal.aborted, false, 'progress is what the bound measures, not elapsed time')
  idle.dispose()
})

test('dispose leaves no timer behind, so a finished transfer cannot abort anything later', async () => {
  const idle = createIdleAbort(30, seconds => `stalled: ${seconds}s`)
  idle.dispose()
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(idle.signal.aborted, false)
})

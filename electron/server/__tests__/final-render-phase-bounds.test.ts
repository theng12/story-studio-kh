/**
 * 1.4.415 — the transfer phase is bounded by progress, every other phase by the wall clock.
 *
 * The pass gives each row's turn a 5-minute ceiling. That is right for a phase that ANSWERS (send,
 * lookup, monitor): a point has either answered or it has not. It is wrong for `importing`, which moves
 * a file whose size nobody can predict — and it was wrong twice over, because `download-video.ts`
 * aborted at the same 300 000 ms. A transfer that keeps delivering bytes is progress; the per-range
 * idle bound in `lib/idle-abort.ts` is what ends one that stops.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

test('only the transfer phase is exempt from the wall-clock ceiling', async () => {
  const { isProgressBoundPhase } = await import('../services/final-render-reconciler.js')
  assert.equal(isProgressBoundPhase('importing'), true, 'a transfer is measured by progress')
  for (const phase of ['output_ready', 'send', 'remote_wait', 'lookup', 'acknowledged', 'prepare']) {
    assert.equal(isProgressBoundPhase(phase), false, `${phase} answers or does not; it keeps the ceiling`)
  }
})

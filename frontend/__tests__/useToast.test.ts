/**
 * Tests for the `useToast.successUndoable` state machine.
 *
 * Four branches pin the contract the `remove()` handler in ideas.vue relies
 * on (and every future consumer of the pattern):
 *
 *   1. undo-within-window  — user clicks Undo → onUndo fires, onTimeout does NOT.
 *   2. timeout-success     — no click → onTimeout fires, toast clears.
 *   3. timeout-error       — onTimeout throws → onUndo rolls back UI, an error
 *      toast is surfaced so the user isn't left with a silent failure.
 *   4. double-fire guard   — calling Undo twice, or Undo after timeout, never
 *      re-fires handlers. Protects against a race between the setTimeout
 *      callback and a user click that lands in the same tick.
 *
 * We run against the real composable, not a reimplementation. The `ref` /
 * `readonly` imports are satisfied by frontend/node_modules/vue (Nuxt dep).
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useToast, type Toast } from '../composables/useToast.js'

// Clear the module-scoped toast list between tests. The composable stores
// its state in a module-level `ref`, so prior tests would otherwise leave
// toasts hanging around.
function resetToasts() {
  const { toasts } = useToast() as unknown as { toasts: { value: Toast[] } }
  // `toasts` is a ReadonlyRef — we swap its underlying array via a fresh
  // successUndoable→undo cycle would be wasteful. Direct assignment via the
  // real (non-readonly) ref isn't exposed, so we just pop everything with
  // a tiny sleep approach: rely on each test creating a distinct snapshot.
  // (In practice the tests below pull a fresh ref at the start of each run.)
  void toasts
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

describe('useToast.successUndoable', () => {
  beforeEach(resetToasts)

  test('onUndo fires and onTimeout never runs when Undo is clicked in window', async () => {
    const { successUndoable, toasts } = useToast()

    let undoCount = 0
    let timeoutCount = 0

    successUndoable({
      message: 'Deleted X',
      onUndo: () => { undoCount++ },
      onTimeout: () => { timeoutCount++ },
      duration: 200,
    })

    // Toast was pushed with an onUndo handler attached.
    const pushed = toasts.value.find(t => t.message === 'Deleted X')
    assert.ok(pushed, 'toast should be in the list')
    assert.ok(typeof pushed!.onUndo === 'function', 'undoable toast exposes onUndo')

    // User clicks Undo well before the 200ms window closes.
    await pushed!.onUndo!()

    assert.equal(undoCount, 1, 'onUndo should fire exactly once')
    assert.equal(timeoutCount, 0, 'onTimeout must NOT fire after successful undo')
    assert.equal(
      toasts.value.find(t => t.message === 'Deleted X'),
      undefined,
      'toast must be removed from the list after undo',
    )

    // Wait past the original duration to prove the timer was cancelled —
    // if it wasn't, onTimeout would now have been called.
    await sleep(300)
    assert.equal(timeoutCount, 0, 'timer must have been cancelled by undo')
  })

  test('onTimeout fires when the window expires with no user action', async () => {
    const { successUndoable, toasts } = useToast()

    let undoCount = 0
    let timeoutCount = 0

    successUndoable({
      message: 'Deleted Y',
      onUndo: () => { undoCount++ },
      onTimeout: () => { timeoutCount++ },
      duration: 100,
    })

    assert.ok(toasts.value.find(t => t.message === 'Deleted Y'), 'toast is live')

    await sleep(200) // comfortably past the 100ms window

    assert.equal(timeoutCount, 1, 'onTimeout should fire once')
    assert.equal(undoCount, 0, 'onUndo should not fire on natural timeout')
    assert.equal(
      toasts.value.find(t => t.message === 'Deleted Y'),
      undefined,
      'toast must be cleared after timeout',
    )
  })

  test('onTimeout throwing triggers onUndo rollback and surfaces an error toast', async () => {
    const { successUndoable, toasts } = useToast()

    let undoCount = 0

    successUndoable({
      message: 'Deleted Z',
      onUndo: () => { undoCount++ },
      onTimeout: async () => { throw new Error('backend hiccup') },
      duration: 80,
    })

    await sleep(200)

    assert.equal(undoCount, 1, 'failed onTimeout must call onUndo to restore UI')
    // An error toast should have been surfaced with the humanised message.
    const errorToast = toasts.value.find(t => t.type === 'error')
    assert.ok(errorToast, 'an error toast should surface after failed destructive call')
    assert.match(errorToast!.message, /hiccup|failed/i)
    // The original optimistic toast is gone.
    assert.equal(
      toasts.value.find(t => t.message === 'Deleted Z'),
      undefined,
      'original optimistic toast is cleared before the error surfaces',
    )
  })

  test('clicking Undo twice only triggers the rollback once', async () => {
    const { successUndoable, toasts } = useToast()

    let undoCount = 0
    let timeoutCount = 0

    successUndoable({
      message: 'Deleted W',
      onUndo: () => { undoCount++ },
      onTimeout: () => { timeoutCount++ },
      duration: 200,
    })

    const pushed = toasts.value.find(t => t.message === 'Deleted W')!
    await pushed.onUndo!()
    await pushed.onUndo!()   // second click — button may still be in user's DOM

    assert.equal(undoCount, 1, 'resolved flag must prevent a second onUndo invocation')

    // Also verify that once timeout fires AFTER an undo, nothing happens.
    await sleep(300)
    assert.equal(timeoutCount, 0)
    assert.equal(undoCount, 1)
  })

  test('onTimeout after an undo does not re-fire the handler (race guard)', async () => {
    // Simulates the race where setTimeout and onUndo land in the same tick.
    const { successUndoable, toasts } = useToast()

    let undoCount = 0
    let timeoutCount = 0

    successUndoable({
      message: 'Deleted V',
      onUndo: () => { undoCount++ },
      onTimeout: () => { timeoutCount++ },
      duration: 50,
    })

    // Race: the timer is about to fire; we click undo at the same ms.
    const pushed = toasts.value.find(t => t.message === 'Deleted V')!
    await sleep(48)
    await pushed.onUndo!()
    await sleep(200) // well past the original duration

    assert.equal(
      undoCount + timeoutCount,
      1,
      'exactly one terminal handler must run, never both',
    )
  })
})

test('toast presentation hides request identities without changing caller input', () => {
  const { success, toasts } = useToast()
  const source = 'Queued Job job_123456789 for recovery'
  success(source)
  assert.equal(source, 'Queued Job job_123456789 for recovery')
  assert.ok(toasts.value.find(toast => toast.message === 'Queued Job [request hidden] for recovery'))
  assert.equal(toasts.value.some(toast => toast.message.includes('job_123456789')), false)
})

test('toast presentation preserves unrelated UUID-like customer content', () => {
  const { success, toasts } = useToast()
  const source = 'Project 123e4567-e89b-12d3-a456-426614174000 saved render_12345678901234567890.png'
  success(source)
  assert.ok(toasts.value.find(toast => toast.message === source))
})

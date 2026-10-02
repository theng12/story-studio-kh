/**
 * Tests for `useAutoSave` — the debounced auto-save state machine.
 *
 * The five-state lifecycle is what every "saved just now" / "saving…" /
 * "error saving" hint in the app renders from:
 *
 *     idle ─► dirty ─► saving ─► saved
 *                              └► error
 *
 * Invariants pinned here:
 *
 *   1. scheduleSave() flips state to 'dirty' and debounces rapid calls into
 *      one save. The last call's save promise wins.
 *   2. During the save promise, state is 'saving'; after success, 'saved'
 *      + savedAt populated.
 *   3. An error maps to state='error' with humanised errorMessage and fires
 *      the optional onError hook.
 *   4. flush() cancels the pending debounce and runs the save immediately.
 *   5. reset() returns to 'idle' and clears the savedAt / errorMessage.
 *   6. Concurrent scheduleSave() while a save is in-flight coalesces —
 *      the `pending` flag prevents overlapping invocations.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { useAutoSave } from '../composables/useAutoSave.js'

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

describe('useAutoSave', () => {
  test('scheduleSave → state cycles dirty → saving → saved', async () => {
    let saveCount = 0
    const { state, savedAt, scheduleSave } = useAutoSave({
      debounceMs: 30,
      save: async () => { saveCount++ },
    })
    assert.equal(state.value, 'idle')
    assert.equal(savedAt.value, null)

    scheduleSave()
    assert.equal(state.value, 'dirty', 'flips to dirty immediately')

    // Wait past the debounce to let the save run and settle.
    await sleep(80)
    assert.equal(state.value, 'saved')
    assert.equal(saveCount, 1)
    assert.ok(savedAt.value && savedAt.value > 0, 'savedAt timestamp populated')
  })

  test('rapid scheduleSave calls coalesce into a single save', async () => {
    let saveCount = 0
    const { scheduleSave } = useAutoSave({
      debounceMs: 30,
      save: async () => { saveCount++ },
    })

    // Five rapid-fire mutations — debounce should collapse them.
    scheduleSave(); scheduleSave(); scheduleSave(); scheduleSave(); scheduleSave()
    await sleep(80)
    assert.equal(saveCount, 1, 'five scheduleSave() calls must debounce to one save')
  })

  test('save() throwing yields state=error + errorMessage + onError callback', async () => {
    let onErrorCalls = 0
    const { state, errorMessage, scheduleSave } = useAutoSave({
      debounceMs: 20,
      save: async () => { throw new Error('disk full') },
      onError: () => { onErrorCalls++ },
    })

    scheduleSave()
    await sleep(80)
    assert.equal(state.value, 'error')
    assert.match(errorMessage.value, /disk full/)
    assert.equal(onErrorCalls, 1, 'onError callback fires exactly once')
  })

  test('flush() runs the save immediately and cancels the pending debounce', async () => {
    let saveCount = 0
    let timestamps: number[] = []
    const { state, scheduleSave, flush } = useAutoSave({
      debounceMs: 1000, // long enough that only flush() could trigger a save in-window
      save: async () => { saveCount++; timestamps.push(Date.now()) },
    })

    const t0 = Date.now()
    scheduleSave()
    await flush()
    const elapsed = Date.now() - t0

    assert.equal(saveCount, 1, 'flush triggers exactly one save')
    assert.ok(elapsed < 200, `flush should not wait for the debounce (took ${elapsed}ms)`)
    assert.equal(state.value, 'saved')

    // Wait past the original debounce to prove the pending timer was cleared.
    await sleep(1100)
    assert.equal(saveCount, 1, 'pending debounce timer was cancelled by flush')
  })

  test('reset() returns the machine to idle and clears savedAt / error', async () => {
    const { state, savedAt, errorMessage, scheduleSave, reset } = useAutoSave({
      debounceMs: 20,
      save: async () => {},
    })

    scheduleSave()
    await sleep(80)
    assert.equal(state.value, 'saved')
    assert.ok(savedAt.value)

    reset()
    assert.equal(state.value, 'idle')
    assert.equal(savedAt.value, null)
    assert.equal(errorMessage.value, '')
  })

  test('scheduleSave while a save is in-flight does not overlap saves', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { scheduleSave } = useAutoSave({
      debounceMs: 10,
      save: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(50)
        inFlight--
      },
    })

    scheduleSave()
    // Wait until the first save is mid-flight, then schedule another.
    await sleep(30)
    scheduleSave()
    await sleep(150)

    assert.equal(maxInFlight, 1, 'pending guard must prevent overlapping save invocations')
  })
})

describe('useAutoSave — edit made while a save is in flight', () => {
  test('the later edit is saved after the in-flight save finishes (not dropped)', async () => {
    let value = 'a'
    const saved: string[] = []
    const { state, scheduleSave, flush } = useAutoSave({
      debounceMs: 5,
      save: async () => { const v = value; await sleep(40); saved.push(v) },
    })

    scheduleSave()
    await sleep(15) // first save ('a') is now in flight
    value = 'b'
    scheduleSave() // debounce (5 ms) fires while 'a' is still saving
    await sleep(120)
    assert.deepEqual(saved, ['a', 'b'], 'the edit made during the save must be written')
    assert.equal(state.value, 'saved')

    // flush() during an in-flight save waits for the newest data to land.
    value = 'c'
    scheduleSave()
    await sleep(15)
    value = 'd'
    await flush()
    assert.deepEqual(saved, ['a', 'b', 'c', 'd'])
  })
})

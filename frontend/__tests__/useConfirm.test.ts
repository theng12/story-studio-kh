/**
 * Tests for the `useConfirm` singleton state machine.
 *
 * This composable is the trunk every destructive action in the app now
 * routes through (delete project, remove API key, delete preset,
 * repair folders, load template, reset idea, …). A regression here
 * would either strand dialogs (resolve never fires) or silently
 * double-fire destructive backend calls.
 *
 * Invariants covered:
 *
 *   1. `ask()` resolves `true` when `confirm()` is called.
 *   2. `ask()` resolves `false` when `cancel()` is called.
 *   3. Calling `confirm()` or `cancel()` twice is safe (nothing to resolve
 *      the second time — no double-invocation of the caller's continuation).
 *   4. A second `ask()` while one is pending auto-resolves the prior to
 *      `false` and takes over the dialog slot.
 *   5. Default labels apply: Confirm/Cancel normally, Delete/Cancel in danger
 *      mode. Caller-supplied labels override defaults.
 *   6. Terminal state: after `confirm()` / `cancel()`, `state.visible` is
 *      false and `state.resolve` is cleared.
 *
 * Runs against the real composable via the frontend workspace's `vue` dep.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { useConfirm } from '../composables/useConfirm.js'

// The composable's state is module-scoped singleton. Each test works
// through a full lifecycle (ask → resolve) so the state ends up clean
// for the next test. If a test leaves state dangling it'll surface as
// unexpected behaviour in the next test — which is itself a useful signal.

describe('useConfirm.ask()', () => {
  test('resolves true when confirm() is called', async () => {
    const { ask, confirm, state } = useConfirm()

    const pending = ask({ title: 'Go ahead?' })
    assert.equal(state.visible, true, 'dialog opens when ask() is called')
    assert.equal(state.options.title, 'Go ahead?')

    confirm()
    const result = await pending
    assert.equal(result, true, 'confirm() resolves the pending promise to true')
    assert.equal(state.visible, false, 'visibility clears on resolve')
    assert.equal(state.resolve, null, 'resolve handle is cleared after firing')
  })

  test('resolves false when cancel() is called', async () => {
    const { ask, cancel, state } = useConfirm()

    const pending = ask({ title: 'Discard changes?' })
    cancel()
    const result = await pending
    assert.equal(result, false)
    assert.equal(state.visible, false)
    assert.equal(state.resolve, null)
  })

  test('a second ask() auto-cancels the first and takes over', async () => {
    const { ask, confirm, state } = useConfirm()

    const first = ask({ title: 'First?' })
    const second = ask({ title: 'Second?' })

    // The first promise is auto-resolved to false when the second ask lands.
    assert.equal(await first, false, 'first ask must be auto-cancelled')

    assert.equal(state.options.title, 'Second?', 'state reflects the second ask')
    confirm()
    assert.equal(await second, true, 'second ask still resolves normally')
  })

  test('calling confirm() when nothing is pending is a safe no-op', () => {
    const { confirm, cancel, state } = useConfirm()
    // No active dialog — calls should not throw and state stays clean.
    confirm()
    cancel()
    assert.equal(state.visible, false)
    assert.equal(state.resolve, null)
  })

  test('default labels: Confirm / Cancel, danger swaps to Delete', async () => {
    const { ask, cancel, state } = useConfirm()

    // Non-danger
    const p1 = ask({ title: 'T' })
    assert.equal(state.options.confirmLabel, 'Confirm')
    assert.equal(state.options.cancelLabel, 'Cancel')
    cancel()
    await p1

    // Danger swaps the confirm label
    const p2 = ask({ title: 'T', danger: true })
    assert.equal(state.options.confirmLabel, 'Delete',
      'danger mode defaults the confirm label to "Delete"')
    assert.equal(state.options.cancelLabel, 'Cancel')
    cancel()
    await p2
  })

  test('caller-supplied labels override defaults', async () => {
    const { ask, cancel, state } = useConfirm()
    const p = ask({
      title: 'Quit without saving?',
      confirmLabel: 'Quit anyway',
      cancelLabel: 'Keep editing',
      danger: true,
    })
    assert.equal(state.options.confirmLabel, 'Quit anyway',
      'explicit confirmLabel overrides the danger default')
    assert.equal(state.options.cancelLabel, 'Keep editing')
    cancel()
    await p
  })

  test('calling cancel() twice on the same dialog resolves once', async () => {
    const { ask, cancel, state } = useConfirm()

    const pending = ask({ title: 'Once?' })
    cancel()
    cancel() // second call must be a no-op — resolve is already cleared
    const result = await pending
    assert.equal(result, false)
    assert.equal(state.visible, false)
  })
})

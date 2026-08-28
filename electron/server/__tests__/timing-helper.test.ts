/**
 * Tests for `_timing.ts`, the shared wait helper.
 *
 * This helper is load-bearing: several suites now decide pass/fail through it
 * instead of through a fixed sleep. A bug that made `waitFor` return early —
 * or never fail — would quietly turn every one of those assertions vacuous
 * while the suite stayed green. So the contract is pinned here.
 *
 * These tests are about the helper's own logic (does it poll, does it give up,
 * does it return the value). They deliberately avoid asserting how LONG
 * anything took, which would reintroduce exactly the defect class the helper
 * exists to remove.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { waitFor, waitForValue } from './_timing.js'

describe('waitFor', () => {
  test('returns as soon as the condition is already true, without polling', async () => {
    let probes = 0
    await waitFor(() => { probes += 1; return true })
    assert.equal(probes, 1, 'a condition true on entry must not sleep at all')
  })

  test('polls until the condition flips, then returns', async () => {
    let probes = 0
    await waitFor(() => { probes += 1; return probes >= 5 }, { pollMs: 1 })
    assert.equal(probes, 5)
  })

  test('awaits an async condition', async () => {
    let probes = 0
    await waitFor(async () => { probes += 1; return probes >= 3 }, { pollMs: 1 })
    assert.equal(probes, 3)
  })

  test('throws when the condition never becomes true — it can still fail', async () => {
    // The whole point of the helper is that it is generous, NOT that it is
    // infinitely patient. A wait that could never fail would delete every
    // assertion built on it.
    await assert.rejects(
      () => waitFor(() => false, { timeoutMs: 50, pollMs: 1, label: 'a condition that is never true' }),
      /Timed out waiting for a condition that is never true/,
    )
  })

  test('the timeout message names what never happened', async () => {
    await assert.rejects(
      () => waitFor(() => false, { timeoutMs: 30, pollMs: 1, label: 'the widget to appear' }),
      /the widget to appear/,
    )
  })

  test('respects the wall-clock backstop even while the budget stretches', async () => {
    // A condition that never becomes true, polled against a tiny backstop:
    // proves the cap can end the wait independently of the scheduled-time
    // budget, so a stuck condition cannot hang a `--test-timeout=0` run.
    await assert.rejects(
      () => waitFor(() => false, {
        timeoutMs: 10_000_000,
        maxWallClockMs: 60,
        pollMs: 1,
        label: 'a stuck condition',
      }),
      /wall-clock backstop/,
    )
  })
})

describe('waitForValue', () => {
  test('returns the first non-empty value the probe yields', async () => {
    let probes = 0
    const value = await waitForValue(() => { probes += 1; return probes >= 3 ? 'ready' : false }, { pollMs: 1 })
    assert.equal(value, 'ready')
  })

  test('treats null and undefined as "not yet", not as a value', async () => {
    const seen: Array<string | null | undefined> = [undefined, null, 'finally']
    let index = 0
    const value = await waitForValue(() => seen[index++], { pollMs: 1 })
    assert.equal(value, 'finally')
  })

  test('throws rather than returning undefined when nothing ever arrives', async () => {
    await assert.rejects(
      () => waitForValue(() => undefined, { timeoutMs: 30, pollMs: 1, label: 'a value that never arrives' }),
      /a value that never arrives/,
    )
  })
})

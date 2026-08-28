/**
 * One place for "wait until something has happened" in the test suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * A test that writes `await sleep(200)` and then asserts the queue reached a
 * terminal state is not asserting a property of the product. It is asserting
 * that this machine will schedule the test promptly. That assumption holds on
 * an idle laptop and is simply false while other suites are running, so the
 * test reports a product defect that does not exist.
 *
 * Measured on 2026-08-28 — four separate false failures, all the same shape:
 *   - a 40ms sleep took 2,656ms under concurrent suites; 41ms when run alone
 *   - a `Date.now() + 10_000` poll ceiling was hit at 10,442ms and 10,621ms:
 *     the helper gave up AT the deadline rather than observing a wrong value
 *   - a 150ms wait for the queue runner to start an executor missed its
 *     window, and the executor then started after the test had already torn
 *     down its temp data dir
 *
 * WHY NOT JUST A BIGGER CONSTANT
 * ------------------------------
 * A bigger constant is the same bug with a longer fuse. It still fails on a
 * machine busier than whatever the author happened to measure, and it makes
 * every genuine regression take that much longer to report.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * `waitFor` spends a budget of *scheduled* time rather than wall time. Each
 * poll asks the event loop for `pollMs` and measures what it actually got.
 * The overshoot — the wall time this process spent descheduled while other
 * suites ran — is credited back to the budget.
 *
 *   - On an idle machine the budget never grows, so a genuinely stuck
 *     condition still fails in roughly `timeoutMs`. Real regressions stay
 *     fast to report.
 *   - On a machine running 65x behind, the wait stretches roughly 65x,
 *     because the test has genuinely not yet had its `timeoutMs` worth of
 *     CPU.
 *
 * The loop always terminates, at any load: every pass adds the full `slept`
 * to elapsed time but only `slept - pollMs` to the budget, so each pass makes
 * `pollMs` of net progress toward the deadline. A hung condition can never
 * hang the suite.
 *
 * WHAT THIS IS NOT FOR
 * --------------------
 * Do not use `waitFor` to replace a deliberate *observation window* — a test
 * that holds still for a fixed period to prove that something did NOT happen
 * (e.g. "exactly one job may hold the lane for the next 500ms"). Waiting for
 * a condition that is supposed to stay false would never return, and polling
 * until it "passes" would delete the assertion. Those windows fail open under
 * load, not closed, so they are not part of this defect class.
 */

/** Plain sleep. Exported so tests have one import for timing, not two. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface WaitForOptions {
  /** Named in the failure message so a timeout says what never happened. */
  label?: string
  /** Budget of *scheduled* time, not wall time. See the module comment. */
  timeoutMs?: number
  /** How long to yield between probes. */
  pollMs?: number
  /**
   * Absolute wall-clock stop, so a genuinely broken condition cannot hang the
   * suite while the budget keeps stretching. See `DEFAULT_MAX_WALL_CLOCK_MS`.
   */
  maxWallClockMs?: number
}

/**
 * Default budget. Deliberately generous: the budget is scheduled time, so
 * this is not "5 seconds of wall clock" and does not need padding for load.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000

/**
 * Backstop only — NOT the correctness criterion.
 *
 * The scheduled-time budget is what decides pass or fail. But on a machine
 * running (say) 65x behind, a 5s budget legitimately corresponds to minutes of
 * wall clock, and the backend harness runs with `--test-timeout=0`, so a
 * genuinely stuck condition would otherwise hang the run rather than report.
 * This cap bounds that. It is deliberately far above anything a healthy wait
 * needs: the worst real failure measured on 2026-08-28 was ~16.5s.
 *
 * If a wait ever dies on this cap, that is a signal about the machine, and
 * the error says so rather than blaming the product.
 */
export const DEFAULT_MAX_WALL_CLOCK_MS = 120_000

/**
 * Wait until `condition()` returns truthy, or throw once the *scheduled*-time
 * budget is spent.
 *
 * Prefer this over any fixed sleep that precedes an assertion about something
 * having happened.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  const {
    label = 'condition',
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollMs = 20,
    maxWallClockMs = DEFAULT_MAX_WALL_CLOCK_MS,
  } = options
  const started = Date.now()
  let budgetMs = timeoutMs
  let polls = 0
  let cappedOut = false

  for (;;) {
    if (await condition()) return
    const before = Date.now()
    await sleep(pollMs)
    polls += 1
    // Credit back only the part we did not ask for: the scheduler delay.
    budgetMs += Math.max(0, Date.now() - before - pollMs)
    const elapsed = Date.now() - started
    if (elapsed >= maxWallClockMs) { cappedOut = true; break }
    if (elapsed >= budgetMs) break
  }

  // One last look — the condition may have become true during the final poll.
  if (await condition()) return

  const waited = Date.now() - started
  throw new Error(
    cappedOut
      ? `Timed out waiting for ${label}: hit the ${maxWallClockMs}ms wall-clock `
        + `backstop after ${polls} polls (scheduled-time budget had stretched to `
        + `${Math.round(budgetMs)}ms). Either the condition is genuinely stuck, or `
        + 'this machine is far more loaded than any run measured so far.'
      : `Timed out waiting for ${label}: ${polls} polls over ${waited}ms wall clock, `
        + `budget ${Math.round(budgetMs)}ms of scheduled time. `
        + 'Scheduler delay is already credited back to that budget, so this is a '
        + 'real failure rather than a slow machine.',
  )
}

/**
 * Wait until `probe()` yields something other than `undefined`/`null`/`false`,
 * and return it. Same budget semantics as `waitFor`.
 *
 * Use when the assertion needs the value that arrived, not just the fact that
 * it did — e.g. reading back a file the product writes asynchronously.
 */
export async function waitForValue<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  options: WaitForOptions = {},
): Promise<T> {
  let captured: T | undefined
  await waitFor(async () => {
    const value = await probe()
    if (value === undefined || value === null || value === false) return false
    captured = value as T
    return true
  }, options)
  return captured as T
}

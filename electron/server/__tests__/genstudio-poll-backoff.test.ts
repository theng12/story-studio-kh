/**
 * Job-poll backoff, jitter, and the deadline it must never break.
 *
 * THE INCIDENT THIS COMES FROM: every one of the five wait loops in
 * genstudio-client.ts polled its job on a FLAT one-second interval. A 90-second
 * chapter generation cost 90 requests, 89 answering "still running". Chapter
 * batches run 4 concurrent, so one customer sitting in one desktop app
 * sustained 4 req/s indefinitely — and the 4-hour job ceiling meant a genuinely
 * stuck job fired 14,400 requests before giving up. On a hosted GenStudio that
 * is steady-state load, not a burst.
 *
 * ZERO paid calls: the schedule is a pure function, so the 90-second job and
 * the 4-hour stuck job below are both SIMULATED by iterating it. Nothing here
 * waits, and nothing here touches GenStudio.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  createGenStudioJobPoller,
  genStudioPollDelayMs,
  readGenStudioPollHintMs,
  GENSTUDIO_LONG_JOB_TIMEOUT_MS,
  GENSTUDIO_POLL_JITTER_FRACTION,
  GENSTUDIO_POLL_MAX_INTERVAL_MS,
} from '../lib/genstudio-client.js'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** No jitter: random() === 0.5 is the exact centre of the symmetric band. */
const CENTRE = () => 0.5

/** Walk the schedule until `jobDurationMs` has elapsed. Returns the poll count
 *  and when the settled job was actually observed. */
function simulate(jobDurationMs: number, random: () => number = CENTRE): {
  polls: number
  observedAtMs: number
} {
  let elapsed = 0
  let polls = 0
  const deadline = GENSTUDIO_LONG_JOB_TIMEOUT_MS
  while (elapsed < jobDurationMs && polls < 100_000) {
    elapsed += genStudioPollDelayMs({
      attempt: polls,
      remainingMs: deadline - elapsed,
      random,
    })
    polls++
    if (elapsed >= deadline) break
  }
  return { polls, observedAtMs: elapsed }
}

// ── The ladder ─────────────────────────────────────────────────────────────

test('the interval ramps 1s → 2s → 5s → 10s and then caps', () => {
  const at = (attempt: number) =>
    genStudioPollDelayMs({ attempt, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS, random: CENTRE })

  // Fast at the start so a short operation still feels instant.
  assert.deepEqual([at(0), at(1), at(2)], [1_000, 1_000, 1_000])
  assert.deepEqual([at(3), at(4), at(5)], [2_000, 2_000, 2_000])
  assert.deepEqual([at(6), at(7)], [5_000, 5_000])
  assert.deepEqual([at(8), at(9)], [10_000, 10_000])
  // Capped from here on, however long the job runs.
  for (const attempt of [10, 11, 50, 500, 5_000]) {
    assert.equal(at(attempt), GENSTUDIO_POLL_MAX_INTERVAL_MS, `attempt ${attempt} broke the cap`)
  }
  assert.equal(GENSTUDIO_POLL_MAX_INTERVAL_MS, 15_000)
})

test('the interval never goes backwards as the job runs longer', () => {
  let previous = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    const delay = genStudioPollDelayMs({
      attempt, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS, random: CENTRE,
    })
    assert.ok(delay >= previous, `attempt ${attempt} narrowed from ${previous} to ${delay}`)
    previous = delay
  }
})

// ── Jitter ─────────────────────────────────────────────────────────────────

test('every interval carries ±20% jitter and stays inside the band', () => {
  assert.equal(GENSTUDIO_POLL_JITTER_FRACTION, 0.2)
  for (const attempt of [0, 3, 6, 8, 12]) {
    const base = genStudioPollDelayMs({
      attempt, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS, random: CENTRE,
    })
    const low = genStudioPollDelayMs({
      attempt, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS, random: () => 0,
    })
    const high = genStudioPollDelayMs({
      attempt, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS, random: () => 1,
    })
    assert.equal(low, Math.round(base * 0.8), `attempt ${attempt} lower bound`)
    assert.equal(high, Math.round(base * 1.2), `attempt ${attempt} upper bound`)
  }
})

test('jitter actually varies, so concurrent clients cannot stay in lockstep', () => {
  // Four concurrent chapter batches is the real shape. With real randomness
  // they must not produce four identical intervals.
  const seen = new Set<number>()
  for (let i = 0; i < 200; i++) {
    seen.add(genStudioPollDelayMs({ attempt: 12, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS }))
  }
  assert.ok(seen.size > 50, `only ${seen.size} distinct intervals — jitter is not being applied`)
  for (const delay of seen) {
    assert.ok(delay >= 12_000 && delay <= 18_000, `${delay} escaped the ±20% band`)
  }
})

// ── A server hint beats the local schedule ─────────────────────────────────

test('a GenStudio poll hint wins over the local ladder', () => {
  // Attempt 0 would locally be 1s. The server says 30s; the server wins.
  const delay = genStudioPollDelayMs({
    attempt: 0,
    remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS,
    hintMs: 30_000,
    random: CENTRE,
  })
  assert.ok(delay >= 30_000, `honouring a hint must never poll sooner than asked (got ${delay})`)
  assert.ok(delay <= 36_000, `hint jitter escaped +20% (got ${delay})`)
})

test('hint jitter is upward only — never poll sooner than the server asked', () => {
  for (const random of [() => 0, () => 0.5, () => 1]) {
    const delay = genStudioPollDelayMs({
      attempt: 0, remainingMs: GENSTUDIO_LONG_JOB_TIMEOUT_MS, hintMs: 20_000, random,
    })
    assert.ok(delay >= 20_000, `jittered below the hint (got ${delay})`)
  }
})

test('every published poll-hint shape is read, and a bad one is ignored', () => {
  const now = Date.now()
  assert.equal(readGenStudioPollHintMs({ poll_after_ms: 4_500 }, now), 4_500)
  assert.equal(readGenStudioPollHintMs({ retry_after_ms: 2_500 }, now), 2_500)
  assert.equal(readGenStudioPollHintMs({ poll_after_seconds: 3 }, now), 3_000)
  assert.equal(readGenStudioPollHintMs({ poll_after: 7 }, now), 7_000)
  // The Retry-After header, folded onto the body by requestJsonWithRetry.
  assert.equal(readGenStudioPollHintMs({ retry_after: '12' }, now), 12_000)
  // A malformed or hostile hint must never become a busy-loop.
  for (const bad of [null, undefined, {}, { poll_after_ms: -1 }, { poll_after_ms: 'soon' },
    { poll_after_seconds: Number.NaN }, { retry_after: 'never' }]) {
    assert.equal(readGenStudioPollHintMs(bad, now), null, `${JSON.stringify(bad)} produced a hint`)
  }
})

test('the Retry-After header is folded onto every successful job body', () => {
  // Without this line the wait loops could only ever see a hint in the JSON.
  assert.match(
    source('../lib/genstudio-client.ts'),
    /body\.retry_after \|\|= response\.headers\.get\('retry-after'\)/,
  )
})

// ── The deadline is untouchable ────────────────────────────────────────────

test('backoff can never overshoot the 4-hour deadline', () => {
  for (const remaining of [0, 1, 250, 3_000, 14_999]) {
    for (const attempt of [0, 8, 12, 900]) {
      const delay = genStudioPollDelayMs({ attempt, remainingMs: remaining, random: () => 1 })
      assert.ok(delay <= remaining, `attempt ${attempt} slept ${delay}ms past a ${remaining}ms deadline`)
    }
  }
  // A hint cannot push past it either, however large.
  assert.equal(
    genStudioPollDelayMs({ attempt: 0, remainingMs: 5_000, hintMs: 600_000, random: CENTRE }),
    5_000,
  )
  // An already-expired deadline sleeps not at all, so the loop's own timeout
  // check fires immediately.
  assert.equal(genStudioPollDelayMs({ attempt: 3, remainingMs: -10_000 }), 0)
})

test('a stuck job still gives up at the 4-hour ceiling, not later', () => {
  const { observedAtMs } = simulate(GENSTUDIO_LONG_JOB_TIMEOUT_MS + 1)
  assert.ok(
    observedAtMs <= GENSTUDIO_LONG_JOB_TIMEOUT_MS,
    `a widening interval pushed the deadline out to ${observedAtMs}ms`,
  )
})

// ── Cancellation stays prompt ──────────────────────────────────────────────

test('cancellation breaks a 15-second wait promptly', async () => {
  const poller = createGenStudioJobPoller(CENTRE)
  // Burn the fast rungs so the next wait is a full capped interval.
  const deadline = Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS
  for (let i = 0; i < 12; i++) {
    await poller.wait(Date.now() + 1, {}, undefined)
  }
  let cancelled = false
  setTimeout(() => { cancelled = true }, 120)
  const started = Date.now()
  await poller.wait(deadline, { isCancelled: () => cancelled }, undefined)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1_500, `cancel took ${elapsed}ms to be noticed — the button feels dead`)
})

test('an aborted signal breaks the wait the same way', async () => {
  const poller = createGenStudioJobPoller(CENTRE)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  await poller.wait(Date.now() + GENSTUDIO_LONG_JOB_TIMEOUT_MS, { signal: controller.signal })
  assert.ok(Date.now() - started < 1_500, 'an aborted wait did not return promptly')
})

// ── The numbers this was built for ─────────────────────────────────────────

test('a 90-second job costs ~15 requests instead of 90', () => {
  const { polls } = simulate(90_000)
  assert.ok(polls <= 15, `a 90s job still costs ${polls} polls`)
  assert.ok(polls >= 10, `${polls} polls means the ladder widened too aggressively`)
  // The flat 1s interval this replaced.
  assert.equal(90_000 / 1_000, 90)
})

test('a stuck job costs under 1,000 requests instead of 14,400', () => {
  const { polls } = simulate(GENSTUDIO_LONG_JOB_TIMEOUT_MS + 1)
  assert.ok(polls < 1_000, `a stuck job still costs ${polls} polls`)
  // The flat 1s interval this replaced.
  assert.equal(GENSTUDIO_LONG_JOB_TIMEOUT_MS / 1_000, 14_400)
})

test('real randomness keeps the stuck-job cost under 1,000 too', () => {
  // Jitter is symmetric, so the mean is the nominal schedule; this proves the
  // spread does not push a real run over the target.
  let worst = 0
  for (let run = 0; run < 25; run++) {
    worst = Math.max(worst, simulate(GENSTUDIO_LONG_JOB_TIMEOUT_MS + 1, Math.random).polls)
  }
  assert.ok(worst < 1_000, `worst simulated stuck-job cost was ${worst} polls`)
})

test('a short job is still answered inside a couple of seconds', () => {
  // The whole reason the ladder starts at 1s: a 2-second image must not wait
  // 15 seconds to be noticed.
  const { observedAtMs } = simulate(2_000)
  assert.ok(observedAtMs <= 3_000, `a 2s job was only observed at ${observedAtMs}ms`)
})

// ── One schedule, not five copies ──────────────────────────────────────────

test('every wait loop shares the one poller and the flat interval is gone', () => {
  const client = source('../lib/genstudio-client.ts')
  const created = client.match(/const poller = createGenStudioJobPoller\(\)/g) || []
  const waited = client.match(/await poller\.wait\(deadline, request, current\)/g) || []
  // SIX job-wait loops, one per modality — image, video, tts, transcription,
  // chat, and music since 1.4.37 — plus ONE more: the language submission
  // reattachment loop in `submitLanguageJson`, which waits out a
  // `request_in_progress` refusal before replaying the same idempotency key.
  // It belongs on this schedule for the same reason the others do (a job that
  // may run for minutes must not be re-asked every second), but it advances by
  // re-POSTing rather than by reading `current`, so it is counted in `created`
  // and deliberately not in `waited`.
  //
  // These counts are the point of the test, not incidental to it: a new
  // modality that hand-rolls its own polling interval would leave them equal
  // and pass silently, which is exactly the drift this alarm exists to catch.
  assert.equal(created.length, 7, 'every wait loop must build a poller')
  assert.equal(waited.length, 6, 'every job-wait loop must poll through the shared schedule')
  assert.match(
    client,
    /await poller\.wait\(\s*deadline,\s*request,/,
    'the submission reattachment loop must use the shared schedule too',
  )
  assert.doesNotMatch(client, /setTimeout\(resolve, POLL_INTERVAL_MS\)/, 'a flat 1s poll survives')
  assert.doesNotMatch(client, /^const POLL_INTERVAL_MS/m, 'the flat interval constant survives')
})

/**
 * The customer-facing job card, as a visual progress tracker.
 *
 * The card used to answer "how is my work going?" with a wall of one line per
 * scene, a raw job id, a per-remote ledger and a machinery vocabulary
 * ("recovered 3 task(s)", "0 recovered, 4 left"). The redesign replaces the
 * default view with counts, a measured ETA, a measured freshness reading, a
 * three-figure money summary and one plain-words line per exception, and folds
 * every id, log line and per-item state into a "Technical details" drawer —
 * folded, never deleted, because those logs are what solved every incident.
 *
 * Two kinds of test here, matching the two kinds of thing being protected:
 *   • regex-against-source for the markup contract (the established job-card
 *     style — see jobsControls.test.ts);
 *   • real unit tests for the arithmetic, which lives in a plain-function
 *     composable precisely so it can be tested this way.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  describeCancellation,
  describeFreshness,
  describeJobExceptions,
  estimateSecondsRemaining,
  ETA_MIN_COMPLETIONS,
  ETA_MIN_OBSERVATION_MS,
  formatEtaApprox,
  hasJobExceptions,
  isProgressStale,
  lastProgressAt,
  medianSecondsPerItem,
  recordEtaSample,
  rollingItemsPerSecond,
  STALE_CADENCE_MULTIPLE,
  stalenessThresholdMs,
  summariseJobItems,
  type EtaSample,
} from '../composables/useJobEta.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const page = read('../pages/projects/[slug]/jobs.vue')
const ledger = read('../components/GenStudioBatchLedger.vue')
const composable = read('../composables/useJobEta.ts')

/** The page's markup only — the script block is not what a customer reads. */
const template = page.slice(0, page.indexOf('<script setup'))
/** Both drawers: the Active card's and the History card's. */
const drawers = template.match(/<AdvancedDisclosure[\s\S]*?<\/AdvancedDisclosure>/g) || []
/** Everything a customer sees WITHOUT opening anything. */
const defaultView = drawers.reduce((rest, block) => rest.replace(block, ''), template)

// ── 1. No raw identifiers, and no per-scene wall, in the default view ─────

describe('the default card view carries no raw identifiers', () => {
  test('both cards have exactly one Technical details drawer', () => {
    assert.equal(drawers.length, 2, 'the Active card and the History card each need one')
    for (const drawer of drawers) assert.match(drawer, /label="Technical details"/)
  })

  test('the job id is rendered only inside Technical details', () => {
    assert.doesNotMatch(
      defaultView, /\{\{\s*job\.job_id\s*\}\}/,
      'the ID meta-tag must not survive in the default view — it is an 8-character hex slice',
    )
    for (const drawer of drawers) assert.match(drawer, /\{\{ job\.job_id \}\}/)
  })

  test('the per-scene wall is rendered only inside Technical details', () => {
    assert.doesNotMatch(
      defaultView, /itemAttemptText\(/,
      'the in-flight COUNT is that information; the wall is not the default view',
    )
    for (const drawer of drawers) assert.match(drawer, /itemAttemptText\(item\)/)
  })

  test('the counts the wall used to spell out are still all reported', () => {
    // Preserves what jobsControls.test.ts guards: whole-batch completed,
    // settling, cancelled, failed and not-submitted must all stay reachable.
    // They moved from a text run into the stat row and the drawer.
    assert.match(defaultView, /jobCounts\(job\)\.total/)
    assert.match(defaultView, /jobCounts\(job\)\.inFlight/)
    assert.match(defaultView, /jobCounts\(job\)\.finished/)
    assert.match(defaultView, /jobCounts\(job\)\.remaining/)
    assert.match(defaultView, /jobCounts\(job\)\.queued/)
    assert.match(defaultView, /jobCounts\(job\)\.settling/)
    assert.match(defaultView, /generating right now/)
  })

  test('money is three humanised figures, each carrying its unit', () => {
    for (const figure of ['charged', 'on hold', 'returned']) {
      assert.match(defaultView, new RegExp(`\\}\\}\\s*credits ${figure}`))
    }
    // And the per-remote chip loop it replaced is gone from the default view.
    assert.doesNotMatch(defaultView, /genStudioQueueLabel\(remote\)/)
  })

  test('the repair chips speak about the work, not the recovery machinery', () => {
    assert.doesNotMatch(page, /recovered \$\{recovered\} task/)
    assert.doesNotMatch(page, /0 recovered, \$\{missing\} left/)
    assert.match(page, /Recovered \$\{piece\(recovered\)\}; \$\{missing\} still missing/)
    assert.match(page, /Nothing to recover yet; \$\{missing\} still missing/)
  })
})

// ── 2. Counts, from a mocked batch ────────────────────────────────────────

describe('summariseJobItems', () => {
  const batch = {
    total: 50,
    completed: 30,
    failed: 4,
    settling: 2,
    cancelled: 1,
    not_submitted: 9,
    concurrency: 6,
    active: [
      { label: 'Scene 31', state: 'running' as const, attempt: 0, max_attempts: 4 },
      { label: 'Scene 32', state: 'running' as const, attempt: 0, max_attempts: 4 },
      { label: 'Scene 33', state: 'waiting_retry' as const, attempt: 1, max_attempts: 4 },
    ],
  }

  test('reports total, in-flight, finished, remaining, queued and settling', () => {
    assert.deepEqual(summariseJobItems(batch), {
      total: 50,
      inFlight: 3,
      finished: 30,
      remaining: 15, // 50 − 30 done − 4 failed − 1 cancelled
      queued: 9,
      settling: 2,
      failed: 4,
      cancelled: 1,
    })
  })

  test('remaining never goes negative when two polls disagree', () => {
    const overshoot = { ...batch, completed: 49, failed: 4, cancelled: 1 }
    assert.equal(summariseJobItems(overshoot).remaining, 0)
  })

  test('an absent item_progress reports zeroes rather than throwing', () => {
    const empty = summariseJobItems(undefined)
    assert.equal(empty.total, 0)
    assert.equal(empty.inFlight, 0)
    assert.equal(empty.remaining, 0)
  })
})

// ── 3. ETA, measured or absent ────────────────────────────────────────────

function windowOf(pairs: Array<[number, number]>): EtaSample[] {
  return pairs.map(([at, completed]) => ({ at, completed }))
}

describe('ETA derivation', () => {
  test('the rolling rate is this job\'s own measured speed', () => {
    // 6 completions across 60s ⇒ 0.1 items/sec ⇒ 12 remaining ⇒ 120s.
    const w = windowOf([[0, 10], [60_000, 16]])
    assert.equal(rollingItemsPerSecond(w, 60_000), 0.1)
    assert.equal(estimateSecondsRemaining({ remaining: 12, nowMs: 60_000, window: w }), 120)
    assert.equal(formatEtaApprox(120), '~2 min left')
  })

  test('a stalled job\'s measured rate decays instead of freezing', () => {
    const w = windowOf([[0, 10], [60_000, 16]])
    // Same window, two minutes later: 6 completions across 180s, not 60s.
    assert.equal(rollingItemsPerSecond(w, 180_000), 6 / 180)
  })

  test('the minimum-sample guard withholds an ETA rather than guessing', () => {
    // Enough time, not enough completions.
    const tooFew = windowOf([[0, 10], [60_000, 10 + ETA_MIN_COMPLETIONS - 1]])
    assert.equal(rollingItemsPerSecond(tooFew, 60_000), null)
    // Enough completions, not enough observation.
    const tooSoon = windowOf([[0, 10], [ETA_MIN_OBSERVATION_MS - 1, 20]])
    assert.equal(rollingItemsPerSecond(tooSoon, ETA_MIN_OBSERVATION_MS - 1), null)
    // One sample is never a rate.
    assert.equal(rollingItemsPerSecond(windowOf([[0, 10]]), 999_999), null)
  })

  test('the historical median is the fallback, and it comes from real history', () => {
    const history = [
      // 100s for 10 items ⇒ 10 s/item
      { type: 'audio', status: 'done', started_at: '2026-08-29T10:00:00.000Z', finished_at: '2026-08-29T10:01:40.000Z', item_progress: { total: 10 } },
      // 40s for 10 items ⇒ 4 s/item
      { type: 'audio', status: 'done', started_at: '2026-08-29T11:00:00.000Z', finished_at: '2026-08-29T11:00:40.000Z', item_progress: { total: 10 } },
      // 60s for 10 items ⇒ 6 s/item  → median of [4, 6, 10] is 6
      { type: 'audio', status: 'done', started_at: '2026-08-29T12:00:00.000Z', finished_at: '2026-08-29T12:01:00.000Z', item_progress: { total: 10 } },
      // Wrong class, and a failure — neither may contribute.
      { type: 'images', status: 'done', started_at: '2026-08-29T12:00:00.000Z', finished_at: '2026-08-29T13:00:00.000Z', item_progress: { total: 1 } },
      { type: 'audio', status: 'error', started_at: '2026-08-29T12:00:00.000Z', finished_at: '2026-08-29T13:00:00.000Z', item_progress: { total: 1 } },
    ]
    assert.equal(medianSecondsPerItem(history, 'audio'), 6)
    // No usable window ⇒ the class median carries it: 5 remaining × 6s.
    assert.equal(
      estimateSecondsRemaining({ remaining: 5, nowMs: 1_000, history, type: 'audio' }),
      30,
    )
  })

  test('no data means no ETA — never a guess', () => {
    assert.equal(medianSecondsPerItem([], 'audio'), null)
    assert.equal(medianSecondsPerItem(undefined, 'audio'), null)
    assert.equal(estimateSecondsRemaining({ remaining: 20, nowMs: 1_000 }), null)
    assert.equal(formatEtaApprox(null), null)
    // Nothing left to do is also not an ETA.
    assert.equal(estimateSecondsRemaining({ remaining: 0, nowMs: 1_000 }), null)
  })

  test('the ETA reads as an approximation at every scale', () => {
    assert.equal(formatEtaApprox(5), 'almost done')
    assert.equal(formatEtaApprox(45), '~45 sec left')
    assert.equal(formatEtaApprox(600), '~10 min left')
  })

  test('samples are only kept when they carry information', () => {
    let w = recordEtaSample(undefined, { at: 0, completed: 3 })
    w = recordEtaSample(w, { at: 1_000, completed: 3 })  // no change — no sample
    assert.equal(w.length, 1)
    w = recordEtaSample(w, { at: 2_000, completed: 4 })
    assert.equal(w.length, 2)
    // A counter that goes backwards is a re-run, not a negative rate.
    w = recordEtaSample(w, { at: 3_000, completed: 0 })
    assert.deepEqual(w, [{ at: 3_000, completed: 0 }])
  })
})

// ── 4. Freshness: when did something last actually happen ─────────────────

describe('progress freshness', () => {
  const iso = (ms: number) => new Date(ms).toISOString()

  test('the newest settlement wins over an older completed-count sample', () => {
    const w = windowOf([[1_000, 0], [2_000, 3]])
    const remote = [{ queue_state: 'succeeded', updated_at: iso(5_000) }]
    assert.equal(lastProgressAt(w, remote), 5_000)
  })

  test('and the newest completed-count sample wins over an older settlement', () => {
    const w = windowOf([[1_000, 0], [9_000, 3]])
    const remote = [{ queue_state: 'succeeded', updated_at: iso(5_000) }]
    assert.equal(lastProgressAt(w, remote), 9_000)
  })

  test('an item still running is not a settlement', () => {
    assert.equal(lastProgressAt(undefined, [{ queue_state: 'running', updated_at: iso(8_000) }]), null)
  })

  test('no data renders no freshness claim rather than "0s ago"', () => {
    assert.equal(lastProgressAt(undefined, undefined), null)
    // A single sample is a first sighting, not a completion.
    assert.equal(lastProgressAt(windowOf([[1_000, 4]]), []), null)
    assert.equal(describeFreshness(null, 10_000), null)
  })

  test('the line says how long ago, in the page\'s unit grammar', () => {
    assert.equal(describeFreshness(60_000, 100_000), 'last progress: 40s ago')
    assert.equal(describeFreshness(0, 240_000), 'last progress: 4 min ago')
  })
})

describe('the staleness threshold is measured, not written down', () => {
  test('it is a multiple of the class\'s own measured cadence', () => {
    assert.equal(stalenessThresholdMs(12), 12 * STALE_CADENCE_MULTIPLE * 1000)
    // Two classes with different measured cadences get different thresholds.
    assert.notEqual(stalenessThresholdMs(4), stalenessThresholdMs(240))
  })

  test('a class with no measured cadence is never called stale', () => {
    assert.equal(stalenessThresholdMs(null), null)
    assert.equal(isProgressStale(0, 10 * 60_000, null), false)
  })

  test('a gap longer than the measured threshold is stale, a shorter one is not', () => {
    const cadence = 10 // seconds per item, measured
    const threshold = stalenessThresholdMs(cadence)!
    assert.equal(isProgressStale(0, threshold - 1, cadence), false)
    assert.equal(isProgressStale(0, threshold + 1, cadence), true)
  })

  test('no duration constant appears anywhere in the freshness code path', () => {
    const start = composable.indexOf('── 3. Freshness')
    const end = composable.indexOf('── 4. Exceptions')
    assert.ok(start > 0 && end > start, 'the freshness section must be findable')
    const freshness = composable.slice(start, end)
    assert.doesNotMatch(freshness, /\d+_\d{3}/, 'a millisecond threshold literal (e.g. 180_000)')
    assert.doesNotMatch(freshness, /\b\d+\s*\*\s*60\b/, 'a minutes-to-seconds threshold')
    assert.doesNotMatch(freshness, /\b(MINUTES|STALE_AFTER|THRESHOLD_MS)\b/, 'a named duration constant')
    // What IS there is dimensionless and derived.
    assert.match(freshness, /STALE_CADENCE_MULTIPLE/)
    assert.match(freshness, /cadenceSecondsPerItem \* multiple \* 1000/)
  })

  test('the card renders the freshness line and its stale styling', () => {
    assert.match(defaultView, /jobFreshness\(job\)/)
    assert.match(defaultView, /'is-stale': jobProgressStale\(job\)/)
    assert.match(page, /\.job-stat-fresh\.is-stale/)
    assert.match(page, /isProgressStale\(jobLastProgressAt\(job\), now\.value, jobCadenceSeconds\(job\)\)/)
  })
})

// ── 5. Exceptions, surfaced individually ──────────────────────────────────

describe('exceptions', () => {
  const nowMs = Date.parse('2026-08-29T12:00:00.000Z')

  test('a healthy job has none — and the inspect affordance stays hidden', () => {
    const healthy = {
      type: 'scene_images_batch',
      item_progress: {
        total: 40, completed: 12, failed: 0, concurrency: 6,
        active: [{ label: 'Scene 13', state: 'running' as const, attempt: 0, max_attempts: 4 }],
      },
      genstudio_jobs: [
        { id: 'gs-1', operation: 'image.generation', queue_state: 'running', updated_at: '' },
        { id: 'gs-2', operation: 'image.generation', queue_state: 'succeeded', updated_at: '' },
      ],
    }
    assert.deepEqual(describeJobExceptions(healthy, nowMs), [])
    assert.equal(hasJobExceptions(healthy, nowMs), false)
  })

  test('a failed remote item gets its own line: what, what it cost, what next', () => {
    const job = {
      type: 'scene_images_batch',
      auto_retry: { eligible: true, attempt: 2, max_attempts: 4, next_retry_at: new Date(nowMs + 40_000).toISOString() },
      item_progress: { total: 3, completed: 2, failed: 1, concurrency: 1, active: [] },
      genstudio_jobs: [{
        id: 'gs-9', operation: 'image.generation', queue_state: 'failed',
        failure_code: 'IMAGE_CONTENT_REFUSED', released_credits: 13, updated_at: '',
      }],
    }
    const lines = describeJobExceptions(job, nowMs)
    assert.equal(lines.length, 1, 'one failed item, one line — and no leftover count line')
    assert.equal(
      lines[0]!.text,
      'An image didn’t finish — the provider refused the prompt.'
      + ' 13 credits were returned. It will retry automatically in 40s.',
    )
  })

  test('a backoff says it cost nothing and is handling itself', () => {
    const job = {
      item_progress: {
        total: 300, completed: 295, failed: 0, concurrency: 4,
        active: [{
          label: 'Scene 296', state: 'waiting_retry' as const, attempt: 1, max_attempts: 4,
          retry_at: new Date(nowMs + 30_000).toISOString(),
        }],
      },
    }
    assert.equal(
      describeJobExceptions(job, nowMs)[0]!.text,
      'Scene 296: high demand right now — nothing was charged;'
      + ' retrying automatically in 30s (attempt 2 of 4).',
    )
  })

  test('failures with no remote record still get a line, so the counts add up', () => {
    const job = { item_progress: { total: 5, completed: 2, failed: 3, concurrency: 1, active: [] } }
    const lines = describeJobExceptions(job, nowMs)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!.text, /^3 items didn’t finish\. Use Retry to run it again\.$/)
  })

  test('the card renders one line per exception, and nothing when there are none', () => {
    assert.match(defaultView, /v-if="jobExceptions\(job\)\.length"/)
    assert.match(defaultView, /v-for="line in jobExceptions\(job\)"/)
    assert.equal((defaultView.match(/class="job-exceptions"/g) || []).length, 2)
  })

  test('the ledger\'s inspect affordance is gated on a REAL exception count', () => {
    // It counted every in-flight item as an exception, so a batch where
    // nothing had gone wrong still offered "Inspect 40 active or failed".
    assert.match(ledger, /const exceptionJobs = computed\(\(\) => props\.remoteJobs\.filter\(remote => stateBucket\(remote\) === 'failed'\)\)/)
    assert.doesNotMatch(ledger, /bucket === 'active' \|\| bucket === 'failed'/)
    assert.doesNotMatch(ledger, /active or failed/i)
    assert.match(ledger, /v-if="exceptionJobs\.length"/)
    assert.match(ledger, /Inspect \$\{exceptionJobs\.length\.toLocaleString\(\)\} failed/)
  })
})

// ── 6. Technical details holds everything the default view dropped ────────

describe('the Technical details drawer', () => {
  test('contains the full item ledger, per-item states, the log and every id', () => {
    for (const drawer of drawers) {
      assert.match(drawer, /<GenStudioBatchLedger[\s\S]*:remote-jobs="job\.genstudio_jobs"/, 'the item ledger')
      assert.match(drawer, /class="job-items"/, 'the per-item state block')
      assert.match(drawer, /itemAttemptText\(item\)/, 'the per-item attempt text')
      assert.match(drawer, /v-for="\(line, i\) in job\.output_lines"/, 'the raw log lines')
      assert.match(drawer, /<GenStudioRequestPreview/, 'the redacted request preview')
      assert.match(drawer, /\{\{ job\.job_id \}\}/, 'the job id')
      assert.match(drawer, /\{\{ remote\.id \}\}/, 'every remote job id')
      assert.match(drawer, /getOutputDir\(job\)/, 'the output folder')
    }
  })

  test('only one drawer is mounted at a time, so long logs stay cheap', () => {
    // AdvancedDisclosure renders its slot with v-show, so an unguarded slot
    // would build every card's ledger and log on a page listing ten of them.
    for (const drawer of drawers) assert.match(drawer, /<template v-if="expanded === job\.job_id">/)
    assert.match(page, /function setTechnicalOpen\(jobId: string, open: boolean\)/)
  })

  test('per-item ledger rows carry their settlement time', () => {
    assert.match(ledger, /settledAtLabel\(remote\)/)
    assert.match(ledger, /const at = remote\.updated_at \? Date\.parse\(remote\.updated_at\) : NaN/)
    assert.match(ledger, /:title="remote\.updated_at"/)
    // An item with no timestamp claims none.
    assert.match(ledger, /if \(!Number\.isFinite\(at\)\) return ''/)
  })
})

// ── 7. Nothing about our capacity may be inferred from this surface ───────

describe('the customer surface names no infrastructure', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['machine', /\bmachines?\b/i],
    ['worker', /\bworkers?\b/i],
    ['site', /\bsites?\b/i],
    ['fleet', /\bfleet\b/i],
    ['placement window', /placement window/i],
    ['no site has accepted', /no site has accepted/i],
  ]

  test('the default card view uses none of the capacity vocabulary', () => {
    for (const [name, pattern] of FORBIDDEN) {
      assert.doesNotMatch(defaultView, pattern, `"${name}" reached the default job-card view`)
    }
  })

  test('nor does any string the card composes for itself', () => {
    // Comments are for us; only the text a customer reads is in scope.
    const speech = composable
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    for (const [name, pattern] of FORBIDDEN) {
      assert.doesNotMatch(speech, pattern, `"${name}" reached a customer-visible string`)
    }
    // The capacity-neutral fallback is what a bare backoff says.
    assert.match(composable, /export const WAITING_FALLBACK_REASON = 'high demand right now'/)
  })

  test('a stop is described as work, not as a job state', () => {
    assert.equal(
      describeCancellation({ item_progress: { total: 40, completed: 20, failed: 0, not_submitted: 16, concurrency: 4, active: [] } }),
      'Cancelling 16 queued items — credits for unstarted work are released.',
    )
    assert.equal(
      describeCancellation({ item_progress: { total: 1, completed: 0, failed: 0, not_submitted: 1, concurrency: 1, active: [] } }),
      'Cancelling 1 queued item — credits for unstarted work are released.',
    )
    // A job with nothing queued still says what happens to the money.
    assert.match(describeCancellation(undefined), /credits for unstarted work are released\.$/)
    assert.match(page, /success\(describeCancellation\(job\)\)/)
  })
})

// ── 6. Exceptions collapse when they are the SAME exception ────────────────

/**
 * A congestion window declined more than a hundred images at once, for the same
 * reason, at the same moment. The card printed a hundred byte-identical
 * sentences:
 *
 *   An image didn't finish — the provider declined it. 9 credits were returned.
 *   Use Retry to run it again.
 *   An image didn't finish — the provider declined it. 9 credits were returned.
 *   Use Retry to run it again.
 *   … ×100
 *
 * That is ONE exception that happened a hundred times. Repeating it told the
 * reader nothing the first line had not, buried every other exception on the
 * card underneath it, and made the two numbers a person actually needs — how
 * many, and how much came back — the only things they had to work out by
 * counting rows.
 *
 * "Exceptions surfaced individually" is still the rule. What it never meant is
 * one line per record. Identical exceptions collapse into one line carrying the
 * count and the totals; genuinely different exceptions stay separate and
 * individual. Nothing is truncated — every record is still listed per item in
 * Technical details, which pages at 25 and always could.
 */
describe('identical exceptions collapse; distinct ones do not', () => {
  const nowMs = Date.parse('2026-08-29T12:00:00.000Z')

  function declined(id: string, released = 9) {
    return {
      id, operation: 'image.generation', queue_state: 'failed',
      failure_code: 'PROVIDER_DECLINED', released_credits: released, updated_at: '',
    }
  }

  test('N identical failures render ONE line carrying the count', () => {
    const N = 37
    const job = {
      type: 'scene_images_batch',
      item_progress: { total: 40, completed: 3, failed: N, concurrency: 6, active: [] },
      genstudio_jobs: Array.from({ length: N }, (_, i) => declined(`gs-${i}`)),
    }
    const lines = describeJobExceptions(job, nowMs)

    assert.equal(lines.length, 1, `37 identical failures must be one line, got ${lines.length}`)
    assert.equal(
      lines[0]!.text,
      '37 images didn’t finish — the provider declined it.'
      + ' 333 credits were returned in total. Use Retry to run them again.',
    )
    // The count and the total are the two facts the wall made unreadable.
    assert.match(lines[0]!.text, /^37 images/)
    assert.match(lines[0]!.text, /333 credits were returned in total/)
  })

  test('the count is live — it follows the number of records, not a fixed word', () => {
    for (const N of [2, 3, 100]) {
      const job = {
        item_progress: { total: N, completed: 0, failed: N, concurrency: 1, active: [] },
        genstudio_jobs: Array.from({ length: N }, (_, i) => declined(`gs-${i}`, 1)),
      }
      const lines = describeJobExceptions(job, nowMs)
      assert.equal(lines.length, 1, `${N} identical failures must still be one line`)
      assert.match(lines[0]!.text, new RegExp(`^${N} images didn’t finish`))
      assert.match(lines[0]!.text, new RegExp(`${N} credits were returned in total`))
    }
  })

  test('two DISTINCT failures render two lines, individually', () => {
    const job = {
      item_progress: { total: 2, completed: 0, failed: 2, concurrency: 1, active: [] },
      genstudio_jobs: [
        declined('gs-1'),
        {
          id: 'gs-2', operation: 'image.generation', queue_state: 'failed',
          failure_code: 'IMAGE_CONTENT_REFUSED', released_credits: 13, updated_at: '',
        },
      ],
    }
    const lines = describeJobExceptions(job, nowMs)

    assert.equal(lines.length, 2, 'a different reason is a different thing that went wrong')
    const texts = lines.map(l => l.text).sort()
    assert.ok(texts.some(t => t.includes('the provider declined it')), texts.join(' | '))
    assert.ok(texts.some(t => t.includes('the provider refused the prompt')), texts.join(' | '))
    // Singular voice is kept for a group of one — a collapsed line is only used
    // where there is genuinely more than one thing to talk about.
    for (const line of lines) {
      assert.match(line.text, /^An image didn’t finish/)
      assert.match(line.text, /Use Retry to run it again\.$/)
    }
  })

  test('different subjects never merge, even under the same reason', () => {
    const job = {
      item_progress: { total: 4, completed: 0, failed: 4, concurrency: 1, active: [] },
      genstudio_jobs: [
        declined('gs-1'), declined('gs-2'),
        { id: 'gs-3', operation: 'voice.tts', queue_state: 'failed', failure_code: 'PROVIDER_DECLINED', released_credits: 4, updated_at: '' },
        { id: 'gs-4', operation: 'voice.tts', queue_state: 'failed', failure_code: 'PROVIDER_DECLINED', released_credits: 4, updated_at: '' },
      ],
    }
    const lines = describeJobExceptions(job, nowMs)
    assert.equal(lines.length, 2, 'images and narration parts are different things')
    const texts = lines.map(l => l.text)
    assert.ok(texts.some(t => t.startsWith('2 images didn’t finish')), texts.join(' | '))
    assert.ok(texts.some(t => t.startsWith('2 narration parts didn’t finish')), texts.join(' | '))
  })

  test('varying credit amounts still collapse, and the total is the SUM', () => {
    // Grouping on the exact refund figure would let a batch whose items differ
    // in size rebuild the very wall this removes. The money is not lost by
    // grouping — it is added up, which is the figure a person wants and the one
    // they cannot get by reading rows.
    const job = {
      item_progress: { total: 3, completed: 0, failed: 3, concurrency: 1, active: [] },
      genstudio_jobs: [declined('gs-1', 9), declined('gs-2', 12), declined('gs-3', 9)],
    }
    const lines = describeJobExceptions(job, nowMs)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!.text, /^3 images didn’t finish/)
    assert.match(lines[0]!.text, /30 credits were returned in total/)
  })

  test('a group holding both charges and refunds reports both, separately', () => {
    const job = {
      item_progress: { total: 3, completed: 0, failed: 3, concurrency: 1, active: [] },
      genstudio_jobs: [
        declined('gs-1', 9), declined('gs-2', 9),
        { id: 'gs-3', operation: 'image.generation', queue_state: 'failed', failure_code: 'PROVIDER_DECLINED', settled_credits: 7, updated_at: '' },
      ],
    }
    const lines = describeJobExceptions(job, nowMs)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!.text, /7 credits were charged in total and 18 credits were returned in total/)
  })

  test('collapsing never hides a record — Technical details still gets them all', () => {
    // The drawer receives the raw array, not this list, and pages it at 25.
    assert.match(defaultView, /:remote-jobs="job\.genstudio_jobs"/)
    const ledger = readFileSync(
      fileURLToPath(new URL('../components/GenStudioBatchLedger.vue', import.meta.url)), 'utf8',
    )
    assert.match(ledger, /const PAGE_SIZE = 25/)
    assert.match(ledger, /props\.remoteJobs\.filter\(remote => stateBucket\(remote\) === 'failed'\)/)
  })
})

// ── 7. One deadline, said once ────────────────────────────────────────────

/**
 * The card rendered two clocks for the same moment, disagreeing:
 *
 *   Queued — waiting for capacity; automatic escalation at 00:00.
 *   GenStudio will step in Today 10:24:24 PM.
 *
 * The first came from the server, which scraped an `HH:MM` out of GenStudio's
 * own prose with an unanchored pattern — so it took the first clock-shaped
 * substring in the sentence whether or not that was the deadline — and printed
 * those digits with no timezone conversion. The second came from
 * `stall_recovery_at`, the real timestamp for that same deadline, rendered in
 * the reader's timezone. Both described one fact. Only one was right.
 *
 * The scrape is gone. The deadline is stated once, from the timestamp.
 */
describe('the escalation deadline is stated once, from the timestamp', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)), 'utf8',
  )

  test('the card renders the deadline from stall_recovery_at, through formatTime', () => {
    assert.match(page, /if \(remote\.stall_recovery_at\) return `\$\{detail\} GenStudio will step in \$\{formatTime\(remote\.stall_recovery_at\)\}\.`/)
    // `formatTime` is the one helper every time on this page goes through, so
    // the deadline is in the reader's timezone like all of them.
    assert.match(page, /function formatTime\(iso: string\): string \{[\s\S]{0,200}toLocaleTimeString/)
  })

  test('the page never re-derives a second clock for the same deadline', () => {
    // Comments stripped: the comment that explains this fix necessarily quotes
    // the wording it removed, and an absence assertion has to look at code.
    const pageCode = page
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.doesNotMatch(pageCode, /automatic escalation/,
      'the escalation wording must not be reconstructed on the client either')
    // Exactly one place turns stall_recovery_at into words.
    assert.equal(
      (pageCode.match(/formatTime\(remote\.stall_recovery_at\)/g) || []).length, 1,
      'one deadline, one rendering',
    )
  })
})

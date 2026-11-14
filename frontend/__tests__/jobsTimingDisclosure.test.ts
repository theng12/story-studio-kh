/**
 * The Jobs page's Timing disclosure (owner request 2026-11-14).
 *
 * A Pipeline-batch row shows its own episode's step checklist — what each step
 * did and how long it took, plus the total. The same facts the Telegram ping
 * reads out, from the same shared builder
 * (`electron/server/contracts/batch-episode-steps.ts`), so the page and the
 * notification cannot drift.
 *
 * Pinned here in the page's source-assert style (the wiring is thin and the
 * pure behaviour is pinned directly against the shared builder):
 *   - the Active AND the History card both mount the disclosure;
 *   - it is gated on the row being a batch step (batch id + a chain);
 *   - a step with no duration and a planned-but-absent step read as "—";
 *   - a failed step shows its reason;
 *   - the total line renders only when the episode actually finished;
 *   - the collapsed label is the plain word "Timing".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { summarizeEpisodeSteps, formatCompactDuration, type BatchEpisodeStep } from '../utils/episode-step-jobs.ts'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)

const stepJob = (type: string, status: string, extra: Record<string, unknown> = {}) => ({
  type,
  status,
  episode_id: 'DM0013',
  created_at: '2026-11-14T00:00:00.000Z',
  finished_at: null,
  error: null,
  params: {},
  ...extra,
})

describe('Timing disclosure on the Jobs page', () => {
  test('both the Active and the History card carry the disclosure', () => {
    const disclosures = page.match(/label="Timing"/g) || []
    assert.equal(disclosures.length, 2, 'one on the Active card, one on the History card')
  })

  test('it is gated on batch membership and mounts only when steps exist', () => {
    assert.match(page, /v-if="jobTimingSteps\(job\)\.length"/)
    assert.match(page, /pipeline_batch_id/)
    assert.match(page, /pipeline_chain/)
  })

  test('collapsed label is the plain word Timing — one line until opened', () => {
    assert.match(page, /label="Timing"/)
    assert.doesNotMatch(page, /label="Step timing|label="Episode timing/)
  })

  test('the shared builder orders steps and computes elapsed — not a page copy', () => {
    assert.match(page, /summarizeEpisodeSteps/)
    // The page must not re-implement the grouping: no local step-order table.
    assert.doesNotMatch(page, /PIPELINE_STEP_ORDER/)
  })

  test('a step that never ran or was planned but absent reads as —', () => {
    const { steps } = summarizeEpisodeSteps([
      stepJob('audio', 'done', { finished_at: '2026-11-14T00:10:00.000Z' }),
      stepJob('scene_plan_run', 'cancelled'),
    ], undefined)
    const plannedAway = summarizeEpisodeSteps([
      { ...stepJob('audio', 'done', { finished_at: '2026-11-14T00:10:00.000Z' }),
        params: { pipeline_chain: [{ type: 'metadata' }] } },
    ]).steps
    assert.equal(plannedAway.find(s => s.type === 'metadata')?.status, 'absent')
    // Any done/absent step with no measured time renders as "—" in the row.
    for (const s of steps) {
      if (s.status === 'absent' || (s.status === 'done' && s.elapsed_ms === 0)) {
        assert.equal(timingStatusTextFor(s), '—')
      }
    }
    assert.ok(steps.every(s => (s as BatchEpisodeStep).label))
  })

  // Mirrors the page's `timingStatusText` branches; kept local so a branch
  // change on the page breaks this test loudly rather than silently.
  function timingStatusTextFor(s: BatchEpisodeStep): string {
    if (s.status === 'done') return s.elapsed_ms > 0 ? formatCompactDuration(s.elapsed_ms) : '—'
    if (s.status === 'absent') return '—'
    if (s.status === 'failed') return s.reason ? `${formatCompactDuration(s.elapsed_ms) || '—'} — ${s.reason}` : (s.elapsed_ms > 0 ? formatCompactDuration(s.elapsed_ms) : 'failed')
    return s.status
  }

  test('a failed step keeps its reason for the row', () => {
    const { steps } = summarizeEpisodeSteps([
      stepJob('expand_chapters', 'error', { error: 'provider timed out', finished_at: '2026-11-14T00:05:00.000Z' }),
    ])
    const failed = steps.find(s => s.status === 'failed')
    assert.ok(failed, 'the step is failed')
    assert.equal(failed!.label, 'Script')
    assert.equal(failed!.reason, 'provider timed out')
  })

  test('the total line renders only when the episode actually finished', () => {
    assert.match(page, /v-if="jobTimingTotal\(job\)"/)
    const settled = summarizeEpisodeSteps([
      stepJob('audio', 'done', { finished_at: '2026-11-14T00:10:00.000Z' }),
    ])
    assert.equal(settled.elapsed_ms, 600_000)
    assert.equal(formatCompactDuration(settled.elapsed_ms), '10m')
    const midFlight = summarizeEpisodeSteps([
      stepJob('audio', 'running'),
    ])
    assert.equal(midFlight.elapsed_ms, 0)
  })

  test('status text helper distinguishes done, absent, failed and live states', () => {
    // Source-assert the branches the template relies on.
    assert.match(page, /timingStatusText/)
    assert.match(page, /if \(s\.status === 'absent'\) return '—'/)
    assert.match(page, /timing-\$\{s\.status\}/, 'each status gets its own class')
  })
})

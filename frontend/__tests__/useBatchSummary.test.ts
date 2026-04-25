/**
 * Tests for `useBatchSummary` — the batch post-mortem aggregator that
 * powers the post-pipeline summary banner on the Jobs page.
 *
 * Invariants covered:
 *   1. A run with mixed states produces correct success/failed/cancelled
 *      counts at episode granularity (not job granularity).
 *   2. Similar provider errors across episodes collapse into one row via
 *      the prefix-normalizer — the whole point of the grouping.
 *   3. `elapsed_ms` reflects wall-clock from earliest actual start to
 *      latest actual finish (cancelled-before-run jobs don't skew it).
 *   4. `null` when the most recent batch still has active work — the
 *      banner must not show mid-flight numbers.
 *   5. `null` when no job carries a pipeline_batch_id — non-pipeline runs
 *      never surface this banner.
 *   6. The multi-batch case: history of old batches doesn't drown out
 *      the most recent one.
 *   7. `normalizeErrorReason` scrubs UUIDs and long tokens so messages
 *      like "Task <id> did not complete in 360 seconds" group across
 *      episodes regardless of the specific task id.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLatestBatchSummary,
  normalizeErrorReason,
  formatElapsed,
  type BatchSummary,
} from '../composables/useBatchSummary.js'
import type { Job } from '../composables/useJobs.js'

// ── Test fixtures ─────────────────────────────────────────────────────────

let seq = 0
function makeJob(partial: Partial<Job> & Pick<Job, 'episode_id' | 'status'>): Job {
  seq++
  const created = partial.created_at ?? `2026-04-25T10:00:${String(seq).padStart(2, '0')}.000Z`
  return {
    job_id: partial.job_id ?? `job-${seq}`,
    project_slug: 'p1',
    type: partial.type ?? 'images',
    episode_id: partial.episode_id,
    title: partial.title ?? '',
    status: partial.status,
    created_at: created,
    started_at: partial.started_at ?? null,
    finished_at: partial.finished_at ?? null,
    error: partial.error ?? null,
    output_lines: partial.output_lines ?? [],
    params: partial.params ?? { pipeline_batch_id: 'batch-A' },
  } as Job
}

function withBatch(j: Job, batchId: string): Job {
  return { ...j, params: { ...(j.params || {}), pipeline_batch_id: batchId } } as Job
}

// ── normalizeErrorReason ──────────────────────────────────────────────────

describe('normalizeErrorReason()', () => {
  test('takes only the first line', () => {
    const msg = 'API request failed (500)\n    at Object.<anonymous> (/a/b/c.js:12:34)\n    at ...'
    assert.equal(normalizeErrorReason(msg), 'API request failed (500)')
  })

  test('strips tail after em-dash separator', () => {
    const msg = 'kie.ai poll: 429 Too Many Requests — {"error":"rate limited","retry_after":30}'
    assert.equal(normalizeErrorReason(msg), 'kie.ai poll: 429 Too Many Requests')
  })

  test('collapses UUIDs so "Task <uuid> did not complete" groups', () => {
    const a = normalizeErrorReason('Task abc12345-1111-2222-3333-444455556666 did not complete within 360 seconds')
    const b = normalizeErrorReason('Task 99887766-aaaa-bbbb-cccc-ddddeeeeffff did not complete within 360 seconds')
    assert.equal(a, b)
    assert.match(a, /<id>/)
  })

  test('collapses long task-id tokens', () => {
    const a = normalizeErrorReason('fal.ai status: 429 for taskVWXYZ123456789abcdef')
    const b = normalizeErrorReason('fal.ai status: 429 for taskPQRSTU987654321xyz')
    assert.equal(a, b, 'both should normalize to the same key')
  })

  test('redacts bearer tokens that slipped through', () => {
    const s = normalizeErrorReason('401 Unauthorized Bearer abcdef1234567890')
    assert.match(s, /Bearer \[REDACTED\]/)
  })

  test('empty input is safe', () => {
    assert.equal(normalizeErrorReason(''), '(no error message)')
    assert.equal(normalizeErrorReason('   \n   '), '(no error message)')
  })

  test('long prefixes are truncated', () => {
    // Build a long first-line message out of short words so the
    // token-collapser doesn't fold the whole thing to one `<id>`.
    const longMessage = ('error step completed failure noise '.repeat(20)).trim()
    const s = normalizeErrorReason(longMessage)
    assert.ok(s.length <= 140, `expected ≤140 chars, got ${s.length}`)
    assert.match(s, /…$/)
  })
})

// ── formatElapsed ─────────────────────────────────────────────────────────

describe('formatElapsed()', () => {
  test('seconds', () => assert.equal(formatElapsed(45_000), '45s'))
  test('minutes', () => assert.equal(formatElapsed(52 * 60_000), '52 min'))
  test('hours + minutes', () => assert.equal(formatElapsed(2 * 3_600_000 + 14 * 60_000), '2h 14m'))
  test('zero or negative renders a dash', () => {
    assert.equal(formatElapsed(0), '—')
    assert.equal(formatElapsed(-100), '—')
  })
})

// ── buildLatestBatchSummary ───────────────────────────────────────────────

describe('buildLatestBatchSummary()', () => {
  test('returns null when no job has pipeline_batch_id', () => {
    const jobs = [
      makeJob({ episode_id: 'TN0001', status: 'done', params: {} }),
    ]
    assert.equal(buildLatestBatchSummary(jobs), null)
  })

  test('returns null while the most recent batch still has active jobs', () => {
    const jobs: Job[] = [
      makeJob({ episode_id: 'TN0001', status: 'done', finished_at: '2026-04-25T10:05:00Z' }),
      makeJob({ episode_id: 'TN0002', status: 'running', started_at: '2026-04-25T10:04:00Z' }),
    ]
    assert.equal(buildLatestBatchSummary(jobs), null)
  })

  test('computes success/failed counts per episode, not per job', () => {
    // TN0001: two done jobs → success. TN0002: one done, one error → failed
    // (and should NOT count as both).
    const jobs: Job[] = [
      makeJob({ episode_id: 'TN0001', type: 'images',      status: 'done',
               started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:10:00Z' }),
      makeJob({ episode_id: 'TN0001', type: 'audio',       status: 'done',
               started_at: '2026-04-25T10:10:00Z', finished_at: '2026-04-25T10:20:00Z' }),
      makeJob({ episode_id: 'TN0002', type: 'images',      status: 'done',
               started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:12:00Z' }),
      makeJob({ episode_id: 'TN0002', type: 'audio',       status: 'error',
               started_at: '2026-04-25T10:12:00Z', finished_at: '2026-04-25T10:14:00Z',
               error: 'ElevenLabs timeout (audio section 4)' }),
    ]
    const s = buildLatestBatchSummary(jobs)!
    assert.ok(s, 'should produce a summary')
    assert.equal(s.total, 2)
    assert.equal(s.success, 1)
    assert.equal(s.failed, 1)
    assert.equal(s.cancelled, 0)
    assert.deepEqual(s.episodes_needing_repair, ['TN0002'])
    assert.equal(s.failed_episodes[0]?.episode_id, 'TN0002')
    assert.equal(s.failed_episodes[0]?.job_type, 'audio')
    assert.match(s.failed_episodes[0]!.reason, /ElevenLabs/)
  })

  test('groups similar failure reasons — same HTTP shape across 4 episodes = one row, count 4', () => {
    const jobs: Job[] = []
    for (let i = 1; i <= 4; i++) {
      jobs.push(makeJob({
        episode_id: `TN000${i}`,
        type: 'images',
        status: 'error',
        started_at: '2026-04-25T10:00:00Z',
        finished_at: `2026-04-25T10:0${i}:00Z`,
        error: `fal.ai TTS status: 429 — {"detail":"rate limited attempt ${i}"}`,
      }))
    }
    // Plus one success and one totally different failure for variety.
    jobs.push(makeJob({
      episode_id: 'TN0005', type: 'images', status: 'done',
      started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:06:00Z',
    }))
    jobs.push(makeJob({
      episode_id: 'TN0006', type: 'images', status: 'error',
      started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:07:00Z',
      error: 'ENOSPC: no space left on device',
    }))

    const s = buildLatestBatchSummary(jobs)!
    assert.equal(s.total, 6)
    assert.equal(s.failed, 5)
    assert.equal(s.success, 1)
    // The 4 fal.ai errors collapse to one row with count 4; ENOSPC is its own row.
    assert.equal(s.failure_reasons.length, 2)
    assert.equal(s.failure_reasons[0]?.count, 4, 'dominant row is the rate-limit group')
    assert.match(s.failure_reasons[0]!.reason, /fal\.ai TTS status: 429/)
    assert.equal(s.failure_reasons[1]?.count, 1)
    assert.match(s.failure_reasons[1]!.reason, /ENOSPC/)
  })

  test('elapsed_ms spans earliest actual start to latest actual finish', () => {
    const jobs: Job[] = [
      makeJob({ episode_id: 'TN0001', status: 'done',
               started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:10:00Z' }),
      makeJob({ episode_id: 'TN0002', status: 'done',
               started_at: '2026-04-25T10:05:00Z', finished_at: '2026-04-25T10:52:00Z' }),
      // Cancelled-before-start: no started_at, no finished_at — should be ignored.
      makeJob({ episode_id: 'TN0003', status: 'cancelled', started_at: null, finished_at: null }),
    ]
    const s = buildLatestBatchSummary(jobs)!
    assert.equal(s.elapsed_ms, 52 * 60_000)
  })

  test('picks the most recent batch when multiple batches exist in history', () => {
    const older: Job[] = [
      withBatch(makeJob({ episode_id: 'OLD1', status: 'done',
                          started_at: '2026-04-20T10:00:00Z', finished_at: '2026-04-20T10:05:00Z' }),
                'batch-OLD'),
    ]
    const newer: Job[] = [
      withBatch(makeJob({ episode_id: 'NEW1', status: 'done',
                          started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:05:00Z' }),
                'batch-NEW'),
      withBatch(makeJob({ episode_id: 'NEW2', status: 'error',
                          started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:06:00Z',
                          error: 'some failure' }),
                'batch-NEW'),
    ]
    const s = buildLatestBatchSummary([...older, ...newer])!
    assert.equal(s.batch_id, 'batch-NEW')
    assert.equal(s.total, 2)
    assert.equal(s.failed, 1)
  })

  test('an episode with one cancelled + no error rolls up as cancelled', () => {
    const jobs: Job[] = [
      makeJob({ episode_id: 'TN0001', status: 'done',
               started_at: '2026-04-25T10:00:00Z', finished_at: '2026-04-25T10:05:00Z' }),
      makeJob({ episode_id: 'TN0001', status: 'cancelled',
               started_at: '2026-04-25T10:05:00Z', finished_at: '2026-04-25T10:06:00Z' }),
    ]
    const s = buildLatestBatchSummary(jobs)!
    assert.equal(s.total, 1)
    assert.equal(s.success, 0)
    assert.equal(s.cancelled, 1)
    assert.equal(s.failed, 0)
  })
})

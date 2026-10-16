/**
 * 2026-10-16 — Dreamlands 571ec142 on the Jobs page. Installed 1.4.305 showed "Remove From List",
 * "Replace Failed Items" and "Retry" beside "This finished job can be removed", "1 item needs
 * another try" and "Credit outcome pending", for a song the Gateway was still holding as an unknown
 * outcome (and later finished). While a song is held, the card offers no Retry or Replace, does not
 * call the job finished or removable, and shows ONE line pointing at "Recover existing result".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { HELD_MUSIC_RESULT_GUIDANCE } from '../../electron/server/contracts/provider-task-state.js'
import { describeJobExceptions, summariseJobItems } from '../composables/useJobEta.js'

const jobs = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)), 'utf8')
const nowMs = Date.parse('2026-10-16T00:00:00.000Z')

function dreamlands(held: Record<string, unknown>) {
  return {
    job_id: '571ec142',
    type: 'music_generate',
    status: 'error',
    item_progress: { total: 20, completed: 19, failed: 1, concurrency: 20, active: [] },
    genstudio_jobs: [
      ...Array.from({ length: 19 }, (_, i) => ({
        id: `music-${i}`, operation: 'music.generation', state: 'succeeded', queue_state: 'succeeded',
        model_id: 'studio-hub::stabilityai/stable-audio-3-optimized', reserved_credits: 0, settled_credits: 0, released_credits: 0,
      })),
      { id: 'planner', operation: 'chat.response', state: 'succeeded', model_id: 'pool::writing-haiku-gemini-luna-ordered' },
      {
        id: '9c963cdc-2fec-4c36-b689-4fbfa8496ca3', operation: 'music.generation', state: 'failed', queue_state: 'failed',
        model_id: 'studio-hub::stabilityai/stable-audio-3-optimized', failure_code: 'PROVIDER_FAILED',
        reserved_credits: 0, settled_credits: 0, released_credits: 0, ...held,
      },
    ],
  } as any
}

test('a held song is settling with one Recover-existing-result line, not a failed item with credit talk', () => {
  const job = dreamlands({ recovery_required: true, recovery_state: 'unknown_outcome' })
  const counts = summariseJobItems(job.item_progress, job.genstudio_jobs)
  assert.equal(counts.failed, 0, 'no "needs another try"')
  assert.equal(counts.settling, 1)
  assert.equal(counts.finished, 19)
  assert.equal(counts.remaining, 0)
  const lines = describeJobExceptions(job, nowMs)
  assert.deepEqual(lines, [{ key: 'held-music-result', text: HELD_MUSIC_RESULT_GUIDANCE }])
  assert.match(lines[0]!.text, /Recover existing result/)
  assert.doesNotMatch(lines.map(line => line.text).join(' '), /another try|Credit outcome pending|finished job|can be removed/)
})

test('once the Gateway settles the song as an ordinary failure, the usual failed-item wording returns', () => {
  const job = dreamlands({ recovery_required: false, recovery_state: null })
  assert.equal(summariseJobItems(job.item_progress, job.genstudio_jobs).failed, 1)
  assert.match(describeJobExceptions(job, nowMs).map(line => line.text).join(' '), /1 item needs another try/)
})

test('the Jobs page offers neither Replace Failed Items nor Retry while a result is held', () => {
  // Replace: its own gate reads the shared held predicate.
  assert.match(jobs, /function canReplaceFailedItems\(job: RJob\): boolean \{[\s\S]{0,260}some\(holdsUnknownProviderOutcome\)\) return false/)
  // Retry: hidden whenever the shared control projection asks for a provider check, which a held
  // song always does (job-history-dismiss-gate.test.ts pins that control and its line).
  assert.match(jobs, /function canRetryJob\(job: RJob\): boolean \{[\s\S]*?control\.action === 'recheck-provider-status' \|\| control\.action === 'return-later'/)
  assert.match(jobs, /const failedJobsForRetryAll = computed[\s\S]*?!waitsForProviderCheck\(j\)/)
})

test('a finished song not in the library yet shows the one import line and counts as settling', async () => {
  const { MUSIC_RESULT_AWAITING_IMPORT_GUIDANCE } = await import('../../electron/server/contracts/provider-task-state.js')
  const job = { ...dreamlands({ state: 'succeeded', recovery_required: false, recovery_state: null }), music_results_awaiting_import: ['9c963cdc-2fec-4c36-b689-4fbfa8496ca3'] }
  const counts = summariseJobItems(job.item_progress, job.genstudio_jobs, job.music_results_awaiting_import.length)
  assert.equal(counts.failed, 0)
  assert.equal(counts.settling, 1)
  assert.deepEqual(describeJobExceptions(job, nowMs), [{ key: 'music-result-awaiting-import', text: MUSIC_RESULT_AWAITING_IMPORT_GUIDANCE }])
  assert.match(jobs, /function jobCounts\(job: RJob\) \{\s*return summariseJobItems\(job\.item_progress, job\.genstudio_jobs, job\.music_results_awaiting_import\?\.length\)/)
})

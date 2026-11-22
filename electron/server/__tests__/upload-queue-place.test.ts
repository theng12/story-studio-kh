/**
 * S29 — a queued upload says where it is and how long it has waited, and a row that was held keeps its
 * first-come place.
 *
 * Production, 2026-11-21: EP0044 sat 29 h behind uploads admitted after it, and nothing on the row said
 * so. The cause is `releaseQuotaWaitIfDue`: a woken row was pushed to the BACK of its lane, so every
 * pacing re-hold sent it behind everything admitted while it waited. Both halves are pinned here — the
 * stated place/age, and the woken row's order.
 */

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { useTempDataDir } from './_helpers.js'

const boot = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const jq = await import('../services/job-queue.js')
await boot.cleanup()

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await jq.setQueuePaused(false)
  await jq._waitForJobPersistenceForTesting()
  await cleanup?.()
  cleanup = undefined
})

test('queued uploads state their place in the lane and how long they have waited', async () => {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await pm.createProject({ name: 'Queue place' })
  await jq.setQueuePaused(true)

  const first = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'youtube_upload', episode_id: 'EP0001',
    title: 'First in line', params: { expected_channel_id: 'chan-place' },
    episode_recovery_job_id: `place-1-${Date.now()}`,
  })
  const second = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'youtube_upload', episode_id: 'EP0002',
    title: 'Second in line', params: { expected_channel_id: 'chan-place' },
    episode_recovery_job_id: `place-2-${Date.now()}`,
  })

  const rows = await jq.getJobs(project.slug, { type: 'youtube_upload' })
  const one = rows.find(row => row.job_id === first.job_id)
  const two = rows.find(row => row.job_id === second.job_id)
  assert.equal(one?.queue_position, 1, 'the row enqueued first is first in the lane')
  assert.equal(two?.queue_position, 2)
  assert.equal(typeof one?.queued_for_seconds, 'number', 'the row states how long it has waited')
  assert.equal(typeof two?.queued_for_seconds, 'number')
  assert.ok(Number(one?.queued_for_seconds) >= Number(two?.queued_for_seconds),
    `${one?.queued_for_seconds}s against ${two?.queued_for_seconds}s — the older row has waited longer`)
})

test('a woken upload returns to its first-come place, not the back of the lane', async () => {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const project = await pm.createProject({ name: 'Queue wake place' })
  await jq.setQueuePaused(true)

  const older = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'youtube_upload', episode_id: 'EP0100',
    title: 'Older upload', params: { expected_channel_id: 'chan-wake' },
    episode_recovery_job_id: `wake-1-${Date.now()}`,
  })
  const newer = jq.enqueuePreparedForTest({
    project_slug: project.slug, type: 'youtube_upload', episode_id: 'EP0101',
    title: 'Newer upload', params: { expected_channel_id: 'chan-wake' },
    episode_recovery_job_id: `wake-2-${Date.now()}`,
  })
  assert.equal(jq.getJob(older.job_id)?.status, 'queued')

  // The older row is held and then wakes while the newer one is still in the lane — the shape that
  // starved EP0044. Its wake must put it back AHEAD of the row admitted after it.
  await jq.holdJobUntil(older.job_id, new Date(Date.now() + 60_000).toISOString(), 'held for its pacing window')
  await jq.reevaluateUploadQueue()

  const rows = await jq.getJobs(project.slug, { type: 'youtube_upload' })
  const olderRow = rows.find(row => row.job_id === older.job_id)
  const newerRow = rows.find(row => row.job_id === newer.job_id)
  // Positions are per lane across every project, so the assertion is about ORDER, not the number.
  assert.ok(Number(olderRow?.queue_position) < Number(newerRow?.queue_position),
    `the held-then-reconsidered row comes back ahead of the one admitted after it `
    + `(${olderRow?.queue_position} against ${newerRow?.queue_position})`)
})

/**
 * Focused dispatch tests for upload pacing (Story 386 Item 1).
 *
 * The pure scheduling algorithm is pinned by `upload-pacing.test.ts`; the glue
 * shape by `upload-pacing-queue.test.ts`. This file pins the QUEUE behaviour
 * the approved brief actually depends on:
 *
 *   - every producer's upload reaches one pacing gate in the pump;
 *   - a held channel is skipped so an eligible channel's upload runs;
 *   - a publish-deadline hold stays queued with no invented wake instant;
 *   - a live eligibility read failure never runs the upload, keeps it queued
 *     with a loud reason and a timer retry, and other channels still run;
 *   - an unconfigured channel (and every other job type) keeps the previous
 *     admission behaviour;
 *   - boot re-decides a stored pacing instant from live inputs instead of
 *     sleeping on it, and rewrites it when the live answer differs.
 *
 * No Story suite is run for this file yet (lane not granted); it is written to
 * be run with `--only upload-pacing-dispatch` once the lead releases the lane.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'
import type { UploadPacingPolicy } from '../services/upload-pacing.js'
import {
  pacingContextForChannel,
  uploadPacingBootReevaluates,
  type PacingChannelContext,
} from '../services/upload-pacing-queue.js'

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 15_000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A window that certainly contains the test's own instant, with no clock guess. */
function openPolicy(now = Date.now()): UploadPacingPolicy {
  const hour = new Date(now).getUTCHours()
  return {
    tier: 'gentle',
    daily_limit: 10,
    timezone: 'UTC',
    window: {
      start: `${String(Math.max(0, hour - 1)).padStart(2, '0')}:00`,
      end: hour >= 23 ? '23:59' : `${String(hour + 1).padStart(2, '0')}:00`,
    },
    min_spacing_minutes: 0,
  }
}

function eligibleContext(now = Date.now()): PacingChannelContext {
  return {
    policy: openPolicy(now),
    recorded_transfers: [],
    quota_exhausted: false,
    quota_reset_at: null,
  }
}

function heldContext(resetAt: string, now = Date.now()): PacingChannelContext {
  return {
    policy: openPolicy(now),
    recorded_transfers: [],
    quota_exhausted: true,
    quota_reset_at: resetAt,
  }
}

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let bootQueue: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  const queueUrl = new URL('../services/job-queue.js', import.meta.url).href
  jq = await import(`${queueUrl}?upload-pacing-dispatch=1`)
  // A separate module instance represents a fresh process reading the same
  // persisted records, so the boot scan can be exercised directly.
  bootQueue = await import(`${queueUrl}?upload-pacing-boot=1`)
})

after(async () => {
  jq._setUploadPacingContextForTesting(null)
  bootQueue._setUploadPacingContextForTesting(null)
  await cleanup()
})

test('a held channel is skipped so another channel\'s eligible upload runs', async () => {
  const heldProject = await pm.createProject({ name: 'Pacing held channel' })
  const openProject = await pm.createProject({ name: 'Pacing open channel' })
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  jq._setUploadPacingContextForTesting(job => (
    job.project_slug === heldProject.slug ? heldContext(resetAt) : eligibleContext()
  ))
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  const held = jq.enqueuePreparedForTest({
    project_slug: heldProject.slug,
    type: 'youtube_upload',
    episode_id: 'EP-HELD',
    params: { expected_channel_id: 'chan-held' },
  })
  jq.enqueuePreparedForTest({
    project_slug: openProject.slug,
    type: 'youtube_upload',
    episode_id: 'EP-OPEN',
    params: { expected_channel_id: 'chan-open' },
  })

  await waitFor(() => started.includes('EP-OPEN'), 'the open channel upload to start')
  assert.deepEqual(started, ['EP-OPEN'], 'the held channel must not run and must not block the open one')
  assert.ok(!started.includes('EP-HELD'))

  const heldRows = await jq.getJobs(heldProject.slug, { type: 'youtube_upload' })
  const heldRow = heldRows.find(row => row.job_id === held.job_id)
  assert.equal(heldRow?.status, 'queued')
  assert.equal(heldRow?.params.quota_retry_at, resetAt, 'the hold is the queue durable marker')
})

test('a live eligibility read failure never starts an upload and other channels still run', async () => {
  const brokenProject = await pm.createProject({ name: 'Pacing unreadable channel' })
  const healthyProject = await pm.createProject({ name: 'Pacing readable channel' })
  jq._setUploadPacingContextForTesting(job => {
    if (job.project_slug === brokenProject.slug) throw new Error('quota registry unreadable')
    return eligibleContext()
  })
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  const broken = jq.enqueuePreparedForTest({
    project_slug: brokenProject.slug,
    type: 'youtube_upload',
    episode_id: 'EP-UNREADABLE',
    params: { expected_channel_id: 'chan-broken' },
  })
  jq.enqueuePreparedForTest({
    project_slug: healthyProject.slug,
    type: 'youtube_upload',
    episode_id: 'EP-READABLE',
    params: { expected_channel_id: 'chan-healthy' },
  })

  await waitFor(() => started.includes('EP-READABLE'), 'the readable channel upload to start')
  assert.equal(started.filter(id => id === 'EP-UNREADABLE').length, 0,
    'an unreadable eligibility must never execute the upload')

  const rows = await jq.getJobs(brokenProject.slug, { type: 'youtube_upload' })
  const row = rows.find(candidate => candidate.job_id === broken.job_id)
  assert.equal(row?.status, 'queued')
  assert.match(String(row?.error), /could not be confirmed/i)
  const retryAt = Date.parse(String(row?.params.quota_retry_at))
  assert.ok(Number.isFinite(retryAt), 'the row keeps a retry through the queue timer')
  assert.ok(retryAt > Date.now())
})

test('reevaluating after a policy change requeues a parked upload and runs it now', async () => {
  const project = await pm.createProject({ name: 'Pacing reevaluate channel' })
  const oldWake = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  jq._setUploadPacingContextForTesting(() => heldContext(oldWake))
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'youtube_upload',
    episode_id: 'EP-REEVALUATE',
    params: { expected_channel_id: 'chan-reevaluate' },
  })

  let parked: Job | undefined
  await waitFor(async () => {
    const rows = await jq.getJobs(project.slug, { type: 'youtube_upload' })
    parked = rows.find(row => row.job_id === job.job_id)
    return parked?.params.quota_retry_at === oldWake
  }, 'the upload to be parked on the old policy')
  assert.ok(!started.includes('EP-REEVALUATE'))

  // The policy is saved; the lead's route awaits this before replying.
  jq._setUploadPacingContextForTesting(() => eligibleContext())
  await jq.reevaluateUploadQueue()
  await waitFor(() => started.includes('EP-REEVALUATE'), 'the requeued upload to run after the policy change')

  const rows = await jq.getJobs(project.slug, { type: 'youtube_upload' })
  assert.equal(rows.filter(row => row.episode_id === 'EP-REEVALUATE').length, 1,
    'reevaluation requeues the same row; it creates no second producer or duplicate')
})

test('a publish-deadline hold stays queued with no invented wake instant', async () => {
  const project = await pm.createProject({ name: 'Pacing deadline channel' })
  jq._setUploadPacingContextForTesting(() => eligibleContext())
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'youtube_upload',
    episode_id: 'EP-DEADLINE',
    params: {
      expected_channel_id: 'chan-deadline',
      scheduled_for: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    },
  })

  let row: Job | undefined
  await waitFor(async () => {
    const rows = await jq.getJobs(project.slug, { type: 'youtube_upload' })
    row = rows.find(candidate => candidate.job_id === job.job_id)
    return row?.params.pacing_publish_deadline_hold === true
  }, 'the publish-deadline hold to be recorded')
  assert.equal(row?.status, 'queued')
  assert.equal(row?.params.pacing_publish_deadline_hold, true)
  assert.equal(row?.params.quota_retry_at, undefined, 'no wake instant is invented for a passed date')
  assert.match(String(row?.error), /publish date/i)
  assert.ok(!started.includes('EP-DEADLINE'))
  // A null-wake hold stays in the lane by design. Retire it here so the next
  // test's pump cannot pick it up with that test's own context.
  jq._setJobRecordForTesting(job.job_id, { status: 'cancelled' })
})

test('an unconfigured channel keeps the previous admission behaviour', async () => {
  const project = await pm.createProject({ name: 'Pacing unconfigured channel' })
  jq._setUploadPacingContextForTesting(() => null)
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'youtube_upload',
    episode_id: 'EP-NOPOLICY',
    params: { expected_channel_id: 'chan-none' },
  })

  await waitFor(() => started.includes('EP-NOPOLICY'), 'the unconfigured upload to start')
})

test('the pacing gate never touches a non-upload lane', async () => {
  const project = await pm.createProject({ name: 'Pacing other lane' })
  // A context that would hold any upload must not be consulted for metadata.
  jq._setUploadPacingContextForTesting(() => heldContext(new Date(Date.now() + 60 * 60 * 1000).toISOString()))
  const started: string[] = []
  jq.registerExecutor('metadata', async job => { started.push(job.episode_id) })

  jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'metadata',
    episode_id: 'EP-METADATA',
  })

  await waitFor(() => started.includes('EP-METADATA'), 'the metadata job to start')
})

test('boot re-decides a stored pacing instant from live inputs', async () => {
  const reevaluated = await pm.createProject({ name: 'Pacing boot reevaluate' })
  const rewritten = await pm.createProject({ name: 'Pacing boot rewrite' })
  const staleMarker = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const liveReset = new Date(Date.now() + 60 * 60 * 1000).toISOString()

  const jobsFile = (slug: string) => path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'jobs.json')
  const persisted = (slug: string, jobId: string, episodeId: string) => ({
    job_id: jobId,
    project_slug: slug,
    type: 'youtube_upload',
    episode_id: episodeId,
    title: episodeId,
    status: 'queued',
    created_at: '2026-11-07T00:00:00.000Z',
    started_at: '2026-11-07T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: { expected_channel_id: `chan-${episodeId}`, quota_retry_at: staleMarker },
  })
  await fs.writeFile(jobsFile(reevaluated.slug), JSON.stringify({
    jobs: [persisted(reevaluated.slug, 'boot-open', 'EP-BOOT-OPEN')],
  }))
  await fs.writeFile(jobsFile(rewritten.slug), JSON.stringify({
    jobs: [persisted(rewritten.slug, 'boot-held', 'EP-BOOT-HELD')],
  }))

  bootQueue._setUploadPacingContextForTesting(job => (
    job.project_slug === rewritten.slug ? heldContext(liveReset) : eligibleContext()
  ))
  const started: string[] = []
  bootQueue.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  await bootQueue.resumeInterruptedJobsAtBoot()
  await waitFor(() => started.includes('EP-BOOT-OPEN'), 'the live-eligible upload to start after boot')

  const openRows = await bootQueue.getJobs(reevaluated.slug, { type: 'youtube_upload' })
  const openRow = openRows.find(row => row.job_id === 'boot-open')
  assert.equal(openRow?.status === 'done' || openRow?.status === 'running', true,
    'the stored future marker must not keep a live-eligible upload waiting')
  assert.equal(openRow?.params.quota_retry_at, undefined)

  const heldRows = await bootQueue.getJobs(rewritten.slug, { type: 'youtube_upload' })
  const heldRow = heldRows.find(row => row.job_id === 'boot-held')
  assert.equal(heldRow?.status, 'queued')
  assert.equal(heldRow?.params.quota_retry_at, liveReset,
    'the live hold instant replaces the stale one')
  assert.ok(!started.includes('EP-BOOT-HELD'))
})

test('the boot helper recognises only a queued upload with a future marker', () => {
  const base = {
    job_id: 'x', project_slug: 'p', type: 'youtube_upload' as const, episode_id: 'E',
    title: '', status: 'queued' as const, created_at: '', started_at: null,
    finished_at: null, error: null, output_lines: [], params: {},
  }
  const future = new Date(Date.now() + 60_000).toISOString()
  assert.equal(uploadPacingBootReevaluates({ ...base, params: { quota_retry_at: future } }), true)
  assert.equal(uploadPacingBootReevaluates({ ...base, params: {} }), false)
  assert.equal(uploadPacingBootReevaluates({ ...base, status: 'running', params: { quota_retry_at: future } }), false)
  assert.equal(uploadPacingBootReevaluates({ ...base, type: 'metadata', params: { quota_retry_at: future } }), false)
  assert.equal(uploadPacingBootReevaluates({ ...base, params: { quota_retry_at: 'not-a-date' } }), false)
})

test('one channel\'s recorded transfers never count for another channel', () => {
  const context = pacingContextForChannel({
    policy: openPolicy(),
    channelId: 'chan-A',
    quota: null,
    jobs: [
      { job_id: 'a', project_slug: 'p', type: 'youtube_upload', episode_id: 'A', title: '', status: 'done', created_at: '', started_at: null, finished_at: new Date().toISOString(), error: null, output_lines: [], params: { expected_channel_id: 'chan-A' } },
      { job_id: 'b', project_slug: 'p', type: 'youtube_upload', episode_id: 'B', title: '', status: 'done', created_at: '', started_at: null, finished_at: new Date().toISOString(), error: null, output_lines: [], params: { expected_channel_id: 'chan-B' } },
    ] as any,
  })
  assert.deepEqual(context.recorded_transfers.map(transfer => transfer.episode_code), ['A'])
  assert.equal(context.quota_exhausted, false, 'no ledger reading is not exhaustion')
})

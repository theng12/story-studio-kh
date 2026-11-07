/**
 * Admission-boundary tests for upload pacing (Story 386 Item 1).
 *
 * `upload-pacing-dispatch.test.ts` pins the pump through the test-only context
 * seam. This file pins the LIVE resolution the seam stands in for, because the
 * seam can never prove what production reads:
 *
 *   - a channel that never saved a policy holds with a plain "choose a window"
 *     reason and no invented wake, then runs once the window is saved;
 *   - a saved but corrupt policy holds as an ERROR, never as "unconfigured"
 *     (false / 0 / '' are corrupt, not missing);
 *   - one channel's configuration hold never blocks another channel;
 *   - an unreadable quota ledger holds the row instead of admitting it on an
 *     assumed zero (AGENTS §6: unknown is not zero).
 *
 * The quota test corrupts a real temp ledger rather than adding a seam, so the
 * production read path is the one under test.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import type { UploadPacingPolicy } from '../services/upload-pacing.js'

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

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let connections: typeof import('../services/youtube-connection-store.js')
let quota: typeof import('../services/youtube-quota-ledger.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  connections = await import('../services/youtube-connection-store.js')
  quota = await import('../services/youtube-quota-ledger.js')
})

after(async () => {
  jq._setUploadPacingContextForTesting(null)
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

async function rowOf(slug: string, jobId: string): Promise<import('../models/types.js').Job | undefined> {
  const rows = await jq.getJobs(slug, { type: 'youtube_upload' })
  return rows.find(row => row.job_id === jobId)
}

/** Retire rows a test deliberately left queued so the next test's pump ignores them. */
async function retire(...jobIds: string[]): Promise<void> {
  for (const id of jobIds) jq._setJobRecordForTesting(id, { status: 'cancelled' })
  await jq._waitForJobPersistenceForTesting()
}

test('a channel with no saved policy holds with a plain reason and no invented wake', async () => {
  const project = await pm.createProject({ name: 'Admission missing policy' })
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'youtube_upload',
    episode_id: 'EP-NO-POLICY',
    params: { expected_channel_id: 'chan-missing' },
  })
  try {
    await waitFor(async () => String((await rowOf(project.slug, job.job_id))?.error).includes('upload window hours'),
      'the unconfigured channel to hold with a plain reason')

    const row = await rowOf(project.slug, job.job_id)
    assert.equal(row?.status, 'queued')
    assert.equal(row?.params.quota_retry_at, undefined, 'a configuration hold invents no clock')
    assert.ok(!started.includes('EP-NO-POLICY'), 'nothing is uploaded before a window is chosen')

    // The Upload Center save awaits this: the same row is re-decided live.
    await pm.updateConfig(project.slug, { upload_pacing: openPolicy() } as any)
    await jq.reevaluateUploadQueue()
    await waitFor(() => started.includes('EP-NO-POLICY'), 'the upload to run once the window is saved')
  } finally {
    await retire(job.job_id)
  }
})

test('a saved corrupt policy holds as an error, never as unconfigured', async () => {
  const corruptValues: unknown[] = [
    { tier: 'gentle', daily_limit: 0, timezone: 'UTC', window: { start: '00:00', end: '23:59' } },
    false,
  ]
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  for (const [index, value] of corruptValues.entries()) {
    const project = await pm.createProject({ name: `Admission corrupt policy ${index + 1}` })
    await pm.updateConfig(project.slug, { upload_pacing: value } as any)
    const episode = `EP-CORRUPT-${index + 1}`
    const job = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'youtube_upload',
      episode_id: episode,
      params: { expected_channel_id: `chan-corrupt-${index + 1}` },
    })
    try {
      await waitFor(async () => String((await rowOf(project.slug, job.job_id))?.error).includes('not usable'),
        `corrupt value ${String(value)} to hold as an error`)
      const row = await rowOf(project.slug, job.job_id)
      assert.equal(row?.status, 'queued')
      assert.equal(row?.params.quota_retry_at, undefined, 'a corrupt policy invents no wake')
      assert.ok(!started.includes(episode), 'a corrupt policy never runs on a default window')
    } finally {
      await retire(job.job_id)
    }
  }
})

test('one channel\'s configuration hold never blocks another channel', async () => {
  const unconfigured = await pm.createProject({ name: 'Admission held channel' })
  const configured = await pm.createProject({ name: 'Admission open channel' })
  await pm.updateConfig(configured.slug, { upload_pacing: openPolicy() } as any)
  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })

  const held = jq.enqueuePreparedForTest({
    project_slug: unconfigured.slug,
    type: 'youtube_upload',
    episode_id: 'EP-HELD-NO-POLICY',
    params: { expected_channel_id: 'chan-held' },
  })
  const open = jq.enqueuePreparedForTest({
    project_slug: configured.slug,
    type: 'youtube_upload',
    episode_id: 'EP-OPEN-CONFIGURED',
    params: { expected_channel_id: 'chan-open' },
  })
  try {
    await waitFor(() => started.includes('EP-OPEN-CONFIGURED'), 'the configured channel to upload')
    assert.ok(!started.includes('EP-HELD-NO-POLICY'), 'the held channel still waits')
    assert.equal((await rowOf(unconfigured.slug, held.job_id))?.status, 'queued')
  } finally {
    await retire(held.job_id, open.job_id)
  }
})

test('an unreadable quota ledger holds the upload instead of assuming zero', async () => {
  const application = await connections.configureYouTubeApplication({
    client_id: 'admission-client', client_secret: 'admission-secret',
  })
  const project = await pm.createProject({ name: 'Admission unreadable quota' })
  await pm.updateConfig(project.slug, { upload_pacing: openPolicy() } as any)

  // Create the real ledger, then corrupt it: this is a genuine read failure.
  await quota.readYouTubeQuota(application.application_id)
  const metaPath = path.join(
    process.env.STORY_STUDIO_DATA_DIR!, 'youtube', 'quota', application.application_id, 'meta.json',
  )
  await fs.writeFile(metaPath, '{not json')

  const started: string[] = []
  jq.registerExecutor('youtube_upload', async job => { started.push(job.episode_id) })
  const job = jq.enqueuePreparedForTest({
    project_slug: project.slug,
    type: 'youtube_upload',
    episode_id: 'EP-QUOTA-UNREADABLE',
    params: { expected_channel_id: 'chan-quota' },
  })
  try {
    await waitFor(async () => String((await rowOf(project.slug, job.job_id))?.error).includes('could not be confirmed'),
      'the unreadable quota ledger to hold the upload')

    const row = await rowOf(project.slug, job.job_id)
    assert.equal(row?.status, 'queued')
    assert.ok(!started.includes('EP-QUOTA-UNREADABLE'), 'an unknown quota is not spent as if it were zero')
    const retryAt = Date.parse(String(row?.params.quota_retry_at))
    assert.ok(Number.isFinite(retryAt) && retryAt > Date.now(), 'the row retries through the queue timer')
  } finally {
    await retire(job.job_id)
  }
})

/**
 * A writing model that answers "quota used up" (proven, uncharged) parks its job
 * instead of failing it, and asks again later — 1, 2, 4 … capped at 30 minutes,
 * reset by a success. One model only: a Gateway pool falls through its own members.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { waitForValue as waitFor } from './_timing.js'
import {
  _setQuotaRecheckMsForTesting,
  clearQuotaStops,
  isUnchargedQuotaStop,
  noteQuotaStop,
  QUOTA_MAX_RECHECK_MS,
} from '../lib/ai-client.js'
import { GENSTUDIO_LANGUAGE_FAILURE_CODES, GenStudioChatTerminalFailureError } from '../lib/genstudio-client.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

const quota = (settled = 0) => new GenStudioChatTerminalFailureError({
  id: `quota-${Math.random()}`, state: 'failed', failure_code: GENSTUDIO_LANGUAGE_FAILURE_CODES.QUOTA_EXHAUSTED,
  reserved_credits: 10, settled_credits: settled, released_credits: 10 - settled,
})

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
  _setQuotaRecheckMsForTesting(300)
})

after(async () => { await cleanup() })

test('only a proven, uncharged quota stop counts — even when an adapter wraps it', () => {
  assert.equal(isUnchargedQuotaStop(quota()), true)
  assert.equal(isUnchargedQuotaStop(new Error('adapter summary', { cause: quota() })), true)
  assert.equal(isUnchargedQuotaStop(quota(1)), false, 'a charged stop is not a free wait')
  assert.equal(isUnchargedQuotaStop(new Error('timeout')), false)
})

test('consecutive quota stops back off and a success resets the recheck', () => {
  _setQuotaRecheckMsForTesting(60_000)
  try {
    const model = `pool::backoff-${Date.now()}`
    const wait = () => Date.parse(noteQuotaStop(model)) - Date.now()
    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 2_000, `${actual} ≈ ${expected}`)
    near(wait(), 60_000)
    near(wait(), 120_000)
    near(wait(), 240_000)
    for (let i = 0; i < 6; i++) wait()
    near(wait(), QUOTA_MAX_RECHECK_MS)
    clearQuotaStops(model)
    near(wait(), 60_000)
  } finally {
    _setQuotaRecheckMsForTesting(300)
  }
})

describe('writing-model quota holds in the job queue', () => {
  test('parks a wrapped quota stop, frees its lane, and later resumes the same job', async () => {
    const project = await pm.createProject({ name: 'Quota lane release' })
    let writingRuns = 0
    let unrelatedRuns = 0
    jq.registerExecutor('idea_campaign', async () => {
      writingRuns++
      if (writingRuns === 1) throw new Error('Idea Campaign stopped', { cause: quota() })
    })
    jq.registerExecutor('broll_select', async () => { unrelatedRuns++ })

    const waiting = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-QUOTA-1',
      title: 'quota wait',
      params: { model: 'pool::lane-release' },
    })
    const parked = await waitFor(() => {
      const job = jq.getJob(waiting.job_id)
      return job?.status === 'queued' && /used up its allowance/.test(job.error || '') ? job : undefined
    })
    assert.match(parked.error || '', /nothing was charged/)
    assert.match(parked.error || '', /pool from GatewayKH/)

    const unrelated = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'broll_select',
      episode_id: 'EP-OTHER-1',
      title: 'unrelated eligible work',
      params: {},
    })
    await waitFor(() => jq.getJob(unrelated.job_id)?.status === 'done' ? true : undefined)
    assert.equal(unrelatedRuns, 1)

    const complete = await waitFor(() => jq.getJob(waiting.job_id)?.status === 'done'
      ? jq.getJob(waiting.job_id)! : undefined)
    assert.equal(complete.job_id, waiting.job_id)
    assert.equal(writingRuns, 2)
    assert.equal(complete.params.quota_retry_at, undefined)
  })

  test('a charged quota stop fails normally instead of waiting', async () => {
    const project = await pm.createProject({ name: 'Quota fails normally' })
    jq.registerExecutor('idea_campaign', async () => { throw quota(1) })
    const charged = jq.enqueuePreparedForTest({
      project_slug: project.slug, type: 'idea_campaign', episode_id: 'EP-Q-CHARGED', title: 'charged', params: { model: 'paid', auto_retry: false },
    })
    await waitFor(() => jq.getJob(charged.job_id)?.status === 'error' ? true : undefined)
    assert.equal(jq.getJob(charged.job_id)?.params.quota_retry_at, undefined)
  })

  test('a queued wait remains paused or cancelled when its due time arrives', async () => {
    const project = await pm.createProject({ name: 'Quota pause and cancel' })
    let runs = 0
    jq.registerExecutor('idea_campaign', async () => {
      runs++
      throw quota()
    })

    const paused = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-QUOTA-PAUSE',
      title: 'pause before recheck',
      params: { model: 'pool::pause' },
    })
    await waitFor(() => jq.getJob(paused.job_id)?.status === 'queued' && jq.getJob(paused.job_id)?.error ? true : undefined)
    const pausedDue = Date.parse(jq.getJob(paused.job_id)!.params.quota_retry_at)
    await jq.pauseJob(paused.job_id)
    await waitFor(() => Date.now() >= pausedDue ? true : undefined, { label: 'paused job original recheck deadline passes' })
    assert.equal(jq.getJob(paused.job_id)?.status, 'paused')

    const cancelled = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-QUOTA-CANCEL',
      title: 'cancel before recheck',
      params: { model: 'pool::cancel' },
    })
    await waitFor(() => jq.getJob(cancelled.job_id)?.status === 'queued' && jq.getJob(cancelled.job_id)?.error ? true : undefined)
    const cancelledDue = Date.parse(jq.getJob(cancelled.job_id)!.params.quota_retry_at)
    await jq.requestJobCancellation(project.slug, cancelled.job_id)
    await waitFor(() => Date.now() >= cancelledDue ? true : undefined, { label: 'cancelled job original recheck deadline passes' })
    assert.equal(jq.getJob(cancelled.job_id)?.status, 'cancelled')
    assert.equal(runs, 2)
  })

  test('restores a persisted waiting job without admitting it before its retry time', async () => {
    const project = await pm.createProject({ name: 'Quota restart' })
    const retryAt = new Date(Date.now() + 320).toISOString()
    const jobId = 'quota-restart-job'
    let runs = 0
    jq.registerExecutor('idea_campaign', async () => { runs++ })
    const persisted: Job = {
      job_id: jobId,
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-QUOTA-RESTART',
      title: 'restored quota wait',
      status: 'queued',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: 'used up its allowance',
      output_lines: ['used up its allowance'],
      params: { model: 'pool::restart', quota_retry_at: retryAt },
    }
    await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [persisted] }))

    await jq.getJobs(project.slug)
    assert.equal(runs, 0)
    const restored = await waitFor(() => jq.getJob(jobId)?.status === 'done' ? jq.getJob(jobId)! : undefined)
    assert.equal(restored.job_id, jobId)
    assert.equal(runs, 1)
  })
})

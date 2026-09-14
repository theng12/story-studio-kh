import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { waitForValue as waitFor } from './_timing.js'
import { LlmLineupWaitingError } from '../lib/ai-client.js'
import type { Job } from '../models/types.js'

let cleanup: () => Promise<void>
let tempDir: string
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

function waitingParams(retryAt: string) {
  return {
    pipeline_model_policy: {
      ideas: {
        mode: 'backup',
        models: ['chat-free', 'chat-paid'],
        assigned_model: 'chat-free',
        wait_for_availability: true,
        prefer_savings: true,
      },
    },
    pipeline_model_checkpoints: {
      'ideas-request': {
        input_fingerprint: 'lineup-test-input',
        candidates: ['chat-free', 'chat-paid'],
        candidate_index: 1,
        candidate_model: 'chat-paid',
        status: 'waiting',
        retry_at: retryAt,
        updated_at: new Date().toISOString(),
      },
    },
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

describe('durable shared LLM lineup waits', () => {
  test('parks a wrapped wait, frees its lane, and later resumes the same job', async () => {
    const project = await pm.createProject({ name: 'Lineup lane release' })
    const retryAt = new Date(Date.now() + 320).toISOString()
    let lineupRuns = 0
    let unrelatedRuns = 0
    jq.registerExecutor('idea_campaign', async () => {
      lineupRuns++
      if (lineupRuns === 1) throw new Error('adapter wrapped the temporary model availability error')
    })
    jq.registerExecutor('broll_select', async () => { unrelatedRuns++ })

    const waiting = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-LINEUP-1',
      title: 'lineup wait',
      params: waitingParams(retryAt),
    })
    await waitFor(() => {
      const job = jq.getJob(waiting.job_id)
      return job?.status === 'queued' && /Waiting for model availability/.test(job.error || '') ? job : undefined
    })

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
    assert.equal(lineupRuns, 2)
    assert.equal(complete.params.llm_lineup_retry_at, undefined)
  })

  test('a queued wait remains paused or cancelled when its due time arrives', async () => {
    const project = await pm.createProject({ name: 'Lineup pause and cancel' })
    let runs = 0
    jq.registerExecutor('idea_campaign', async () => {
      runs++
      throw new LlmLineupWaitingError(new Date(Date.now() + 320).toISOString())
    })

    const paused = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-LINEUP-PAUSE',
      title: 'pause before availability',
      params: waitingParams(new Date(Date.now() + 320).toISOString()),
    })
    await waitFor(() => jq.getJob(paused.job_id)?.status === 'queued' && jq.getJob(paused.job_id)?.error ? true : undefined)
    const pausedDue = Date.parse(jq.getJob(paused.job_id)!.params.llm_lineup_retry_at)
    await jq.pauseJob(paused.job_id)
    await waitFor(() => Date.now() >= pausedDue ? true : undefined, { label: 'paused job original recheck deadline passes' })
    assert.equal(jq.getJob(paused.job_id)?.status, 'paused')

    const cancelled = jq.enqueuePreparedForTest({
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-LINEUP-CANCEL',
      title: 'cancel before availability',
      params: waitingParams(new Date(Date.now() + 320).toISOString()),
    })
    await waitFor(() => jq.getJob(cancelled.job_id)?.status === 'queued' && jq.getJob(cancelled.job_id)?.error ? true : undefined)
    const cancelledDue = Date.parse(jq.getJob(cancelled.job_id)!.params.llm_lineup_retry_at)
    await jq.requestJobCancellation(project.slug, cancelled.job_id)
    await waitFor(() => Date.now() >= cancelledDue ? true : undefined, { label: 'cancelled job original recheck deadline passes' })
    assert.equal(jq.getJob(cancelled.job_id)?.status, 'cancelled')
    assert.equal(runs, 2)
  })

  test('restores a persisted waiting job without admitting it before its retry time', async () => {
    const project = await pm.createProject({ name: 'Lineup restart' })
    const retryAt = new Date(Date.now() + 320).toISOString()
    const jobId = 'lineup-restart-job'
    let runs = 0
    jq.registerExecutor('idea_campaign', async () => { runs++ })
    const persisted: Job = {
      job_id: jobId,
      project_slug: project.slug,
      type: 'idea_campaign',
      episode_id: 'EP-LINEUP-RESTART',
      title: 'restored lineup wait',
      status: 'queued',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: 'Waiting for model availability',
      output_lines: ['Waiting for model availability'],
      params: { ...waitingParams(retryAt), llm_lineup_retry_at: retryAt },
    }
    await fs.writeFile(path.join(tempDir, 'projects', project.slug, 'jobs.json'), JSON.stringify({ jobs: [persisted] }))

    await jq.getJobs(project.slug)
    assert.equal(runs, 0)
    const restored = await waitFor(() => jq.getJob(jobId)?.status === 'done' ? jq.getJob(jobId)! : undefined)
    assert.equal(restored.job_id, jobId)
    assert.equal(runs, 1)
  })
})

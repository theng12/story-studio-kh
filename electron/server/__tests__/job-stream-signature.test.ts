import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Job } from '../models/types.js'
import { jobStreamSignature } from '../services/job-stream-signature.js'

function runningJob(): Job {
  return {
    job_id: 'job-1',
    project_slug: 'project',
    type: 'audio',
    episode_id: 'EP0001',
    title: 'Audio',
    status: 'running',
    created_at: new Date(0).toISOString(),
    started_at: new Date(0).toISOString(),
    finished_at: null,
    error: null,
    output_lines: ['Started'],
    progress: 10,
    params: {},
  }
}

describe('jobStreamSignature', () => {
  test('stays stable while a waiting job has no visible changes', () => {
    const job = runningJob()
    assert.equal(jobStreamSignature(job), jobStreamSignature({ ...job, output_lines: [...job.output_lines] }))
  })

  test('changes for logs, progress, transfers, and account attribution', () => {
    const job = runningJob()
    const initial = jobStreamSignature(job)

    job.output_lines.push('Chapter 1 complete')
    assert.notEqual(jobStreamSignature(job), initial)
    const withLog = jobStreamSignature(job)

    job.progress = 35
    assert.notEqual(jobStreamSignature(job), withLog)
    const withProgress = jobStreamSignature(job)

    job.bytes_done = 1024
    assert.notEqual(jobStreamSignature(job), withProgress)
    const withTransfer = jobStreamSignature(job)

    job.accounts_used = { fal: { id: 'default', label: 'Default' } }
    assert.notEqual(jobStreamSignature(job), withTransfer)
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { activityItemForJob } from '../composables/useNotifications.js'
import type { Job } from '../composables/useJobs.js'

test('Notification Center redacts known job identities without mutating durable evidence', () => {
  const job = {
    job_id: 'job_123456789',
    project_slug: 'story',
    type: 'images',
    episode_id: 'episode-1',
    title: 'Episode One',
    status: 'error',
    created_at: '2026-08-30T09:00:00.000Z',
    started_at: '2026-08-30T09:01:00.000Z',
    finished_at: '2026-08-30T09:02:00.000Z',
    error: 'Request provider_1234567890 failed for project 123e4567-e89b-12d3-a456-426614174000',
    output_lines: [],
    params: {},
    genstudio_jobs: [{
      id: 'provider_1234567890',
      operation: 'image.generation',
      state: 'failed',
      updated_at: '2026-08-30T09:02:00.000Z',
    }],
  } as Job

  const item = activityItemForJob(job)

  assert.equal(item.error, 'Request [request hidden] failed for project 123e4567-e89b-12d3-a456-426614174000')
  assert.equal(job.error, 'Request provider_1234567890 failed for project 123e4567-e89b-12d3-a456-426614174000')
  assert.equal(job.genstudio_jobs?.[0]?.id, 'provider_1234567890')
})

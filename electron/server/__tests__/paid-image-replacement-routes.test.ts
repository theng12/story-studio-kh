import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const queue = await import('../services/job-queue.js')
const { router } = await import('../routes/jobs.js')
const app = express()
app.use('/api', router)

const attempt = {
  asset_key: 'thumbnail:1', manifest_dir: '/private/manifest', manifest_key: 'thumb.png', output_path: '/private/output.png',
  state: 'blocked', original_task_id: 'original-task-id', original_idempotency_key: 'original-idempotency-key',
  input_hash: 'a'.repeat(64), output_selector: { resolution: '1K', aspect_ratio: '16:9', width: 1280, height: 720, reference_mode: 'normal' },
  reference_inputs: [], reference_identity_hash: 'b'.repeat(64), failure_code: 'SITE_PLACEMENT_EXHAUSTED',
  reserved_credits: 8, settled_credits: 3, released_credits: 5, terminal_observed_at: '2026-08-31T00:00:00.000Z',
  eligible_at: '2026-08-31T00:30:00.000Z', quoted_credits: 6, price_version: 'image-price-v2',
  replacement_scope: 'private-replacement-scope', replacement_committed_at: '2026-08-31T00:31:00.000Z',
  replacement_task_id: 'replacement-task-id', actual_settled_credits: 4,
  public_reason: 'original_failure_not_eligible' as const,
  reason: 'INTERNAL_PROVIDER_CODE original-task-id original-idempotency-key /private/manifest /private/output.png private-replacement-scope ' + 'a'.repeat(64) + 'b'.repeat(64),
}

async function prepare(
  slug: string,
  jobId: string,
  durableAttempt: Omit<typeof attempt, 'reason' | 'public_reason'> & {
    reason?: string
    public_reason?: typeof attempt.public_reason
  } = attempt,
): Promise<void> {
  const projectDir = path.join(temp.dir, 'projects', slug)
  await mkdir(projectDir, { recursive: true })
  await writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [{
    job_id: jobId, project_slug: slug, type: 'thumb_images', episode_id: 'EP0001', title: 'Route projection',
    status: 'error', created_at: '2026-08-31T00:00:00.000Z', started_at: '2026-08-31T00:00:00.000Z',
    finished_at: '2026-08-31T00:32:00.000Z', error: 'Image replacement did not succeed.', output_lines: [], params: {},
    paid_image_replacement_attempts: [durableAttempt],
  }] }))
  await queue.getJobs(slug)
}

test('single-job HTTP routes and SSE redact raw paid replacement reasons', async () => {
  const projectSlug = 'paid-image-route-projection'
  await prepare(projectSlug, 'project-route-job')
  await prepare('_app_', 'app-route-job')
  const { reason: _rawReason, public_reason: _publicReason, ...waitingAttempt } = attempt
  await prepare('paid-image-sse-projection', 'sse-route-job', { ...waitingAttempt, state: 'waiting' })

  for (const pathName of [
    `/api/projects/${projectSlug}/jobs/project-route-job`,
    '/api/jobs/app/app-route-job',
  ]) {
    const res = await request(app).get(pathName)
    assert.equal(res.status, 200, pathName)
    assert.deepEqual(res.body.paid_image_replacement_attempt, {
      state: 'blocked', eligible_at: '2026-08-31T00:30:00.000Z', replacement_committed_at: '2026-08-31T00:31:00.000Z',
      quoted_credits: 6, price_version: 'image-price-v2', reason: 'original_failure_not_eligible', actual_settled_credits: 4,
    }, pathName)
    assert.equal('paid_image_replacement_attempts' in res.body, false, pathName)
    const payload = JSON.stringify(res.body)
    for (const secret of ['original-task-id', 'original-idempotency-key', 'replacement-task-id', 'private-replacement-scope', '/private/manifest', '/private/output.png', 'a'.repeat(64), 'b'.repeat(64)]) {
      assert.equal(payload.includes(secret), false, `${pathName}: ${secret} must not reach HTTP`)
    }
  }

  const sseJob = queue.getJob('sse-route-job')!
  const update = new Promise<unknown>(resolve => queue.jobEvents.once('update', resolve))
  await queue.checkpointPaidImageReplacementBlockedIfPresent(sseJob, 'thumbnail:1', attempt.reason)
  const emitted = await update
  const ssePayload = JSON.stringify(emitted)
  assert.match(ssePayload, /automatic_replacement_unavailable/)
  for (const secret of ['original-task-id', 'original-idempotency-key', 'replacement-task-id', 'private-replacement-scope', '/private/manifest', '/private/output.png', 'INTERNAL_PROVIDER_CODE', 'a'.repeat(64), 'b'.repeat(64)]) {
    assert.equal(ssePayload.includes(secret), false, `${secret} must not reach SSE`)
  }
})

test('a blocked ineligible image without a paid attempt still exposes a typed no-submission reason', async () => {
  const slug = 'paid-image-no-attempt'
  const projectDir = path.join(temp.dir, 'projects', slug)
  await mkdir(projectDir, { recursive: true })
  const job: any = {
    job_id: 'no-attempt-job', project_slug: slug, type: 'continuity_render', episode_id: 'EP0081',
    title: 'Missing scene images', status: 'error', created_at: '2026-08-31T00:00:00.000Z',
    started_at: '2026-08-31T00:00:00.000Z', finished_at: '2026-08-31T00:01:00.000Z',
    error: queue.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE, output_lines: [], params: {},
  }
  queue.recordPaidImageReplacementPublicReason(job, 'original_failure_not_eligible')
  await writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [job] }))
  await queue.getJobs(slug)

  const res = await request(app).get(`/api/projects/${slug}/jobs/no-attempt-job`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.result.image_replacement, {
    state: 'blocked', reason: 'original_failure_not_eligible', submitted: false,
  })
  assert.equal('paid_image_replacement_attempt' in res.body, false)
  assert.equal('paid_image_replacement_attempts' in res.body, false)
})

after(async () => { await temp.cleanup() })

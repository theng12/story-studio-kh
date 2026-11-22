/**
 * S26, the half that stayed open after 1.4.417.
 *
 * Approval refuses a blank description at the door, but a job row saved before that check (or
 * replayed from one) still carries the blank inside `approved_final_payload`, and the dispatcher
 * reads the FROZEN payload, not the live metadata. Retry copies the row's own params, so pressing
 * Retry on such a row queues a second run that can only die the same way — the one remaining path
 * that still produces the symptom Production measured on 1.4.417 (angkor, 2026-11-22: PR0047
 * `58d7c3b4` and PR0048 `71ce594c`, each created and failed 4 s later with "has a blank description
 * in the approved upload details", both carrying `approved_upload_mode: "apply-plan"` in their own
 * params).
 *
 * These rows are written to `jobs.json` directly because a fresh admission can no longer produce
 * them (the route-level refusal is pinned in youtube-upload-center-route.test.ts); what this file
 * pins is the remaining path that could replay one.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import type { Job, JobType } from '../models/types.js'

function terminalUpload(slug: string, id: string, description: string, episode = 'PR0047'): Job {
  const now = new Date().toISOString()
  return {
    job_id: id,
    project_slug: slug,
    type: 'youtube_upload' as JobType,
    episode_id: episode,
    title: `YouTube upload — ${episode}`,
    status: 'error',
    created_at: now,
    started_at: now,
    finished_at: now,
    error: `${episode} has a blank description in the approved upload details. Review and confirm the exact video and YouTube details again; nothing was uploaded.`,
    output_lines: [],
    params: {
      episode_id: episode,
      approved_upload_mode: 'apply-plan',
      expected_package_revision: 'approved-package-revision',
      expected_source_revision: `sha256:${'b'.repeat(64)}`,
      approved_final_payload: {
        snippet_json: JSON.stringify({ title: `Night Atlas — ${episode}`, description, tags: ['history'] }),
        status_json: JSON.stringify({ privacyStatus: 'private', containsSyntheticMedia: true }),
        source_sha256: 'a'.repeat(64),
      },
    },
  } as Job
}

async function projectWithRows(name: string, rows: Job[]): Promise<{
  app: import('express').Express, jq: typeof import('../services/job-queue.js'), slug: string, temp: Awaited<ReturnType<typeof useTempDataDir>>
}> {
  const temp = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const app = (await import('../app.js')).app
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name })
  const dir = path.join(temp.dir, 'projects', project.slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'jobs.json'), JSON.stringify({ jobs: rows.map(row => ({ ...row, project_slug: project.slug })) }))
  await jq.getJobs(project.slug) // load the rows the routes will read
  return { app, jq, slug: project.slug, temp }
}

void test('Retry of an upload whose frozen description was blank is refused, and queues nothing', async () => {
  const { app, jq, slug, temp } = await projectWithRows('S26 blank retry', [terminalUpload('', 'blank-upload', '')])
  const restoreExecutor = jq._setExecutorForTesting('youtube_upload', async () => {})
  try {
    // The row's own route, the one the Jobs page calls.
    const refused = await request(app).post(`/api/projects/${slug}/jobs/blank-upload/retry`)
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.match(String(refused.body.detail), /PR0047 has a blank description in the approved upload details/)
    assert.match(String(refused.body.detail), /Review and confirm the exact video and YouTube details again/)
    assert.equal(
      (await jq.getJobs(slug)).filter(job => job.previous_job_id === 'blank-upload').length,
      0,
      'a refused retry never becomes a second doomed upload',
    )

    // The universal route shares the same admission rule.
    const universal = await request(app).post('/api/jobs/all/blank-upload/retry')
    assert.equal(universal.status, 409, JSON.stringify(universal.body))
    assert.match(String(universal.body.detail), /blank description/)
  } finally {
    restoreExecutor()
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

void test('Retry of an upload with a description, or a legacy row without a frozen payload, is still allowed', async () => {
  const legacy = terminalUpload('', 'legacy-upload', '', 'PR0048')
  delete (legacy.params as any).approved_final_payload
  delete (legacy.params as any).expected_package_revision
  const { app, jq, slug, temp } = await projectWithRows('S26 retry control', [
    terminalUpload('', 'good-upload', 'A real description of the episode.'),
    legacy,
  ])
  const restoreExecutor = jq._setExecutorForTesting('youtube_upload', async () => {})
  try {
    for (const id of ['good-upload', 'legacy-upload']) {
      const retried = await request(app).post(`/api/projects/${slug}/jobs/${id}/retry`)
      assert.equal(retried.status, 202, JSON.stringify(retried.body))
      assert.equal(retried.body.job?.previous_job_id, id)
      jq.removeTerminalJob(slug, retried.body.job.job_id)
    }
  } finally {
    restoreExecutor()
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

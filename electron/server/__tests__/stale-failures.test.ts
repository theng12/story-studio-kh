import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

// Dreamlands 2026-10-03 (LOG 07:39–08:35): "Repair all (3)" on three failed
// thumbnail jobs ADDED three failed "Image repair" rows (3 → 6 needing
// attention), and once every thumbnail existed the dashboard still asked for
// "Repair 6 failed jobs".
test('failed rows whose files were made later settle, and Repair of a job adds no second row', async t => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const { settleCompletedFailures } = await import('../services/stale-failures.js')
  const app = (await import('../app.js')).app
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot' })
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  const failed = async (slug: string, type: 'thumb_images' | 'images_repair' | 'audio' | 'audio_merge' | 'video_assembly', episode = 'EP001',
    status: 'error' | 'done' = 'error', finishedAt = new Date().toISOString()) => {
    const job = jq.enqueuePreparedForTest({ project_slug: slug, type, episode_id: episode, title: type, params: { episode_id: episode, mode: 'thumbs' } })
    await jq.mutateAuthoritativeJob(slug, job.job_id, current => ({
      ...current, status, finished_at: finishedAt, error: status === 'error' ? 'Thumbnail generation incomplete: 1/3' : null,
    }))
    return job.job_id
  }
  try {
    await t.test('settled rows leave "needs attention" but stay in history', async () => {
      const project = await pm.createProject({ name: 'Stale failures settle' })
      const thumb = await failed(project.slug, 'thumb_images')
      const repair = await failed(project.slug, 'images_repair')
      const audio = await failed(project.slug, 'audio')
      assert.equal(jq.getQueueStats(project.slug).error, 3)

      const settled = await settleCompletedFailures(project.slug, undefined, async job => job.type !== 'audio')
      assert.deepEqual(settled.sort(), [thumb, repair].sort())

      assert.equal(jq.getQueueStats(project.slug).error, 1, 'the dashboard counts only the audio job that is really missing files')
      const listed = await request(app).get(`/api/projects/${project.slug}/jobs`)
      assert.equal(listed.body.stats.error, 1)
      const row = listed.body.jobs.find((job: any) => job.job_id === thumb)
      assert.equal(row.status, 'error', 'history is kept, not rewritten')
      assert.match(row.resolved.reason, /now saved/)
      assert.match(row.output_lines.at(-1), /no longer needs attention/)

      assert.deepEqual(await settleCompletedFailures(project.slug, undefined, async () => true), [audio], 'already-settled rows are not settled twice')
      assert.equal(await jq.clearFinished(project.slug, 'failed'), 0, 'settled rows are not "failed" any more')
    })

    await t.test('a failed Audio/Video Assembly row settles once a later build of the same episode finished', async () => {
      const project = await pm.createProject({ name: 'Assembly failures settle' })
      const merge = await failed(project.slug, 'audio_merge', 'EP001', 'error', '2026-10-03T08:00:00.000Z')
      const video = await failed(project.slug, 'video_assembly', 'EP001', 'error', '2026-10-03T08:00:00.000Z')
      await failed(project.slug, 'video_assembly', 'EP001', 'done', '2026-10-03T07:00:00.000Z') // finished BEFORE the failure
      await failed(project.slug, 'audio_merge', 'EP002', 'done', '2026-10-03T09:00:00.000Z') // another episode
      assert.deepEqual(await settleCompletedFailures(project.slug), [], 'an older build or another episode proves nothing')
      await failed(project.slug, 'audio_merge', 'EP001', 'done', '2026-10-03T09:00:00.000Z')
      assert.deepEqual(await settleCompletedFailures(project.slug), [merge])
      assert.ok(!(await jq.getJobs(project.slug)).find(job => job.job_id === video)!.resolved, 'video still needs attention')
    })

    await t.test('Repair on a failed thumbnail job runs on that job — no new "Image repair" row', async () => {
      const project = await pm.createProject({ name: 'Inline thumbnail repair' })
      const thumb = await failed(project.slug, 'thumb_images')
      const before = (await jq.getJobs(project.slug)).length
      const response = await request(app)
        .post(`/api/projects/${project.slug}/generate/images-repair`)
        .send({ episode_id: 'EP001', pool: 'thumbnails', source_job_id: thumb })
      assert.equal(response.status, 409, JSON.stringify(response.body)) // no thumbnail prompts here, so nothing to repair — and nothing queued
      assert.equal((await jq.getJobs(project.slug)).length, before, 'no second row for the same missing files')
      assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'images_repair').length, 0)

      const stale = await request(app)
        .post(`/api/projects/${project.slug}/generate/images-repair`)
        .send({ episode_id: 'EP002', source_job_id: thumb })
      assert.equal(stale.status, 404, 'a repair is never applied to another episode\'s job')
    })
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

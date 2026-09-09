import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

async function bootApp(): Promise<typeof import('../app.js').app> {
  const app = (await import('../app.js')).app
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot before queue fixture setup' })
  return app
}

test('Jobs Finish missing images keeps one durable continuity row', async t => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const app = await bootApp()
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    await t.test('requeues a terminal row, retains evidence, and replays the same row', async () => {
      const project = await pm.createProject({ name: 'Jobs direct missing images' })
      const original = jq.enqueuePreparedForTest({
        project_slug: project.slug,
        type: 'continuity_render',
        episode_id: 'EP001',
        title: 'Original scene render',
        params: {
          episode_id: 'EP001', model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K',
          scene_ids: ['scene-001'], missing_only: false, force: true,
          generation_action: { id: 'old-action', kind: 'fresh' },
          manual_image_finish: { action_id: 'old-manual-action', replace_uncertain: true, uncertain_scene_ids: ['scene-001'] },
        },
      })
      const providerEvidence = [{
        id: 'provider-accepted', operation: 'image.generation' as const, state: 'accepted',
        updated_at: new Date().toISOString(),
      }]
      const preservedResult = { complete: false, completed_scene_ids: ['scene-complete'] }
      await jq.mutateAuthoritativeJob(project.slug, original.job_id, job => ({
        ...job, status: 'error', finished_at: new Date().toISOString(), error: 'render interrupted',
        output_lines: ['render interrupted'], result: preservedResult,
        force_abandoned: { at: new Date().toISOString(), unsettled: ['provider-accepted'] }, genstudio_jobs: providerEvidence,
      }))

      const response = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${original.job_id}/finish-missing-images`)
        .send({})
      assert.equal(response.status, 202, JSON.stringify(response.body))
      assert.equal(response.body.ok, true)
      assert.equal(response.body.job.job_id, original.job_id)
      assert.equal(response.body.job.status, 'queued')
      assert.equal(response.body.job.params.model, 'mock-image-v1')
      assert.deepEqual(response.body.job.params.scene_ids, ['scene-001'])
      assert.equal(response.body.job.params.missing_only, true)
      assert.equal(response.body.job.params.force, undefined, 'a Finish action can never overwrite a complete image')
      assert.equal(response.body.job.params.generation_action, undefined, 'the old fresh action cannot be reused')
      assert.equal(response.body.job.params.manual_image_finish.replace_uncertain, false)
      assert.notEqual(response.body.job.params.manual_image_finish.action_id, 'old-manual-action')
      assert.equal(response.body.job.params.manual_image_finish.uncertain_scene_ids, undefined)
      assert.notEqual(response.body.job.params.jobs_finish_missing_images, undefined)
      assert.equal(response.body.job.force_abandoned, undefined, 'an explicit resume must restore provider reconciliation tracking')

      const persisted = await jq.loadAuthoritativeJob(project.slug, original.job_id)
      assert.equal(persisted?.status, 'queued', 'the same row is durable before the queue can execute it')
      assert.deepEqual(persisted?.genstudio_jobs, providerEvidence, 'provider evidence remains attached to the same row')
      assert.deepEqual(persisted?.output_lines.slice(0, 1), ['render interrupted'], 'the prior job audit stays on the same row')
      assert.equal(persisted?.result, undefined, 'stale transient completion state is cleared before the new run')
      assert.equal(persisted?.force_abandoned, undefined, 'the durable row resumes provider reconciliation tracking')

      const replay = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${original.job_id}/finish-missing-images`)
        .send({})
      assert.equal(replay.status, 202, JSON.stringify(replay.body))
      assert.equal(replay.body.reused, true)
      assert.equal(replay.body.job.job_id, original.job_id)
      assert.equal((await jq.getJobs(project.slug)).filter(job => job.job_id === original.job_id).length, 1)
      await jq.forceAbandonJob(project.slug, original.job_id)
    })

    await t.test('rejects wrong project, type, cancellation-owned work, and active duplicates', async () => {
      const project = await pm.createProject({ name: 'Jobs finish scope checks' })
      const continuity = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: 'EP001', title: 'Continuity', params: {
          episode_id: 'EP001', model: 'mock-image-v1',
        },
      })
      await jq.mutateAuthoritativeJob(project.slug, continuity.job_id, job => ({
        ...job, status: 'error', finished_at: new Date().toISOString(), error: 'failed',
      }))
      const wrongProject = await request(app)
        .post(`/api/projects/other-project/jobs/${continuity.job_id}/finish-missing-images`)
        .send({})
      assert.equal(wrongProject.status, 404)

      const audio = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'audio', episode_id: 'EP001', title: 'Audio', params: { model: 'x' },
      })
      await jq.mutateAuthoritativeJob(project.slug, audio.job_id, job => ({
        ...job, status: 'error', finished_at: new Date().toISOString(), error: 'failed',
      }))
      const wrongType = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${audio.job_id}/finish-missing-images`)
        .send({})
      assert.equal(wrongType.status, 409)

      const active = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'continuity_render', episode_id: 'EP002', title: 'Active render', params: { model: 'mock-image-v1' },
      })
      await jq.mutateAuthoritativeJob(project.slug, active.job_id, job => ({ ...job, episode_id: 'EP001' }))
      const duplicate = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${continuity.job_id}/finish-missing-images`)
        .send({})
      assert.equal(duplicate.status, 409, 'a different active bulk render keeps this episode from gaining a second owner')
      await jq.forceAbandonJob(project.slug, active.job_id)

      await jq.mutateAuthoritativeJob(project.slug, continuity.job_id, job => ({
        ...job,
        status: 'error',
        remote_cancellations: {
          'image.generation:provider-accepted': {
            status: 'unknown', operation: 'image.generation', provider_job_id: 'provider-accepted',
            requested_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          },
        },
      }))
      const cancellationOwned = await request(app)
        .post(`/api/projects/${project.slug}/jobs/${continuity.job_id}/finish-missing-images`)
        .send({})
      assert.equal(cancellationOwned.status, 409)
      assert.match(cancellationOwned.body.detail, /cancellation|reconcile/i)
    })

    await t.test('admits one same-episode owner when two failed rows race', async () => {
      const project = await pm.createProject({ name: 'Jobs finish admission race' })
      const createTerminal = async (title: string) => {
        const job = jq.enqueuePreparedForTest({
          project_slug: project.slug, type: 'continuity_render', episode_id: 'EP001', title, params: { model: 'mock-image-v1' },
        })
        await jq.mutateAuthoritativeJob(project.slug, job.job_id, current => ({
          ...current, status: 'error', finished_at: new Date().toISOString(), error: 'failed',
        }))
        return job
      }
      const first = await createTerminal('First failed render')
      const second = await createTerminal('Second failed render')
      const [firstResponse, secondResponse] = await Promise.all([
        request(app).post(`/api/projects/${project.slug}/jobs/${first.job_id}/finish-missing-images`).send({}),
        request(app).post(`/api/projects/${project.slug}/jobs/${second.job_id}/finish-missing-images`).send({}),
      ])
      assert.deepEqual([firstResponse.status, secondResponse.status].sort(), [202, 409])
      const queued = [firstResponse, secondResponse].find(response => response.status === 202)!
      assert.equal(queued.body.job.status, 'queued')
      assert.equal((await jq.getJobs(project.slug)).filter(job => job.status === 'queued').length, 1)
      const winnerId = queued.body.job.job_id as string
      assert.equal((await jq.getJobs(project.slug)).filter(job => job.job_id === winnerId).length, 1)
      await jq.forceAbandonJob(project.slug, winnerId)
    })
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

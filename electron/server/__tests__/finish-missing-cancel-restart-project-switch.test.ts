/**
 * A manual Finish action is project-scoped, durable through a queue restart,
 * and never turns a cancelled click into a second image request.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

async function createRenderableEpisode(projectName: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: projectName, episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: `${projectName} idea`, logline: 'Manual Finish recovery fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await Promise.all([paths.scene_prompts_dir, paths.audio_dir, paths.subtitles_dir, paths.merged_audio_dir, paths.script_dir]
    .map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, '## Chapter 01: Fixture\n\nManual Finish narration.\n')
  await fs.writeFile(path.join(paths.audio_dir, `${episodeId}_Chapter_01.mp3`), 'fixture-audio')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    gap_duration_s: 1, sections: [{ slug: 'Chapter_01', duration_s: 1 }],
  }))
  await fs.writeFile(path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`),
    '1\n00:00:00,000 --> 00:00:01,000\nFixture narration.\n')
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nFixture narration.\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    scenes: [{
      id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 1,
      transcript_segment: 'Fixture narration.', visual_prompt: 'A lantern in a quiet archive.', approved: false,
    }],
  }))
  return { project, episodeId }
}

async function preSubmitCancelAndProjectSwitchCase(): Promise<void> {
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    await jq.setQueuePaused(true)
    const a = await createRenderableEpisode('Finish A')
    const b = await createRenderableEpisode('Finish B')
    const actionId = '90909090-9090-4090-8090-909090909090'
    const finishBody = { action_id: actionId, model: 'mock-image-v1', aspect_ratio: '16:9' }

    const queued = await request(app)
      .post(`/api/projects/${a.project.slug}/scene-review/${a.episodeId}/finish-missing`)
      .send(finishBody)
    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    assert.equal(queued.body.queued, 1)
    const jobId = queued.body.job_id as string
    assert.ok(jobId)
    assert.equal(service.providerSubmissionCount('image'), 0, 'the held queue has made no provider request')

    const sceneAQueued = await request(app).get(`/api/projects/${a.project.slug}/scene-review/${a.episodeId}`)
    assert.equal(sceneAQueued.status, 200)
    assert.equal(sceneAQueued.body.active_render_job?.job_id, jobId, 'Scene Review shows its own queued Finish action')
    const jobsAQueued = await request(app).get(`/api/projects/${a.project.slug}/jobs`)
    assert.equal(jobsAQueued.body.jobs.filter((job: any) => job.job_id === jobId).length, 1, 'Jobs shows one durable owner')

    const sceneB = await request(app).get(`/api/projects/${b.project.slug}/scene-review/${b.episodeId}`)
    assert.equal(sceneB.status, 200)
    assert.equal(sceneB.body.active_render_job, null, 'switching projects never renders A activity in B')
    const jobsB = await request(app).get(`/api/projects/${b.project.slug}/jobs`)
    assert.equal(jobsB.body.jobs.some((job: any) => job.params?.manual_image_finish?.action_id === actionId), false)

    const cancelled = await request(app).post(`/api/projects/${a.project.slug}/jobs/${jobId}/cancel`).send({})
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.job.status, 'cancelled')
    assert.equal(service.providerSubmissionCount('image'), 0, 'cancelling before submit cannot charge an image request')
    const sceneACancelled = await request(app).get(`/api/projects/${a.project.slug}/scene-review/${a.episodeId}`)
    assert.equal(sceneACancelled.body.active_render_job, null, 'Scene Review clears a cancelled action from live activity')

    await jq._waitForJobPersistenceForTesting()
    jq._forgetProjectPersistenceForTesting(a.project.slug)
    const restartedQueue = await import(`${pathToFileURL(path.resolve('server/services/job-queue.ts')).href}?finish-cancel-restart`)
    const durableAfterRestart = await restartedQueue.getJobs(a.project.slug)
    assert.equal(durableAfterRestart.find((job: import('../models/types.js').Job) => job.job_id === jobId)?.status, 'cancelled',
      'the restarted queue reads the cancelled Finish owner rather than treating it as missing work')
    await restartedQueue._waitForJobPersistenceForTesting()

    const replay = await request(app)
      .post(`/api/projects/${a.project.slug}/scene-review/${a.episodeId}/finish-missing`)
      .send(finishBody)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.reused, true)
    assert.equal(replay.body.job_id, jobId)
    assert.equal(service.providerSubmissionCount('image'), 0, 'same cancelled action is durable evidence, never a fresh provider POST')
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?.setQueuePaused(false).catch(() => {})
    await jq?._waitForJobPersistenceForTesting()
    await service.close()
  }
}

async function remoteAcceptedCancelAndRestartCase(): Promise<void> {
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  try {
    const app = (await import('../app.js')).app
    const jq = await import('../services/job-queue.js')
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    await jq.setQueuePaused(true)
    const { project, episodeId } = await createRenderableEpisode('Finish remote ownership')
    const oldAction = '91919191-9191-4191-8191-919191919191'
    const newAction = '92929292-9292-4292-8292-929292929292'
    const finish = (action_id: string) => ({ action_id, model: 'mock-image-v1', aspect_ratio: '16:9' })

    // The mock advances on each read. Leave one accepted state for the
    // cancellation reconciler's preflight read before its control POST.
    service.queueScenario('image', { states: ['accepted', 'accepted', 'succeeded'] })
    const acceptedResponse = await fetch(`${service.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`, 'Idempotency-Key': 'story-finish-remote-owner' },
      body: JSON.stringify({ model_id: 'mock-image-v1', prompt: 'A lantern in a quiet archive.', aspect_ratio: '16:9' }),
    })
    assert.equal(acceptedResponse.status, 202)
    const accepted = await acceptedResponse.json() as { id: string; state: string }
    assert.equal(accepted.state, 'accepted')

    const queued = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/finish-missing`)
      .send(finish(oldAction))
    assert.equal(queued.status, 200, JSON.stringify(queued.body))
    const oldJobId = queued.body.job_id as string
    await jq.mutateAuthoritativeJob(project.slug, oldJobId, job => ({
      ...job, status: 'running', started_at: new Date().toISOString(), local_execution_complete: true,
      genstudio_jobs: [{
        id: accepted.id, operation: 'image.generation', state: 'accepted', dispatch_state: 'pre_dispatch', cancellable: true,
        updated_at: new Date().toISOString(), request: {
          method: 'POST', path: '/v1/images/generations', captured_at: new Date().toISOString(),
          idempotency_key: 'story-finish-remote-owner',
        },
      }],
    }))

    const cancel = await request(app).post(`/api/projects/${project.slug}/jobs/${oldJobId}/cancel`).send({})
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body))
    try {
      await waitFor(() => jq.getJob(oldJobId)?.status === 'cancelled', {
        label: 'remote Finish cancellation to become authoritative', timeoutMs: 10_000,
      })
    } catch (error) {
      const live = jq.getJob(oldJobId)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; final job evidence=${JSON.stringify({
        status: live?.status, local_execution_complete: live?.local_execution_complete,
        remote_cancellations: live?.remote_cancellations, genstudio_jobs: live?.genstudio_jobs, output_lines: live?.output_lines.slice(-6),
      })}`)
    }
    assert.equal(service.providerSubmissionCount('image'), 1, 'the accepted provider task remains the only old action request')
    const cancelledProvider = await fetch(`${service.baseUrl}/v1/images/${accepted.id}`, {
      headers: { Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}` },
    })
    const cancelledBody = await cancelledProvider.json() as { cancelled?: boolean; image_url?: string | null }
    assert.equal(cancelledBody.cancelled, true)
    assert.equal(cancelledBody.image_url, null, 'the cancelled old task has no result that can overwrite a later action')

    await jq._waitForJobPersistenceForTesting()
    jq._forgetProjectPersistenceForTesting(project.slug)
    const restartedQueue = await import(`${pathToFileURL(path.resolve('server/services/job-queue.ts')).href}?finish-remote-cancel-restart`)
    assert.equal((await restartedQueue.getJobs(project.slug)).find((job: import('../models/types.js').Job) => job.job_id === oldJobId)?.status, 'cancelled')
    await restartedQueue._waitForJobPersistenceForTesting()
    const oldReplay = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/finish-missing`)
      .send(finish(oldAction))
    assert.equal(oldReplay.status, 200, JSON.stringify(oldReplay.body))
    assert.equal(oldReplay.body.reused, true)
    assert.equal(oldReplay.body.job_id, oldJobId)
    assert.equal(service.providerSubmissionCount('image'), 1, 'same action reconnects to cancellation evidence without a second charge')

    const successor = await request(app)
      .post(`/api/projects/${project.slug}/scene-review/${episodeId}/finish-missing`)
      .send(finish(newAction))
    assert.equal(successor.status, 200, JSON.stringify(successor.body))
    assert.notEqual(successor.body.job_id, oldJobId)
    const successorJob = jq.getJob(successor.body.job_id)
    assert.equal(successorJob?.params.manual_image_finish?.action_id, newAction)
    assert.equal(service.providerSubmissionCount('image'), 1, 'the held successor is distinct work but has not submitted yet')
    await jq.requestJobCancellation(project.slug, successor.body.job_id)
    // The held test job was promoted to `running` to represent a recovered
    // accepted request, so remove its stale in-memory pending entry before
    // releasing the global queue for the next test file.
    await jq.forceAbandonJob(project.slug, oldJobId)
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?.setQueuePaused(false).catch(() => {})
    await jq?._waitForJobPersistenceForTesting()
    await service.close()
  }
}

void test('Finish cancellation stays project- and action-scoped across pre-submit and accepted provider ownership', async t => {
  const isolated = await useTempDataDir()
  try {
    await t.test('queued Finish cancels before submission and stays isolated on project switch', preSubmitCancelAndProjectSwitchCase)
    await t.test('accepted Finish cancels remotely, persists through restart, and cannot supersede a later action', remoteAcceptedCancelAndRestartCase)
  } finally {
    const jq = await import('../services/job-queue.js').catch(() => null)
    await jq?._waitForJobPersistenceForTesting()
    await isolated.cleanup()
  }
})

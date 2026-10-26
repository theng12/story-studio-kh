/**
 * Pipeline preflight and the app-wide default models (owner, 2026-10-27).
 *
 * AGENTS §5 says a preset that names no writing model counts as NO usable preset, and the run leaves
 * that step out with a plain message. The owner approved a "Default models" setting on top of that
 * rule, so the precedence for a Pipeline run is now:
 *
 *   the preset's model → the app-wide default (if set) → refuse with the plain message
 *
 * The default is a POLICY ADDITION, not a relaxation: a run still never invents a model. What these
 * tests pin:
 *
 *  - a model-less preset with NO default set is left out exactly as before (the old rule is intact);
 *  - a model-less preset WITH a default set runs, and the job's own params carry that model;
 *  - a preset that names its own model ignores the default entirely;
 *  - the default is only READ — it never reaches the preset stored on disk;
 *  - the image family applies to the thumbnail-render step, not the writing family.
 */
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { after, before, describe, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let settings: typeof import('../services/app-settings.js')
let resolveEpisodePaths: typeof import('../services/utils.js').resolveEpisodePaths
const fixtureJobs: Array<{ slug: string; jobId: string }> = []

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  jq = await import('../services/job-queue.js')
  settings = await import('../services/app-settings.js')
  await jq.setQueuePaused(true)
  ;({ resolveEpisodePaths } = await import('../services/utils.js'))
})

after(async () => {
  for (const { slug, jobId } of fixtureJobs) {
    const job = jq.getJob(jobId)
    if (job && (job.status === 'queued' || job.status === 'paused')) {
      await jq.requestJobCancellation(slug, jobId)
    }
    jq.removeTerminalJob(slug, jobId)
  }
  await jq._waitForJobPersistenceForTesting()
  await jq.drainJobPersistenceForShutdown(1_000)
  await jq.setQueuePaused(false)
  await jq.drainJobPersistenceForShutdown(1_000)
  await cleanup()
})

function rememberJobs(slug: string, jobs: Array<{ job_id: string }>): void {
  for (const job of jobs) fixtureJobs.push({ slug, jobId: job.job_id })
}

async function addEpisode(slug: string, title: string): Promise<{ code: string; dir: string }> {
  const [idea] = await im.addIdeas(slug, [{
    title, logline: '', themes: [], suggested_chapters: 3, suggested_length: '2 min', mood: 'calm',
  }], 'test-model')
  await im.acceptIdea(slug, idea!.id)
  const accepted = await im.getIdeas(slug, 'accepted')
  const row = accepted.find(item => item.title === title)!
  const paths = await resolveEpisodePaths(slug, row.episode_code!, title)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  return { code: row.episode_code!, dir: paths.episode_dir }
}

/**
 * Everything a Scene Plan run needs EXCEPT the Scene Plan itself.
 *
 * `scene_plan: true` would make run-batch skip the step as already done, and the test would then
 * assert about a job that was never meant to exist. The prerequisites above it ARE done, or
 * preflight refuses on a missing prerequisite instead of reaching the model question.
 */
async function setReadyForScenePlan(slug: string, code: string): Promise<void> {
  await im.setEpisodeStatusOverrides(slug, code, { script: true, merged_audio: true, subtitles: true })
}

describe('Pipeline preflight and the app-wide default models', () => {
  test('a model-less Scene Plan preset is still left out when NO default is set', async () => {
    await settings.setDefaultModels({})
    const project = await pm.createProject({ name: 'Default models absent' })
    await pm.updateConfig(project.slug, {
      metadata_presets: [{ id: 'metadata', name: 'Metadata', data: { model: 'saved-chat-model' } }],
      metadata_last_preset: 'metadata',
      scene_plan_presets: [{ id: 'plan', name: 'Plan', type: 'scene-plan', data: { pacing: {} } }],
      'scene_plan_last_preset_scene-plan': 'plan',
    } as any)
    const episode = await addEpisode(project.slug, 'No default row')
    await setReadyForScenePlan(project.slug, episode.code)
    await im.setEpisodeStatusOverrides(project.slug, episode.code, {
      script: true, merged_audio: true, subtitles: true, audio_merge: true,
    })

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episode.code], steps: ['metadata', 'scene_plan'] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    assert.match(response.body.warnings.join('\n'),
      /Scene Plan is left out of this run: Scene Plan has no writing model chosen/)
    assert.equal(response.body.jobs.some((job: any) => job.type === 'scene_plan_run'), false)
  })

  test('the same preset RUNS on the writing default, and the job carries that model', async () => {
    await settings.setDefaultModels({ writing: 'app-default-writing' })
    const project = await pm.createProject({ name: 'Default models writing' })
    await pm.updateConfig(project.slug, {
      scene_plan_presets: [{ id: 'plan', name: 'Plan', type: 'scene-plan', data: { pacing: {} } }],
      'scene_plan_last_preset_scene-plan': 'plan',
    } as any)
    const episode = await addEpisode(project.slug, 'Default writing row')
    await setReadyForScenePlan(project.slug, episode.code)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episode.code], steps: ['scene_plan'] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    assert.doesNotMatch(response.body.warnings.join('\n'), /no writing model chosen/)

    const planned = await jq.getJobs(project.slug)
    const scenePlanJob = planned.find(job => job.type === 'scene_plan_run')
    assert.ok(scenePlanJob, `expected a Scene Plan job, got ${planned.map(job => job.type).join(', ')}`)
    assert.equal(scenePlanJob!.params.model, 'app-default-writing')

    // The default was READ, not written back: the stored preset still names no model.
    const config = await pm.getConfig(project.slug) as Record<string, any>
    const preset = (config.scene_plan_presets as any[]).find(entry => entry.id === 'plan')
    assert.equal(preset.data.model, undefined, 'the preset must not be rewritten with the default')
  })

  test('a preset that names its own model ignores the default', async () => {
    await settings.setDefaultModels({ writing: 'app-default-writing' })
    const project = await pm.createProject({ name: 'Default models overridden' })
    await pm.updateConfig(project.slug, {
      scene_plan_presets: [{ id: 'plan', name: 'Plan', type: 'scene-plan', data: { model: 'preset-own-model', pacing: {} } }],
      'scene_plan_last_preset_scene-plan': 'plan',
    } as any)
    const episode = await addEpisode(project.slug, 'Preset wins row')
    await setReadyForScenePlan(project.slug, episode.code)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episode.code], steps: ['scene_plan'] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)

    const scenePlanJob = (await jq.getJobs(project.slug)).find(job => job.type === 'scene_plan_run')
    assert.ok(scenePlanJob)
    assert.equal(scenePlanJob!.params.model, 'preset-own-model')
  })

  test('the thumbnail-render step takes the IMAGE default, never the writing one', async () => {
    await settings.setDefaultModels({ writing: 'app-default-writing', image: 'app-default-image' })
    const project = await pm.createProject({ name: 'Default models image family' })
    await pm.updateConfig(project.slug, {
      thumbnail_generator_presets: [{ id: 'thumbs', name: 'Thumbs', type: 'thumbnail-generator', data: { form: {} } }],
      thumbnail_generator_last_preset: 'thumbs',
    } as any)
    const episode = await addEpisode(project.slug, 'Thumbnail default row')

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episode.code], steps: ['thumb_images'] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)

    const render = (await jq.getJobs(project.slug)).find(job => job.type === 'thumb_images')
    assert.ok(render, 'the thumbnail render must not be left out when an image default is set')
    assert.equal(render!.params.model, 'app-default-image')
  })
})

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let resolveEpisodePaths: typeof import('../services/utils.js').resolveEpisodePaths
let applicablePipelineStepsForVisualSource: typeof import('../routes/pipeline.js').applicablePipelineStepsForVisualSource
const fixtureJobs: Array<{ slug: string; jobId: string }> = []

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  jq = await import('../services/job-queue.js')
  await jq.setQueuePaused(true)
  ;({ resolveEpisodePaths } = await import('../services/utils.js'))
  ;({ applicablePipelineStepsForVisualSource } = await import('../routes/pipeline.js'))
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

async function setImagePoolSource(code: string, dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'broll-selection.json'), JSON.stringify({
    schema_version: 1,
    episode_code: code,
    source: 'image_pool',
  }))
}

async function setReadyForLateStages(slug: string, code: string): Promise<void> {
  await im.setEpisodeStatusOverrides(slug, code, {
    script: true,
    merged_audio: true,
    subtitles: true,
    // 1.4.288 — a final video needs a finished Scene Plan, not only approved pictures.
    scene_plan: true,
    scene_review: true,
  })
}

function presets() {
  return {
    metadata_presets: [{ id: 'metadata', name: 'Metadata', data: { model: 'saved-chat-model' } }],
    metadata_last_preset: 'metadata',
    scene_plan_presets: [{ id: 'plan', name: 'Plan', type: 'scene-plan', data: { model: 'saved-chat-model' } }],
    'scene_plan_last_preset_scene-plan': 'plan',
    video_bundle_presets: [{ id: 'assembly', name: 'Assembly', data: {} }],
    video_bundle_last_preset: 'assembly',
  }
}

describe('Pipeline episode visual source', () => {
  test('marks Scene Plan work inapplicable for Image Pool while retaining common stages', () => {
    assert.deepEqual(
      applicablePipelineStepsForVisualSource(['metadata', 'character_sheet', 'scene_plan', 'scene_review', 'motion_review'], 'image_pool'),
      { applicable: ['metadata'], inapplicable: ['character_sheet', 'scene_plan', 'scene_review', 'motion_review'] },
    )
  })

  test('B-Roll selection cannot replace an Image Pool episode’s frozen sidecar', async () => {
    const project = await pm.createProject({ name: 'Image Pool B-Roll preservation' })
    const episode = await addEpisode(project.slug, 'Frozen Image Pool selection')
    const sidecarPath = path.join(episode.dir, 'broll-selection.json')
    const frozen = JSON.stringify({
      schema_version: 1,
      episode_code: episode.code,
      source: 'image_pool',
      pool_id: 'image-pool',
      media: 'image',
      selection_mode: 'manual',
      pacing_mode: 'timed',
      segment_seconds: 4,
      broll_volume: 0,
      selection: [{ filename: 'still.png', sha256: 'frozen-hash', target_duration: 4 }],
      target_duration: 4,
      generated_at: '2026-01-01T00:00:00.000Z',
      warnings: [],
    })
    await fs.writeFile(sidecarPath, frozen)
    const { pickBrollForEpisode } = await import('../services/broll-selection.js')

    await assert.rejects(
      () => pickBrollForEpisode(project.slug, episode.code, {}),
      /B-Roll selection is not used for Image Pool/i,
    )
    assert.equal(await fs.readFile(sidecarPath, 'utf8'), frozen)
  })

  test('does not require a Scene Plan preset when every selected episode uses Image Pool', async () => {
    const project = await pm.createProject({ name: 'Pool Pipeline Common Stage' })
    await pm.updateConfig(project.slug, {
      metadata_presets: [{ id: 'metadata', name: 'Metadata', data: { model: 'saved-chat-model' } }],
      metadata_last_preset: 'metadata',
    } as any)
    const episode = await addEpisode(project.slug, 'Pool common stage')
    await setImagePoolSource(episode.code, episode.dir)
    await setReadyForLateStages(project.slug, episode.code)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [episode.code], steps: ['metadata', 'scene_plan'] })

    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    assert.equal(response.body.enqueued, 1)
    assert.equal(response.body.total_jobs_planned, 1)
    assert.deepEqual(response.body.steps_skipped_as_inapplicable, [{ episode_id: episode.code, step: 'scene_plan' }])
    const job = jq.getJob(response.body.jobs[0].job_id)
    assert.equal(job?.type, 'metadata')
    assert.equal(job?.params.visual_source, 'image_pool')
    assert.deepEqual(job?.params.pipeline_chain, [])
  })

  test('mixed source rows keep their own steps and frozen visual settings', async () => {
    const project = await pm.createProject({ name: 'Mixed Pipeline Visual Settings' })
    await pm.updateConfig(project.slug, presets() as any)
    const sceneEpisode = await addEpisode(project.slug, 'Scene row')
    const poolEpisode = await addEpisode(project.slug, 'Pool row')
    await setImagePoolSource(poolEpisode.code, poolEpisode.dir)
    await setReadyForLateStages(project.slug, sceneEpisode.code)
    await setReadyForLateStages(project.slug, poolEpisode.code)

    const periods = [
      { start_sec: 0, end_sec: 20, min_sec: 1, max_sec: 3 },
      { start_sec: 20, end_sec: null, min_sec: 5, max_sec: 10 },
    ]
    await fs.writeFile(path.join(sceneEpisode.dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: { mode: 'variable', periods },
      motion_scope: { mode: 'selected', scene_ids: ['scene-a'] },
      motion_level: 3,
    }))
    const promptsDir = path.join(sceneEpisode.dir, `${sceneEpisode.code} - 03 Scene Prompts`)
    await fs.mkdir(promptsDir, { recursive: true })
    await fs.writeFile(path.join(promptsDir, 'scene_plan.json'), JSON.stringify({ scenes: [
      { id: 'scene-a', start_sec: 0, end_sec: 5 },
      { id: 'scene-b', start_sec: 5, end_sec: 10 },
    ] }))

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({
        episode_ids: [sceneEpisode.code, poolEpisode.code],
        steps: ['metadata', 'scene_plan'],
        force: true,
        operation_id: 'd2aa096e-dfc0-45fa-936a-aa2a425cf01d',
      })

    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    assert.equal(response.body.enqueued, 2)
    assert.equal(response.body.total_jobs_planned, 3)
    assert.deepEqual(response.body.steps_skipped_as_inapplicable, [{ episode_id: poolEpisode.code, step: 'scene_plan' }])

    const sceneJob = jq.getJob(response.body.jobs.find((row: any) => row.episode_id === sceneEpisode.code).job_id)!
    const poolJob = jq.getJob(response.body.jobs.find((row: any) => row.episode_id === poolEpisode.code).job_id)!
    assert.equal(sceneJob.params.visual_source, 'scene_plan')
    assert.equal(sceneJob.params.pacing.mode, 'variable')
    assert.deepEqual(sceneJob.params.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] })
    assert.equal(sceneJob.params.motion_scene_ids, undefined, 'a replan must not freeze IDs from the plan it replaces')
    assert.equal(sceneJob.params.motion_level, 3)
    assert.equal(sceneJob.params.pipeline_chain[0].params.visual_source, 'scene_plan')
    assert.equal(poolJob.params.visual_source, 'image_pool')
    assert.deepEqual(poolJob.params.pipeline_chain, [])

    await fs.writeFile(path.join(sceneEpisode.dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: { min_sec: 20, max_sec: 30 },
      motion_scope: { mode: 'all' },
      motion_level: 4,
    }))
    assert.equal(sceneJob.params.pacing.mode, 'variable', 'queued settings do not follow later episode edits')
    assert.equal(sceneJob.params.motion_scene_ids, undefined)
  })

  test('an unready Image Pool row is blocked without stopping a ready Scene Plan assembly', async () => {
    const project = await pm.createProject({ name: 'Mixed Pipeline Partial Success' })
    await pm.updateConfig(project.slug, presets() as any)
    const ready = await addEpisode(project.slug, 'Ready scene assembly')
    const blocked = await addEpisode(project.slug, 'Blocked pool assembly')
    await setImagePoolSource(blocked.code, blocked.dir)
    await setReadyForLateStages(project.slug, ready.code)
    await setReadyForLateStages(project.slug, blocked.code)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [ready.code, blocked.code], steps: ['video_assembly'] })

    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    assert.equal(response.body.enqueued, 1)
    assert.equal(response.body.jobs[0].episode_id, ready.code)
    assert.deepEqual(response.body.blocked.map((row: any) => row.episode_id), [blocked.code])
    assert.match(response.body.blocked[0].reason, /Image Pool.*selection is missing/i)
  })

  test('a Character Sheet preset never replaces the live episode rhythm, motion or anchor', async () => {
    // The preset below still stores a `pacing` block on disk — the shape every
    // preset saved between 2026-08-18 and 2026-10-17 has. It has no authority
    // now: `pacing` is excluded from continuity_page presets (owner,
    // 2026-10-17) and Scene Plan owns the episode's rhythm. Here the stored
    // band is even a half-written one, which was never applicable anyway.
    const project = await pm.createProject({ name: 'Pipeline Character Sheet Preserve' })
    await pm.updateConfig(project.slug, {
      continuity_page_presets: [{
        id: 'look', name: 'Look only', type: 'continuity-page',
        data: {
          schema_version: 1,
          style_bible: 'A saved watercolor look.',
          pacing: { min_sec: 12 },
          motion_scope: { mode: 'all' },
        },
      }],
      'continuity_page_last_preset_continuity-page': 'look',
    } as any)
    const episode = await addEpisode(project.slug, 'Preserved timing row')
    await fs.writeFile(path.join(episode.dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: {
        mode: 'variable', min_sec: 2, max_sec: 4,
        periods: [
          { start_sec: 0, end_sec: 30, min_sec: 2, max_sec: 4 },
          { start_sec: 30, end_sec: null, min_sec: 6, max_sec: 10 },
        ],
      },
      motion_scope: { mode: 'selected', scene_ids: ['scene-a'] },
      motion_level: 3,
      use_episode_sheet: true,
      references: { prev_render: false, sheet: true, characters: false, style: false, composition: false },
    }))

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({
        episode_ids: [episode.code], steps: ['character_sheet'], force: true,
        operation_id: '8cb22457-eb15-48c3-80b0-51344920b5de',
      })

    assert.equal(response.status, 201, JSON.stringify(response.body))
    const saved = JSON.parse(await fs.readFile(path.join(episode.dir, 'continuity.json'), 'utf8'))
    assert.equal(saved.style_bible, 'A saved watercolor look.')
    assert.equal(saved.pacing.mode, 'variable', 'a half band has no authority to replace the live rhythm')
    assert.deepEqual(saved.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] })
    assert.equal(saved.motion_level, 3)
    assert.equal(saved.use_episode_sheet, true)
    assert.equal(saved.references.sheet, true)
  })

  test('a Character Sheet preset band is NOT applied — downstream jobs snapshot the episode\'s own rhythm', async () => {
    const project = await pm.createProject({ name: 'Pipeline Character Sheet Pacing Snapshot' })
    await pm.updateConfig(project.slug, {
      ...presets(),
      continuity_page_presets: [{
        id: 'timed-look', name: 'Timed look', type: 'continuity-page',
        data: { schema_version: 1, pacing: { min_sec: 8, max_sec: 12 }, motion_scope: { mode: 'all' } },
      }],
      'continuity_page_last_preset_continuity-page': 'timed-look',
    } as any)
    const episode = await addEpisode(project.slug, 'Applied timing row')
    await setReadyForLateStages(project.slug, episode.code)
    await fs.writeFile(path.join(episode.dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: { min_sec: 1, max_sec: 3 },
      motion_scope: { mode: 'selected', scene_ids: ['scene-a'] },
      motion_level: 4,
    }))

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({
        episode_ids: [episode.code], steps: ['character_sheet', 'scene_plan'], force: true,
        operation_id: 'd7592df5-dac5-4711-b21e-91c05e48cf71',
      })

    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    const job = jq.getJob(response.body.jobs[0].job_id)!
    // The preset stores 8–12s; the episode is on 1–3s. The episode wins, and
    // the downstream Scene Plan job snapshots the episode's band, not the
    // preset's — the preset's look applied, its rhythm did not.
    assert.deepEqual(job.params.pacing, { min_sec: 1, max_sec: 3 },
      'a Character Sheet preset has no authority over the episode rhythm')
    assert.deepEqual(job.params.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] })
    const saved = JSON.parse(await fs.readFile(path.join(episode.dir, 'continuity.json'), 'utf8'))
    assert.deepEqual(saved.pacing, { min_sec: 1, max_sec: 3 }, 'the sidecar keeps the episode\'s own band')
    assert.deepEqual(saved.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] })

    await fs.writeFile(path.join(episode.dir, 'continuity.json'), JSON.stringify({
      ...saved,
      pacing: { min_sec: 20, max_sec: 30 },
      motion_scope: { mode: 'off' },
      motion_level: 1,
    }))
    assert.deepEqual(job.params.pacing, { min_sec: 1, max_sec: 3 },
      'accepted work keeps the baseline captured before a later sidecar edit')
    assert.deepEqual(job.params.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] })
    assert.equal(job.params.motion_level, 4)
  })

  test('Scene Plan admission mixes exact preset fields with independent captured chain baselines', async () => {
    const project = await pm.createProject({ name: 'Pipeline Scene Plan mixed snapshot' })
    await pm.updateConfig(project.slug, {
      ...presets(),
      scene_plan_presets: [{
        id: 'plan', name: 'Plan', type: 'scene-plan',
        data: { model: 'saved-chat-model', pacing: { min_sec: 9, max_sec: 13 }, motion_level: 2 },
      }],
      'scene_plan_last_preset_scene-plan': 'plan',
      scene_review_genstudio_presets: [{
        id: 'review', name: 'Review', type: 'scene-review', data: { model: 'saved-chat-model' },
      }],
      'scene_review_genstudio_last_preset_scene-review': 'review',
    } as any)
    const episode = await addEpisode(project.slug, 'Mixed snapshot')
    await setReadyForLateStages(project.slug, episode.code)
    await fs.writeFile(path.join(episode.dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: { min_sec: 1, max_sec: 3 },
      motion_scope: { mode: 'selected', scene_ids: ['scene-a'] },
      motion_level: 4,
    }))

    const body = {
      episode_ids: [episode.code], steps: ['scene_plan', 'scene_review'], force: true,
      operation_id: '77cad852-434d-4fa8-b5c5-bb6920592686',
    }
    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send(body)

    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    const job = jq.getJob(response.body.jobs[0].job_id)!
    const review = job.params.pipeline_chain[0].params
    assert.deepEqual(job.params.pacing, { min_sec: 9, max_sec: 13 }, 'exact preset pacing wins')
    assert.equal(job.params.motion_level, 2, 'exact preset motion level wins')
    assert.deepEqual(job.params.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] },
      'an omitted preset field keeps the captured episode-owned selection')
    assert.deepEqual(review.pacing, { min_sec: 1, max_sec: 3 })
    assert.deepEqual(review.motion_scope, { mode: 'selected', scene_ids: ['scene-a'] })
    assert.equal(review.motion_level, 4)
    assert.notStrictEqual(job.params.motion_scope, review.motion_scope,
      'each accepted chain link owns its captured settings object')
    const acceptedParams = structuredClone(job.params)

    await fs.writeFile(path.join(episode.dir, 'continuity.json'), JSON.stringify({
      schema_version: 1,
      pacing: { min_sec: 30, max_sec: 40 },
      motion_scope: { mode: 'off' },
      motion_level: 1,
    }))
    await pm.updateConfig(project.slug, {
      ...presets(),
      scene_plan_presets: [{
        id: 'plan', name: 'Plan changed after acceptance', type: 'scene-plan',
        data: { model: 'changed-model', pacing: { min_sec: 30, max_sec: 40 }, motion_scope: { mode: 'off' } },
      }],
      'scene_plan_last_preset_scene-plan': 'plan',
      scene_review_genstudio_presets: [{
        id: 'review', name: 'Review changed after acceptance', type: 'scene-review', data: { model: 'changed-model' },
      }],
      'scene_review_genstudio_last_preset_scene-review': 'review',
    } as any)

    const replay = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send(body)
    assert.equal(replay.status, 201, JSON.stringify(replay.body))
    assert.equal(replay.body.enqueued, 0)
    assert.deepEqual(replay.body.reused_jobs, [{
      episode_id: episode.code, job_id: job.job_id, type: 'scene_plan_run',
    }])
    assert.deepEqual(jq.getJob(job.job_id)?.params, acceptedParams,
      'same-body replay adopts the accepted snapshot before mutable sidecar and preset resolution')
    assert.equal((await jq.getJobs(project.slug)).filter(candidate => (
      candidate.params?.pipeline_batch_id === body.operation_id
    )).length, 1, 'same-body replay cannot enqueue another batch owner')
  })

  test('a missing Scene Plan preset blocks only the row whose selected branch needs it', async () => {
    const project = await pm.createProject({ name: 'Pipeline Branch Preset Partial Success' })
    await pm.updateConfig(project.slug, {
      metadata_presets: [{ id: 'metadata', name: 'Metadata', data: { model: 'saved-chat-model' } }],
      metadata_last_preset: 'metadata',
      // 1.4.300 — the missing-preset stop is the step_preset safety check on Block.
      safety_checks: { step_preset: 'block' },
    } as any)
    const scene = await addEpisode(project.slug, 'Scene row missing preset')
    const pool = await addEpisode(project.slug, 'Pool row common work')
    await setImagePoolSource(pool.code, pool.dir)
    await setReadyForLateStages(project.slug, scene.code)
    await setReadyForLateStages(project.slug, pool.code)

    const response = await request(app)
      .post(`/api/projects/${project.slug}/pipeline/run-batch`)
      .send({ episode_ids: [scene.code, pool.code], steps: ['metadata', 'scene_plan'] })

    assert.equal(response.status, 201, JSON.stringify(response.body))
    rememberJobs(project.slug, response.body.jobs)
    assert.equal(response.body.enqueued, 1)
    assert.equal(response.body.jobs[0].episode_id, pool.code)
    assert.equal(response.body.jobs[0].type, 'metadata')
    assert.equal(response.body.blocked[0].episode_id, scene.code)
    assert.match(response.body.blocked[0].reason, /No active preset for Scene Plan/i)
  })
})

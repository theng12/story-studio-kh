/**
 * A failed Continuity Render or Contextual Cues row stops asking for attention
 * once a later run has really finished its work.
 *
 * Production, 2026-11-01: both types were missing from `RESOLVABLE_TYPES`, so
 * their failed rows said "needs attention" for ever — the same defect the
 * Still Posts, Scene Plan and Motion Batch rows already had fixed.
 *
 * The bar is the §8 completion contract, not "a file exists": each type settles
 * through the SAME proof its generator and the Production Board use, and a
 * partial result keeps the row needing attention.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let utils: typeof import('../services/utils.js')
let cues: typeof import('../services/contextual-cues.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  utils = await import('../services/utils.js')
  cues = await import('../services/contextual-cues.js')
  // Importing the app is what runs the boot, so the rows below are read by the
  // same started server the owner runs.
  await import('../app.js')
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot', timeoutMs: 30_000 })
  // The queue stays paused: these rows are history, and a live executor would
  // try to reach the Gateway for them.
  await jq.setQueuePaused(true)
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  // The queue stays paused on purpose. Unpausing it here would pump these
  // history rows at the Gateway and write outside the claimed data dir once
  // cleanup has removed it.
  await cleanup()
})

const PLAN = {
  schema_version: 1,
  generated_at: '2026-10-01T00:00:00.000Z',
  planner_model: 'test',
  source_stitched_srt: 'test.srt',
  total_duration_sec: 20,
  research_used: false,
  planned_in_windows: 0,
  planning_stage: 'visual',
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 10, transcript_segment: 'One', visual_prompt: 'Prompt one', approved: false },
    { id: 'scene-2', scene_index: 2, start_sec: 10, end_sec: 20, transcript_segment: 'Two', visual_prompt: 'Prompt two', approved: false },
  ],
}

/** An episode folder with a scene plan in it, and the paths that reach it. */
async function episodeFixture(slug: string, code = 'EP001') {
  const paths = await utils.resolveEpisodePathsByCode(slug, code)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  const planPath = await utils.resolveScenePlanPath(slug, code, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify(PLAN), 'utf-8')
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imagesDir = await resolveSceneImagesDir(slug, code, paths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  return { paths, planPath, imagesDir }
}

async function failJob(slug: string, type: 'continuity_render' | 'contextual_cues', episode: string, params: Record<string, unknown> = {}) {
  const job = jq.enqueuePreparedForTest({
    project_slug: slug, type, episode_id: episode, title: type,
    params: { episode_id: episode, ...params },
  })
  await jq.mutateAuthoritativeJob(slug, job.job_id, current => ({
    ...current,
    status: 'error',
    started_at: '2026-10-01T00:00:00.000Z',
    finished_at: '2026-10-01T00:05:00.000Z',
    error: 'The Gateway reported a provider failure.',
  }))
  return job.job_id
}

describe('failed Continuity Render and Contextual Cues rows settle when a later run finished the work', () => {
  test('a Continuity Render row settles only when every scene it covered has a usable picture', async () => {
    const { settleCompletedFailures } = await import('../services/stale-failures.js')
    const project = await pm.createProject({ name: 'Stale continuity render' })
    const { planPath, imagesDir } = await episodeFixture(project.slug)

    // A partial render: one picture of the two.
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), ONE_PIXEL_PNG)
    const jobId = await failJob(project.slug, 'continuity_render', 'EP001')

    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'a partial render stays failed')
    assert.equal(jq.getQueueStats(project.slug).error, 1, 'it still needs attention')

    // The rest of the render lands, and the plan registers both pictures.
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), ONE_PIXEL_PNG)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    for (const scene of plan.scenes) {
      scene.image_path = path.join(imagesDir, `${scene.id}.png`)
      scene.rendered_prompt = scene.visual_prompt
    }
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')

    assert.deepEqual(await settleCompletedFailures(project.slug), [jobId], 'a complete render settles the row')
    assert.equal(jq.getQueueStats(project.slug).error, 0)
    const settled = (await jq.getJobs(project.slug)).find(job => job.job_id === jobId)!
    assert.equal(settled.status, 'error', 'history is kept')
    assert.match(settled.resolved!.reason, /now saved/)
  })

  test('a Continuity Render row with a missing picture, a corrupt picture or a stale prompt stays failed', async () => {
    const { settleCompletedFailures } = await import('../services/stale-failures.js')
    const project = await pm.createProject({ name: 'Stale continuity render, incomplete' })
    const { planPath, imagesDir } = await episodeFixture(project.slug)

    // One picture missing, one corrupt.
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), Buffer.from('not an image'))
    const missingId = await failJob(project.slug, 'continuity_render', 'EP001')

    let plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    for (const scene of plan.scenes) {
      scene.image_path = path.join(imagesDir, `${scene.id}.png`)
      scene.rendered_prompt = scene.visual_prompt
    }
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')

    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'a corrupt picture is not a picture')
    assert.equal(jq.getQueueStats(project.slug).error, 1)

    // Repair the corrupt file, but the plan still carries an OUTDATED prompt for
    // it: the picture on disk was rendered from an older prompt, so the row is
    // not settled by it.
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), ONE_PIXEL_PNG)
    plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    plan.scenes[1].rendered_prompt = 'An older prompt'
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'a picture rendered from an outdated prompt settles nothing')

    // The plan is back in step with the pictures on disk.
    plan.scenes[1].rendered_prompt = plan.scenes[1].visual_prompt
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
    assert.deepEqual(await settleCompletedFailures(project.slug), [missingId])
  })

  test('a forced re-render does not settle on the pictures the previous run left behind', async () => {
    const { settleCompletedFailures } = await import('../services/stale-failures.js')
    const project = await pm.createProject({ name: 'Stale forced continuity render' })
    const { planPath, imagesDir } = await episodeFixture(project.slug)
    await fs.writeFile(path.join(imagesDir, 'scene-1.png'), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(imagesDir, 'scene-2.png'), ONE_PIXEL_PNG)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    for (const scene of plan.scenes) {
      scene.image_path = path.join(imagesDir, `${scene.id}.png`)
      scene.rendered_prompt = scene.visual_prompt
    }
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')

    const jobId = await failJob(project.slug, 'continuity_render', 'EP001', { force: true })
    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'a forced render wanted NEW pictures')
    assert.equal(jq.getQueueStats(project.slug).error, 1)

    // The same row without the force flag settles on the same disk state.
    await jq.mutateAuthoritativeJob(project.slug, jobId, current => ({
      ...current, params: { ...current.params, force: false },
    }))
    assert.deepEqual(await settleCompletedFailures(project.slug), [jobId])
  })

  test('a Contextual Cues row settles only when the labels timeline for this plan exists', async () => {
    const { settleCompletedFailures } = await import('../services/stale-failures.js')
    const project = await pm.createProject({ name: 'Stale contextual cues' })
    const { planPath } = await episodeFixture(project.slug)
    const jobId = await failJob(project.slug, 'contextual_cues', 'EP001')

    // A partial run: progress was saved, the timeline was not.
    await cues.writeContextualCueProgress(planPath, {
      schema_version: 1,
      fingerprint: 'partial',
      source_scene_plan_generated_at: PLAN.generated_at,
      model: 'test', batch_size: 1, total_scenes: 2, total_batches: 2,
      completed_batches: [],
      updated_at: '2026-10-01T00:01:00.000Z',
    } as any)
    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'a half-proposed run stays failed')
    assert.equal(jq.getQueueStats(project.slug).error, 1)

    // The run finishes and writes the timeline.
    await cues.writeContextualCueTimeline(planPath, {
      schema_version: 2,
      generated_at: '2026-10-01T00:10:00.000Z',
      source_scene_plan_generated_at: PLAN.generated_at,
      cues: [],
    })
    assert.deepEqual(await settleCompletedFailures(project.slug), [jobId], 'the finished run settles the row')
    assert.equal(jq.getQueueStats(project.slug).error, 0)
  })

  test('a Contextual Cues row does not settle on a timeline built from an earlier scene plan', async () => {
    const { settleCompletedFailures } = await import('../services/stale-failures.js')
    const project = await pm.createProject({ name: 'Stale contextual cues, old plan' })
    const { planPath } = await episodeFixture(project.slug)
    const jobId = await failJob(project.slug, 'contextual_cues', 'EP001')

    await cues.writeContextualCueTimeline(planPath, {
      schema_version: 2,
      generated_at: '2026-10-01T00:10:00.000Z',
      source_scene_plan_generated_at: '2026-09-01T00:00:00.000Z',
      cues: [],
    })
    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'labels from an earlier plan are not this plan\'s labels')
    assert.equal(jq.getQueueStats(project.slug).error, 1)

    // The plan is regenerated, and the labels are proposed for the NEW plan.
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    plan.generated_at = '2026-10-02T00:00:00.000Z'
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
    await cues.writeContextualCueTimeline(planPath, {
      schema_version: 2,
      generated_at: '2026-10-02T00:10:00.000Z',
      source_scene_plan_generated_at: '2026-10-02T00:00:00.000Z',
      cues: [],
    })
    assert.deepEqual(await settleCompletedFailures(project.slug), [jobId])
  })

  test('a Contextual Cues row with Sound switched on does not settle on its labels alone', async () => {
    const { settleCompletedFailures } = await import('../services/stale-failures.js')
    const { readSoundDesignTimeline, writeSoundDesignTimeline } = await import('../services/sound-design.js')
    const project = await pm.createProject({ name: 'Stale contextual cues with sound' })
    await pm.updateConfig(project.slug, { sound_design: { enabled: true } } as any)
    const { planPath } = await episodeFixture(project.slug)
    const jobId = await failJob(project.slug, 'contextual_cues', 'EP001')

    await cues.writeContextualCueTimeline(planPath, {
      schema_version: 2,
      generated_at: '2026-10-01T00:10:00.000Z',
      source_scene_plan_generated_at: PLAN.generated_at,
      cues: [],
    })
    assert.deepEqual(await settleCompletedFailures(project.slug), [], 'the sound half is still missing')
    assert.equal(jq.getQueueStats(project.slug).error, 1)

    await writeSoundDesignTimeline(planPath, {
      schema_version: 2,
      generated_at: '2026-10-01T00:12:00.000Z',
      source_scene_plan_generated_at: PLAN.generated_at,
      settings: {} as any,
      cues: [],
    })
    assert.deepEqual(await settleCompletedFailures(project.slug), [jobId], 'both halves are done')
    assert.equal(jq.getQueueStats(project.slug).error, 0)
    assert.ok(await readSoundDesignTimeline(planPath))
  })
})

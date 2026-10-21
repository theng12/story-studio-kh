/**
 * 1.4.300 — the Pipeline start checks and the queue's "same step already queued" check obey the
 * channel's Off / Warn / Block switch (Settings → Safety checks). Block keeps the old stop; Off and
 * Warn let the episode run (Warn also says so).
 *
 * The second half of that story: a step a lenient check LEFT OUT is left out of the RUN too, not
 * only out of preflight's report. Night Atlas Mythology EP0012 (job fa69e918, 2026-10-20) had
 * motion_scope off and no usable Motion preset, so preflight left the step out and said so — and
 * `run-batch` submitted it anyway, from the snapshot `preflightBatch` captured before any of those
 * decisions. The job reached `scene_clips_batch` with no model or variant and died on
 * "episode_id and model are required" before any provider work.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs/promises'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitForValue } from './_timing.js'

let cleanup: () => Promise<void>
let app: express.Express
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode
let n = 0

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  jq = await import('../services/job-queue.js')
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
  const { router } = await import('../routes/pipeline.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

const preset = (list: string, active: string, data: Record<string, unknown> = { model: 'test-model' }) =>
  ({ [list]: [{ id: `${list}-1`, name: 'P', data }], [active]: `${list}-1` })
const SCRIPT = preset('script_presets', 'script_last_preset')

async function seed(config: Record<string, unknown>, safety: Record<string, string> = {}) {
  const project = await pm.createProject({ name: `Safety pipeline ${++n}` })
  await pm.updateConfig(project.slug, { ...config, safety_checks: safety } as any)
  const [idea] = await im.addIdeas(project.slug, [{
    title: `Episode ${n}`, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false)
  const episodeId = accepted.episode_code!
  await fs.mkdir((await resolveEpisodePathsByCode(project.slug, episodeId)).episode_dir, { recursive: true })
  return { slug: project.slug, episodeId, ideaId: idea!.id }
}

const preflight = (slug: string, episodeId: string, steps: string[]) =>
  request(app).post(`/api/projects/${slug}/pipeline/preflight`).send({ episode_ids: [episodeId], steps })

const codes = (body: any) => (body.issues || []).map((issue: any) => issue.code)

test('accepted_idea: Warn runs a dismissed episode with a warning; Block skips it', async () => {
  for (const mode of ['warn', 'block']) {
    const { slug, episodeId, ideaId } = await seed(SCRIPT, { accepted_idea: mode })
    await im.dismissIdea(slug, ideaId)
    const res = await preflight(slug, episodeId, ['script-only'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.deepEqual(codes(res.body), ['episode_not_accepted'])
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.eligible_episode_ids, [episodeId])
      assert.ok(res.body.warnings.some((w: string) => /not an accepted episode/.test(w)), res.body.warnings.join('\n'))
    }
  }
})

test('earlier_step_done: Warn adds the missing earlier step to the run; Block stops the episode', async () => {
  const config = {
    ...SCRIPT,
    ...preset('thumbnail_prompts_presets', 'thumbnail_prompts_last_preset'),
    ...preset('thumbnail_generator_presets', 'thumbnail_generator_last_preset'),
  }
  for (const mode of ['warn', 'block']) {
    const { slug, episodeId } = await seed(config, { earlier_step_done: mode })
    const res = await preflight(slug, episodeId, ['image_prompts', 'thumb_images'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.ok(res.body.issues.some((i: any) => i.code === 'missing_prerequisite' && i.requires === 'script-only'))
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.steps_added, [{ episode_id: episodeId, steps: ['script-only'] }])
      assert.ok(res.body.warnings.some((w: string) => /added Script/i.test(w)), res.body.warnings.join('\n'))
    }
  }
})

test('step_preset: Warn leaves the step with no preset out and runs the rest; Block stops the batch', async () => {
  for (const mode of ['warn', 'block']) {
    const { slug, episodeId } = await seed(SCRIPT, { step_preset: mode })
    const res = await preflight(slug, episodeId, ['research', 'script-only'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.deepEqual(codes(res.body), ['missing_preset'])
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.steps_left_out.map((s: any) => s.step), ['research'])
    }
  }
})

test('preset_files: Off runs with the preset as saved; Block stops the batch', async () => {
  const config = preset('script_presets', 'script_last_preset', { model: 'test-model', music_path: '/no/such/drive/music.mp3' })
  for (const mode of ['off', 'block']) {
    const { slug, episodeId } = await seed(config, { preset_files: mode })
    const res = await preflight(slug, episodeId, ['script-only'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.deepEqual(codes(res.body), ['missing_local_asset'])
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.ok(!res.body.warnings.some((w: string) => /isn't available/.test(w)), 'Off says nothing')
    }
  }
})

test('audio_voice: Warn leaves Audio out and runs the rest; Block (default) stops the batch', async () => {
  const config = { ...SCRIPT, ...preset('audio_generator_presets', 'audio_generator_last_preset', { form: { voice: '' } }) }
  for (const mode of ['warn', undefined]) {
    const { slug, episodeId } = await seed(config, mode ? { audio_voice: mode } : {})
    const res = await preflight(slug, episodeId, ['script-only', 'audio'])
    if (!mode) {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.deepEqual(codes(res.body), ['missing_voice'])
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.steps_left_out.map((s: any) => s.step), ['audio'])
    }
  }
})

test('step_fits_channel: Warn drops a music step from a story channel; Block stops the batch', async () => {
  for (const mode of ['warn', 'block']) {
    const { slug, episodeId } = await seed(SCRIPT, { step_fits_channel: mode })
    const res = await preflight(slug, episodeId, ['script-only', 'music_build'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.deepEqual(codes(res.body), ['invalid_preset'])
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.steps_left_out.map((s: any) => s.step), ['music_build'])
    }
  }
})

test('cues_feature_on: Warn leaves Contextual Cues out when the feature is off; Block stops the batch', async () => {
  const config = { ...SCRIPT, ...preset('contextual_cues_presets', 'contextual_cues_last_preset_contextual-cues') }
  for (const mode of ['warn', 'block']) {
    const { slug, episodeId } = await seed(config, { cues_feature_on: mode })
    const res = await preflight(slug, episodeId, ['script-only', 'contextual_cues'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.ok(codes(res.body).includes('invalid_preset'))
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.deepEqual(res.body.steps_left_out.map((s: any) => s.step), ['contextual_cues'])
    }
  }
})

/** The job types a run-batch planned: each enqueued head plus its frozen chain. */
const plannedTypes = (body: any): string[] => (body.jobs || []).flatMap((job: any) => {
  const queued = jq.getJob(job.job_id)!
  const chain = ((queued.params as any).pipeline_chain || []) as Array<{ type: string }>
  return [queued.type, ...chain.map(link => link.type)]
})

const runBatch = (slug: string, episodeId: string, steps: string[]) =>
  request(app).post(`/api/projects/${slug}/pipeline/run-batch`).send({ episode_ids: [episodeId], steps })

test('a Motion step with no usable preset is left out and never enqueued', async () => {
  await jq.setQueuePaused(true)
  try {
    const { slug, episodeId } = await seed(SCRIPT, { step_preset: 'warn' })
    const steps = ['script-only', 'motion_review']
    const dry = await preflight(slug, episodeId, steps)
    assert.equal(dry.status, 200, JSON.stringify(dry.body))
    assert.deepEqual(dry.body.steps_left_out.map((s: any) => s.step), ['motion_review'])

    const res = await runBatch(slug, episodeId, steps)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(plannedTypes(res.body), ['outline_only', 'expand_chapters'])
  } finally {
    await jq.setQueuePaused(false)
  }
})

test('a Scene Plan preset with no writing model is left out and never enqueued', async () => {
  await jq.setQueuePaused(true)
  try {
    const config = { ...SCRIPT, ...preset('scene_plan_presets', 'scene_plan_last_preset_scene-plan', {}) }
    const { slug, episodeId } = await seed(config, { step_preset: 'warn' })
    await im.setEpisodeStatusOverrides(slug, episodeId, { subtitles: true })
    const steps = ['script-only', 'scene_plan']
    const dry = await preflight(slug, episodeId, steps)
    assert.equal(dry.status, 200, JSON.stringify(dry.body))
    assert.deepEqual(dry.body.steps_left_out.map((s: any) => s.step), ['scene_plan'])

    const res = await runBatch(slug, episodeId, steps)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(plannedTypes(res.body), ['outline_only', 'expand_chapters'])
  } finally {
    await jq.setQueuePaused(false)
  }
})

test('a Contextual Cues step left out for the feature switch is never enqueued', async () => {
  await jq.setQueuePaused(true)
  try {
    const { slug, episodeId } = await seed(SCRIPT, { cues_feature_on: 'warn' })
    const steps = ['script-only', 'contextual_cues']
    const dry = await preflight(slug, episodeId, steps)
    assert.equal(dry.status, 200, JSON.stringify(dry.body))
    assert.deepEqual(dry.body.steps_left_out.map((s: any) => s.step), ['contextual_cues'])

    const res = await runBatch(slug, episodeId, steps)
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(plannedTypes(res.body), ['outline_only', 'expand_chapters'])
  } finally {
    await jq.setQueuePaused(false)
  }
})

test('a usable step is still enqueued', async () => {
  await jq.setQueuePaused(true)
  try {
    const config = { ...SCRIPT, ...preset('research_presets', 'research_last_preset') }
    const { slug, episodeId } = await seed(config, { step_preset: 'warn' })
    const res = await runBatch(slug, episodeId, ['research', 'script-only'])
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(plannedTypes(res.body), ['research_run', 'outline_only', 'expand_chapters'])
  } finally {
    await jq.setQueuePaused(false)
  }
})

test('a step whose prerequisite preflight left out is blocked, not run without it', async () => {
  const config = {
    ...SCRIPT,
    ...preset('scene_plan_presets', 'scene_plan_last_preset_scene-plan', {}),
    ...preset('scene_review_genstudio_presets', 'scene_review_genstudio_last_preset_scene-review'),
  }
  for (const mode of ['warn', 'block']) {
    const { slug, episodeId } = await seed(config, { step_preset: 'warn', earlier_step_done: mode })
    const res = await runBatch(slug, episodeId, ['scene_review'])
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.ok(
      res.body.issues.some((i: any) => i.code === 'missing_prerequisite' && i.requires === 'scene_plan'),
      JSON.stringify(res.body.issues),
    )
  }
})

test('disk_space: Warn starts the batch with a warning; Block stops it', async () => {
  const realStatfs = (fs as any).statfs
  ;(fs as any).statfs = async () => ({ bsize: 1, bavail: 1 })
  try {
    for (const mode of ['warn', 'block']) {
      const { slug, episodeId } = await seed(SCRIPT, { disk_space: mode })
      const res = await preflight(slug, episodeId, ['script-only'])
      if (mode === 'block') {
        assert.equal(res.status, 422, JSON.stringify(res.body))
        assert.deepEqual(codes(res.body), ['insufficient_disk'])
      } else {
        assert.equal(res.status, 200, JSON.stringify(res.body))
        assert.ok(res.body.warnings.some((w: string) => /Not enough free disk space/.test(w)), res.body.warnings.join('\n'))
      }
    }
  } finally {
    ;(fs as any).statfs = realStatfs
  }
})

test('captions_missing: Block stops an episode whose captions are on but has no subtitles; Off says nothing', async () => {
  const bundle = { id: 'va', name: 'VA', data: { fallback: { subtitles: { enabled: true, source: 'chapters' } } } }
  for (const mode of ['off', 'block']) {
    const { slug, episodeId } = await seed({ video_bundle_presets: [bundle], video_bundle_last_preset: 'va' }, { captions_missing: mode })
    await im.setEpisodeStatusOverrides(slug, episodeId, { script: true, merged_audio: true, subtitles: false, scene_plan: true, scene_review: true })
    const res = await preflight(slug, episodeId, ['video_assembly'])
    if (mode === 'block') {
      assert.equal(res.status, 422, JSON.stringify(res.body))
      assert.deepEqual(codes(res.body), ['captions_missing'])
    } else {
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.ok(!(res.body.video_effects?.not_drawn || []).some((l: string) => /captions are switched on/.test(l)))
    }
  }
})

test('cue_review: Off carries the run on to Scene Review; Block pauses after Contextual Cues', async () => {
  const config = {
    contextual_cues: { enabled: true },
    ...preset('contextual_cues_presets', 'contextual_cues_last_preset_contextual-cues', { settings: {} }),
    ...preset('scene_review_genstudio_presets', 'scene_review_genstudio_last_preset_scene-review'),
  }
  for (const mode of ['off', 'block']) {
    const { slug, episodeId } = await seed(config, { cue_review: mode })
    await im.setEpisodeStatusOverrides(slug, episodeId, { script: true, merged_audio: true, subtitles: true, scene_plan: true })
    const res = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episodeId], steps: ['contextual_cues', 'scene_review'] })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const head = (await jq.getJobs(slug)).find(job => job.job_id === res.body.jobs[0].job_id)!
    assert.equal(head.type, 'contextual_cues')
    const chain = (head.params.pipeline_chain || []) as Array<{ type: string }>
    if (mode === 'block') assert.deepEqual(chain, [])
    else assert.deepEqual(chain.map(link => link.type), ['continuity_render'])
  }
})

test('same_step_queued: Off joins a run-batch to the step already queued; Block skips the episode', async () => {
  await jq.setQueuePaused(true)
  try {
    for (const mode of ['off', 'block']) {
      const { slug, episodeId } = await seed(SCRIPT, { same_step_queued: mode })
      const existing = jq.enqueuePreparedForTest({ project_slug: slug, type: 'outline_only', episode_id: episodeId, title: 'already here', params: {} })
      const res = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`)
        .send({ episode_ids: [episodeId], steps: ['script-only'] })
      assert.equal(res.status, 201, JSON.stringify(res.body))
      if (mode === 'block') {
        assert.equal(res.body.reused, 0)
        assert.ok(res.body.skipped.some((s: any) => /already queued or running/.test(s.reason)))
      } else {
        assert.deepEqual(res.body.reused_jobs.map((j: any) => j.job_id), [existing.job_id])
        const joined = jq.getJob(existing.job_id)!
        assert.deepEqual((joined.params.pipeline_chain as any[]).map(link => link.type), ['expand_chapters'])
      }
    }
  } finally {
    await jq.setQueuePaused(false)
  }
})

const TERMINAL_JOB_STATES = ['done', 'error', 'cancelled']

test('same_step_queued: a chain handoff joins the job already queued (Off) instead of failing (Block)', async () => {
  let open = false
  jq.registerExecutor('broll_assemble', async () => {
    while (!open) await new Promise(r => setTimeout(r, 10))
  })
  jq.registerExecutor('chapter-only', async () => {})
  // The joined job carries the later step on, so that step must not reach the network here.
  jq.registerExecutor('youtube_playlist_update', async () => {})
  const projectSlugs: string[] = []
  let assertionFailure: unknown
  try {
    for (const mode of ['off', 'block']) {
      const project = await pm.createProject({ name: `Safety handoff ${mode}` })
      projectSlugs.push(project.slug)
      await pm.updateConfig(project.slug, { safety_checks: { same_step_queued: mode } } as any)
      const busy = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'broll_assemble', episode_id: 'EP001', title: 'busy', params: {} })
      const rest = [{ type: 'youtube_playlist_update', title: 'later', params: {} }]
      jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'chapter-only', episode_id: 'EP001', title: 'head',
        params: { pipeline_chain: [{ type: 'broll_assemble', title: 'dup', params: {} }, ...rest] },
      })
      const head = await waitForValue(async () => {
        const job = (await jq.getJobs(project.slug)).find(candidate => candidate.title === 'head')
        return job?.status === 'done' ? job : undefined
      }, { label: 'head job to finish', timeoutMs: 3000 })
      assert.equal(head?.status, 'done')
      // The handoff is dispatched after the parent's terminal checkpoint, so the queue has
      // not decided yet when the parent reads as done. Wait for that decision BEFORE the
      // held job is released: "already queued" only holds while that job is still active,
      // and letting it finish first turns the join into a second copy of the same step.
      await waitForValue(() => {
        const state = (jq.getJob(head.job_id) as any)?.pipeline_handoff?.state
        return state === 'dispatched' || state === 'failed' ? state : undefined
      }, { label: 'the chain handoff to be dispatched', timeoutMs: 5000 })
      if (mode === 'block') {
        // The failure record is written after the handoff is marked failed.
        await waitForValue(async () => {
          const recorded = (await jq.getJobs(project.slug)).some(job => (job.params as any)?.pipeline_handoff_failed === true)
          return recorded ? true : undefined
        }, { label: 'the handoff failure record', timeoutMs: 5000 })
      }
      const failed = (await jq.getJobs(project.slug)).find(job => (job.params as any)?.pipeline_handoff_failed === true)
      if (mode === 'block') {
        assert.ok(failed, 'Block keeps the handoff failure')
      } else {
        assert.equal(failed, undefined)
        assert.deepEqual(jq.getJob(busy.job_id)!.params.pipeline_chain, rest)
      }
    }
  } catch (error) {
    assertionFailure = error
  } finally {
    // Release the held executor and let every job this test started settle, including
    // the chained link that follows the joined job. A job still writing when the
    // fixture's data dir goes would race the teardown, so this runs even when an
    // assertion above failed.
    open = true
    try {
      await waitForValue(async () => {
        for (const slug of projectSlugs) {
          for (const job of await jq.getJobs(slug)) {
            // Durable, not in-memory: a job reads terminal before its last write is
            // requested, and a write still in flight when the data dir goes lands outside it.
            const durable = await jq.loadAuthoritativeJob(slug, job.job_id)
            if (!durable || !TERMINAL_JOB_STATES.includes(durable.status)) return undefined
            // A chain link that is still pending adds its next job after this pass.
            const marker = (job as any).pipeline_handoff
            if (marker && marker.state === 'pending') return undefined
          }
        }
        return true
      }, { label: 'every job this test started to reach a durable terminal state' })
      await jq._waitForJobPersistenceForTesting()
    } catch (error) {
      if (!assertionFailure) throw error
    }
  }
  if (assertionFailure) throw assertionFailure
})

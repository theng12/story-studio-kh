/**
 * 1.4.312 — a chained Final Video is resolved from the channel's CURRENT Video Assembly preset
 * when its job is submitted, not frozen into the chain when the batch was submitted.
 *
 * Production (pronom, 2026-10-17). Batch `e30d2222` was submitted at 09:16:37Z, so every later
 * step's params were resolved then. The owner applied the channel's base look at 09:38:24Z. When
 * the chain reached Final Video the links were dispatched at 16:41–16:47Z carrying
 * `effect_stack: []` with no `scene_effects` / `color_grading` (PR0001 `0c30f3bc`, PR0013
 * `ffb0a4f1`), while a run-batch of the same single step at 17:23Z carried the base look
 * (`Colour grade: cool-moonlight`, `Heavy Vignette`, `Fog / Mist`, `Fine Film Grain`, PR0005
 * `ff0b55d9`). The channel's look is a reusable channel choice; the episode's own decision
 * (pacing, motion scope, visual source, the run's force / repair stamps) is still frozen at submit.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let cleanup: () => Promise<void>
let app: import('express').Express
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let wasQueuePaused = false

/** The channel's look, exactly as the owner saved it on pronom. */
const BASE_LOOK = {
  color_grading: { enabled: true, preset: 'cool-moonlight', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 },
  scene_effects: {
    enabled: true,
    overlays: [
      { id: 'vignette-heavy', enabled: true, params: {} },
      { id: 'ground-mist', enabled: true, params: {} },
      { id: 'film-grain-fine', enabled: true, params: {} },
    ],
  },
}

/** The bundle as it stood before the base look: a timeline and export choice, no look at all. */
function bundleData(effects: Record<string, unknown>) {
  return {
    effects_preset_id: '',
    fallback: {
      intro: { enabled: false },
      timeline: { transition: { type: 'crossfade', duration: 0.6 }, post_audio: { behavior: 'fade-to-black', fade_duration: 4, tail_seconds: 3 } },
      effects,
      subtitles: { enabled: false },
      export: { resolution: '1080p', aspect_ratio: '16:9', quality: 'medium', fps: 24, encoding_effort: 'hardware', codec: 'h264', format: 'mp4', upscale_sharpen: 'off', loudness_tolerance_pct: 20 },
    },
  }
}

const NO_LOOK = { chapter_titles: { enabled: false }, film_grain: { enabled: false }, scene_effects: { enabled: false, overlays: [] } }

async function setChannelLook(slug: string, effects: Record<string, unknown>): Promise<void> {
  await pm.updateConfig(slug, {
    video_bundle_presets: [{ id: 'va', name: 'Video Assembly', data: bundleData(effects) }],
    video_bundle_last_preset: 'va',
  } as any)
}

/** An accepted episode with narration, scenes and Scene Review already done — only the head step is left. */
async function seedEpisode(slug: string, title: string): Promise<string> {
  const [idea] = await ideas.addIdeas(slug, [{
    title, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const episodeId = (await ideas.acceptIdea(slug, idea!.id)).episode_code!
  await ideas.setEpisodeStatusOverrides(slug, episodeId, {
    script: true, audio: true, scene_plan: true, scene_review: true, merged_audio: false, video_assembly: false,
  })
  return episodeId
}

before(async () => {
  const isolated = await useTempDataDir()
  cleanup = isolated.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  // Neither Audio Assembly nor Final Video carries a completion auditor, so a stub
  // executor that returns is a completed step — this test is about the chain's params,
  // not about providers.
  jq.registerExecutor('audio_merge', async () => {})
  jq.registerExecutor('video_assembly', async () => {})
  wasQueuePaused = jq.isQueuePaused()
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  if (!wasQueuePaused) await jq.setQueuePaused(false)
  await cleanup()
})

async function seedChannel(name: string): Promise<string> {
  const project = await pm.createProject({ name })
  await pm.updateConfig(project.slug, {
    audio_merge_presets: [{ id: 'am', name: 'Audio Assembly', data: { normalize_volume: true } }],
    audio_merge_last_preset: 'am',
  } as any)
  await setChannelLook(project.slug, NO_LOOK)
  return project.slug
}

const stack = (job: any) => (job?.params?.effect_stack as string[] | undefined) ?? []

describe('a chained Final Video resolves the channel look when its job is submitted', () => {
  test('a look applied after the batch was submitted reaches the chained Final Video, exactly as a run-batch', async () => {
    const slug = await seedChannel('Chained look parity')
    const chained = await seedEpisode(slug, 'Chained episode')
    const solo = await seedEpisode(slug, 'Run-batch episode')

    await jq.setQueuePaused(true)
    // 1. The batch is submitted while the channel has NO look. Its Final Video link is resolved now.
    const batch = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [chained], steps: ['audio_merge', 'video_assembly'] })
    assert.equal(batch.status, 201, JSON.stringify(batch.body))
    const head = (await jq.getJobs(slug)).find(job => job.episode_id === chained && job.status === 'queued')!
    assert.ok(head, 'the head step is queued')
    const link = (head.params.pipeline_chain as any[]).find(l => l.params?.pipeline_step === 'video_assembly')
    assert.ok(link, 'the batch chained Final Video after its head step')
    assert.deepEqual(link.params.effect_stack, [], 'the link captured the channel look as it was at submit')
    assert.ok(Array.isArray(link.params.pipeline_preset_keys) && link.params.pipeline_preset_keys.length > 0,
      'the link records which keys its preset produced, so the refresh can drop exactly those')

    // 2. The owner applies the base look. Nothing already queued is touched.
    await setChannelLook(slug, BASE_LOOK)
    assert.deepEqual(link.params.effect_stack, [], 'applying the look does not rewrite the queued chain')

    // 3. The chain reaches Final Video: the job is resolved from the channel's preset NOW.
    await jq.setQueuePaused(false)
    await waitFor(async () => {
      const jobs = await jq.getJobs(slug)
      return jobs.some(job => job.episode_id === chained && job.type === 'video_assembly')
    })
    const chainedJob = (await jq.getJobs(slug)).find(job => job.episode_id === chained && job.type === 'video_assembly')!

    // 4. The same step submitted on its own, at the same moment, is the control.
    const soloBatch = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [solo], steps: ['video_assembly'] })
    assert.equal(soloBatch.status, 201, JSON.stringify(soloBatch.body))
    const soloJob = (await jq.getJobs(slug)).find(job => job.episode_id === solo && job.type === 'video_assembly')!

    assert.deepEqual(stack(chainedJob), stack(soloJob), 'chained and run-batch Final Video carry the same effect stack')
    assert.deepEqual(stack(chainedJob), [
      'Colour grade: cool-moonlight',
      'Effect: Heavy Vignette',
      'Effect: Fog / Mist (moving loop, slower render)',
      'Effect: Fine Film Grain',
    ])
    assert.deepEqual(chainedJob.params.scene_effects, {
      enabled: true,
      overlays: [
        { id: 'vignette-heavy', enabled: true, params: {} },
        { id: 'ground-mist', enabled: true, params: {} },
        { id: 'film-grain-fine', enabled: true, params: {} },
      ],
    })
    assert.deepEqual(chainedJob.params.color_grading, BASE_LOOK.color_grading)
    // The episode's own decision still travels with the link, untouched.
    assert.ok(chainedJob.params.pacing, 'the episode pacing the batch captured is still on the job')
    assert.equal(chainedJob.params.visual_source, head.params.visual_source)
    // The bookkeeping the refresh needs does not reach the render request.
    assert.equal(chainedJob.params.pipeline_preset_keys, undefined)
    assert.equal(chainedJob.params.pipeline_preset_id, undefined)
    // The refresh is said out loud on the handoff, never silent.
    assert.match(jq.getJob(head.job_id)!.output_lines.join('\n'), /resolved from the channel's current Video Assembly preset/)
  })

  test('a channel that deliberately has no look still gets no look, and a look switched off is off', async () => {
    const slug = await seedChannel('Chained no-look')
    const episode = await seedEpisode(slug, 'No look episode')
    await setChannelLook(slug, { ...BASE_LOOK })

    await jq.setQueuePaused(true)
    const batch = await request(app).post(`/api/projects/${slug}/pipeline/run-batch`)
      .send({ episode_ids: [episode], steps: ['audio_merge', 'video_assembly'] })
    assert.equal(batch.status, 201, JSON.stringify(batch.body))
    const head = (await jq.getJobs(slug)).find(job => job.episode_id === episode && job.status === 'queued')!
    const link = (head.params.pipeline_chain as any[]).find(l => l.params?.pipeline_step === 'video_assembly')
    assert.ok(stack({ params: link.params }).length === 4, 'the link captured the look that was on')

    // The owner switches the whole look off before the chain reaches Final Video.
    await setChannelLook(slug, NO_LOOK)
    await jq.setQueuePaused(false)
    await waitFor(async () => {
      const jobs = await jq.getJobs(slug)
      return jobs.some(job => job.episode_id === episode && job.type === 'video_assembly')
    })
    const job = (await jq.getJobs(slug)).find(j => j.episode_id === episode && j.type === 'video_assembly')!
    assert.deepEqual(stack(job), [], 'an effect switched off is off, not left behind by the capture')
    assert.equal(job.params.scene_effects, undefined)
    assert.equal(job.params.color_grading, undefined)
    assert.equal(job.params.film_grain, undefined)
  })
})

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: express.Express
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode
let fixtureNumber = 0

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

async function seedEpisode() {
  const project = await pm.createProject({ name: `Targeted prerequisite ${++fixtureNumber}` })
  await pm.updateConfig(project.slug, {
    scene_plan_presets: [{ id: 'scene-plan', name: 'Scene Plan', type: 'scene-plan', data: { model: 'test-model' } }],
    'scene_plan_last_preset_scene-plan': 'scene-plan',
    scene_review_genstudio_presets: [{ id: 'scene-review', name: 'Scene Review', type: 'scene-review', data: { model: 'test-model' } }],
    'scene_review_genstudio_last_preset_scene-review': 'scene-review',
  } as unknown as Parameters<typeof pm.updateConfig>[1])
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Targeted prerequisite episode',
    logline: '',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'calm',
  }], 'test-model')
  assert.ok(idea)
  const accepted = await im.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  return { slug: project.slug, episodeId: accepted.episode_code, paths }
}

async function acceptSiblingEpisode(slug: string) {
  const [idea] = await im.addIdeas(slug, [{
    title: 'Eligible sibling episode',
    logline: '',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'calm',
  }], 'test-model')
  assert.ok(idea)
  const accepted = await im.acceptIdea(slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(slug, accepted.episode_code)
  return { episodeId: accepted.episode_code, paths }
}

async function writeValidSubtitleTimeline(paths: Awaited<ReturnType<typeof resolveEpisodePathsByCode>>, episodeId: string) {
  const srt = '1\n00:00:00,000 --> 00:00:01,000\nA complete subtitle timeline.\n'
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({
    sections: [{ slug: 'full-track', duration_s: 1 }],
  }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  await fs.writeFile(stitched, srt)
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: true,
    missing_sections: [],
    sections: [{ slug: 'full-track', source_srt: `${episodeId}_full-track.srt`, cues_added: 1 }],
    total_cues: 1,
    timeline: {
      sha256: createHash('sha256').update('0-1000').digest('hex'),
      total_cues: 1,
      first_cue_start_sec: 0,
      last_cue_end_sec: 1,
    },
  }))
  const { inspectSubtitleCompletion } = await import('../services/subtitle-completion.js')
  const { readSubtitleTimelineIntegrity } = await import('../services/scene-timeline-integrity.js')
  const completion = await inspectSubtitleCompletion(paths.episode_dir, paths.subtitles_dir, episodeId)
  const integrity = await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId)
  assert.equal(completion.complete, true, JSON.stringify(completion))
  assert.equal(integrity.complete, true, JSON.stringify(integrity))
}

async function assertRejectedWithoutJob(
  slug: string,
  episodeId: string,
  step: 'scene_plan' | 'scene_review' | 'video_assembly',
  prerequisite: 'subtitles' | 'scene_plan',
) {
  const beforeJobs = await jq.getJobs(slug)
  const response = await request(app)
    .post(`/api/projects/${slug}/pipeline/run-batch`)
    .send({ episode_ids: [episodeId], steps: [step] })

  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.match(response.body.detail, /Nothing was started/)
  assert.equal(response.body.blocked?.[0]?.episode_id, episodeId)
  assert.match(response.body.blocked?.[0]?.reason || '', new RegExp(prerequisite === 'subtitles' ? 'Subtitles' : 'Scene Plan'))
  assert.deepEqual(response.body.eligible_episode_ids, [])
  assert.ok(
    response.body.issues?.some((issue: { code?: string; episode_id?: string; step?: string; message?: string }) => issue.code === 'missing_prerequisite'
      && issue.episode_id === episodeId
      && issue.step === step
      && (issue as { requires?: string }).requires === prerequisite),
    `preflight names ${prerequisite} as the missing prerequisite`,
  )
  assert.equal((await jq.getJobs(slug)).length, beforeJobs.length, 'preflight creates no job')
}

void test('targeted Scene Plan rejects a missing stitched subtitle timeline before job creation', async () => {
  const fixture = await seedEpisode()
  await assertRejectedWithoutJob(fixture.slug, fixture.episodeId, 'scene_plan', 'subtitles')
})

void test('targeted Scene Plan rejects an incomplete stitched subtitle timeline before job creation', async () => {
  const fixture = await seedEpisode()
  await fs.mkdir(fixture.paths.subtitles_dir, { recursive: true })
  const stitched = path.join(fixture.paths.subtitles_dir, `${fixture.episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nPartial subtitles.\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: false,
    missing_sections: ['Chapter_02'],
    sections: [{ slug: 'Chapter_01', cues_added: 1 }],
  }))
  await assertRejectedWithoutJob(fixture.slug, fixture.episodeId, 'scene_plan', 'subtitles')
})

void test('targeted Scene Plan accepts a verified stitched subtitle timeline', async () => {
  const fixture = await seedEpisode()
  await writeValidSubtitleTimeline(fixture.paths, fixture.episodeId)
  const response = await request(app)
    .post(`/api/projects/${fixture.slug}/pipeline/run-batch`)
    .send({ episode_ids: [fixture.episodeId], steps: ['scene_plan'] })

  assert.equal(response.status, 201, JSON.stringify(response.body))
  const jobs = await jq.getJobs(fixture.slug)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.type, 'scene_plan_run')
})

void test('bulk Scene Plan queues eligible episodes and reports blocked subtitle prerequisites without duplicates', async () => {
  const blocked = await seedEpisode()
  const eligible = await acceptSiblingEpisode(blocked.slug)
  await writeValidSubtitleTimeline(eligible.paths, eligible.episodeId)
  const body = { episode_ids: [blocked.episodeId, eligible.episodeId], steps: ['scene_plan'] }
  await jq.setQueuePaused(true)
  try {
    const first = await request(app)
      .post(`/api/projects/${blocked.slug}/pipeline/run-batch`)
      .send(body)

    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.enqueued, 1)
    assert.equal(first.body.jobs[0]?.episode_id, eligible.episodeId)
    assert.equal(first.body.blocked?.[0]?.episode_id, blocked.episodeId)
    assert.match(first.body.blocked?.[0]?.reason || '', /Scene Plan needs Subtitles/)
    assert.ok(first.body.blocked?.[0]?.issues?.some((issue: { code?: string; step?: string }) =>
      issue.code === 'missing_prerequisite' && issue.step === 'scene_plan',
    ))
    assert.ok(first.body.issues?.some((issue: { code?: string; episode_id?: string; step?: string }) =>
      issue.code === 'missing_prerequisite'
      && issue.episode_id === blocked.episodeId
      && issue.step === 'scene_plan',
    ))

    const replay = await request(app)
      .post(`/api/projects/${blocked.slug}/pipeline/run-batch`)
      .send(body)

    assert.equal(replay.status, 201, JSON.stringify(replay.body))
    assert.equal(replay.body.enqueued, 0)
    assert.equal((await jq.getJobs(blocked.slug)).filter(job => job.episode_id === eligible.episodeId).length, 1)
    assert.deepEqual(replay.body.blocked, first.body.blocked)
  } finally {
    for (const job of await jq.getJobs(blocked.slug)) {
      if (job.episode_id === eligible.episodeId) await jq.requestJobCancellation(blocked.slug, job.job_id)
    }
    await jq.setQueuePaused(false)
  }
})

void test('bulk preflight admits eligible Scene Plan episodes while retaining blocked reasons', async () => {
  const blocked = await seedEpisode()
  const eligible = await acceptSiblingEpisode(blocked.slug)
  await writeValidSubtitleTimeline(eligible.paths, eligible.episodeId)

  const response = await request(app)
    .post(`/api/projects/${blocked.slug}/pipeline/preflight`)
    .send({ episode_ids: [blocked.episodeId, eligible.episodeId], steps: ['scene_plan'] })

  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.ok, true)
  assert.deepEqual(response.body.eligible_episode_ids, [eligible.episodeId])
  assert.equal(response.body.blocked?.[0]?.episode_id, blocked.episodeId)
  assert.match(response.body.blocked?.[0]?.reason || '', /Scene Plan needs Subtitles/)
})

void test('targeted Scene Review rejects a missing Scene Plan before job creation', async () => {
  const fixture = await seedEpisode()
  await writeValidSubtitleTimeline(fixture.paths, fixture.episodeId)
  await assertRejectedWithoutJob(fixture.slug, fixture.episodeId, 'scene_review', 'scene_plan')
})

void test('targeted Scene Review accepts an authoritative complete Scene Plan', async () => {
  const fixture = await seedEpisode()
  await writeValidSubtitleTimeline(fixture.paths, fixture.episodeId)
  await fs.mkdir(fixture.paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(fixture.paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [{
      id: 'scene-001',
      scene_index: 1,
      start_sec: 0,
      end_sec: 1,
      transcript_segment: 'A complete subtitle timeline.',
      visual_prompt: 'A quiet archive lit by one warm lantern.',
    }],
  }))
  const response = await request(app)
    .post(`/api/projects/${fixture.slug}/pipeline/run-batch`)
    .send({ episode_ids: [fixture.episodeId], steps: ['scene_review'] })

  assert.equal(response.status, 201, JSON.stringify(response.body))
  const jobs = await jq.getJobs(fixture.slug)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.type, 'continuity_render')
})

// 1.4.288 — a final video alone was started on plans that stopped short (AF EP0136) and on
// plans with zero-length scenes (BW EP0040/41); it waited an hour in the assembly line to say so.
void test('targeted Video Assembly rejects a Scene Plan that is not done before job creation', async () => {
  const fixture = await seedEpisode()
  await pm.updateConfig(fixture.slug, {
    video_bundle_presets: [{ id: 'va', name: 'Video Assembly', type: 'video_assembly', data: {} }],
    video_bundle_last_preset: 'va',
  } as unknown as Parameters<typeof pm.updateConfig>[1])
  await writeValidSubtitleTimeline(fixture.paths, fixture.episodeId)
  await assertRejectedWithoutJob(fixture.slug, fixture.episodeId, 'video_assembly', 'scene_plan')
})

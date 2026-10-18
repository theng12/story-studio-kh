/**
 * The per-episode automatic-introduction gate, end to end.
 *
 * Contract:
 *   - an episode created while the switch was OFF has NO `intro_eligible` fact;
 *   - after the switch and the channel recipe are turned ON, a newly accepted
 *     episode records the fact and inherits the automatic opening;
 *   - preflight never marks the old episode as missing an opening, and
 *     run-batch never enqueues one for it.
 *
 * Manual generation is a separate route and is not exercised here.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let app: import('express').Express
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let segments: typeof import('../services/channel-segments.js')
let facts: typeof import('../lib/episode-creation-facts.js')
let introSegmentId: string
let wasQueuePaused = false

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  jq = await import('../services/job-queue.js')
  segments = await import('../services/channel-segments.js')
  facts = await import('../lib/episode-creation-facts.js')
  introSegmentId = (await import('../lib/episode-segments.js')).INTRODUCTION_SEGMENT_ID
  wasQueuePaused = jq.isQueuePaused()
  // Never execute the scripts the batch enqueues; this test is about WHICH
  // jobs are created, not about running a model.
  await jq.setQueuePaused(true)
})

after(async () => {
  await jq.setQueuePaused(true)
  for (const project of await pm.listProjects()) {
    for (const job of await jq.getJobs(project.slug)) {
      if (!['done', 'error', 'cancelled'].includes(job.status)) {
        await jq.requestJobCancellation(project.slug, job.job_id)
      }
      jq.removeTerminalJob(project.slug, job.job_id)
    }
  }
  await jq._waitForJobPersistenceForTesting()
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  if (!wasQueuePaused) await jq.setQueuePaused(false)
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  await cleanup()
})

const baseIdea = {
  logline: 'A line.', themes: ['a'], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
}

async function acceptOne(slug: string, title: string) {
  const [idea] = await im.addIdeas(slug, [{ ...baseIdea, title }], 'test-model')
  const result = await im.acceptIdea(slug, idea!.id)
  const info = JSON.parse(await fs.readFile(path.join(result.episode_dir, 'episode_info.json'), 'utf-8'))
  return { code: result.episode_code, info, episodeDir: result.episode_dir }
}

test('old episode is not enqueued or marked missing; a later episode inherits the opening', async () => {
  const project = await pm.createProject({ name: 'Future intro gate' })

  // 1. An episode exists BEFORE activation: no creation fact.
  const oldEpisode = await acceptOne(project.slug, 'Old episode')

  // 2. Activate the future-only switch and the channel recipe.
  await pm.updateProject(project.slug, { auto_introduction_enabled: true })
  await pm.updateConfig(project.slug, {
    script_presets: [{ id: 'sp1', name: 'default', type: 'script', data: { form: { model: 'gpt-4o', chapters: 5 }, customStyleText: '' } }],
    script_last_preset_script: 'sp1',
  } as any)
  await segments.saveChannelSegment(project.slug, introSegmentId, { enabled: true })

  // 3. A later episode captures the fact.
  const newEpisode = await acceptOne(project.slug, 'New episode')
  assert.equal('intro_eligible' in oldEpisode.info, false)
  assert.equal(newEpisode.info.intro_eligible, true)
  assert.equal(await facts.episodeIsIntroEligible(oldEpisode.episodeDir), false)
  assert.equal(await facts.episodeIsIntroEligible(newEpisode.episodeDir), true)

  const body = {
    episode_ids: [oldEpisode.code, newEpisode.code],
    steps: ['script-only', 'introduction-only'],
  }

  // 4. Preflight: the old episode gets neither the step nor a "missing" issue.
  const preflight = await request(app)
    .post(`/api/projects/${project.slug}/pipeline/preflight`)
    .send(body)
  assert.equal(preflight.status, 200, JSON.stringify(preflight.body))
  assert.ok(
    preflight.body.warnings.some((w: string) => w.includes(oldEpisode.code) && w.includes('not added automatically')),
    'the old episode is told, informationally, why no opening will be added',
  )
  assert.ok(
    !preflight.body.issues.some((issue: any) => issue.episode_id === oldEpisode.code
      && (issue.step === 'introduction-only' || issue.requires === 'introduction-only')),
    'an old episode is never reported as missing an introduction',
  )

  // 5. Run-batch: only the eligible episode gets an Introduction job.
  const run = await request(app)
    .post(`/api/projects/${project.slug}/pipeline/run-batch`)
    .send(body)
  assert.equal(run.status, 201, JSON.stringify(run.body))
  const introJobs = (await jq.getJobs(project.slug)).filter(job => job.type === 'introduction-only')
  assert.deepEqual(introJobs.map(job => job.episode_id), [newEpisode.code])

  // 6. The Scripts page's automatic tail uses the same authoritative fact:
  // an explicit `automatic` request for the old episode is declined before any
  // paid work is queued. Manual calls omit `automatic` and are unaffected.
  const automatic = await request(app)
    .post(`/api/projects/${project.slug}/generate/introduction-only`)
    .send({ episode_id: oldEpisode.code, automatic: true })
  assert.equal(automatic.status, 200, JSON.stringify(automatic.body))
  assert.equal(automatic.body.skipped, true)
  assert.equal(
    (await jq.getJobs(project.slug)).filter(job => job.type === 'introduction-only' && job.episode_id === oldEpisode.code).length,
    0,
  )
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Job } from '../models/types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import express from 'express'
import request from 'supertest'
import { pathToFileURL } from 'node:url'

const subject = () => import('../services/episode-recovery.js')
const source = (type: Job['type'], params = {}): Job => ({
  job_id: type, project_slug: 'test', episode_id: 'EP0001', type, params,
  status: 'error', title: type, created_at: '2026-09-05T00:00:00Z',
  started_at: null, finished_at: null, error: 'failed', output_lines: [],
})
const rows = () => [source('subtitles_transcribe', { sections: ['Chapter_02', 'Chapter_16'], force: true }), source('scene_plan_run'), source('continuity_render')]
const ready = { audio_merge: true, subtitle_sections: true, subtitle_stitch: true, scene_plan_run: true, contextual_cues: true, continuity_render: true }

test('first unresolved prerequisite owns dispatch; failed downstream rows are deferred', async () => {
  const { createEpisodeRecoveryPlan, nextEpisodeRecoveryStep } = await subject()
  const plan = createEpisodeRecoveryPlan(rows())
  const step = nextEpisodeRecoveryStep(plan, { ...ready, subtitle_sections: false, subtitle_stitch: false, scene_plan_run: false, continuity_render: false })
  assert.equal(step, 'subtitle_sections')
  assert.deepEqual(plan.completed, ['audio_merge'])
  assert.equal(plan.first_unresolved, 'subtitle_sections')
  assert.deepEqual(plan.steps.subtitle_sections?.params.sections, ['Chapter_02', 'Chapter_16'])
  assert.equal(plan.steps.subtitle_sections?.params.force, false)
})

test('stitch verification blocks Scene Plan even when all sections are ready', async () => {
  const { createEpisodeRecoveryPlan, nextEpisodeRecoveryStep } = await subject()
  const plan = createEpisodeRecoveryPlan(rows())
  assert.equal(nextEpisodeRecoveryStep(plan, { ...ready, subtitle_stitch: false }), 'subtitle_stitch')
  assert.deepEqual(plan.completed, ['audio_merge', 'subtitle_sections'])
})

test('restart retains dispatch identities and completes edges strictly in order', async () => {
  const { createEpisodeRecoveryPlan, nextEpisodeRecoveryStep } = await subject()
  const plan = createEpisodeRecoveryPlan(rows())
  const subtitleId = plan.steps.subtitle_sections?.job_id
  nextEpisodeRecoveryStep(plan, { ...ready, subtitle_sections: false })
  const restarted = JSON.parse(JSON.stringify(plan))
  assert.equal(restarted.steps.subtitle_sections.job_id, subtitleId)
  assert.equal(nextEpisodeRecoveryStep(restarted, { ...ready, scene_plan_run: false }), 'scene_plan_run')
  assert.deepEqual(restarted.completed, ['audio_merge', 'subtitle_sections', 'subtitle_stitch'])
  assert.equal(nextEpisodeRecoveryStep(restarted, ready), null)
  assert.equal(nextEpisodeRecoveryStep(restarted, ready), null)
})

test('required contextual cues defer Scene Review; unselected cues are not invented', async () => {
  const { createEpisodeRecoveryPlan, nextEpisodeRecoveryStep } = await subject()
  const plan = createEpisodeRecoveryPlan([...rows(), source('contextual_cues', { auto_approve: false })])
  assert.equal(nextEpisodeRecoveryStep(plan, { ...ready, contextual_cues: false, continuity_render: false }), 'contextual_cues')
  assert.equal(plan.steps.contextual_cues?.params.auto_approve, false)
  assert.equal(createEpisodeRecoveryPlan(rows()).steps.contextual_cues, undefined)
})

test('saved missing set narrows but never widens an exact source allow-list', async () => {
  const { createEpisodeRecoveryPlan } = await subject()
  const jobs = rows()
  jobs[0].result = { missing_sections: ['Chapter_02', 'Chapter_99'] }
  assert.deepEqual(createEpisodeRecoveryPlan(jobs).steps.subtitle_sections?.params.sections, ['Chapter_02'])
  jobs[0].result = { missing_sections: [] }
  assert.deepEqual(createEpisodeRecoveryPlan(jobs).steps.subtitle_sections?.params.sections, [])
  assert.throws(() => createEpisodeRecoveryPlan([source('subtitles_transcribe', { sections: 'Chapter_02' })]), /scope/i)
  assert.throws(() => createEpisodeRecoveryPlan([source('subtitles_transcribe', { sections: ['Chapter_02', 99] })]), /scope/i)
})

test('explicit cancelled source selection owns settings even beside a newer unrelated row', async () => {
  const { createEpisodeRecoveryPlan } = await subject()
  const chosen = { ...source('subtitles_transcribe', { force: true, sections: ['Chapter_02'], model: 'chosen' }), status: 'cancelled' as const }
  const newer = { ...chosen, job_id: 'newer-other', status: 'done' as const, created_at: '2026-09-06T00:00:00Z', params: { sections: ['Chapter_99'], model: 'other' } }
  const plan = createEpisodeRecoveryPlan([chosen, newer], [chosen.job_id])
  assert.deepEqual(plan.steps.subtitle_sections?.params.sections, ['Chapter_02'])
  assert.equal(plan.steps.subtitle_sections?.params.model, 'chosen')
  assert.equal(plan.steps.subtitle_sections?.params.force, false)
})

test('episode recovery directs a manual image Finish back to current Scene Review settings', async () => {
  const temp = await useTempDataDir()
  try {
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Manual image Finish recovery boundary' })
    const manual = { ...source('continuity_render', {
      model: 'historical-model',
      manual_image_finish: { action_id: 'manual-action', replace_uncertain: false },
    }), project_slug: project.slug }
    const plan = createEpisodeRecoveryPlan([manual])
    manual.job_id = plan.steps.continuity_render!.job_id
    await dispatchEpisodeRecoveryStep(plan, {
      verified: { ...ready, continuity_render: false }, message: 'Images are incomplete',
    }, [manual], [manual.job_id])
    assert.equal(manual.status, 'error')
    assert.match(plan.message, /Open Scene Review.*current model settings/i)
  } finally {
    await temp.cleanup()
  }
})

test('a terminal manual image Finish source cannot mint a recovery queue identity', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const { router } = await import('../routes/jobs.js')
    const project = await pm.createProject({ name: 'Manual image Finish retry boundary' })
    await jq.setQueuePaused(true)
    const manual = { ...source('continuity_render', {
      model: 'historical-model',
      manual_image_finish: { action_id: 'manual-action', replace_uncertain: false },
    }), job_id: 'terminal-manual-finish', project_slug: project.slug }
    await jq.writeAuthoritativeJob(manual)
    await jq.getJobs(project.slug)
    const app = express().use(express.json()).use(router)

    const response = await request(app)
      .post(`/projects/${project.slug}/jobs/${manual.job_id}/retry`)
      .send({})

    assert.equal(response.status, 202, JSON.stringify(response.body))
    assert.match(response.body.plan.message, /Open Scene Review.*current model settings/i)
    assert.equal(response.body.plan.steps.continuity_render.manual_image_finish_withheld, true)
    assert.equal(response.body.plan.steps.continuity_render.params.manual_image_finish, undefined)
    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.job_id), [manual.job_id])
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a restored recovery plan with copied manual authority is fenced before dispatch or resume', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Restored manual image recovery boundary' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, recoverEpisode } = await subject()
    const manual = { ...source('continuity_render', {
      manual_image_finish: { action_id: 'original-manual-action', replace_uncertain: false },
    }), job_id: 'restored-manual-source', project_slug: project.slug }
    await jq.writeAuthoritativeJob(manual)
    await jq.getJobs(project.slug)
    const plan = JSON.parse(JSON.stringify(createEpisodeRecoveryPlan([
      manual,
    ])))
    delete plan.steps.continuity_render.manual_image_finish_withheld
    plan.steps.continuity_render.params.manual_image_finish = {
      action_id: 'copied-by-old-plan', replace_uncertain: false,
    }
    await fs.writeFile(path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json'), JSON.stringify({
      version: 1, plans: { EP0001: plan },
    }))

    const restored = (await recoverEpisode(project.slug, 'EP0001', true, [manual.job_id]))!

    assert.match(restored.message, /Open Scene Review.*current model settings/i)
    assert.equal(restored.steps.continuity_render?.manual_image_finish_withheld, true)
    assert.equal(restored.steps.continuity_render?.params.manual_image_finish, undefined)
    const saved = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json'), 'utf8'))
    assert.equal(saved.plans.EP0001.steps.continuity_render.manual_image_finish_withheld, true)
    assert.equal(saved.plans.EP0001.steps.continuity_render.params.manual_image_finish, undefined)
    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.job_id), [manual.job_id])
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a restored continuation cannot dispatch copied manual image authority', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Restored manual continuation boundary' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const plan = createEpisodeRecoveryPlan([{ ...source('scene_plan_run'), project_slug: project.slug }])
    plan.continuation = [
      { type: 'metadata', params: { model: 'saved-metadata-model' } },
      { type: 'continuity_render', params: {
        manual_image_finish: { action_id: 'copied-continuation', replace_uncertain: true },
      } },
    ]

    await dispatchEpisodeRecoveryStep(plan, { verified: ready, message: 'Complete' }, [])

    assert.match(plan.message, /Open Scene Review.*current model settings/i)
    assert.equal(plan.continuation[1].manual_image_finish_withheld, true)
    assert.equal(plan.continuation[1].params?.manual_image_finish, undefined)
    assert.deepEqual(await jq.getJobs(project.slug), [])
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('mixed episode recovery advances ordinary prerequisites but stops at manual image Finish', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Mixed manual image recovery boundary' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const plan = createEpisodeRecoveryPlan([
      { ...source('scene_plan_run'), project_slug: project.slug },
      { ...source('continuity_render', {
        manual_image_finish: { action_id: 'withheld-after-plan', replace_uncertain: false },
      }), project_slug: project.slug },
    ])
    const facts = { verified: { ...ready, scene_plan_run: false, continuity_render: false }, message: 'Incomplete' }

    await dispatchEpisodeRecoveryStep(plan, facts, [])
    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.type), ['scene_plan_run'])
    await jq.mutateAuthoritativeJob(project.slug, plan.steps.scene_plan_run!.job_id, job => ({ ...job, status: 'done' }))
    facts.verified.scene_plan_run = true
    await dispatchEpisodeRecoveryStep(plan, facts, await jq.getJobs(project.slug))

    assert.match(plan.message, /Open Scene Review.*current model settings/i)
    assert.equal((await jq.getJobs(project.slug)).some(job => job.type === 'continuity_render'), false)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('pipeline continuation is captured without creating a competing downstream chain', async () => {
  const { createEpisodeRecoveryPlan } = await subject()
  const plan = createEpisodeRecoveryPlan([source('subtitles_transcribe', {
    sections: ['Chapter_02'], pipeline_chain: [{ type: 'scene_plan_run', params: { model: 'selected' } }, { type: 'continuity_render', params: {} }],
  })])
  assert.equal(plan.target, 'continuity_render')
  assert.equal(plan.steps.scene_plan_run?.params.model, 'selected')
  assert.equal(plan.steps.subtitle_sections?.params.pipeline_chain, undefined)
  const subtitleOnlyTail = createEpisodeRecoveryPlan([source('subtitles_transcribe', {
    pipeline_chain: [{ type: 'metadata', params: { model: 'chosen' } }],
  })])
  assert.equal(subtitleOnlyTail.continuation?.[0].type, 'metadata')
})

test('cancelled recovery clears forced generation from every pipeline child and tail before durable dispatch', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Cancelled pipeline force boundary' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const cancelled = { ...source('subtitles_transcribe', { force: true, sections: ['Chapter_02'], pipeline_chain: [
      { type: 'scene_plan_run', params: { force: true, model: 'chosen-planner' } },
      { type: 'continuity_render', params: { force: true, image_model: 'chosen-image', reference_strength: 0.7 } },
      { type: 'metadata', params: { force: true, model: 'chosen-metadata' } },
      { type: 'thumb_images', params: { force: true, mode: 'thumbs', selected_indices: [2] } },
      { type: 'audio', params: { force: true, no_overwrite: true, generation_mode: 'new_version', sections: ['Chapter_02'], voice: 'chosen-voice' } },
    ] }), project_slug: project.slug, status: 'cancelled' as const }
    const before = structuredClone(cancelled)
    const plan = createEpisodeRecoveryPlan([cancelled], [cancelled.job_id])
    assert.equal(plan.steps.scene_plan_run?.params.force, false)
    assert.deepEqual(plan.steps.continuity_render?.params, { force: false, image_model: 'chosen-image', reference_strength: 0.7 })
    assert.deepEqual(plan.continuation?.map(node => node.params), [
      { force: false, model: 'chosen-metadata' }, { force: false, mode: 'thumbs', selected_indices: [2] },
      { force: false, no_overwrite: false, generation_mode: 'skip', sections: ['Chapter_02'], voice: 'chosen-voice' },
    ])
    assert.deepEqual(cancelled, before, 'source force/cancellation evidence remains untouched')
    await dispatchEpisodeRecoveryStep(plan, { verified: { ...ready, continuity_render: false }, message: 'prerequisites ready' }, [])
    const review = jq.getJob(plan.steps.continuity_render!.job_id)!
    assert.equal(review.type, 'continuity_render')
    assert.equal(review.params.force, false, 'the executor receives no force re-render intent')
    assert.equal(review.params.image_model, 'chosen-image')
    await jq.mutateAuthoritativeJob(project.slug, review.job_id, job => ({ ...job, status: 'done' }))
    await dispatchEpisodeRecoveryStep(plan, { verified: ready, message: 'complete' }, await jq.getJobs(project.slug))
    const tail = (await jq.getJobs(project.slug)).find(job => job.type === 'metadata')!
    assert.equal(tail.params.force, false)
    assert.deepEqual(tail.params.pipeline_chain, [
      { type: 'thumb_images', params: { force: false, mode: 'thumbs', selected_indices: [2] } },
      { type: 'audio', params: { force: false, no_overwrite: false, generation_mode: 'skip', sections: ['Chapter_02'], voice: 'chosen-voice' } },
    ])
    const disk = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'jobs.json'), 'utf8'))
    assert.equal(disk.jobs.find((job: Job) => job.job_id === review.job_id).params.force, false)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('repeated dispatch and process reload reuse the durable job, including terminal outcomes', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Episode recovery dispatch' })
    await jq.setQueuePaused(true)
    const options = { project_slug: project.slug, episode_id: 'EP0001', type: 'scene_plan_run' as const,
      params: { model: 'saved-model', episode_recovery_id: 'plan-one' } }
    const results = await Promise.all(Array.from({ length: 4 }, () => jq.enqueueEpisodeRecoveryOnce('edge-one', options)))
    assert.equal(new Set(results.map(j => j.job_id)).size, 1)
    const disk = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'jobs.json'), 'utf8'))
    assert.equal(disk.jobs.filter((j: Job) => j.job_id === 'edge-one').length, 1)
    assert.equal(disk.jobs.find((j: Job) => j.job_id === 'edge-one').params.model, 'saved-model')
    await jq.mutateAuthoritativeJob(project.slug, 'edge-one', job => ({ ...job, status: 'done' }))
    assert.equal((await jq.enqueueEpisodeRecoveryOnce('edge-one', options)).status, 'done')
    assert.equal((await jq.getJobs(project.slug)).length, 1)
    const restarted = await import(`${pathToFileURL(path.resolve('server/services/job-queue.ts')).href}?recovery-restart`)
    assert.equal((await restarted.enqueueEpisodeRecoveryOnce('edge-one', options)).status, 'done')
    assert.equal((await restarted.getJobs(project.slug)).length, 1)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})

test('subtitle source verification rejects empty and malformed chapters even beside a complete-looking stitch', async () => {
  const temp = await useTempDataDir()
  try {
    const subs = path.join(temp.dir, 'subs')
    await fs.mkdir(subs)
    await fs.writeFile(path.join(temp.dir, 'audio_chapters.json'), JSON.stringify({ sections: [
      { slug: 'Chapter_01', duration_s: 4 }, { slug: 'Chapter_02', duration_s: 4 }, { slug: 'Chapter_03', duration_s: 4 },
    ] }))
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nReal words\n'
    await fs.writeFile(path.join(subs, 'EP0001_Chapter_01.srt'), srt)
    await fs.writeFile(path.join(subs, 'EP0001_Chapter_02.srt'), '')
    await fs.writeFile(path.join(subs, 'EP0001_Chapter_03.srt'), 'not subtitle cues')
    await fs.writeFile(path.join(subs, 'EP0001_stitched.srt'), srt)
    const { inspectRecoverySubtitles } = await subject()
    assert.deepEqual(await inspectRecoverySubtitles(temp.dir, subs, 'EP0001'), {
      expected: ['Chapter_01', 'Chapter_02', 'Chapter_03'], missing: ['Chapter_02', 'Chapter_03'], complete: false,
    })
    await fs.writeFile(path.join(subs, 'EP0001_Chapter_02.srt'), srt)
    await fs.writeFile(path.join(subs, 'EP0001_Chapter_03.srt'), srt)
    assert.equal((await inspectRecoverySubtitles(temp.dir, subs, 'EP0001')).complete, true)
  } finally { await temp.cleanup() }
})

test('local recovery repairs malformed stitch metadata and re-stitches changed sources before releasing the edge', async () => {
  const temp = await useTempDataDir()
  try {
    const subs = path.join(temp.dir, 'subs'), merged = path.join(temp.dir, 'merged')
    await fs.mkdir(subs); await fs.mkdir(merged)
    await fs.writeFile(path.join(temp.dir, 'audio_chapters.json'), JSON.stringify({ gap_duration_s: 0, sections: [{ slug: 'Chapter_01', duration_s: 4 }] }))
    const sourcePath = path.join(subs, 'EP0001_Chapter_01.srt')
    await fs.writeFile(sourcePath, '1\n00:00:00,000 --> 00:00:02,000\nHello\n')
    await fs.writeFile(path.join(merged, 'EP0001_merged_audio.mp3'), 'fixture')
    await fs.writeFile(path.join(merged, 'EP0001_merged_audio.completion.json'), JSON.stringify({ output_filename: 'EP0001_merged_audio.mp3', opening: { lead_in_sec: 0, music_lead_in_sec: 0 } }))
    const { ensureRecoveryStitch } = await subject()
    const opts = { episodeDir: temp.dir, subtitlesDir: subs, mergedAudioDir: merged, episodeCode: 'EP0001' }
    assert.equal(await ensureRecoveryStitch(opts), true)
    const metaPath = path.join(subs, 'EP0001_stitched.srt.json')
    const before = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    await fs.writeFile(metaPath, JSON.stringify({ ...before, complete: false, sections: [] }))
    assert.equal(await ensureRecoveryStitch(opts), true)
    assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).complete, true)
    await fs.writeFile(sourcePath, '1\n00:00:01,000 --> 00:00:03,000\nChanged source\n')
    assert.equal(await ensureRecoveryStitch(opts), true)
    assert.notEqual(JSON.parse(await fs.readFile(metaPath, 'utf8')).timeline.sha256, before.timeline.sha256)
    await fs.writeFile(sourcePath, 'malformed')
    assert.equal(await ensureRecoveryStitch(opts), false)
  } finally { await temp.cleanup() }
})

test('verified subtitle recovery continues through Scene Plan and cues to Scene Review once each', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Ordered recovery continuation' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    let plan = createEpisodeRecoveryPlan([...rows(), source('contextual_cues')].map(job => ({ ...job, project_slug: project.slug })))
    const facts = { verified: { ...ready, subtitle_sections: false, subtitle_stitch: false, scene_plan_run: false, contextual_cues: false, continuity_render: false },
      message: '14/16 sections ready', missing: ['Chapter_02', 'Chapter_16'] }
    const advance = async () => dispatchEpisodeRecoveryStep(plan, facts, await jq.getJobs(project.slug))
    await advance()
    await advance()
    assert.deepEqual((await jq.getJobs(project.slug)).map(job => job.type), ['subtitles_transcribe'])
    const subs = plan.steps.subtitle_sections!
    assert.deepEqual(jq.getJob(subs.job_id)?.params.sections, ['Chapter_02', 'Chapter_16'])
    await jq.mutateAuthoritativeJob(project.slug, subs.job_id, job => ({ ...job, status: 'done' }))
    facts.verified.subtitle_sections = true
    await advance()
    assert.equal(plan.first_unresolved, 'subtitle_stitch')
    assert.equal((await jq.getJobs(project.slug)).length, 1)
    facts.verified.subtitle_stitch = true
    await advance()
    plan = JSON.parse(JSON.stringify(plan)) // restart between dispatch and completion
    await advance()
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'scene_plan_run').length, 1)
    await jq.mutateAuthoritativeJob(project.slug, plan.steps.scene_plan_run!.job_id, job => ({ ...job, status: 'done' }))
    facts.verified.scene_plan_run = true
    await advance()
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'continuity_render').length, 0)
    await jq.mutateAuthoritativeJob(project.slug, plan.steps.contextual_cues!.job_id, job => ({ ...job, status: 'done' }))
    facts.verified.contextual_cues = true
    await advance()
    await advance()
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'continuity_render').length, 1)
    // A pruned completed edge must not become fresh generation on the next Retry All.
    await jq.mutateAuthoritativeJob(project.slug, plan.steps.continuity_render!.job_id, job => ({ ...job, status: 'done' }))
    await dispatchEpisodeRecoveryStep(plan, facts, [])
    assert.match(plan.message, /already dispatched/i)
    plan.continuation = [{ type: 'metadata', params: { model: 'saved-metadata-model' } }]
    await dispatchEpisodeRecoveryStep(plan, { verified: ready, message: 'complete' }, [])
    await dispatchEpisodeRecoveryStep(JSON.parse(JSON.stringify(plan)), { verified: ready, message: 'complete' }, [])
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'metadata').length, 1)
    assert.equal(plan.continuation_dispatched, true)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('settlement polling resumes the same subtitle job only when due; paid blocks never auto-resume', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Free settlement recovery' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const plan = createEpisodeRecoveryPlan(rows().map(job => ({ ...job, project_slug: project.slug })))
    const facts = { verified: { ...ready, subtitle_sections: false }, message: '14/16 sections ready', missing: ['Chapter_02', 'Chapter_16'] }
    await dispatchEpisodeRecoveryStep(plan, facts, [])
    const id = plan.steps.subtitle_sections!.job_id
    const fail = (state: string) => jq.mutateAuthoritativeJob(project.slug, id, job => ({ ...job, status: 'error',
      params: { ...job.params, subtitle_recovery: { sections: { Chapter_02: { state, message: 'Waiting for credit settlement' } } } } }))
    await fail('waiting_settlement')
    await dispatchEpisodeRecoveryStep(plan, facts, await jq.getJobs(project.slug))
    assert.equal(jq.getJob(id)?.status, 'error', 'a repeated completion signal cannot busy-loop')
    plan.next_free_check_at = '2000-01-01T00:00:00Z'
    await dispatchEpisodeRecoveryStep(plan, facts, await jq.getJobs(project.slug))
    assert.equal(jq.getJob(id)?.status, 'queued')
    assert.equal((await jq.getJobs(project.slug)).length, 1)
    await fail('paid_blocked')
    plan.next_free_check_at = '2000-01-01T00:00:00Z'
    await dispatchEpisodeRecoveryStep(plan, facts, await jq.getJobs(project.slug))
    assert.equal(jq.getJob(id)?.status, 'error')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('explicit recovery Retry re-enters failed download, transport, and Scene Plan edges once without a new identity', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    await jq.setQueuePaused(true)
    for (const [index, failure] of ['Download interrupted', 'Transport unavailable', 'Scene Plan response lost'].entries()) {
      const project = await pm.createProject({ name: `Explicit failed edge ${index}` })
      const plan = createEpisodeRecoveryPlan(rows().map(job => ({ ...job, project_slug: project.slug })))
      const isScene = index === 2
      const facts = { verified: { ...ready, ...(isScene ? { scene_plan_run: false } : { subtitle_sections: false }) }, message: '', missing: ['Chapter_02'] }
      await dispatchEpisodeRecoveryStep(plan, facts, [])
      const id = plan.steps[isScene ? 'scene_plan_run' : 'subtitle_sections']!.job_id
      const originalPosition = (await jq.getJobs(project.slug))[0].queue_position
      await jq.mutateAuthoritativeJob(project.slug, id, job => ({ ...job, status: 'error', error: failure,
        params: { ...job.params, force: isScene, durable_request_key: 'original-key', subtitle_recovery_plan_id: 'original-budget' } }))
      await dispatchEpisodeRecoveryStep(plan, facts, await jq.getJobs(project.slug))
      assert.equal(jq.getJob(id)?.status, 'error', 'automatic observation does not loop terminal failures')
      const restarted = JSON.parse(JSON.stringify(plan))
      await Promise.all([1, 2].map(async () => dispatchEpisodeRecoveryStep(restarted, facts, await jq.getJobs(project.slug), [id])))
      assert.equal(jq.getJob(id)?.status, 'queued')
      assert.equal(jq.getJob(id)?.params.durable_request_key, 'original-key')
      assert.equal(jq.getJob(id)?.params.subtitle_recovery_plan_id, 'original-budget')
      assert.equal(jq.getJob(id)?.params.force, isScene, 'explicit retry retains the same prior operation, never a fresh epoch')
      assert.equal((await jq.getJobs(project.slug)).length, 1)
      assert.equal((await jq.getJobs(project.slug))[0].queue_position, originalPosition)
    }
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('whole-track recovery retains merged scope through failure, restart, and verified success without chapter jobs', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Whole track recovery' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep, inspectRecoverySubtitles, inspectRecoverySubtitlePrerequisites } = await subject()
    const job = { ...source('subtitles_transcribe', { per_chapter: false, force: false, sections: ['ignored-in-whole-track-mode'], subtitle_recovery_plan_id: 'accepted-merged' }), project_slug: project.slug,
      result: { missing_sections: ['merged'] } }
    const plan = createEpisodeRecoveryPlan([job])
    const subs = path.join(temp.dir, 'whole-subs')
    await fs.mkdir(subs)
    const failed = await inspectRecoverySubtitles(temp.dir, subs, 'EP0001', false)
    assert.deepEqual(failed, { expected: ['merged'], missing: ['merged'], complete: false })
    const facts = { verified: { ...ready, subtitle_sections: false }, message: '0/1 track ready', missing: failed.missing }
    await dispatchEpisodeRecoveryStep(plan, facts, [])
    const id = plan.steps.subtitle_sections!.job_id
    assert.equal(jq.getJob(id)?.params.per_chapter, false)
    assert.deepEqual(jq.getJob(id)?.params.sections, ['merged'])
    await jq.mutateAuthoritativeJob(project.slug, id, row => ({ ...row, status: 'error', error: 'accepted track download interrupted' }))
    await dispatchEpisodeRecoveryStep(JSON.parse(JSON.stringify(plan)), facts, await jq.getJobs(project.slug), [id])
    assert.equal(jq.getJob(id)?.status, 'queued')
    await fs.writeFile(path.join(subs, 'EP0001_whisper.srt'), '1\n00:00:00,000 --> 00:00:02,000\nRecovered whole track\n')
    assert.deepEqual(await inspectRecoverySubtitles(temp.dir, subs, 'EP0001', false), { expected: ['merged'], missing: [], complete: true })
    await jq.mutateAuthoritativeJob(project.slug, id, row => ({ ...row, status: 'done' }))
    const paths = { episodeDir: temp.dir, subtitlesDir: subs, mergedAudioDir: path.join(temp.dir, 'merged'), episodeCode: 'EP0001' }
    const success = await inspectRecoverySubtitlePrerequisites(plan, paths, await jq.getJobs(project.slug))
    await dispatchEpisodeRecoveryStep(plan, success, await jq.getJobs(project.slug))
    assert.equal(plan.first_unresolved, null)
    assert.equal((await jq.getJobs(project.slug)).length, 1)
    assert.equal(jq.getJob(id)?.params.subtitle_recovery_plan_id, 'accepted-merged')
    const downstream = createEpisodeRecoveryPlan([job, { ...source('scene_plan_run'), project_slug: project.slug }])
    const blocked = await inspectRecoverySubtitlePrerequisites(downstream, paths, [])
    assert.equal(blocked.verified.subtitle_sections, true)
    assert.equal(blocked.verified.subtitle_stitch, false)
    assert.match(blocked.message, /Whole-track transcription is complete.*verified per-section subtitle stitch/)
    await dispatchEpisodeRecoveryStep(downstream, blocked, [])
    assert.equal(downstream.first_unresolved, 'subtitle_stitch')
    assert.equal((await jq.getJobs(project.slug)).length, 1, 'no invented chapter job or early Scene Plan')
    await fs.mkdir(paths.mergedAudioDir)
    await fs.writeFile(path.join(temp.dir, 'audio_chapters.json'), JSON.stringify({ gap_duration_s: 0, sections: [{ slug: 'Chapter_01', duration_s: 4 }] }))
    await fs.writeFile(path.join(subs, 'EP0001_Chapter_01.srt'), '1\n00:00:00,000 --> 00:00:02,000\nExisting chapter\n')
    await fs.writeFile(path.join(paths.mergedAudioDir, 'EP0001_merged_audio.mp3'), 'fixture')
    await fs.writeFile(path.join(paths.mergedAudioDir, 'EP0001_merged_audio.completion.json'), JSON.stringify({ output_filename: 'EP0001_merged_audio.mp3', opening: { lead_in_sec: 0, music_lead_in_sec: 0 } }))
    assert.equal((await inspectRecoverySubtitlePrerequisites(downstream, paths, [])).verified.subtitle_stitch, true)
    const chapter = await fs.readFile(path.join(subs, 'EP0001_Chapter_01.srt'), 'utf8')
    assert.match(chapter, /Existing chapter/)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('an active or cancelled prerequisite cannot release downstream work from stale ready artifacts', async () => {
  const temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const jq = await import('../services/job-queue.js')
  const project = await pm.createProject({ name: 'Active prerequisite proof' })
  await jq.setQueuePaused(true)
  try {
  const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
  const plan = createEpisodeRecoveryPlan(rows().map(job => ({ ...job, project_slug: project.slug })))
  const active = { ...source('scene_plan_run'), status: 'running' as const }
  await dispatchEpisodeRecoveryStep(plan, { verified: { ...ready, continuity_render: false }, message: '' }, [active])
  assert.equal(plan.first_unresolved, 'scene_plan_run')
  const cancelled = { ...active, status: 'cancelled' as const, params: { episode_recovery_id: plan.id } }
  await dispatchEpisodeRecoveryStep(plan, { verified: { ...ready, continuity_render: false }, message: '' }, [cancelled])
  assert.equal(plan.first_unresolved, 'scene_plan_run')
  assert.match(plan.message, /cancel/i)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('episode plans persist once and hold existing failed downstream rows behind audio repair', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Episode recovery plan persistence' })
    const jobs = rows().map(job => ({ ...job, project_slug: project.slug }))
    for (const job of jobs) await jq.writeAuthoritativeJob(job)
    await jq.getJobs(project.slug)
    const { recoverEpisode } = await subject()
    const plans = await Promise.all([recoverEpisode(project.slug, 'EP0001'), recoverEpisode(project.slug, 'EP0001')])
    assert.equal(plans[0]!.id, plans[1]!.id)
    assert.equal(plans[0]!.first_unresolved, 'audio_merge')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.status === 'queued').length, 0)
    assert.equal(jq.getJob('scene_plan_run')?.params.episode_recovery.deferred, true)
    const saved = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json'), 'utf8'))
    assert.equal(Object.keys(saved.plans).length, 1)
    assert.equal((await recoverEpisode(project.slug, 'EP0001'))!.id, saved.plans.EP0001.id)
    const { router } = await import('../routes/jobs.js')
    const app = express().use(express.json()).use(router)
    const response = await request(app).post(`/projects/${project.slug}/jobs/recover-episode/EP0001`).send({ sections: ['Chapter_99'] })
    assert.equal(response.status, 400)
    const valid = await request(app).post(`/projects/${project.slug}/jobs/recover-episode/EP0001`).send({})
    assert.equal(valid.status, 202)
    assert.equal(valid.body.plan.id, saved.plans.EP0001.id)
    const deferred = await request(app).post(`/projects/${project.slug}/jobs/scene_plan_run/retry`).send({})
    assert.equal(deferred.status, 202)
    assert.equal(deferred.body.plan.first_unresolved, 'audio_merge')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.status === 'queued').length, 0)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('manual purchase replay keeps one Story job and exact persisted sections even after it finishes', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Subtitle purchase replay' })
    await jq.setQueuePaused(true)
    const job = { ...source('subtitles_transcribe', { sections: ['Chapter_02'], subtitle_recovery_plan_id: 'paid-plan', episode_recovery_id: 'dag-plan' }),
      job_id: 'buy-source', project_slug: project.slug, result: { missing_sections: ['Chapter_02'] } }
    await jq.writeAuthoritativeJob(job)
    const { router } = await import('../routes/video.js')
    const app = express().use(express.json()).use(router)
    const url = `/projects/${project.slug}/video-editor/subtitles/buy-missing/buy-source`
    const first = await request(app).post(url).send({ additional_credit_ceiling: 12, sections: ['Chapter_99'] })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    await jq.mutateAuthoritativeJob(project.slug, first.body.job_id, row => ({ ...row, status: 'done' }))
    const replay = await request(app).post(url).send({ additional_credit_ceiling: 12 })
    assert.equal(replay.status, 201)
    assert.equal(replay.body.job_id, first.body.job_id)
    assert.deepEqual(replay.body.params.sections, ['Chapter_02'])
    assert.equal(replay.body.params.episode_recovery_id, 'dag-plan')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('explicit cancelled retries create one new topological plan while preserving all cancellation tombstones', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Explicit cancelled episode retry' })
    await jq.setQueuePaused(true)
    const { recoverEpisode, dispatchEpisodeRecoveryStep } = await subject()
    const original = rows().map(job => ({ ...job, job_id: `cancel-source-${job.type}`, project_slug: project.slug, params: { ...job.params, force: true } }))
    for (const job of original) await jq.writeAuthoritativeJob(job)
    const old = (await recoverEpisode(project.slug, 'EP0001'))!
    for (const job of original) await jq.mutateAuthoritativeJob(project.slug, job.job_id, row => ({ ...row, status: 'cancelled' }))
    const tombstones = await jq.getJobs(project.slug)
    assert.equal((await recoverEpisode(project.slug, 'EP0001', false))!.id, old.id, 'automatic continuation cannot create a new cancellation epoch')
    const { router } = await import('../routes/jobs.js')
    const app = express().use(express.json()).use(router)
    const url = `/projects/${project.slug}/jobs/recover-episode/EP0001`
    const intent = { source_job_ids: original.map(job => job.job_id) }
    const [first, duplicate] = await Promise.all([request(app).post(url).send(intent), request(app).post(url).send(intent)])
    assert.equal(first.status, 202, JSON.stringify(first.body))
    const plan = first.body.plan
    assert.notEqual(plan.id, old.id)
    assert.equal(duplicate.body.plan.id, plan.id)
    assert.equal(plan.first_unresolved, 'audio_merge')
    assert.equal(plan.steps.subtitle_sections.params.force, false)
    assert.equal(plan.steps.scene_plan_run.params.force, false)
    assert.equal(plan.steps.continuity_render.params.force, false)
    assert.deepEqual(plan.steps.subtitle_sections.params.sections, ['Chapter_02', 'Chapter_16'])
    for (const job of original) {
      const single = await request(app).post(`/projects/${project.slug}/jobs/${job.job_id}/retry`).send({})
      assert.equal(single.status, 202)
      assert.equal(single.body.plan.id, plan.id)
    }
    const all = await request(app).post(`/jobs/all/${original[0].job_id}/retry`).send({})
    assert.equal(all.body.plan.id, plan.id)
    assert.deepEqual(await jq.getJobs(project.slug), tombstones, 'cancelled rows are neither resumed, deleted, nor relabelled')
    const saved = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json'), 'utf8'))
    assert.equal(saved.retired_plans[old.id].id, old.id)
    assert.equal((await request(app).post(url).send({ source_job_ids: ['not-owned'] })).status, 409)
    assert.equal((await request(app).post(url).send({ ...intent, force: true })).status, 400)
    await dispatchEpisodeRecoveryStep(plan, { verified: { ...ready, subtitle_sections: false, subtitle_stitch: false, scene_plan_run: false, continuity_render: false }, message: '', missing: ['Chapter_02', 'Chapter_16'] }, await jq.getJobs(project.slug))
    const fresh = (await jq.getJobs(project.slug)).filter(job => job.status !== 'cancelled')
    assert.deepEqual(fresh.map(job => job.type), ['subtitles_transcribe'])
    assert.equal(fresh[0].params.force, false)
    assert.deepEqual(fresh[0].params.sections, ['Chapter_02', 'Chapter_16'])
    assert.notEqual(fresh[0].job_id, 'subtitles_transcribe')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('individual cancelled DAG retries start through the owned queue route without reviving any original row', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const { router } = await import('../routes/jobs.js')
    const { recoverEpisode } = await subject()
    const app = express().use(express.json()).use(router)
    await jq.setQueuePaused(true)
    for (const type of ['subtitles_transcribe', 'scene_plan_run', 'continuity_render'] as const) {
      const project = await pm.createProject({ name: `Individual cancellation ${type}` })
      const job = { ...source(type, { force: true, sections: ['Chapter_02'] }), job_id: `individual-${type}`, project_slug: project.slug, status: 'cancelled' as const }
      await jq.writeAuthoritativeJob(job)
      await jq.getJobs(project.slug)
      assert.equal(await recoverEpisode(project.slug, 'EP0001', false), null)
      const response = await request(app).post(`/projects/${project.slug}/jobs/${job.job_id}/retry`).send({})
      assert.equal(response.status, 202, JSON.stringify(response.body))
      assert.equal(response.body.plan.first_unresolved, 'audio_merge')
      assert.equal((await jq.getJobs(project.slug)).length, 1)
      assert.equal(jq.getJob(job.job_id)?.status, 'cancelled')
      assert.equal(jq.getJob(job.job_id)?.params.force, true)
      assert.equal(jq.getJob(job.job_id)?.params.episode_recovery_id, undefined)
    }
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('automatic recovery does not select unrelated cancelled source jobs', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Unselected cancelled recovery' })
    await jq.setQueuePaused(true)
    const { recoverEpisode } = await subject()
    for (const row of rows()) await jq.writeAuthoritativeJob({ ...row, job_id: `unselected-${row.type}`, project_slug: project.slug, status: 'cancelled' })
    assert.equal(await recoverEpisode(project.slug, 'EP0001', false), null)
    await assert.rejects(recoverEpisode(project.slug, 'EP0001'), /No recoverable/)
    assert.equal((await jq.getJobs(project.slug)).every(job => job.status === 'cancelled'), true)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Job } from '../models/types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
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

async function chapterCheckEvidence(projectSlug: string, sections = ['Chapter_01', 'Chapter_02']) {
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
  const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
  const paths = await resolveEpisodePathsByCode(projectSlug, 'EP0001')
  for (const dir of [paths.script_dir, paths.audio_dir, paths.subtitles_dir]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(paths.narration_docx, sections.map((_, index) => `## Chapter ${index + 1}: Fixture\n\nNarration words.`).join('\n\n'))
  const first = path.join(paths.audio_dir, `EP0001_${sections[0]}.mp3`)
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'libmp3lame', '-q:a', '9', first])
  for (const section of sections) {
    const audio = path.join(paths.audio_dir, `EP0001_${section}.mp3`)
    if (audio !== first) await fs.copyFile(first, audio)
    await fs.writeFile(path.join(paths.subtitles_dir, `EP0001_${section}.srt`), '1\n00:00:00,000 --> 00:00:00,900\nChecked words\n')
    await recordSubtitleSourceEvidence(paths.subtitles_dir, `EP0001_${section}.srt`, (await hashSubtitleAudioSources([audio]))!, 'fixture-asr')
  }
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ sections: sections.map(slug => ({ slug, duration_s: 1, source_file: `EP0001_${slug}.mp3` })) }))
  return paths
}

test('chapter repair coalesces two scoped checks before one Audio Assembly and ignores an older failed attempt', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Chapter repair QA ordering' })
    await chapterCheckEvidence(project.slug)
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const plan = createEpisodeRecoveryPlan([{ ...source('audio_merge', { gap_duration: 0.5, music_volume: 0.12 }), project_slug: project.slug }])
    plan.target = 'audio_merge'
    plan.narration_refresh_job_ids = ['narration-1', 'narration-2']
    const narration = (index: number): Job => ({ ...source('audio', { then_subtitles: true }), project_slug: project.slug,
      job_id: `narration-${index}`, status: 'done', created_at: `2026-09-06T00:00:0${index}Z` })
    const check = (index: number): Job => ({ ...source('subtitles_transcribe', { per_chapter: true, sections: [`Chapter_0${index}`],
      narration_refresh_job_id: `narration-${index}` }), project_slug: project.slug, job_id: `check-${index}`,
      status: 'done', created_at: `2026-09-06T00:01:0${index}Z`, result: { complete: true, scope_complete: true, episode_complete: false, stitch_complete: false } })
    const first = check(1)
    const second: Job = { ...check(2), status: 'running' }
    const jobs = [narration(1), narration(2), first, second]
    const facts = { verified: { ...ready, audio_merge: false }, message: 'Merge stale' }
    await dispatchEpisodeRecoveryStep(plan, facts, jobs)
    assert.equal((await jq.getJobs(project.slug)).length, 0, 'pending chapter QA holds assembly')
    second.status = 'error'
    second.result = { complete: false, scope_complete: false }
    await dispatchEpisodeRecoveryStep(plan, facts, jobs)
    assert.equal((await jq.getJobs(project.slug)).length, 0, 'failed QA cannot start assembly')
    const healed = { ...check(2), job_id: 'check-2-healed', created_at: '2026-09-06T00:02:00Z' }
    await dispatchEpisodeRecoveryStep(plan, facts, [...jobs, healed])
    await dispatchEpisodeRecoveryStep(JSON.parse(JSON.stringify(plan)), facts, [...jobs, healed, ...await jq.getJobs(project.slug)])
    const merges = (await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge')
    assert.equal(merges.length, 1)
    assert.equal(merges[0].params.music_volume, 0.12)
    assert.equal(merges[0].params.gap_duration, 0.5)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a new stamped narration refresh retires a completed plan while keeping an accepted merge owned', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Chapter refresh plan identity' })
    await chapterCheckEvidence(project.slug)
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, recoverEpisode } = await subject()
    const prior = { ...source('audio_merge', { gap_duration: 0.7, music_volume: 0.2 }), project_slug: project.slug,
      job_id: 'prior-assembly', status: 'done' as const, finished_at: '2026-09-05T00:02:00Z' }
    const old = createEpisodeRecoveryPlan([prior])
    old.target = 'audio_merge'
    old.first_unresolved = null
    old.completed = ['audio_merge']
    old.steps.audio_merge!.job_id = prior.job_id
    old.steps.audio_merge!.dispatched = true
    const file = path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, plans: { EP0001: old } }))
    const narration = { ...source('audio', { then_subtitles: true }), project_slug: project.slug,
      job_id: 'new-narration', status: 'done' as const, created_at: '2026-09-06T00:00:00Z' }
    const check = { ...source('subtitles_transcribe', { per_chapter: true, sections: ['Chapter_01'], narration_refresh_job_id: narration.job_id }),
      project_slug: project.slug, job_id: 'new-check', status: 'done' as const, created_at: '2026-09-06T00:01:00Z',
      result: { complete: true, scope_complete: true, episode_complete: false, stitch_complete: false } }
    for (const job of [prior, narration, check]) await jq.writeAuthoritativeJob(job)
    const renewed = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.notEqual(renewed.id, old.id)
    assert.equal(renewed.target, 'subtitle_stitch')
    assert.deepEqual(Object.keys(renewed.steps), ['audio_merge'], 'only the saved local assembly is copied; no ASR or downstream generation')
    assert.deepEqual(renewed.narration_refresh_job_ids, [narration.job_id])
    assert.equal(renewed.steps.audio_merge!.params.music_volume, 0.2)
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(saved.retired_plans[old.id].id, old.id)
    const accepted = (await jq.getJobs(project.slug)).find(job => job.job_id === renewed.steps.audio_merge!.job_id)!
    assert.equal(accepted.status, 'queued')
    const nextNarration = { ...narration, job_id: 'later-narration', created_at: '2026-09-06T00:03:00Z' }
    const nextCheck = { ...check, job_id: 'later-check', created_at: '2026-09-06T00:04:00Z',
      params: { ...check.params, sections: ['Chapter_02'], narration_refresh_job_id: nextNarration.job_id } }
    for (const job of [nextNarration, nextCheck]) {
      await jq.enqueueEpisodeRecoveryOnce(job.job_id, { project_slug: job.project_slug, episode_id: job.episode_id, type: job.type, params: job.params })
      await jq.mutateAuthoritativeJob(project.slug, job.job_id, () => job)
    }
    const observed = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.equal(observed.id, renewed.id)
    assert.equal(observed.dispatch_job_id, accepted.job_id)
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge' && job.status === 'queued').length, 1)
    const { dispatchEpisodeRecoveryStep } = await subject()
    await jq.mutateAuthoritativeJob(project.slug, accepted.job_id, job => ({ ...job, status: 'done' }))
    await dispatchEpisodeRecoveryStep(renewed, { verified: { ...ready, subtitle_sections: false, subtitle_stitch: false }, message: 'Other chapters are missing' }, await jq.getJobs(project.slug))
    assert.equal(renewed.first_unresolved, 'subtitle_sections')
    assert.deepEqual(renewed.completed, ['audio_merge'], 'assembly is complete while the full subtitle timeline remains blocked')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge').length, 2, 'no second assembly')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'subtitles_transcribe').length, 2, 'no fresh ASR')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('chapter repair observes free settlement with the same job and never auto-resumes a paid block', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Chapter repair free settlement' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const plan = createEpisodeRecoveryPlan([{ ...source('audio_merge'), project_slug: project.slug }])
    plan.target = 'audio_merge'
    plan.narration_refresh_job_ids = ['settlement-narration']
    const narration = { ...source('audio', { then_subtitles: true }), job_id: 'settlement-narration', project_slug: project.slug, status: 'done' as const }
    const check = { ...source('subtitles_transcribe', { per_chapter: true, sections: ['Chapter_01'], narration_refresh_job_id: narration.job_id,
      episode_recovery_id: plan.id, durable_request_key: 'accepted-provider-task', subtitle_recovery: { sections: { Chapter_01: { state: 'waiting_settlement' } } } }),
      job_id: 'settlement-check', project_slug: project.slug, result: { scope_complete: false } }
    await jq.writeAuthoritativeJob(check)
    await jq.getJobs(project.slug)
    const facts = { verified: { ...ready, audio_merge: false }, message: 'Merge stale' }
    plan.next_free_check_at = '2000-01-01T00:00:00Z'
    await dispatchEpisodeRecoveryStep(plan, facts, [narration, ...await jq.getJobs(project.slug)])
    assert.equal(jq.getJob(check.job_id)!.status, 'queued')
    assert.equal(jq.getJob(check.job_id)!.params.durable_request_key, 'accepted-provider-task')
    await jq.mutateAuthoritativeJob(project.slug, check.job_id, job => ({ ...job, status: 'error', params: { ...job.params,
      subtitle_recovery: { sections: { Chapter_01: { state: 'paid_blocked' } } } } }))
    plan.next_free_check_at = '2000-01-01T00:00:00Z'
    await dispatchEpisodeRecoveryStep(plan, facts, [narration, ...await jq.getJobs(project.slug)])
    assert.equal(jq.getJob(check.job_id)!.status, 'error')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge').length, 0)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('chapter repair survives Clear Finished with saved source and verified QA acknowledgements, but rejects later audio changes', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Chapter repair cleared history' })
    const paths = await chapterCheckEvidence(project.slug)
    await jq.setQueuePaused(true)
    const prior = { ...source('audio_merge', { music_volume: 0.15 }), project_slug: project.slug, status: 'done' as const }
    const parent = (index: number): Job => ({ ...source('audio', { then_subtitles: true }), job_id: `clear-parent-${index}`, project_slug: project.slug,
      status: 'done', created_at: `2026-09-06T00:00:0${index}Z` })
    const check = (index: number): Job => ({ ...source('subtitles_transcribe', { per_chapter: true, sections: [`Chapter_0${index}`],
      narration_refresh_job_id: `clear-parent-${index}`, narration_refresh_source: { saved_at: `2026-09-06T00:01:0${index}.000Z`, sections: [`Chapter_0${index}`] } }),
      job_id: `clear-check-${index}`, project_slug: project.slug, status: index === 1 ? 'done' : 'running',
      created_at: `2026-09-06T00:02:0${index}Z`, result: { scope_complete: index === 1, complete: index === 1 } })
    for (const job of [prior, parent(1), parent(2), check(1), check(2)]) await jq.writeAuthoritativeJob(job)
    const { recoverEpisode } = await subject()
    const waiting = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.equal(waiting.dispatch_status, 'blocked')
    await jq.clearFinished(project.slug, 'finished')
    await jq._waitForJobPersistenceForTesting()
    await jq.mutateAuthoritativeJob(project.slug, 'clear-check-2', job => ({ ...job, status: 'done', result: { scope_complete: true, complete: true } }))
    const changedAudio = path.join(paths.audio_dir, 'EP0001_Chapter_01.mp3')
    const saved = await fs.readFile(changedAudio)
    await fs.writeFile(changedAudio, Buffer.concat([saved, Buffer.from('later narration bytes')]))
    const stale = (await recoverEpisode(project.slug, 'EP0001', false))!
    assert.equal(stale.dispatch_status, 'blocked')
    assert.match(stale.message, /Chapter_01|changed|source/i)
    assert.equal((await jq.getJobs(project.slug)).some(job => job.type === 'audio_merge'), false)
    await fs.writeFile(changedAudio, saved)
    await jq.clearFinished(project.slug, 'finished')
    await jq._waitForJobPersistenceForTesting()
    const assembled = (await recoverEpisode(project.slug, 'EP0001', false))!
    assert.equal(assembled.id, waiting.id)
    assert.equal(assembled.dispatch_status, 'queued')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge').length, 1)
    assert.equal(jq.getJob(assembled.dispatch_job_id!)!.params.music_volume, 0.15)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a cleared completion event can start a stamped repair while an unproven missing parent cannot', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Cleared scoped completion event' })
    await chapterCheckEvidence(project.slug, ['Chapter_01'])
    await jq.setQueuePaused(true)
    const prior = { ...source('audio_merge', { music_volume: 0.25 }), project_slug: project.slug, status: 'done' as const }
    await jq.writeAuthoritativeJob(prior)
    await jq.getJobs(project.slug)
    const completed = { ...source('subtitles_transcribe', { per_chapter: true, sections: ['Chapter_01'], narration_refresh_job_id: 'cleared-parent',
      narration_refresh_source: { saved_at: '2026-09-06T00:01:00.000Z', sections: ['Chapter_01'] } }),
      project_slug: project.slug, job_id: 'cleared-qa', status: 'done' as const, created_at: '2026-09-06T00:02:00Z', result: { scope_complete: true, complete: true } }
    const { recoverEpisode, createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const result = (await recoverEpisode(project.slug, 'EP0001', true, [], [completed]))!
    assert.equal(result.dispatch_status, 'queued', 'event snapshot retains verified completion after its row was cleared')
    assert.deepEqual(result.narration_refresh_job_ids, ['cleared-parent'])
    const unproven = createEpisodeRecoveryPlan([prior])
    unproven.narration_refresh_job_ids = ['missing-unknown-parent']
    await dispatchEpisodeRecoveryStep(unproven, { verified: { ...ready, audio_merge: false }, message: 'stale' }, [])
    assert.match(unproven.message, /saved chapter narration|verified|source/i)
    assert.equal(unproven.steps.audio_merge!.dispatched, undefined)
    const failedParent = { ...source('audio', { then_subtitles: true }), job_id: 'missing-unknown-parent', project_slug: project.slug }
    const unprovedCheck = { ...completed, params: { ...completed.params, narration_refresh_job_id: failedParent.job_id, narration_refresh_source: undefined } }
    await dispatchEpisodeRecoveryStep(unproven, { verified: { ...ready, audio_merge: false }, message: 'stale' }, [failedParent, unprovedCheck])
    assert.deepEqual(unproven.narration_refresh_checks, [], 'a failed parent timestamp is not saved-source completion evidence')
    await dispatchEpisodeRecoveryStep(unproven, { verified: { ...ready, audio_merge: false }, message: 'stale' }, [unprovedCheck])
    assert.equal(unproven.steps.audio_merge!.dispatched, undefined, 'clearing the failed parent cannot convert its timestamp into success')
    const missingProject = await pm.createProject({ name: 'Unproven refresh cannot become generic recovery' })
    await assert.rejects(recoverEpisode(missingProject.slug, 'EP0001', true, [], [{ ...unprovedCheck, project_slug: missingProject.slug }]), /Narration refresh source could not be verified/)
    assert.equal((await jq.getJobs(missingProject.slug)).length, 0)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

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

test('a failed fresh subtitle action cannot complete recovery from older SRT files', async () => {
  const temp = await useTempDataDir()
  try {
    const subs = path.join(temp.dir, 'subs')
    await fs.mkdir(subs)
    const sections = ['Introduction', ...Array.from({ length: 20 }, (_, index) => `Chapter_${String(index + 1).padStart(2, '0')}`)]
    const unresolved = sections.slice(0, 13)
    await fs.writeFile(path.join(temp.dir, 'audio_chapters.json'), JSON.stringify({ sections: sections.map(slug => ({ slug, duration_s: 4 })) }))
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nOlder transcript remains on disk\n'
    await Promise.all(sections.map(section => fs.writeFile(path.join(subs, `EP0001_${section}.srt`), srt)))
    const states = Object.fromEntries(sections.map(section => [section, {
      state: unresolved.includes(section) ? 'needs_attention' : 'artifact_recovered',
      message: unresolved.includes(section) ? 'Saved fresh task needs attention.' : 'Current fresh artifact recovered.',
    }]))
    const fresh = {
      ...source('subtitles_transcribe', {
        per_chapter: true, force: false, sections,
        generation_action: { id: 'fresh-action', kind: 'fresh' },
        subtitle_recovery: { sections: states },
      }),
      result: { complete: false, expected_sections: 21, ready_sections: 8, missing_sections: unresolved },
    }
    const { createEpisodeRecoveryPlan, inspectRecoverySubtitles, inspectRecoverySubtitlePrerequisites, nextEpisodeRecoveryStep } = await subject()
    const plan = createEpisodeRecoveryPlan([fresh])
    const paths = { episodeDir: temp.dir, subtitlesDir: subs, mergedAudioDir: path.join(temp.dir, 'merged'), episodeCode: 'EP0001' }
    const facts = await inspectRecoverySubtitlePrerequisites(plan, paths, [])

    assert.equal((await inspectRecoverySubtitles(temp.dir, subs, 'EP0001')).complete, true, 'the stale files alone are physically usable')
    assert.equal(facts.verified.subtitle_sections, false)
    assert.deepEqual(facts.missing, unresolved)
    assert.equal(facts.message, '8/21 sections ready')
    assert.equal(nextEpisodeRecoveryStep(plan, facts.verified), 'subtitle_sections')
    assert.equal(plan.first_unresolved, 'subtitle_sections')

    const rawOnly = {
      ...fresh, job_id: plan.steps.subtitle_sections!.job_id,
      params: { ...fresh.params, subtitle_recovery: { sections: Object.fromEntries(sections.map(section => [section, {
        state: 'artifact_recovered', message: 'Raw provider bytes were fetched.',
      }])) } },
      result: { complete: false, expected_sections: 21, ready_sections: 8, missing_sections: unresolved },
    }
    const rawFacts = await inspectRecoverySubtitlePrerequisites(plan, paths, [fresh, rawOnly])
    assert.equal(rawFacts.verified.subtitle_sections, false, 'raw recovery state cannot override the final failed result')
    assert.equal(rawFacts.message, '8/21 sections ready')

    const laterFreshSuccess = {
      ...fresh, job_id: 'new-fresh-action', status: 'done' as const, created_at: '2026-09-06T00:00:00Z',
      params: {
        ...fresh.params, sections: unresolved,
        generation_action: { id: 'new-fresh-action', kind: 'fresh' },
        subtitle_recovery: { sections: Object.fromEntries(unresolved.map(section => [section, {
          state: 'artifact_recovered', message: 'New fresh artifact recovered.',
        }])) },
      },
      result: { complete: true, expected_sections: 13, ready_sections: 13, missing_sections: [] },
    }
    const advanced = await inspectRecoverySubtitlePrerequisites(plan, paths, [fresh, laterFreshSuccess])
    assert.equal(advanced.verified.subtitle_sections, true, 'a later verified fresh action supersedes only its covered failed scope')
    assert.equal(nextEpisodeRecoveryStep(plan, advanced.verified), 'subtitle_stitch')

    const ordinary = createEpisodeRecoveryPlan([{ ...fresh, params: { ...fresh.params, generation_action: undefined } }])
    const ordinaryFacts = await inspectRecoverySubtitlePrerequisites(ordinary, paths, [])
    assert.equal(ordinaryFacts.verified.subtitle_sections, true, 'ordinary imported recovery still relies on verified artifact coverage')
  } finally { await temp.cleanup() }
})

test('a fresh whole-track action needs a verified final result after raw recovery', async () => {
  const temp = await useTempDataDir()
  try {
    const subs = path.join(temp.dir, 'subs')
    await fs.mkdir(subs)
    await fs.writeFile(path.join(subs, 'EP0001_whisper.srt'), '1\n00:00:00,000 --> 00:00:02,000\nOld whole-track transcript\n')
    const rawOnly = source('subtitles_transcribe', {
      per_chapter: false, sections: ['merged'], generation_action: { id: 'whole-track-action', kind: 'fresh' },
      subtitle_recovery: { sections: { merged: { state: 'artifact_recovered', message: 'Raw provider bytes were fetched.' } } },
    })
    const { createEpisodeRecoveryPlan, inspectRecoverySubtitlePrerequisites } = await subject()
    const plan = createEpisodeRecoveryPlan([rawOnly])
    const facts = await inspectRecoverySubtitlePrerequisites(plan, {
      episodeDir: temp.dir, subtitlesDir: subs, mergedAudioDir: path.join(temp.dir, 'merged'), episodeCode: 'EP0001',
    }, [rawOnly])
    assert.equal(facts.verified.subtitle_sections, false)
    assert.deepEqual(facts.missing, ['merged'])
    assert.equal(facts.message, '0/1 whole track ready')
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


test('a slow episode audit does not hold other episodes behind the plans file lock', async (t) => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  let release = () => {}
  let first: Promise<unknown> | undefined
  let second: Promise<unknown> | undefined
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Independent recovery audits' })
    const projectDir = pm.getProjectDir(project.slug)!
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const episodeDir = (await resolveEpisodePathsByCode(project.slug, 'EP0001')).episode_dir
    await fs.mkdir(episodeDir, { recursive: true })
    const manifest = path.join(episodeDir, 'audio_chapters.json')
    await fs.writeFile(manifest, JSON.stringify({ sections: [] }))
    for (const code of ['EP0001', 'EP0002']) {
      await jq.writeAuthoritativeJob({ ...source('scene_plan_run'), job_id: `source-${code}`, project_slug: project.slug, episode_id: code })
    }
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached = () => {}
    const auditing = new Promise<void>(resolve => { reached = resolve })
    const originalRead = fs.readFile.bind(fs)
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === manifest) { reached(); await gate }
      return originalRead(...args)
    })
    const { recoverEpisode } = await subject()
    first = recoverEpisode(project.slug, 'EP0001', true, ['source-EP0001'])
    await Promise.race([auditing, first.then(() => { throw new Error('Fixture audit did not reach its chapter manifest') })])
    second = recoverEpisode(project.slug, 'EP0002', true, ['source-EP0002'])
    let secondSettled = false
    void second.then(() => { secondSettled = true }, () => { secondSettled = true })
    await waitFor(() => secondSettled, { label: 'EP0002 to finish while EP0001 is still checking its audio' })
    await second
    release()
    await first
    const store = JSON.parse(await originalRead(path.join(projectDir, 'episode-recovery-plans.json'), 'utf8'))
    assert.deepEqual(Object.keys(store.plans).sort(), ['EP0001', 'EP0002'], 'concurrent completion must merge both plans')
  } finally {
    release()
    await Promise.allSettled([first, second])
    t.mock.restoreAll()
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})


test('recovery response separates actual dispatch from blocked checks and completed artifacts', async () => {
  const { createEpisodeRecoveryPlan, episodeRecoveryDispatch } = await subject()
  const plan = createEpisodeRecoveryPlan(rows())
  plan.first_unresolved = 'scene_plan_run'
  const node = plan.steps.scene_plan_run!
  const job = { ...source('scene_plan_run'), job_id: node.job_id }
  assert.deepEqual(episodeRecoveryDispatch(plan, []), { dispatch_status: 'blocked' })
  for (const status of ['queued', 'running', 'paused'] as const) {
    assert.deepEqual(episodeRecoveryDispatch(plan, [{ ...job, status }]), { dispatch_status: status, dispatch_job_id: node.job_id })
  }
  assert.deepEqual(episodeRecoveryDispatch(plan, [{ ...job, status: 'queued', episode_id: 'EP0002' }]), { dispatch_status: 'blocked' })
  assert.deepEqual(episodeRecoveryDispatch(plan, [job]), { dispatch_status: 'blocked' }, 'failed job is not queued')
  plan.first_unresolved = null
  assert.deepEqual(episodeRecoveryDispatch(plan, []), { dispatch_status: 'complete' })
  plan.continuation = [{ type: 'metadata' }]
  assert.deepEqual(episodeRecoveryDispatch(plan, []), { dispatch_status: 'blocked' }, 'unfinished continuation is not completed')
  plan.continuation_dispatched = true
  assert.deepEqual(episodeRecoveryDispatch(plan, [{ ...job, job_id: `recovery-${plan.id}-continuation`, type: 'metadata', status: 'running' }]), {
    dispatch_status: 'running', dispatch_job_id: `recovery-${plan.id}-continuation`,
  })
})

test('checking an already queued recovery returns its identity without another prerequisite scan', async (t) => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Queued recovery does not rescan' })
    const original = { ...source('scene_plan_run'), job_id: 'queued-recovery-source', project_slug: project.slug }
    const { createEpisodeRecoveryPlan, recoverEpisode } = await subject()
    const plan = createEpisodeRecoveryPlan([original])
    plan.first_unresolved = 'scene_plan_run'
    const node = plan.steps.scene_plan_run!
    node.dispatched = true
    const active = { ...original, job_id: node.job_id, status: 'queued' as const, params: { episode_recovery_id: plan.id } }
    await jq.writeAuthoritativeJob(original)
    await jq.getJobs(project.slug)
    await jq.setQueuePaused(true)
    await jq.enqueueEpisodeRecoveryOnce(active.job_id, { project_slug: project.slug, episode_id: active.episode_id, type: active.type, params: active.params })
    await fs.writeFile(path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json'), JSON.stringify({ version: 1, plans: { EP0001: plan } }))
    let scans = 0
    const read = fs.readdir.bind(fs)
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => { scans++; return read(...args) })
    const result = await recoverEpisode(project.slug, 'EP0001', true, [original.job_id])
    assert.equal(result!.dispatch_status, 'queued')
    assert.equal(result!.dispatch_job_id, active.job_id)
    assert.equal(scans, 0, 'no episode tree or artifact audit while its accepted job is queued')
    assert.equal((await jq.getJobs(project.slug)).length, 2, 'no duplicate recovery job')
  } finally { t.mock.restoreAll(); await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a section re-narrated after its subtitles were made counts as missing, not complete', async () => {
  const temp = await useTempDataDir()
  try {
    const subs = path.join(temp.dir, 'subs'), audio = path.join(temp.dir, 'audio')
    await fs.mkdir(subs); await fs.mkdir(audio)
    await fs.writeFile(path.join(temp.dir, 'audio_chapters.json'), JSON.stringify({ sections: [
      { slug: 'Chapter_01', duration_s: 4 }, { slug: 'Chapter_02', duration_s: 4 },
    ] }))
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nReal words\n'
    for (const slug of ['Chapter_01', 'Chapter_02']) {
      await fs.writeFile(path.join(subs, `EP0001_${slug}.srt`), srt)
      await fs.writeFile(path.join(audio, `EP0001_${slug}.mp3`), 'take one')
      await fs.utimes(path.join(subs, `EP0001_${slug}.srt`), new Date(2_000_000_000_000), new Date(2_000_000_000_000))
      await fs.utimes(path.join(audio, `EP0001_${slug}.mp3`), new Date(1_900_000_000_000), new Date(1_900_000_000_000))
    }
    // SS0101: Chapter 2 was re-narrated; its old cues no longer match the active audio.
    await fs.utimes(path.join(audio, 'EP0001_Chapter_02.mp3'), new Date(2_100_000_000_000), new Date(2_100_000_000_000))
    const { inspectRecoverySubtitles, createEpisodeRecoveryPlan, inspectRecoverySubtitlePrerequisites, nextEpisodeRecoveryStep } = await subject()
    assert.equal((await inspectRecoverySubtitles(temp.dir, subs, 'EP0001')).complete, true, 'the cues alone look usable')
    assert.deepEqual(await inspectRecoverySubtitles(temp.dir, subs, 'EP0001', true, audio), {
      expected: ['Chapter_01', 'Chapter_02'], missing: ['Chapter_02'], complete: false,
    })
    const plan = createEpisodeRecoveryPlan([source('subtitles_transcribe', { per_chapter: true })])
    const facts = await inspectRecoverySubtitlePrerequisites(plan, {
      episodeDir: temp.dir, subtitlesDir: subs, audioDir: audio, mergedAudioDir: path.join(temp.dir, 'merged'), episodeCode: 'EP0001',
    }, [])
    assert.deepEqual(facts.missing, ['Chapter_02'])
    assert.equal(nextEpisodeRecoveryStep(plan, facts.verified), 'subtitle_sections', 'recovery queues the fix instead of parking at subtitle stitch')
  } finally { await temp.cleanup() }
})

test('a finished subtitle edge whose audio changed again is transcribed once more under a new identity', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await subject()
    const project = await pm.createProject({ name: 'Stale subtitle edge' })
    await jq.setQueuePaused(true)
    const plan = createEpisodeRecoveryPlan([{ ...source('subtitles_transcribe', { per_chapter: true }), project_slug: project.slug }])
    const firstId = plan.steps.subtitle_sections!.job_id
    const finished = { ...source('subtitles_transcribe', { per_chapter: true }), job_id: firstId, project_slug: project.slug, status: 'done' as const }
    const facts = { verified: { ...ready, subtitle_sections: false, subtitle_stitch: false }, message: '1/2 sections ready', missing: ['Chapter_02'] }
    await dispatchEpisodeRecoveryStep(plan, facts, [finished])
    const node = plan.steps.subtitle_sections!
    assert.notEqual(node.job_id, firstId)
    assert.equal(node.dispatched, true)
    const queued = jq.getJob(node.job_id)!
    assert.deepEqual(queued.params.sections, ['Chapter_02'])
    // Once only: a section that stays stale does not loop.
    const again = { ...finished, job_id: node.job_id }
    await dispatchEpisodeRecoveryStep(plan, facts, [again])
    assert.equal(plan.steps.subtitle_sections!.job_id, node.job_id)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    await jq.setQueuePaused(false)
    await temp.cleanup()
  }
})

/**
 * Two boot-scan defects found on the production Mac after Story 1.4.361 (2026-10-27).
 *
 * 1. A narration-refresh plan reported `audio_merge` as unresolved BEFORE asking whether the saved
 *    merge was already current, so every boot queued `recovery-<plan>-audio_merge` for finished,
 *    owner-accepted episodes (AWBU EP0001/2/3/5, night-atlas-science EP0012). An episode whose
 *    merged audio really is missing must still assemble (mineepod EP0014).
 * 2. Recovery replays SAVED generator params, bypassing 1.4.361's percent→linear conversion at the
 *    preset boundary. A plan saved before it carries `music.volume: 8` (8%), which FFmpeg reads as
 *    eight times the voice. The node now records its unit; an unmarked percent-shaped node is
 *    refused with the repair rather than replayed (AGENTS.md §6 — never guess a unit from its size).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'

const notReady = { audio_merge: false, subtitle_sections: false, subtitle_stitch: false, scene_plan_run: false, contextual_cues: false, continuity_render: false }

function row(projectSlug: string, type: Job['type'], status: Job['status'], jobId: string, params: Job['params'] = {}, createdAt = '2026-09-05T00:00:00Z'): Job {
  return {
    job_id: jobId, project_slug: projectSlug, episode_id: 'EP0001', type, params,
    status, title: type, created_at: createdAt,
    started_at: null, finished_at: null, error: status === 'error' ? 'failed' : null, output_lines: [],
  }
}

/** Chapter audio, checked subtitles and the chapter-timing sidecar — what readiness and the refresh checks read. */
async function chapterEvidence(projectSlug: string) {
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
  const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
  const paths = await resolveEpisodePathsByCode(projectSlug, 'EP0001')
  const sections = ['Chapter_01', 'Chapter_02']
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

/** A completion-verified merge that is newer than every chapter file, i.e. current. */
async function currentMerge(mergedDir: string) {
  const { runFfmpeg } = await import('../lib/ffmpeg-utils.js')
  await fs.mkdir(mergedDir, { recursive: true })
  const target = path.join(mergedDir, 'EP0001_merged_audio.mp3')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'libmp3lame', '-q:a', '9', target])
  const stat = await fs.stat(target)
  await fs.writeFile(path.join(mergedDir, 'EP0001_merged_audio.completion.json'), JSON.stringify({
    output_filename: 'EP0001_merged_audio.mp3', bytes: stat.size, duration_sec: 1, opening: { lead_in_sec: 0 },
  }))
}

/** The saved narration-refresh plan: its merge node was never dispatched, as after a page-run merge. */
async function refreshPlan(projectSlug: string, narrationId: string, mergeParams: Job['params']) {
  const { createEpisodeRecoveryPlan } = await import('../services/episode-recovery.js')
  const plan = createEpisodeRecoveryPlan([row(projectSlug, 'audio_merge', 'done', `${projectSlug}-prior-merge`, mergeParams, '2026-09-06T00:02:00Z')])
  plan.target = 'subtitle_stitch'
  plan.first_unresolved = 'audio_merge'
  plan.narration_refresh_job_ids = [narrationId]
  return plan
}

async function refreshFixture(withMerge: boolean) {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const project = await pm.createProject({ name: `Recovery current merge ${withMerge ? 'present' : 'missing'}` })
  await jq.setQueuePaused(true)
  const paths = await chapterEvidence(project.slug)
  if (withMerge) await currentMerge(paths.merged_audio_dir)
  // Job ids are global in the queue, so they carry the project's own slug.
  const narrationId = `${project.slug}-renarrate`
  const narration = { ...row(project.slug, 'audio', 'done', narrationId, { then_subtitles: true }, '2026-09-06T00:00:00Z') }
  const check: Job = { ...row(project.slug, 'subtitles_transcribe', 'done', `${narrationId}-check`, {
    per_chapter: true, sections: ['Chapter_01'], narration_refresh_job_id: narrationId,
  }, '2026-09-06T00:01:00Z'), result: { complete: true, scope_complete: true, episode_complete: false, stitch_complete: false } }
  for (const job of [narration, check]) await jq.writeAuthoritativeJob(job)
  // The defect is the BOOT scan: re-read the saved history from disk the way a restart does.
  jq._restartProjectForTesting(project.slug)
  const plan = await refreshPlan(project.slug, narrationId, { music: { enabled: true, source: 'manual', files: [], volume: 0.08 } })
  const file = path.join(pm.getProjectDir(project.slug)!, 'episode-recovery-plans.json')
  await fs.writeFile(file, JSON.stringify({ version: 1, plans: { EP0001: plan } }))
  return { temp, jq, pm, project, plan }
}

test('a narration-refresh plan whose merged audio is already current completes without another merge', async () => {
  const { temp, jq, project, plan } = await refreshFixture(true)
  try {
    const { recoverEpisode } = await import('../services/episode-recovery.js')
    const recovery = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.equal(recovery.id, plan.id, 'the saved plan is audited, not replaced')
    assert.ok(recovery.completed.includes('audio_merge'), 'the current merge is verified')
    assert.notEqual(recovery.first_unresolved, 'audio_merge', 'the plan moves past Audio Assembly')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge').length, 0, 'nothing was enqueued')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a current merge does not verify while narration is still being replaced', async () => {
  const { temp, jq, project } = await refreshFixture(true)
  try {
    // Chapters land one at a time, so the merge can look current until the next one replaces a source.
    await jq.enqueue({ project_slug: project.slug, episode_id: 'EP0001', type: 'audio', title: 'Re-narration', params: { then_subtitles: true } })
    const { recoverEpisode } = await import('../services/episode-recovery.js')
    const recovery = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.equal(recovery.first_unresolved, 'audio_merge')
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge').length, 0, 'nothing was enqueued')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a narration-refresh plan whose merged audio is missing still queues Audio Assembly', async () => {
  const { temp, jq, project } = await refreshFixture(false)
  try {
    const { recoverEpisode } = await import('../services/episode-recovery.js')
    const recovery = (await recoverEpisode(project.slug, 'EP0001'))!
    assert.equal(recovery.first_unresolved, 'audio_merge')
    const merges = (await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge')
    assert.equal(merges.length, 1, 'the legitimate repair is still dispatched')
    assert.equal(merges[0]!.params.level_unit, 'linear', 'a node created now records the unit it speaks')
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('an old saved merge node with a percent music level is refused, never replayed', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Recovery legacy merge level' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const plan = createEpisodeRecoveryPlan([row(project.slug, 'audio_merge', 'error', 'legacy-merge',
      { music: { enabled: true, source: 'manual', files: [], volume: 8, post_narration_volume: 5 } })])
    assert.equal(plan.steps.audio_merge!.params.level_unit, undefined, 'a percent-shaped node is not marked linear')
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Merged audio is missing' }, [row(project.slug, 'audio_merge', 'error', 'legacy-merge')])
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge').length, 0, 'no job was queued')
    assert.match(plan.message, /written before levels became linear gain/)
    assert.match(plan.message, /music\.volume = 8/)
    assert.match(plan.message, /run Audio Assembly from that page/)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a percent merge node is not resumed on an explicit retry either', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Recovery legacy merge resume' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const legacy = row(project.slug, 'audio_merge', 'error', 'legacy-merge-error', { music: { enabled: true, source: 'manual', files: [], volume: 8 } })
    await jq.writeAuthoritativeJob(legacy)
    const plan = createEpisodeRecoveryPlan([legacy])
    plan.steps.audio_merge!.job_id = legacy.job_id
    plan.steps.audio_merge!.dispatched = true
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Merged audio is missing' }, [legacy], [legacy.job_id])
    assert.equal((await jq.findJobs(project.slug, job => job.job_id === legacy.job_id))[0]!.status, 'error', 'the percentage was never replayed')
    assert.match(plan.message, /written before levels became linear gain/)
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

test('a marked linear merge node is replayed unchanged', async () => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  try {
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({ name: 'Recovery marked merge level' })
    await jq.setQueuePaused(true)
    const { createEpisodeRecoveryPlan, dispatchEpisodeRecoveryStep } = await import('../services/episode-recovery.js')
    const plan = createEpisodeRecoveryPlan([row(project.slug, 'audio_merge', 'error', 'linear-merge',
      { music: { enabled: true, source: 'manual', files: [], volume: 0.08, post_narration_volume: 0.5 } })])
    assert.equal(plan.steps.audio_merge!.params.level_unit, 'linear')
    await dispatchEpisodeRecoveryStep(plan, { verified: notReady, message: 'Merged audio is missing' }, [row(project.slug, 'audio_merge', 'error', 'linear-merge')])
    const merges = (await jq.getJobs(project.slug)).filter(job => job.type === 'audio_merge')
    assert.equal(merges.length, 1)
    assert.deepEqual(merges[0]!.params.music, { enabled: true, source: 'manual', files: [], volume: 0.08, post_narration_volume: 0.5 })
  } finally { await jq._waitForJobPersistenceForTesting(); await temp.cleanup() }
})

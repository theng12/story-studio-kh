/**
 * The owner's chapter repair, end to end (1.4.258 review): re-narrate one chapter -> its scoped
 * subtitle check -> exactly one Audio Assembly with the saved mix -> local stitch, with no extra
 * transcription. Plus the recovery edges the review fixed: a stale chapter SRT behind a current
 * merge is missing, a quality-refresh merge is never replayed as the repair Assembly, and an
 * unverifiable refresh source is said on the check's own job line.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TestContext } from 'node:test'
import type { Job } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { hashSubtitleAudioSources } from '../services/subtitle-completion.js'

/** Files written after this get a strictly newer mtime than files written before it. */
async function clockMovesOn() {
  const start = Date.now()
  await waitFor(() => Date.now() > start + 20, { label: 'the clock to move on' })
}
async function tone(file: string, frequency = 440) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=1`, '-codec:a', 'libmp3lame', '-q:a', '9', file])
}
async function merged(dir: string, code: string, durationSec = 5) {
  const filename = `${code}_merged_audio.mp3`
  const target = path.join(dir, filename)
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${durationSec}`, '-codec:a', 'libmp3lame', '-q:a', '9', target])
  const stat = await fs.stat(target)
  await fs.writeFile(path.join(dir, `${code}_merged_audio.completion.json`), JSON.stringify({ output_filename: filename, bytes: stat.size, duration_sec: durationSec, opening: { lead_in_sec: 0, music_lead_in_sec: 0 } }))
}

async function fixture(t: TestContext, name = 'Review 1258') {
  const isolated = await useTempDataDir()
  const mock = await startMockGenStudioService()
  const jq = await import('../services/job-queue.js')
  t.after(async () => { await jq._waitForJobPersistenceForTesting(); await mock.close(); await isolated.cleanup() })
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const utils = await import('../services/utils.js')
  const { recordSubtitleSourceEvidence } = await import('../services/subtitle-recovery.js')
  await settings.setGenStudioUrl(mock.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Three', logline: 'x', themes: [], suggested_chapters: 3, suggested_length: '3 minutes', mood: 'calm' }], 'mock-chat-v1')
  const code = (await ideas.acceptIdea(project.slug, idea!.id, false)).episode_code
  const paths = await utils.resolveEpisodePathsByCode(project.slug, code)
  const sections = ['Chapter_01', 'Chapter_02', 'Chapter_03']
  for (const dir of [paths.script_dir, paths.audio_dir, paths.merged_audio_dir, paths.subtitles_dir]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(paths.narration_docx, sections.map((s, i) => `## Chapter ${String(i + 1).padStart(2, '0')}: F\n\nNarration for ${s}.`).join('\n\n'))
  for (const s of sections) {
    const audio = path.join(paths.audio_dir, `${code}_${s}.mp3`)
    await tone(audio)
    await fs.writeFile(path.join(paths.subtitles_dir, `${code}_${s}.srt`), '1\n00:00:00,000 --> 00:00:00,900\nOld words\n')
    await recordSubtitleSourceEvidence(paths.subtitles_dir, `${code}_${s}.srt`, (await hashSubtitleAudioSources([audio]))!, 'mock-whisper-v1')
  }
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ gap_duration_s: 1,
    sections: sections.map(slug => ({ slug, duration_s: 1, source_file: `${code}_${slug}.mp3` })) }))
  await clockMovesOn()
  await merged(paths.merged_audio_dir, code)
  await jq.setQueuePaused(true)
  const row = (job_id: string, type: Job['type'], params: Record<string, unknown>, extra: Partial<Job> = {}): Job => ({
    job_id, project_slug: project.slug, episode_id: code, type, params: { episode_id: code, ...params }, status: 'done', title: job_id,
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString(), output_lines: [], ...extra } as Job)
  return { jq, mock, project, code, paths, sections, row }
}

test('re-narrate Chapter_02 -> scoped check -> one merge with saved mix -> local stitch, no extra ASR', async t => {
  const f = await fixture(t)
  const { inspectAudioAssemblyReadiness } = await import('../services/audio-workflow-readiness.js')
  const prior = f.row('prior-merge', 'audio_merge', { gap_duration: 1, normalize_volume: false, music_volume: 0.33 }, { created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z' })
  await f.jq.writeAuthoritativeJob(prior)
  assert.equal((await inspectAudioAssemblyReadiness(f.project.slug, f.code)).audio_assembly_ready, true)
  await clockMovesOn()
  await tone(path.join(f.paths.audio_dir, `${f.code}_Chapter_02.mp3`), 880) // the re-narration
  assert.equal((await inspectAudioAssemblyReadiness(f.project.slug, f.code)).audio_assembly_ready, false, 'owner precondition: merge is stale')

  const parent = f.row('narration-1', 'audio', { then_subtitles: true, sections: 'Chapter_02' }, { status: 'running' })
  await f.jq.writeAuthoritativeJob(parent)
  const { queueSubtitlesAfterNarration } = await import('../generators/audio.js')
  await queueSubtitlesAfterNarration(parent, ['Chapter_02'])
  const checkId = parent.result?.subtitles_job_id as string
  assert.ok(checkId, parent.output_lines.join('\n'))
  await f.jq.mutateAuthoritativeJob(f.project.slug, parent.job_id, job => ({ ...job, status: 'done' }))
  const check = { ...f.jq.getJob(checkId)!, status: 'running' } as Job
  check.output_lines = []
  f.mock.queueScenario('transcription', { states: ['accepted', 'succeeded'] })
  const { generateSubtitlesTranscribe } = await import('../generators/subtitles.js')
  await generateSubtitlesTranscribe(check)
  assert.equal(check.result?.scope_complete, true, check.output_lines.join('\n'))
  assert.equal(f.mock.providerSubmissionCount('transcription'), 1, 'only the re-narrated chapter is transcribed')
  const done = await f.jq.mutateAuthoritativeJob(f.project.slug, checkId, job => ({ ...job, status: 'done', result: check.result, finished_at: new Date().toISOString() }))

  const { recoverEpisode } = await import('../services/episode-recovery.js')
  const plan = (await recoverEpisode(f.project.slug, f.code, true, [], [done as Job]))!
  const merges = (await f.jq.getJobs(f.project.slug)).filter(job => job.type === 'audio_merge' && job.status === 'queued')
  assert.equal(merges.length, 1, 'exactly one Audio Assembly queued')
  assert.equal(merges[0].params.music_volume, 0.33, 'saved mix settings reused')

  // Simulate the merge finishing (fresh merged file newer than the chapters).
  await clockMovesOn()
  await merged(f.paths.merged_audio_dir, f.code)
  await f.jq.mutateAuthoritativeJob(f.project.slug, merges[0].job_id, job => ({ ...job, status: 'done', finished_at: new Date().toISOString() }))
  const after = (await recoverEpisode(f.project.slug, f.code, false))!
  assert.equal(after.first_unresolved, null, `recovery must not park: ${after.message}`)
  await fs.access(path.join(f.paths.subtitles_dir, `${f.code}_stitched.srt`))
  assert.equal(f.mock.providerSubmissionCount('transcription'), 1, 'no extra ASR after the merge')
})

test('a stale chapter SRT behind a current merge is not counted as complete by recovery', async t => {
  const f = await fixture(t, 'Review parking')
  await clockMovesOn()
  await tone(path.join(f.paths.audio_dir, `${f.code}_Chapter_02.mp3`), 880) // re-narrated, subtitles not redone
  await clockMovesOn()
  await merged(f.paths.merged_audio_dir, f.code) // the owner ran Audio Assembly by hand
  const { inspectRecoverySubtitles } = await import('../services/episode-recovery.js')
  const coverage = await (inspectRecoverySubtitles as any)(f.paths.episode_dir, f.paths.subtitles_dir, f.code, true, f.paths.audio_dir)
  assert.ok(coverage.missing.includes('Chapter_02'), `stale Chapter_02 counted as complete: ${JSON.stringify(coverage)}`)
})

test('a quality-refresh merge is not replayed as the repair Assembly', async t => {
  const f = await fixture(t, 'Review quality')
  const ordinary = f.row('ordinary-merge', 'audio_merge', { gap_duration: 1, music_volume: 0.2 }, { created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z' })
  const refresh = f.row('quality-merge', 'audio_merge', { gap_duration: 1, music_volume: 0.2, audio_quality_refresh: { action_id: 'old-action', sections: ['Chapter_01'] } },
    { created_at: '2026-01-02T00:00:00Z', started_at: '2026-01-02T00:00:00Z' })
  const parent = f.row('narration-q', 'audio', { then_subtitles: true })
  const check = f.row('check-q', 'subtitles_transcribe', { per_chapter: true, sections: ['Chapter_02'], narration_refresh_job_id: 'narration-q',
    narration_refresh_source: { saved_at: new Date().toISOString(), sections: ['Chapter_02'] } }, { result: { scope_complete: true, complete: true } })
  for (const job of [ordinary, refresh, parent, check]) await f.jq.writeAuthoritativeJob(job)
  const { recoverEpisode } = await import('../services/episode-recovery.js')
  const plan = (await recoverEpisode(f.project.slug, f.code, true, [], [check]))!
  assert.equal(plan.steps.audio_merge?.params?.audio_quality_refresh, undefined, 'stale quality-refresh marker replayed into the repair merge')
})

test('an unverifiable narration refresh source is shown on the check job, not only logged', async t => {
  const f = await fixture(t, 'Review unverified')
  const merge = f.row('done-merge', 'audio_merge', { gap_duration: 1 }, { created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z' })
  // A chapter check whose narration parent is gone and that carries no saved source stamp.
  const check = f.row('check-orphan', 'subtitles_transcribe', { per_chapter: true, sections: ['Chapter_02'], narration_refresh_job_id: 'narration-missing' })
  for (const job of [merge, check]) await f.jq.writeAuthoritativeJob(job)
  const { recoverEpisode } = await import('../services/episode-recovery.js')
  await assert.rejects(recoverEpisode(f.project.slug, f.code, true, [], [check]), /Narration refresh source could not be verified/)
  await assert.rejects(recoverEpisode(f.project.slug, f.code, true, [], [check]), /Narration refresh source could not be verified/)
  const lines = f.jq.getJob('check-orphan')!.output_lines.filter(line => line.startsWith('Narration refresh source could not be verified'))
  assert.equal(lines.length, 1, 'said once on the job the owner sees')
})

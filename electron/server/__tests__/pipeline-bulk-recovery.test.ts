/**
 * One real queue-chain recovery fixture. Pipeline/Jobs route assertions alone
 * cannot prove that a saved transcript, the subtitle repair ledger, stitch,
 * Pipeline handoff, and missing-only image owner retain one action identity.
 *
 * The scene-plan executor is deliberately a local fixture: Scene Plan is not
 * this recovery's provider boundary. Subtitles and Continuity Image run their
 * real generators against the in-process GenStudio mock.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

let cleanup: () => Promise<void>
let app: import('express').Express
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode
let generateSubtitlesTranscribe: typeof import('../generators/subtitles.js').generateSubtitlesTranscribe
let runContinuityRenderJob: typeof import('../generators/continuity-render.js').runContinuityRenderJob
let service: Awaited<ReturnType<typeof startMockGenStudioService>>

async function writeValidMergedAudio(mergedDir: string, code: string, durationSec: number): Promise<void> {
  const filename = `${code}_merged_audio.mp3`
  const target = path.join(mergedDir, filename)
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${durationSec}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', target,
  ])
  const stat = await fs.stat(target)
  await fs.writeFile(path.join(mergedDir, `${code}_merged_audio.completion.json`), JSON.stringify({
    output_filename: filename,
    bytes: stat.size,
    duration_sec: durationSec,
    opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
  }))
}

before(async () => {
  const isolated = await useTempDataDir()
  cleanup = isolated.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  jq = await import('../services/job-queue.js')
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
  ;({ generateSubtitlesTranscribe } = await import('../generators/subtitles.js'))
  ;({ runContinuityRenderJob } = await import('../generators/continuity-render.js'))
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  service = await startMockGenStudioService()
  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  // Real subtitle + image executors; Scene Plan is a local handoff fixture.
  jq.registerExecutor('subtitles_transcribe', generateSubtitlesTranscribe)
  jq.registerExecutor('continuity_render', runContinuityRenderJob)
  jq.registerExecutor('scene_plan_run', async job => {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [{
      id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 1,
      transcript_segment: 'Recovered chapter.', visual_prompt: 'A quiet archive lit by a lantern.',
    }] }))
  })
})

after(async () => {
  await jq._waitForJobPersistenceForTesting()
  await service.close()
  await cleanup()
})

async function seedEpisode() {
  const project = await pm.createProject({ name: 'Pipeline recovery chain', episode_prefix: 'EP', episode_digits: 4 })
  await pm.updateConfig(project.slug, {
    subtitles_generator_presets: [{ id: 'stt', name: 'Mock STT', data: { model: 'mock-whisper-v1', language: 'en', per_chapter: true } }],
    subtitles_generator_last_preset: 'stt',
    scene_plan_presets: [{ id: 'plan', name: 'Mock plan', type: 'scene-plan', data: { model: 'mock-chat-v1' } }],
    'scene_plan_last_preset_scene-plan': 'plan',
    scene_review_genstudio_presets: [{ id: 'images', name: 'Mock images', type: 'scene-review', data: { model: 'mock-image-v1', aspect_ratio: '16:9' } }],
    'scene_review_genstudio_last_preset_scene-review': 'images',
  } as any)
  const [idea] = await ideas.addIdeas(project.slug, [{ title: 'Bulk repair fixture', logline: '', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await Promise.all([paths.audio_dir, paths.subtitles_dir, paths.merged_audio_dir, paths.script_dir].map(dir => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(paths.narration_docx, [
    '## Chapter 01: Fixture', '', 'Narration for Chapter_01.', '',
    '## Chapter 02: Fixture', '', 'Narration for Chapter_02.', '',
  ].join('\n'))
  await fs.writeFile(path.join(paths.audio_dir, `${episodeId}_Chapter_01.mp3`), 'fixture-audio-one')
  await fs.writeFile(path.join(paths.audio_dir, `${episodeId}_Chapter_02.mp3`), 'fixture-audio-two')
  await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), JSON.stringify({ gap_duration_s: 1, sections: [
    { slug: 'Chapter_01', duration_s: 1, source_file: `${episodeId}_Chapter_01.mp3` },
    { slug: 'Chapter_02', duration_s: 1, source_file: `${episodeId}_Chapter_02.mp3` },
  ] }))
  await writeValidMergedAudio(paths.merged_audio_dir, episodeId, 3)
  return { project, episodeId, paths }
}

async function acceptSiblingEpisode(projectSlug: string): Promise<string> {
  const [idea] = await ideas.addIdeas(projectSlug, [{
    title: 'Second recovery fixture', logline: '', themes: [], suggested_chapters: 2,
    suggested_length: 'short', mood: 'calm',
  }], 'mock-chat-v1')
  return (await ideas.acceptIdea(projectSlug, idea!.id, false)).episode_code
}

test('repair run reclaims saved subtitle output, preserves valid chapters, hands off to Scene Plan and one missing image, and replays one action', async () => {
  const { project, episodeId, paths } = await seedEpisode()
  const validPath = path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`)
  const validBytes = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nApproved Chapter One.\n')
  await fs.writeFile(validPath, validBytes)

  // Seed Chapter 02 through the real generator so its manifest/ledger point to
  // an already available provider result. Corrupt only the local artifact.
  const seedJob: any = { job_id: `seed-${episodeId}`, project_slug: project.slug, episode_id: episodeId,
    type: 'subtitles_transcribe', status: 'running', progress: 0, output_lines: [],
    params: { per_chapter: true, engine: 'genstudio', model: 'mock-whisper-v1', language: 'en', sections: ['Chapter_02'] } }
  await generateSubtitlesTranscribe(seedJob)
  const transcriptionPosts = service.providerSubmissionCount('transcription')
  const damagedPath = path.join(paths.subtitles_dir, `${episodeId}_Chapter_02.srt`)
  await fs.writeFile(damagedPath, [
    '1', '00:00:00,000 --> 00:00:01,000', 'Before the gap.', '',
    '2', '00:00:31,500 --> 00:00:32,000', 'After the gap.', '',
  ].join('\n'))

  const actionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const body = { episode_ids: [episodeId], steps: ['subtitles', 'scene_plan', 'scene_review'], repair_missing: true, action_id: actionId }
  const first = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const replay = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)
  assert.equal(replay.status, 201, JSON.stringify(replay.body))

  await waitFor(async () => {
    const jobs = await jq.getJobs(project.slug)
    return ['subtitles_transcribe', 'scene_plan_run', 'continuity_render'].every(type =>
      jobs.some(job => job.type === type && job.episode_id === episodeId && job.status === 'done'))
  }, { label: 'bulk repair subtitle → Scene Plan → image chain', timeoutMs: 10_000 })

  const jobs = await jq.getJobs(project.slug)
  const chain = jobs.filter(job => job.episode_id === episodeId && ['subtitles_transcribe', 'scene_plan_run', 'continuity_render'].includes(job.type))
  assert.equal(chain.length, 3, 'one action owns one real three-stage queue chain')
  assert.ok(chain.every(job => job.params.pipeline_repair?.action_id === actionId), 'handoff preserves the repair action')
  assert.deepEqual(await fs.readFile(validPath), validBytes, 'valid chapter is byte-identical')
  assert.match(await fs.readFile(damagedPath, 'utf8'), /Hello from mock the Gateway/, 'saved provider result repaired the internally gapped chapter')
  assert.equal(service.providerSubmissionCount('transcription'), transcriptionPosts, 'repair rejoined saved transcription without a new POST')
  assert.equal(service.providerSubmissionCount('image'), 1, 'only the missing Scene Review image used one fresh request')

  const afterReplay = await jq.getJobs(project.slug)
  assert.equal(afterReplay.filter(job => job.episode_id === episodeId && job.type === 'continuity_render').length, 1, 'replay did not create a second image owner')
})

test('repair with usable chapter sources rebuilds a missing or stale stitch before Scene Plan, without a transcription POST', async () => {
  for (const [label, staleOutput] of [['missing', undefined], ['stale', 'stale stitched output']] as const) {
    const { project, episodeId, paths } = await seedEpisode()
    const chapterOne = path.join(paths.subtitles_dir, `${episodeId}_Chapter_01.srt`)
    const chapterTwo = path.join(paths.subtitles_dir, `${episodeId}_Chapter_02.srt`)
    await fs.writeFile(chapterOne, '1\n00:00:00,000 --> 00:00:01,000\nPreserved source one.\n')
    await fs.writeFile(chapterTwo, '1\n00:00:00,000 --> 00:00:01,000\nPreserved source two.\n')
    const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
    if (staleOutput) await fs.writeFile(stitched, staleOutput)

    const transcriptionPosts = service.providerSubmissionCount('transcription')
    const response = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send({
      episode_ids: [episodeId], steps: ['subtitles', 'scene_plan'], repair_missing: true,
      action_id: label === 'missing'
        ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })
    assert.equal(response.status, 201, JSON.stringify(response.body))

    await waitFor(async () => {
      const jobs = await jq.getJobs(project.slug)
      return ['subtitles_transcribe', 'scene_plan_run'].every(type =>
        jobs.some(job => job.type === type && job.episode_id === episodeId && job.status === 'done'))
    }, { label: `${label} local stitch → Scene Plan chain`, timeoutMs: 10_000 })

    const { readSubtitleTimelineIntegrity } = await import('../services/scene-timeline-integrity.js')
    assert.equal((await readSubtitleTimelineIntegrity(paths.subtitles_dir, episodeId)).complete, true, `${label} stitch was rebuilt from good chapter sources`)
    assert.equal(service.providerSubmissionCount('transcription'), transcriptionPosts, `${label} local stitch recovery made no transcription POST`)
    assert.match(await fs.readFile(stitched, 'utf8'), /Preserved source one/, `${label} rebuild contains preserved sources`)
  }
})

test('repairing an unselected downstream stage with failed subtitles creates no downstream job', async () => {
  const { project, episodeId } = await seedEpisode()
  const response = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send({
    episode_ids: [episodeId], steps: ['scene_review'], repair_missing: true,
    action_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  })
  assert.equal(response.status, 400, JSON.stringify(response.body))
  assert.match(response.body.detail, /Nothing was started/)
  assert.equal((await jq.getJobs(project.slug)).filter(job => job.episode_id === episodeId).length, 0)
})

test('a paused repair remains scoped to episode A when Jobs and Scene Review read episode B', async () => {
  const { project, episodeId: episodeA } = await seedEpisode()
  const episodeB = await acceptSiblingEpisode(project.slug)
  const actionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const body = { episode_ids: [episodeA], steps: ['subtitles'], repair_missing: true, action_id: actionId }
  const postsBefore = service.providerSubmissionCount('transcription')

  await jq.setQueuePaused(true)
  try {
    const first = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.enqueued, 1)
    const jobId = first.body.jobs[0]?.job_id
    assert.equal(typeof jobId, 'string')
    assert.equal((await jq.pauseJob(jobId, 'manual'))?.status, 'paused')

    const jobsA = await request(app).get(`/api/projects/${project.slug}/jobs`)
    assert.equal(jobsA.status, 200)
    assert.equal(jobsA.body.jobs.filter((job: any) => job.episode_id === episodeA).length, 1)
    assert.equal(jobsA.body.jobs.find((job: any) => job.episode_id === episodeA)?.params.pipeline_repair.action_id, actionId)

    const reviewB = await request(app).get(`/api/projects/${project.slug}/scene-review/${episodeB}`)
    assert.equal(reviewB.status, 200)
    assert.equal(reviewB.body.active_render_job, undefined)
    assert.doesNotMatch(JSON.stringify(reviewB.body), new RegExp(actionId))
    assert.equal(jobsA.body.jobs.some((job: any) => job.episode_id === episodeB), false)

    const replay = await request(app).post(`/api/projects/${project.slug}/pipeline/run-batch`).send(body)
    assert.equal(replay.status, 201, JSON.stringify(replay.body))
    assert.equal(replay.body.enqueued, 0)
    assert.equal(replay.body.reused, 1)
    assert.equal((await jq.getJobs(project.slug)).filter(job => job.params.pipeline_repair?.action_id === actionId).length, 1)
    assert.equal(service.providerSubmissionCount('transcription'), postsBefore, 'paused replay does not submit provider work')
  } finally {
    await jq.setQueuePaused(false)
  }
})

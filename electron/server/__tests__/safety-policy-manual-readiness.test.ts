import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { parseSrt } from '../lib/subtitle-builder.js'
import { stampFromCues } from '../lib/scene-plan-timeline.js'

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let jq: typeof import('../services/job-queue.js')
let n = 0

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  ;({ app } = await import('../app.js'))
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  jq = await import('../services/job-queue.js')
  await jq.setQueuePaused(true)
})

after(async () => {
  for (const project of await pm.listProjects()) {
    for (const job of await jq.getJobs(project.slug)) {
      if (job.status === 'queued') await jq.requestJobCancellation(project.slug, job.job_id)
    }
  }
  await jq.setQueuePaused(false)
  await jq._waitForJobPersistenceForTesting()
  await cleanup()
})

async function episode(title: string) {
  const project = await pm.createProject({ name: `${title} ${++n}`, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await im.addIdeas(project.slug, [{ title, logline: '', themes: [], suggested_chapters: 2, suggested_length: 'short', mood: 'calm' }], 'test-model')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false)
  const code = accepted.episode_code!
  const paths = await (await import('../services/utils.js')).resolveEpisodePathsByCode(project.slug, code)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  return { slug: project.slug, code, title, paths }
}

test('manual YouTube Finalizer enqueue uses chapter_marks instead of a fixed Audio Assembly stop', async () => {
  const fixture = await episode('Manual finalizer policy')
  await pm.updateConfig(fixture.slug, { safety_checks: { chapter_marks: 'block' } } as any)
  const blocked = await request(app).post(`/api/projects/${fixture.slug}/generate/metadata`).send({
    episode_id: fixture.code, title: fixture.title, model: 'test-model',
  })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'YOUTUBE_FINALIZER_AUDIO_REQUIRED')

  await pm.updateConfig(fixture.slug, { safety_checks: { chapter_marks: 'warn' } } as any)
  const warned = await request(app).post(`/api/projects/${fixture.slug}/generate/metadata`).send({
    episode_id: fixture.code, title: fixture.title, model: 'test-model',
  })
  assert.equal(warned.status, 201, JSON.stringify(warned.body))
  assert.equal(warned.body.type, 'metadata')
})

test('manual Audio Assembly enqueue uses chapter_audio_present when at least one chapter can be joined', async () => {
  const fixture = await episode('Manual audio policy')
  const narration = fixture.paths.narration_docx.replace(/\.docx$/i, '.md')
  await fs.mkdir(path.dirname(narration), { recursive: true })
  await fs.writeFile(narration, [
    '# Narration', '## Chapter 1: One', 'First chapter.', '## Chapter 2: Two', 'Second chapter.',
  ].join('\n\n'))
  const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
  const audioDir = await resolveAudioDir(fixture.slug, await findNarrationFile(fixture.slug, fixture.code), fixture.code)
  await fs.mkdir(audioDir, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'libmp3lame', path.join(audioDir, `${fixture.code}_Chapter_01.mp3`)])

  const body = { episode_id: fixture.code, chapters: [], gap_duration: 0, normalize_volume: false }
  await pm.updateConfig(fixture.slug, { safety_checks: { chapter_audio_present: 'block' } } as any)
  const blocked = await request(app).post(`/api/projects/${fixture.slug}/generate/audio-merge`).send(body)
  assert.equal(blocked.status, 409)
  assert.match(blocked.body.detail, /Chapter_02\.mp3/)

  await pm.updateConfig(fixture.slug, { safety_checks: { chapter_audio_present: 'warn' } } as any)
  const warned = await request(app).post(`/api/projects/${fixture.slug}/generate/audio-merge`).send(body)
  assert.equal(warned.status, 201, JSON.stringify(warned.body))
  assert.equal(warned.body.type, 'audio_merge')
})

test('subtitle readiness measures the corrected planning transcript and applies caption-gap policy', async () => {
  const fixture = await episode('Caption gap policy')
  const subtitlesDir = fixture.paths.subtitles_dir
  await fs.mkdir(subtitlesDir, { recursive: true })
  const rawSrt = [
    '1', '00:00:01,000 --> 00:00:02,000', 'before', '',
    '2', '00:00:20,000 --> 00:00:21,000', 'removed by correction', '',
    '3', '00:00:43,000 --> 00:00:44,000', 'after', '',
  ].join('\n')
  const correctedSrt = [
    '1', '00:00:01,000 --> 00:00:02,000', 'before', '',
    '2', '00:00:43,000 --> 00:00:44,000', 'after', '',
  ].join('\n')
  const cues = parseSrt(rawSrt)
  const stitched = path.join(subtitlesDir, `${fixture.code}_stitched.srt`)
  await fs.writeFile(stitched, rawSrt)
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: true, generated_at: '2026-10-12T00:00:00.000Z', missing_sections: [], total_cues: cues.length,
    timeline: stampFromCues(cues),
    sections: [{ slug: 'Chapter_01', source_srt: `${fixture.code}_Chapter_01.srt`, offset_sec: 0, duration_sec: 45, cues_added: 2 }],
  }))
  const rawStat = await fs.stat(stitched)
  const corrected = path.join(subtitlesDir, `${fixture.code}_stitched.corrected.srt`)
  await fs.writeFile(corrected, correctedSrt)
  await fs.writeFile(`${corrected}.json`, JSON.stringify({
    schema_version: 1,
    source_mtime_ms: rawStat.mtimeMs,
    source_size: rawStat.size,
  }))
  await fs.mkdir(fixture.paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(fixture.paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    generated_at: '2026-10-12T00:00:00.000Z',
    total_duration_sec: 45,
    research_used: false,
    scenes: [{
      id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 45,
      transcript_segment: 'before after', visual_prompt: 'A complete test image prompt.', approved: false,
    }],
  }))

  const assertMode = async (mode: 'off' | 'warn' | 'block', complete: boolean) => {
    await pm.updateConfig(fixture.slug, { safety_checks: { caption_gap: mode } } as any)
    const lightweight = await request(app)
      .get(`/api/projects/${fixture.slug}/video-editor/subtitles/timeline-integrity/${fixture.code}`)
    assert.equal(lightweight.status, 200)
    assert.equal(lightweight.body.timeline_integrity.caption_gap_mode, mode)
    assert.equal(lightweight.body.timeline_integrity.complete, complete)
    assert.equal(lightweight.body.timeline_integrity.max_cue_gap_sec, 30)
    assert.equal(lightweight.body.timeline_integrity.blocking_cue_gaps.length, 1)

    const subtitleStatus = await request(app)
      .get(`/api/projects/${fixture.slug}/video-editor/subtitles/status/${fixture.code}`)
    assert.equal(subtitleStatus.status, 200)
    assert.equal(subtitleStatus.body.timeline_integrity.caption_gap_mode, mode)
    assert.equal(subtitleStatus.body.timeline_integrity.complete, complete)
    assert.equal(subtitleStatus.body.timeline_integrity.blocking_cue_gaps.length, 1)

    const scenePlan = await request(app).get(`/api/projects/${fixture.slug}/scene-plan/${fixture.code}`)
    assert.equal(scenePlan.status, 200)
    assert.equal(scenePlan.body.timeline_integrity.caption_gap_mode, mode)
    assert.equal(scenePlan.body.timeline_integrity.complete, complete)

    const sceneReview = await request(app).get(`/api/projects/${fixture.slug}/scene-review/${fixture.code}`)
    assert.equal(sceneReview.status, 200)
    assert.equal(sceneReview.body.subtitle_integrity.caption_gap_mode, mode)
    assert.equal(sceneReview.body.subtitle_integrity.complete, complete)
    assert.equal(sceneReview.body.subtitle_integrity.blocking_cue_gaps.length, 1)

    const status = await request(app).get(`/api/projects/${fixture.slug}/episodes/${fixture.code}/status?invalidate=true`)
    assert.equal(status.status, 200)
    assert.equal(status.body.status.subtitles, complete)
  }

  await assertMode('off', true)
  await assertMode('warn', true)
  await assertMode('block', false)
})

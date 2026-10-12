import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const WARN_SLUG = 'video-safety-warn'
const BLOCK_SLUG = 'video-safety-block'
let tmp: { dir: string; cleanup: () => Promise<void> }
let episodeDir = ''
let goodImage = ''
let brokenImage = ''

async function writeProject(slug: string, safetyChecks: Record<string, string>): Promise<void> {
  const projectDir = path.join(tmp.dir, 'projects', slug)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug,
    name: slug,
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify({ safety_checks: safetyChecks }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: `${slug}-idea`, title: 'Safety', status: 'accepted', episode_code: 'EP0001' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
}

before(async () => {
  tmp = await useTempDataDir()
  const warnChecks = Object.fromEntries([
    'scene_pictures', 'scenes_approved', 'stale_picture', 'picture_opens', 'scene_count',
    'subtitles_this_episode', 'narration_covered', 'cues_approved',
  ].map(id => [id, 'warn']))
  await writeProject(WARN_SLUG, warnChecks)
  await writeProject(BLOCK_SLUG, {
    scene_pictures: 'block',
    subtitles_this_episode: 'block',
    narration_covered: 'block',
    cues_approved: 'block',
  })

  episodeDir = path.join(tmp.dir, 'projects', WARN_SLUG, 'episodes', 'Season 001', 'EP0001 - Safety')
  const imagesDir = path.join(episodeDir, 'scene_images')
  const mergedDir = path.join(episodeDir, 'EP0001 - 08 Audio Merge Output')
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(mergedDir, { recursive: true })
  goodImage = path.join(imagesDir, 's1.png')
  brokenImage = path.join(imagesDir, 'broken.png')
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16', '-frames:v', '1', goodImage])
  await fs.writeFile(path.join(imagesDir, 's3.png'), await fs.readFile(goodImage))
  await fs.writeFile(brokenImage, 'not an image')
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000', '-t', '3',
    '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, 'EP0001_merged_audio.mp3'),
  ])
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    research_used: false,
    opening_mode: 'from-start',
    total_duration_sec: 3,
    scenes: [
      { id: 's1', scene_index: 1, start_sec: 0, end_sec: 1, transcript_segment: 'one', visual_prompt: 'one', approved: false },
      { id: 's2', scene_index: 2, start_sec: 1, end_sec: 2, transcript_segment: 'two', visual_prompt: 'two', approved: true },
      { id: 's3', scene_index: 3, start_sec: 2, end_sec: 3, transcript_segment: 'three', visual_prompt: 'three now', rendered_prompt: 'three before', approved: true },
    ],
  }))
})

after(async () => { await tmp.cleanup() })

const job = (slug = WARN_SLUG) => ({ project_slug: slug, output_lines: [], result: {} }) as any

test('all fourteen owner-controlled video checks are wired to the video generator', async () => {
  const source = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
  for (const id of [
    'scene_pictures', 'scenes_approved', 'stale_picture', 'picture_opens', 'scene_overlap',
    'narration_covered', 'scene_count', 'merged_audio_exists', 'subtitles_this_episode',
    'switched_on_inputs', 'cues_approved', 'opening_outro', 'image_pool_covers', 'final_video_whole',
  ]) {
    assert.match(source, new RegExp(`safetyGate\\([^\\n]+['\"]${id}['\"]`), `${id} is not wired`)
  }
})

test('a measured opening covers the matching raw Scene Plan head gap', async () => {
  const { blockingUncoveredNarrationSeconds } = await import('../generators/video.js')
  const timing = { uncovered_sec: 9.542, head_gap_sec: 9.542 }
  assert.equal(blockingUncoveredNarrationSeconds(timing, { intro: { enabled: true, video_path: goodImage } } as any), 0)
  assert.equal(blockingUncoveredNarrationSeconds(timing, { intro: { enabled: false } } as any), 9.542)
})

test('a portable opening is resolved against the authoritative project root before coverage is judged', async () => {
  const { blockingUncoveredNarrationSeconds } = await import('../generators/video.js')
  const timing = { uncovered_sec: 9.542, head_gap_sec: 9.542 }
  const outputRoot = path.join(tmp.dir, 'projects', WARN_SLUG, 'episodes')
  const portable = '${PROJECT}/Season 001/EP0001 - Safety/scene_images/s1.png'
  assert.equal(blockingUncoveredNarrationSeconds(timing, { intro: { enabled: true, video_path: portable } } as any, outputRoot), 0)
  assert.equal(blockingUncoveredNarrationSeconds(timing, { intro: { enabled: true, video_path: portable } } as any), 9.542)
})

test('the final coverage audit obeys narration policy and safely holds the last scene', async () => {
  const { absorbUncoveredNarration } = await import('../generators/video.js')
  const warned = job()
  const durations = [1, 1]
  await absorbUncoveredNarration(WARN_SLUG, warned, durations, 3.5, 'coverage detail')
  assert.deepEqual(durations, [1, 4.5])
  assert.equal(warned.result.safety_warnings[0].check, 'narration_covered')

  const blockedDurations = [1, 1]
  await assert.rejects(
    absorbUncoveredNarration(BLOCK_SLUG, job(BLOCK_SLUG), blockedDurations, 3.5, 'coverage detail'),
    /coverage detail/,
  )
  assert.deepEqual(blockedDurations, [1, 1])
})

test('Sound Design follows cue policy when chapter fallback has no merged track', async () => {
  const { resolveSoundDesignCuesForRender } = await import('../generators/video.js')
  const warned = job()
  const req = { sound_design: { cues: [{ id: 'cue-1' }] } } as any
  assert.deepEqual(await resolveSoundDesignCuesForRender(WARN_SLUG, req, warned), [])
  assert.equal(req.sound_design, undefined)
  assert.equal(warned.result.safety_warnings[0].check, 'cues_approved')

  await assert.rejects(
    resolveSoundDesignCuesForRender(BLOCK_SLUG, { sound_design: { cues: [{ id: 'cue-1' }] } } as any, job(BLOCK_SLUG)),
    /merged audio is missing/i,
  )
})

test('Warn borrows the nearest episode picture and records each affected scene check', async () => {
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const req = { subtitles: { enabled: false } } as any
  const render = job()
  await prepareUnifiedVideoAssemblyInputs(WARN_SLUG, 'EP0001', req, render)

  assert.equal(req.scenes.length, 3)
  assert.equal(req.scenes[1].plan_scene_id, 's2')
  assert.equal(req.scenes[1].image_path, goodImage)
  assert.deepEqual(render.result.safety_warnings.map((warning: any) => warning.check), [
    'scene_pictures', 'scenes_approved', 'stale_picture', 'scene_count',
  ])
})

test('Block still refuses a missing Scene Plan picture', async () => {
  const blockEpisode = path.join(tmp.dir, 'projects', BLOCK_SLUG, 'episodes', 'Season 001', 'EP0001 - Safety')
  await fs.mkdir(path.dirname(blockEpisode), { recursive: true })
  await fs.cp(episodeDir, blockEpisode, { recursive: true })
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  await assert.rejects(
    prepareUnifiedVideoAssemblyInputs(BLOCK_SLUG, 'EP0001', { subtitles: { enabled: false } } as any, job(BLOCK_SLUG)),
    /missing image/i,
  )
})

test('Warn replaces an unreadable picture with a decodable neighbour before encoding', async () => {
  const { replaceUndecodableSceneImages } = await import('../generators/video.js')
  const render = job()
  const scenes = [
    { image_path: goodImage, plan_scene_id: 's1' },
    { image_path: brokenImage, plan_scene_id: 's2' },
    { image_path: path.join(path.dirname(goodImage), 's3.png'), plan_scene_id: 's3' },
  ] as any
  await replaceUndecodableSceneImages(WARN_SLUG, scenes, render)
  assert.equal(scenes[1].image_path, goodImage)
  assert.equal(render.result.safety_warnings[0].check, 'picture_opens')
})

test('Warn never burns a foreign subtitle; Block still refuses it', async () => {
  const foreign = path.join(tmp.dir, 'foreign', 'EP9999_stitched.srt')
  await fs.mkdir(path.dirname(foreign), { recursive: true })
  await fs.writeFile(foreign, '1\n00:00:00,000 --> 00:00:01,000\nforeign\n')
  const { assertSubtitleFileBelongsToEpisode } = await import('../generators/video.js')
  const warned = job()
  const req = { subtitles: { enabled: true, srt_path: foreign } } as any
  await assertSubtitleFileBelongsToEpisode(WARN_SLUG, 'EP0001', episodeDir, req, warned)
  assert.equal(req.subtitles.enabled, false)
  assert.equal(req.subtitles.srt_path, undefined)
  assert.equal(warned.result.safety_warnings[0].check, 'subtitles_this_episode')

  const blockReq = { subtitles: { enabled: true, srt_path: foreign } } as any
  await assert.rejects(
    assertSubtitleFileBelongsToEpisode(BLOCK_SLUG, 'EP0001', episodeDir, blockReq, job(BLOCK_SLUG)),
    /not EP0001's/,
  )
})

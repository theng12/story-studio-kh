/**
 * Scene import library functions (owner 2026-11-02: Google Flow import flow).
 *
 * Tests the shared logic for matching files to scenes, picking clip lengths
 * from preset-owned bounds, generating hand-off data, and broad asset matching.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import {
  pickClipLength,
  matchFilesToScenes,
  generateHandoffData,
  parseCustomClipLengths,
} from '../lib/scene-import.js'
import type { ScenePlanEntry } from '../models/types.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { resolveVideoAssetsDir } from '../generators/scene-clip.js'

let app: any
let cleanup: () => Promise<void>
let work: string

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-bulk-import-test-'))
})

after(async () => {
  await cleanup()
  await fs.rm(work, { recursive: true, force: true }).catch(() => {})
})

function makeScene(overrides: Partial<ScenePlanEntry> & { id: string; scene_index: number; start_sec: number; end_sec: number }): ScenePlanEntry {
  return {
    approved: true,
    visual_prompt: 'A scene.',
    motion_prompt: 'A slow drift.',
    ...overrides,
  } as ScenePlanEntry
}

/** A channel + accepted episode with a two-scene plan, ready for imports. */
async function makeEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Import fixture', logline: 'A deterministic import fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    scenes: [
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'A still archive.', motion_prompt: 'A slow drift.' },
      { id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 16, approved: true, visual_prompt: 'A quiet library.', motion_prompt: 'Gentle pan.' },
    ],
  }))
  return { slug: project.slug, episodeId: accepted.episode_code, paths, planPath }
}

test('pickClipLength returns shortest covering length for Flow (8s default)', () => {
  // 5s scene → 8s clip covers it
  assert.deepEqual(pickClipLength(5, 'flow'), { clip_seconds: 8, exceeds_max: false })
  // 8s scene → 8s clip exactly covers it
  assert.deepEqual(pickClipLength(8, 'flow'), { clip_seconds: 8, exceeds_max: false })
})

test('pickClipLength warns when scene exceeds max allowed clip', () => {
  // 10s scene with Flow (max 8s) → exceeds
  assert.deepEqual(pickClipLength(10, 'flow'), { clip_seconds: 8, exceeds_max: true })
})

test('pickClipLength with extended preset picks shortest covering', () => {
  // 5s scene → 8s (shortest that covers)
  assert.deepEqual(pickClipLength(5, 'flow_extended'), { clip_seconds: 8, exceeds_max: false })
  // 10s scene → 16s
  assert.deepEqual(pickClipLength(10, 'flow_extended'), { clip_seconds: 16, exceeds_max: false })
  // 20s scene → 24s
  assert.deepEqual(pickClipLength(20, 'flow_extended'), { clip_seconds: 24, exceeds_max: false })
  // 30s scene → exceeds max (24s)
  assert.deepEqual(pickClipLength(30, 'flow_extended'), { clip_seconds: 24, exceeds_max: true })
})

test('pickClipLength with custom allowed lengths picks shortest covering length', () => {
  const custom = [5, 10]
  // 3s scene → 5s
  assert.deepEqual(pickClipLength(3, custom), { clip_seconds: 5, exceeds_max: false })
  // 5s scene → 5s
  assert.deepEqual(pickClipLength(5, custom), { clip_seconds: 5, exceeds_max: false })
  // 7s scene → 10s
  assert.deepEqual(pickClipLength(7, custom), { clip_seconds: 10, exceeds_max: false })
  // 15s scene → exceeds max (10s)
  assert.deepEqual(pickClipLength(15, custom), { clip_seconds: 10, exceeds_max: true })
  // Works when passed as 'custom' preset with customLengths argument
  assert.deepEqual(pickClipLength(7, 'custom', custom), { clip_seconds: 10, exceeds_max: false })
  // Fallback to flow default when custom lengths is empty
  assert.deepEqual(pickClipLength(7, 'custom', []), { clip_seconds: 8, exceeds_max: false })
})

test('parseCustomClipLengths parses valid inputs and sorts uniquely', () => {
  assert.deepEqual(parseCustomClipLengths('5, 10'), { ok: true, lengths: [5, 10] })
  assert.deepEqual(parseCustomClipLengths('5, 10s'), { ok: true, lengths: [5, 10] })
  assert.deepEqual(parseCustomClipLengths('5s, 10sec'), { ok: true, lengths: [5, 10] })
  assert.deepEqual(parseCustomClipLengths('10 5 10'), { ok: true, lengths: [5, 10] })
  assert.deepEqual(parseCustomClipLengths([10, 5, 20]), { ok: true, lengths: [5, 10, 20] })
  assert.deepEqual(parseCustomClipLengths(8), { ok: true, lengths: [8] })
})

test('parseCustomClipLengths refuses invalid inputs', () => {
  assert.equal(parseCustomClipLengths('').ok, false)
  assert.equal(parseCustomClipLengths('   ').ok, false)
  assert.equal(parseCustomClipLengths([]).ok, false)
  assert.equal(parseCustomClipLengths(null).ok, false)
  assert.equal(parseCustomClipLengths(undefined).ok, false)
  assert.equal(parseCustomClipLengths('0').ok, false)
  assert.equal(parseCustomClipLengths('-5').ok, false)
  assert.equal(parseCustomClipLengths('5.5').ok, false)
  assert.equal(parseCustomClipLengths('abc').ok, false)
  assert.equal(parseCustomClipLengths([0, 5]).ok, false)
  assert.equal(parseCustomClipLengths([-2, 10]).ok, false)
})

test('matchFilesToScenes matches by exact scene ID', () => {
  const scenes = [
    makeScene({ id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8 }),
    makeScene({ id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 16 }),
  ]
  const files = [
    { name: 'scene-a.mp4' },
    { name: 'scene-b.webm' },
  ]
  const result = matchFilesToScenes(files, scenes)
  assert.equal(result.matched.length, 2)
  assert.equal(result.matched[0]!.scene.id, 'scene-a')
  assert.equal(result.matched[1]!.scene.id, 'scene-b')
  assert.equal(result.unmatched.length, 0)
})

test('matchFilesToScenes matches by scene index in filename', () => {
  const scenes = [
    makeScene({ id: 'abc-123', scene_index: 1, start_sec: 0, end_sec: 8 }),
    makeScene({ id: 'def-456', scene_index: 2, start_sec: 8, end_sec: 16 }),
  ]
  const files = [
    { name: 'Scene01.mov' },
    { name: 'clip_02.mp4' },
  ]
  const result = matchFilesToScenes(files, scenes)
  assert.equal(result.matched.length, 2)
  assert.equal(result.matched[0]!.scene.id, 'abc-123')
  assert.equal(result.matched[1]!.scene.id, 'def-456')
})

test('matchFilesToScenes handles unmatched and odd-named files', () => {
  const scenes = [
    makeScene({ id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8 }),
  ]
  const files = [
    { name: 'scene-a.mp4' },
    { name: 'random-video.mp4' },
  ]
  const result = matchFilesToScenes(files, scenes)
  assert.equal(result.matched.length, 1)
  assert.equal(result.unmatched.length, 1)
  assert.equal(result.unmatched[0]!.name, 'random-video.mp4')
})

test('matchFilesToScenes matches common outside-tool name shapes and handles random names', () => {
  const scenes = [
    makeScene({ id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 5 }),
    makeScene({ id: 'scene-b', scene_index: 2, start_sec: 5, end_sec: 15 }),
    makeScene({ id: 'scene-c', scene_index: 3, start_sec: 15, end_sec: 25 }),
  ]
  const files = [
    { name: 'clip_01.mp4' },                 // outside tool with scene index 1
    { name: 'my-clip (1).mp4' },             // browser/Finder duplicate download suffix must NOT match scene 1
    { name: 'video (1).mp4' },               // bare trailing (1) must stay unmatched
    { name: 'Untitled_scene-b_v2.mp4' },     // outside tool export containing scene ID
    { name: 'scene-c_watermark.mp4' },       // outside tool clip with watermark in filename
    { name: 'f47ac10b-58cc-4372-a567-0e02b2c3d479.mp4' }, // long random hash name
  ]
  const result = matchFilesToScenes(files, scenes)
  // clip_01 → scene-a (index 1)
  // Untitled_scene-b_v2 → scene-b (ID match)
  // scene-c_watermark → scene-c (ID match)
  assert.equal(result.matched.length, 3)
  assert.equal(result.matched[0]!.scene.id, 'scene-a')
  assert.equal(result.matched[1]!.scene.id, 'scene-b')
  assert.equal(result.matched[2]!.scene.id, 'scene-c')
  // Duplicate download suffixes and long random name stay unmatched
  assert.equal(result.unmatched.length, 3)
  assert.equal(result.unmatched[0]!.name, 'my-clip (1).mp4')
  assert.equal(result.unmatched[1]!.name, 'video (1).mp4')
  assert.equal(result.unmatched[2]!.name, 'f47ac10b-58cc-4372-a567-0e02b2c3d479.mp4')
})

test('matchFilesToScenes matches all files dropped under suggested names (clips and images)', () => {
  const scenes = [
    makeScene({ id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 5, motion_prompt: 'drift', visual_prompt: 'shelves' }),
    makeScene({ id: 'scene-b', scene_index: 2, start_sec: 5, end_sec: 15, motion_prompt: 'walk', image_path: '/img/b.png' }),
    makeScene({ id: 'scene-c', scene_index: 3, start_sec: 15, end_sec: 25, motion_prompt: 'pan', image_path: '/img/c.png' }),
    makeScene({ id: 'scene-d', scene_index: 4, start_sec: 25, end_sec: 30, visual_prompt: 'lamp', clip_path: '/clip/d.mp4', motion_choice: 'clip' }),
  ]
  const handoff = generateHandoffData(scenes, 'flow')
  const files = [
    ...handoff.scenes_needing_clips.map(c => ({ name: c.suggested_filename })),
    ...handoff.scenes_needing_images.map(i => ({ name: i.suggested_filename })),
  ]
  assert.equal(files.length, 5) // scene-a.mp4, scene-b.mp4, scene-c.mp4, scene-a.png, scene-d.png
  const result = matchFilesToScenes(files, scenes)
  assert.equal(result.matched.length, 5)
  assert.equal(result.unmatched.length, 0)
  assert.equal(result.ambiguous.length, 0)
  assert.deepEqual(
    result.matched.map(m => `${m.file.name} -> ${m.scene.id}`),
    [
      'scene-a.mp4 -> scene-a',
      'scene-b.mp4 -> scene-b',
      'scene-c.mp4 -> scene-c',
      'scene-a.png -> scene-a',
      'scene-d.png -> scene-d',
    ],
  )
})

test('generateHandoffData lists scenes needing clips with prompts and filenames', () => {
  const scenes = [
    makeScene({
      id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 5,
      visual_prompt: 'An archive.', motion_prompt: 'Slow drift.',
      // No clip_path → needs a clip
    }),
    makeScene({
      id: 'scene-b', scene_index: 2, start_sec: 5, end_sec: 13,
      visual_prompt: 'A library.', motion_prompt: 'Gentle pan.',
      clip_path: '/some/clip.mp4', motion_choice: 'clip',
      image_path: '/some/image.png',
    }),
  ]
  const handoff = generateHandoffData(scenes, 'flow')
  assert.equal(handoff.scenes_needing_clips.length, 1)
  assert.equal(handoff.scenes_needing_clips[0]!.scene_id, 'scene-a')
  assert.equal(handoff.scenes_needing_clips[0]!.clip_seconds, 8)
  assert.equal(handoff.scenes_needing_clips[0]!.motion_prompt, '8s clip: Slow drift.')
  assert.equal(handoff.scenes_needing_clips[0]!.suggested_filename, 'scene-a.mp4')
  assert.equal(handoff.scenes_needing_clips[0]!.exceeds_max, false)
})

test('generateHandoffData warns when scene exceeds max clip length', () => {
  const scenes = [
    makeScene({
      id: 'scene-long', scene_index: 1, start_sec: 0, end_sec: 20,
      visual_prompt: 'A long scene.', motion_prompt: 'Slow movement.',
    }),
  ]
  const handoff = generateHandoffData(scenes, 'flow')
  assert.equal(handoff.scenes_needing_clips.length, 1)
  assert.equal(handoff.scenes_needing_clips[0]!.exceeds_max, true)
  assert.equal(handoff.scenes_needing_clips[0]!.clip_seconds, 8)
})

test('generateHandoffData lists scenes needing images', () => {
  const scenes = [
    makeScene({
      id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8,
      visual_prompt: 'An archive.',
      // No image_path → needs an image
    }),
  ]
  const handoff = generateHandoffData(scenes, 'flow')
  assert.equal(handoff.scenes_needing_images.length, 1)
  assert.equal(handoff.scenes_needing_images[0]!.scene_id, 'scene-a')
  assert.equal(handoff.scenes_needing_images[0]!.suggested_filename, 'scene-a.png')
})

test('GET hand-off endpoint returns scene import data', async () => {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Handoff endpoint', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Handoff fixture', logline: 'A fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'An archive.', motion_prompt: 'Slow drift.' },
      { id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 16, approved: true, visual_prompt: 'A library.', motion_prompt: 'Gentle pan.', clip_path: '/x.mp4', motion_choice: 'clip', image_path: '/x.png' },
    ],
  }))

  const response = await request(app)
    .get(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/import-handoff`)
    .query({ preset: 'flow' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.scenes_needing_clips.length, 1)
  assert.equal(response.body.scenes_needing_clips[0].scene_id, 'scene-a')
  assert.equal(response.body.scenes_needing_clips[0].clip_seconds, 8)
  assert.ok(Array.isArray(response.body.scenes_needing_images))

  // Custom preset with custom_lengths in query
  const customQueryResponse = await request(app)
    .get(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/import-handoff`)
    .query({ preset: 'custom', custom_lengths: '5, 10' })
  assert.equal(customQueryResponse.status, 200)
  // Scene duration is 8s; with custom [5, 10], shortest covering is 10s
  assert.equal(customQueryResponse.body.scenes_needing_clips[0].clip_seconds, 10)

  // Refuses bad custom_lengths in query with 400
  const badQueryResponse = await request(app)
    .get(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/import-handoff`)
    .query({ preset: 'custom', custom_lengths: 'invalid' })
  assert.equal(badQueryResponse.status, 400)
})

test('channel scene_import settings save per channel, persist custom lengths, and read back', async () => {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Channel Settings Import', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Custom channel fixture', logline: 'Fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 4, approved: true, visual_prompt: 'A.', motion_prompt: 'Drift.' },
    ],
  }))

  // 1. Save custom preset and custom_lengths via PUT /projects/:slug/settings/config
  const saveRes = await request(app)
    .put(`/api/projects/${project.slug}/settings/config`)
    .send({ scene_import: { preset: 'custom', custom_lengths: [5, 10] } })
  assert.equal(saveRes.status, 200, JSON.stringify(saveRes.body))

  // 2. Read back config via GET /projects/:slug/settings/config
  const readRes = await request(app)
    .get(`/api/projects/${project.slug}/settings/config`)
  assert.equal(readRes.status, 200)
  assert.deepEqual(readRes.body.scene_import, { preset: 'custom', custom_lengths: [5, 10] })

  // 3. GET /import-handoff without query params picks up saved channel preset & custom lengths
  const handoffRes = await request(app)
    .get(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/import-handoff`)
  assert.equal(handoffRes.status, 200)
  // Scene duration is 4s; saved lengths are [5, 10] → shortest covering is 5s
  assert.equal(handoffRes.body.scenes_needing_clips[0].clip_seconds, 5)

  // 4. Invalid custom lengths refused by PUT /settings/config
  const badRes1 = await request(app)
    .put(`/api/projects/${project.slug}/settings/config`)
    .send({ scene_import: { preset: 'custom', custom_lengths: [0] } })
  assert.equal(badRes1.status, 400)

  const badRes2 = await request(app)
    .put(`/api/projects/${project.slug}/settings/config`)
    .send({ scene_import: { preset: 'custom', custom_lengths: [] } })
  assert.equal(badRes2.status, 400)
})

test('GET match-files endpoint returns matching results', async () => {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Match files', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Match fixture', logline: 'A fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'A.', motion_prompt: 'B.' },
      { id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 16, approved: true, visual_prompt: 'C.', motion_prompt: 'D.' },
    ],
  }))

  const response = await request(app)
    .post(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/match-import-files`)
    .send({ files: [{ name: 'scene-a.mp4' }, { name: 'Scene02.webm' }, { name: 'random.jpg' }] })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.matched.length, 2)
  assert.equal(response.body.matched[0].scene_id, 'scene-a')
  assert.equal(response.body.matched[1].scene_id, 'scene-b')
  assert.equal(response.body.unmatched.length, 1)
  assert.equal(response.body.unmatched[0].name, 'random.jpg')
})
test('replacing an existing clip moves the old one to Story Trash, never overwrites', async () => {
  const fixture = await makeEpisode('Trash replace clip')
  const ffmpeg = await getFFmpegPath()
  const clipsDir = await resolveVideoAssetsDir(fixture.slug, fixture.episodeId, fixture.paths.episode_dir)
  await fs.mkdir(clipsDir, { recursive: true })
  const accepted = path.join(clipsDir, 'scene-a.mp4')
  await fs.writeFile(accepted, Buffer.from('the clip that was already accepted'))

  const source = path.join(work, 'replacement.mp4')
  await promisify(execFile)(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=64x48:r=10:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
  ])
  const response = await request(app)
    .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-clip/scene-a`)
    .set('Content-Type', 'video/mp4')
    .set('X-File-Name', encodeURIComponent('replacement.mp4'))
    .send(await fs.readFile(source))
  assert.equal(response.status, 200, JSON.stringify(response.body))

  // The active file is now the new clip
  const after = await fs.readFile(accepted)
  assert.notDeepEqual(after, Buffer.from('the clip that was already accepted'), 'the active clip was replaced')
  // The old bytes are recoverable from Story Trash — compute the root exactly as the route does.
  const pm = await import('../services/project-manager.js')
  const { trashRootFor } = await import('../lib/trash-move.js')
  const trashClips = path.join(trashRootFor(clipsDir, pm.getProjectDir(fixture.slug) ?? clipsDir, fixture.slug), 'scene-clips')
  const trashed = await fs.readdir(trashClips).catch(() => [] as string[])
  assert.ok(trashed.some(n => n.startsWith('scene-a')), `expected scene-a.* in ${trashClips}, got ${JSON.stringify(trashed)}`)
  const trashedFile = path.join(trashClips, trashed.find(n => n.startsWith('scene-a'))!)
  assert.deepEqual(await fs.readFile(trashedFile), Buffer.from('the clip that was already accepted'), 'the old clip bytes live in Trash')
})

test('replacing an existing scene image moves the old one to Story Trash', async () => {
  const fixture = await makeEpisode('Trash replace image')
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const imagesDir = await resolveSceneImagesDir(fixture.slug, fixture.episodeId.toUpperCase(), fixture.paths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  const accepted = path.join(imagesDir, 'scene-a.png')
  await fs.writeFile(accepted, Buffer.from('the image that was already accepted'))

  const ffmpeg = await getFFmpegPath()
  const source = path.join(work, 'replacement.jpg')
  await promisify(execFile)(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=orange:s=64x48:d=1',
    '-frames:v', '1', '-q:v', '3', source,
  ])
  const imageBytes = await fs.readFile(source)
  const response = await request(app)
    .post(`/api/projects/${fixture.slug}/scene-review/${fixture.episodeId}/upload-image/scene-a`)
    .send({ data_base64: imageBytes.toString('base64') })
  assert.equal(response.status, 200, JSON.stringify(response.body))

  const after = await fs.readFile(accepted)
  assert.notDeepEqual(after, Buffer.from('the image that was already accepted'), 'the active image was replaced')
  // The old bytes are recoverable from Story Trash — compute the root exactly as the route does.
  const pm = await import('../services/project-manager.js')
  const { trashRootFor } = await import('../lib/trash-move.js')
  const trashImages = path.join(trashRootFor(imagesDir, pm.getProjectDir(fixture.slug) ?? imagesDir, fixture.slug), 'scene-images')
  const trashed = await fs.readdir(trashImages).catch(() => [] as string[])
  assert.ok(trashed.some(n => n.startsWith('scene-a')), `expected scene-a.* in ${trashImages}, got ${JSON.stringify(trashed)}`)
  const trashedFile = path.join(trashImages, trashed.find(n => n.startsWith('scene-a'))!)
  assert.deepEqual(await fs.readFile(trashedFile), Buffer.from('the image that was already accepted'), 'the old image bytes live in Trash')
})

/**
 * Scene import: clip length in the hand-off prompt, imported-clip freshness,
 * and a missing clip falling back to the still (owner 2026-11-02).
 *
 * - The copied motion prompt states the clip length the external tool must make,
 *   and says when the scene is longer than any allowed clip.
 * - An imported external clip is judged by its motion prompt only: the local
 *   still's version/hash are not its source, so importing the still after the
 *   clip must not call the clip stale (which silently replaced it with the still).
 * - A scene whose clip file is missing falls back to its approved still and the
 *   episode still assembles (scanEpisodeAssets returns it as a usable still).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { clipPrompt, generateHandoffData, pickClipLength } from '../lib/scene-import.js'
import { sceneClipStaleReason } from '../services/scene-media-checkpoint.js'
import type { ScenePlanEntry } from '../models/types.js'

let app: any
let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
})

after(async () => { await cleanup() })

function makeScene(overrides: Partial<ScenePlanEntry> & { id: string; scene_index: number; start_sec: number; end_sec: number }): ScenePlanEntry {
  return { approved: true, visual_prompt: 'A scene.', motion_prompt: 'A slow drift.', ...overrides } as ScenePlanEntry
}

// ── clip_seconds reaches the copied prompt ────────────────────────────────────

test('the hand-off motion prompt states the clip length the tool must make', () => {
  const scenes = [makeScene({ id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 5, motion_prompt: 'Slow drift.' })]
  const handoff = generateHandoffData(scenes, 'flow')
  const row = handoff.scenes_needing_clips[0]!
  assert.equal(row.clip_seconds, 8)
  assert.equal(row.motion_prompt, '8s clip: Slow drift.')
  // The raw prompt is still reachable for callers that want it unornamented.
  assert.match(row.motion_prompt, /Slow drift\.$/)
})

test('a scene longer than the longest allowed clip says so in the prompt', () => {
  const scenes = [makeScene({ id: 'scene-long', scene_index: 1, start_sec: 0, end_sec: 20, motion_prompt: 'Slow movement.' })]
  const { clip_seconds, exceeds_max } = pickClipLength(20, 'flow')
  assert.deepEqual({ clip_seconds, exceeds_max }, { clip_seconds: 8, exceeds_max: true })
  const handoff = generateHandoffData(scenes, 'flow')
  const prompt = handoff.scenes_needing_clips[0]!.motion_prompt
  assert.match(prompt, /^8s clip/)
  assert.match(prompt, /longer than any allowed clip/)
  assert.match(prompt, /Slow movement\.$/)
})

test('every clip length is at most the preset max with warning whenever scene runs longer (10s scene with Flow 8s max)', () => {
  const scenes = [
    makeScene({ id: 'scene-c', scene_index: 3, start_sec: 0, end_sec: 10, motion_prompt: 'A pan across the reading room.' }),
  ]
  const { clip_seconds, exceeds_max } = pickClipLength(10, 'flow')
  assert.equal(clip_seconds, 8)
  assert.equal(exceeds_max, true)
  const handoff = generateHandoffData(scenes, 'flow')
  const row = handoff.scenes_needing_clips[0]!
  assert.equal(row.clip_seconds, 8)
  assert.equal(row.exceeds_max, true)
  assert.equal(
    row.motion_prompt,
    '8s clip (scene runs 10s — longer than any allowed clip; trim or hold to fit): A pan across the reading room.',
  )
})

test('clipPrompt is pure text assembly — no scene data leaks in', () => {
  assert.equal(clipPrompt(false, 16, 12, 'Pan right.'), '16s clip: Pan right.')
  assert.equal(
    clipPrompt(true, 8, 30, 'Pan right.'),
    '8s clip (scene runs 30s — longer than any allowed clip; trim or hold to fit): Pan right.',
  )
})

// ── an imported clip is not called stale by the still's identity ─────────────

test('an imported external clip stays fresh when the still is imported after it', async () => {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'External freshness', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Freshness fixture', logline: 'A fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
  await fs.writeFile(planPath, JSON.stringify({
    scenes: [
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'An archive.', motion_prompt: 'Slow drift.' },
    ],
  }))

  // 1. The clip arrives first (no still yet) — the owner's Flow order.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-fresh-'))
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const ffmpeg = (await import('../services/ffmpeg-manager.js')).getFFmpegPath
  const source = path.join(dir, 'clip.mp4')
  await promisify(execFile)(await ffmpeg(), [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=white:s=64x48:r=10:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source,
  ])
  const clipRes = await request(app)
    .post(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/upload-clip/scene-a`)
    .set('Content-Type', 'video/mp4')
    .set('X-File-Name', encodeURIComponent('clip.mp4'))
    .send(await fs.readFile(source))
  assert.equal(clipRes.status, 200, JSON.stringify(clipRes.body))

  // 2. The still arrives second and bumps image_version.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const imgRes = await request(app)
    .post(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/upload-image/scene-a`)
    .send({ data_base64: png.toString('base64') })
  assert.equal(imgRes.status, 200, JSON.stringify(imgRes.body))

  // 3. The imported clip is still fresh: only its motion prompt judges it.
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  const scene = plan.scenes[0]
  assert.equal(scene.clip_renderer, 'external')
  assert.ok(scene.image_version, 'the still stamped a version after the clip')
  assert.notEqual(scene.clip_source_image_version ?? null, scene.image_version, 'fixture: versions differ')
  assert.equal(await sceneClipStaleReason(scene), null, 'an imported clip must not be staled by the still')

  // 4. Motion Review accepts it as the clip choice (the route re-checks freshness).
  const choice = await request(app)
    .put(`/api/projects/${project.slug}/scene-review/${accepted.episode_code}/motion-choice`)
    .send({ scene_id: 'scene-a', choice: 'clip' })
  assert.equal(choice.status, 200, JSON.stringify(choice.body))
  assert.equal(choice.body.changed, 1)

  // 5. Editing the motion prompt DOES stale it — the rule that still applies.
  const plan2 = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  plan2.scenes[0].motion_prompt = 'A different drift.'
  await fs.writeFile(planPath, JSON.stringify(plan2))
  const plan3 = JSON.parse(await fs.readFile(planPath, 'utf-8'))
  assert.equal(await sceneClipStaleReason(plan3.scenes[0]), 'stale motion prompt')
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── a missing clip falls back to the still and the episode assembles ─────────

test('a scene whose clip file is missing falls back to its approved still', async () => {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  const project = await pm.createProject({ name: 'Missing clip', episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Fallback fixture', logline: 'A fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [
      // Clip chosen, file gone: must fall back to the still, not vanish.
      { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 8, approved: true, visual_prompt: 'An archive.', motion_prompt: 'Slow drift.', motion_choice: 'clip' },
      // Plain still scene.
      { id: 'scene-b', scene_index: 2, start_sec: 8, end_sec: 16, approved: true, visual_prompt: 'A library.', motion_choice: 'still' },
    ],
  }))
  const imagesDir = await resolveSceneImagesDir(project.slug, accepted.episode_code.toUpperCase(), paths.episode_dir)
  await fs.mkdir(imagesDir, { recursive: true })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  for (const id of ['scene-a', 'scene-b']) await fs.writeFile(path.join(imagesDir, `${id}.png`), png)

  const { scanEpisodeAssets } = await import('../generators/video.js')
  const assets = await scanEpisodeAssets(project.slug, accepted.episode_code)

  // Both scenes assemble; neither is reported missing.
  assert.deepEqual(assets.scene_plan_coverage?.missing, [])
  assert.equal(assets.scene_plan_coverage?.ready, 2)
  const a = assets.scenes.find(s => s.plan_scene_id === 'scene-a')
  const b = assets.scenes.find(s => s.plan_scene_id === 'scene-b')
  assert.ok(a && b, 'both scenes reach assembly')
  assert.equal(a.media_type, 'still', 'missing clip falls back to the still')
  assert.equal(a.path, a.still_path, 'the fallback uses this scene own still')
  assert.equal(b.media_type, 'still')
  // The dropped selection is named, not silent (AGENTS §4).
  const fallback = assets.scene_plan_coverage?.motion_fallback ?? []
  assert.ok(
    fallback.some(row => row.id === 'scene-a'),
    `scene-a's missing clip is announced: ${JSON.stringify(fallback)}`,
  )
})

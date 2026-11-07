/**
 * Episode Visual Setup Phase 2 — story state in the ACTUAL batch render and in
 * freshness.
 *
 * What this pins:
 *   - the checkpoint records the prompt that was really submitted, story state
 *     included, while the saved editorial `visual_prompt` is untouched;
 *   - a state-only edit marks the still and its clip stale, in both the I2V and
 *     T2V lanes, through the one freshness rule;
 *   - a caller without the story context (the legacy surfaces) never red-flags
 *     a story-stamped record it cannot judge;
 *   - completion's audit agrees with the batch when it is given the state, and
 *     stays honest — not falsely invalid — when it is not.
 *
 * ZERO paid calls.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import {
  auditSceneImageCompletion,
  checkpointSceneImage,
  sceneClipStaleReason,
} from '../services/scene-media-checkpoint.js'
import { sceneImageStaleReason } from '../services/scene-plan-staleness.js'
import {
  readSceneStoryContext,
  sceneStoryStateSuffix,
  writeSceneStoryContext,
} from '../services/scene-reference-characters.js'
import type { ScenePlan, ScenePlanEntry } from '../models/types.js'

let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
})
after(async () => { await cleanup() })

async function seed(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
  const { writeStoryEntities } = await import('../services/story-entities.js')

  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Story state freshness', logline: 'A deterministic episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  const planPath = await resolveScenePlanPath(project.slug, episodeId, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1, generated_at: '', planner_model: '', total_duration_sec: 20,
    scenes: [
      {
        id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 10, transcript_segment: 'One',
        visual_prompt: 'A lighthouse.', motion_prompt: 'Slow push in.', video_prompt: 'Waves roll.',
      },
      {
        id: 'scene-002', scene_index: 2, start_sec: 10, end_sec: 20, transcript_segment: 'Two',
        visual_prompt: 'A harbour.', video_prompt: 'Waves roll.',
      },
    ],
  }), 'utf-8')

  await writeStoryEntities(project.slug, episodeId, {
    entities: [
      { id: 'cast-mara', kind: 'cast', name: 'Mara', important: true, review: 'keep' },
    ],
  })
  return { project, episodeId, paths, planPath }
}

async function setOutfit(slug: string, episodeId: string, outfit: string) {
  await writeSceneStoryContext(slug, episodeId, {
    scenes: ['scene-001', 'scene-002'].map(sceneId => ({
      scene_id: sceneId,
      entities: [{ entity_id: 'cast-mara', state: { outfit } }],
    })),
  })
}

async function readPlan(planPath: string): Promise<ScenePlan> {
  return JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
}

async function sceneOf(planPath: string, sceneId: string): Promise<ScenePlanEntry> {
  return (await readPlan(planPath)).scenes.find(scene => scene.id === sceneId)!
}

test('the checkpoint stamps the submitted prompt, leaves the editorial prompt alone, and state-only edits stale the still', async () => {
  const { project, episodeId, paths, planPath } = await seed('Story state image freshness')
  await setOutfit(project.slug, episodeId, 'red coat')
  const story = await readSceneStoryContext(project.slug, episodeId)
  const suffix = sceneStoryStateSuffix('scene-001', story).suffix
  assert.match(suffix, /Mara — outfit: red coat/)

  const effective = `A lighthouse.${suffix}`
  const imagePath = path.join(paths.episode_dir, 'scene-001.png')
  await fs.writeFile(imagePath, await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer())
  await checkpointSceneImage(planPath, 'scene-001', imagePath, effective, false)

  const scene = await sceneOf(planPath, 'scene-001')
  assert.equal(scene.rendered_prompt, effective, 'the record is what was submitted, state included')
  assert.equal(scene.visual_prompt, 'A lighthouse.', 'the saved editorial prompt is never rewritten')
  assert.equal(sceneImageStaleReason(scene, effective), null)
  assert.equal(sceneImageStaleReason(scene), null, 'a caller without the state does not red-flag what it cannot judge')

  await setOutfit(project.slug, episodeId, 'blue coat')
  const changed = sceneStoryStateSuffix('scene-001', await readSceneStoryContext(project.slug, episodeId)).suffix
  assert.notEqual(changed, suffix)
  assert.equal(
    sceneImageStaleReason(scene, `A lighthouse.${changed}`),
    'image was rendered from an outdated prompt',
    'a state-only edit is a real change to what the picture must show',
  )
})

test('a state-only edit stales the I2V clip and the T2V clip through the same rule', async () => {
  const { project, episodeId, paths, planPath } = await seed('Story state clip freshness')
  await setOutfit(project.slug, episodeId, 'red coat')
  const suffix = sceneStoryStateSuffix('scene-001', await readSceneStoryContext(project.slug, episodeId)).suffix
  const context = { slug: project.slug, episodeId, episodeDir: paths.episode_dir }

  const plan = await readPlan(planPath)
  const i2v = plan.scenes.find(scene => scene.id === 'scene-001')!
  i2v.clip_renderer = 'image_to_video'
  i2v.rendered_motion_prompt = `${i2v.motion_prompt}${suffix}`
  const t2v = plan.scenes.find(scene => scene.id === 'scene-002')!
  t2v.visual_lane = 'text_to_video'
  t2v.clip_renderer = 'text_to_video'
  t2v.rendered_video_prompt = `${t2v.video_prompt}${suffix}`
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')

  assert.equal(await sceneClipStaleReason(i2v, context), null)
  assert.equal(await sceneClipStaleReason(t2v, context), null)
  assert.equal(await sceneClipStaleReason(i2v), null, 'a context-less caller cannot judge state and leaves it alone')
  assert.equal(await sceneClipStaleReason(t2v), null)

  await setOutfit(project.slug, episodeId, 'blue coat')
  // A new check pass reads the sidecar again; the previous context's one read
  // belongs to the pass that made it.
  const afterEdit = { ...context }
  assert.equal(await sceneClipStaleReason(i2v, afterEdit), 'stale motion prompt')
  assert.equal(await sceneClipStaleReason(t2v, afterEdit), 'stale video prompt')
})

test('the completion audit agrees with the batch when it is given the state', async () => {
  const { project, episodeId, paths, planPath } = await seed('Story state completion audit')
  await setOutfit(project.slug, episodeId, 'red coat')
  const suffix = sceneStoryStateSuffix('scene-001', await readSceneStoryContext(project.slug, episodeId)).suffix

  const plan = await readPlan(planPath)
  plan.scenes[0]!.rendered_prompt = `A lighthouse.${suffix}`
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
  const imagePath = path.join(paths.episode_dir, 'scene-001.png')
  await fs.writeFile(imagePath, await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 50, b: 60 } } }).png().toBuffer())

  const matching = await auditSceneImageCompletion(planPath, ['scene-001'], [paths.episode_dir], { 'scene-001': suffix })
  assert.deepEqual(matching.invalid, [])

  await setOutfit(project.slug, episodeId, 'blue coat')
  const changed = sceneStoryStateSuffix('scene-001', await readSceneStoryContext(project.slug, episodeId)).suffix
  const stale = await auditSceneImageCompletion(planPath, ['scene-001'], [paths.episode_dir], { 'scene-001': changed })
  assert.deepEqual(stale.invalid, ['scene-001 (image was rendered from an outdated prompt)'])

  const noState = await auditSceneImageCompletion(planPath, ['scene-001'], [paths.episode_dir])
  assert.deepEqual(noState.invalid, [], 'without the state the audit does not invent a verdict')
})

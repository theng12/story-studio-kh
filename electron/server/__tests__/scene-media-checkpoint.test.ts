import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { checkpointSceneClip, checkpointSceneImage } from '../services/scene-media-checkpoint.js'
import type { ScenePlan } from '../models/types.js'

const tempDirs: string[] = []

async function fixture(): Promise<{ dir: string; planPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-media-checkpoint-'))
  tempDirs.push(dir)
  const planPath = path.join(dir, 'scene_plan.json')
  const plan: ScenePlan = {
    schema_version: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    planner_model: 'test',
    source_stitched_srt: 'test.srt',
    total_duration_sec: 10,
    research_used: false,
    planned_in_windows: 0,
    planning_stage: 'visual',
    scenes: [
      { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 5, transcript_segment: 'One', visual_prompt: 'Prompt one' },
      { id: 'scene-2', scene_index: 2, start_sec: 5, end_sec: 10, transcript_segment: 'Two', visual_prompt: 'Prompt two' },
    ],
  }
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
  return { dir, planPath }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('scene media checkpoints', () => {
  it('keeps concurrent image registrations for different scenes', async () => {
    const { dir, planPath } = await fixture()
    const image1 = path.join(dir, 'scene-1.png')
    const image2 = path.join(dir, 'scene-2.png')
    await Promise.all([fs.writeFile(image1, 'image-one'), fs.writeFile(image2, 'image-two')])

    await Promise.all([
      checkpointSceneImage(planPath, 'scene-1', image1, 'Prompt one'),
      checkpointSceneImage(planPath, 'scene-2', image2, 'Prompt two'),
    ])

    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.image_path, image1)
    assert.equal(saved.scenes[1]?.image_path, image2)
  })

  it('rejects an empty media file without changing the plan', async () => {
    const { dir, planPath } = await fixture()
    const empty = path.join(dir, 'empty.png')
    await fs.writeFile(empty, '')
    await assert.rejects(checkpointSceneImage(planPath, 'scene-1', empty, 'Prompt one'), /usable file/)
    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.image_path, undefined)
  })

  it('fails loudly when a paid result no longer has a matching scene', async () => {
    const { dir, planPath } = await fixture()
    const image = path.join(dir, 'orphan.png')
    await fs.writeFile(image, 'image')
    await assert.rejects(checkpointSceneImage(planPath, 'missing', image, 'Prompt'), /disappeared/)
  })

  it('registers a verified clip with its prompt and image version', async () => {
    const { dir, planPath } = await fixture()
    const clip = path.join(dir, 'scene-1.mp4')
    await fs.writeFile(clip, 'video')
    await checkpointSceneClip(planPath, 'scene-1', clip, 'Slow push in', 'image-v1', true)
    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.clip_path, clip)
    assert.equal(saved.scenes[0]?.rendered_motion_prompt, 'Slow push in')
    assert.equal(saved.scenes[0]?.clip_source_image_version, 'image-v1')
    assert.equal(saved.scenes[0]?.motion_choice, 'clip')
  })
})

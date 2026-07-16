import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { checkpointScenePrompt } from '../services/scene-prompt-checkpoint.js'
import { parseDirectPackResults } from '../generators/scene-plan.js'
import type { ScenePlan } from '../models/types.js'

const tempDirs: string[] = []

async function makePlan(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-prompt-checkpoint-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'scene_plan.json')
  const plan: ScenePlan = {
    schema_version: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    planner_model: 'test-model',
    source_stitched_srt: 'EP0001_stitched.srt',
    total_duration_sec: 12,
    research_used: false,
    planned_in_windows: 0,
    planning_stage: 'timeline',
    scenes: [
      { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6, transcript_segment: 'One', visual_prompt: '' },
      { id: 'scene-2', scene_index: 2, start_sec: 6, end_sec: 12, transcript_segment: 'Two', visual_prompt: '' },
    ],
  }
  await fs.writeFile(file, JSON.stringify(plan), 'utf-8')
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('scene prompt checkpoints', () => {
  it('recovers completed scene rows from truncated cloud JSON', () => {
    const truncated = '{"results":[{"scene_id":"scene-1","visual_prompt":"First"},{"scene_id":"scene-2","visual_prompt":"Second"},{"scene_id":"scene-3","visual_prompt":"cut off'
    assert.deepEqual(
      [...parseDirectPackResults(truncated, ['scene-1', 'scene-2', 'scene-3'], 'visual')],
      [['scene-1', 'First'], ['scene-2', 'Second']],
    )
  })

  it('preserves completed prompts when a later scene result is invalid', async () => {
    const file = await makePlan()
    await checkpointScenePrompt(file, 'scene-1', 'A complete visual prompt', 'visual')

    await assert.rejects(
      checkpointScenePrompt(file, 'missing-scene', 'Should not be written', 'visual'),
      /not in the current timeline/,
    )

    const saved = JSON.parse(await fs.readFile(file, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.visual_prompt, 'A complete visual prompt')
    assert.equal(saved.scenes[1]?.visual_prompt, '')
    assert.equal(saved.planning_stage, 'visual')
  })

  it('serializes concurrent scene saves without losing either result', async () => {
    const file = await makePlan()
    await Promise.all([
      checkpointScenePrompt(file, 'scene-1', 'First prompt', 'visual'),
      checkpointScenePrompt(file, 'scene-2', 'Second prompt', 'visual'),
    ])

    const saved = JSON.parse(await fs.readFile(file, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.visual_prompt, 'First prompt')
    assert.equal(saved.scenes[1]?.visual_prompt, 'Second prompt')
  })

  it('rejects empty prompt content without changing the plan', async () => {
    const file = await makePlan()
    await assert.rejects(checkpointScenePrompt(file, 'scene-1', '   ', 'visual'), /empty visual prompt/)

    const saved = JSON.parse(await fs.readFile(file, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.visual_prompt, '')
    assert.equal(saved.planning_stage, 'timeline')
  })
})

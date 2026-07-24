import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { auditScenePromptCompletion, checkpointScenePrompt } from '../services/scene-prompt-checkpoint.js'
import {
  checkpointPackPromptResults,
  diagnoseScenePromptCompletionIssues,
  packScenePromptItems,
  parseDirectPackResults,
} from '../generators/scene-plan.js'
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
  it('packs a 322-scene repair into seven bounded GenStudio requests', () => {
    const sceneIds = Array.from({ length: 322 }, (_, index) => `scene-${index + 1}`)
    const packs = packScenePromptItems(sceneIds, 50)

    assert.equal(packs.length, 7)
    assert.deepEqual(packs.map(pack => pack.length), [50, 50, 50, 50, 50, 50, 22])
    assert.deepEqual(packs.flat(), sceneIds)
  })

  it('recovers completed scene rows from truncated cloud JSON', () => {
    const truncated = '{"results":[{"scene_id":"scene-1","visual_prompt":"First"},{"scene_id":"scene-2","visual_prompt":"Second"},{"scene_id":"scene-3","visual_prompt":"cut off'
    assert.deepEqual(
      [...parseDirectPackResults(truncated, ['scene-1', 'scene-2', 'scene-3'], 'visual')],
      [['scene-1', 'First'], ['scene-2', 'Second']],
    )
  })

  it('keeps checkpointing later prompt rows when one row cannot be saved', async () => {
    const saved = new Set<string>()
    const durable: string[] = []
    const errors = await checkpointPackPromptResults(
      new Map([
        ['scene-1', 'First prompt'],
        ['scene-2', 'Second prompt'],
        ['scene-3', 'Third prompt'],
      ]),
      new Set(['scene-1', 'scene-2', 'scene-3']),
      saved,
      async sceneId => {
        if (sceneId === 'scene-2') throw new Error('temporary checkpoint failure')
        durable.push(sceneId)
      },
    )

    assert.deepEqual(durable, ['scene-1', 'scene-3'])
    assert.deepEqual([...saved], ['scene-1', 'scene-3'])
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /scene-2: temporary checkpoint failure/)
  })

  it('rejects unexpected pack IDs without blocking valid scene prompts', async () => {
    const saved = new Set<string>()
    const durable: string[] = []
    const errors = await checkpointPackPromptResults(
      [
        ['unknown-scene', 'Wrong prompt'],
        ['scene-1', 'Valid prompt'],
      ],
      new Set(['scene-1']),
      saved,
      async sceneId => { durable.push(sceneId) },
    )

    assert.deepEqual(durable, ['scene-1'])
    assert.deepEqual([...saved], ['scene-1'])
    assert.deepEqual(errors, ['unexpected scene ID unknown-scene'])
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

  it('audits completion from the saved plan and names only missing visual prompts', async () => {
    const file = await makePlan()
    await checkpointScenePrompt(file, 'scene-1', 'A complete visual prompt', 'visual')

    const audit = await auditScenePromptCompletion(file, ['scene-1', 'scene-2'], 'visual')
    assert.deepEqual(audit.completed_ids, ['scene-1'])
    assert.deepEqual(audit.missing_ids, ['scene-2'])
  })

  it('treats a duplicated saved visual prompt as incomplete', async () => {
    const file = await makePlan()
    await checkpointScenePrompt(file, 'scene-1', 'Repeated visual prompt', 'visual')
    await checkpointScenePrompt(file, 'scene-2', 'Repeated visual prompt', 'visual')

    const audit = await auditScenePromptCompletion(file, ['scene-1', 'scene-2'], 'visual')
    assert.deepEqual(audit.completed_ids, ['scene-1'])
    assert.deepEqual(audit.missing_ids, ['scene-2'])
  })

  it('labels duplicate prompt rejection separately from a provider omission', async () => {
    const file = await makePlan()
    await checkpointScenePrompt(file, 'scene-1', 'Repeated visual prompt', 'visual')
    await checkpointScenePrompt(file, 'scene-2', 'Repeated visual prompt', 'visual')
    const plan = JSON.parse(await fs.readFile(file, 'utf-8')) as ScenePlan
    const issues = diagnoseScenePromptCompletionIssues({
      plan,
      requestedIds: ['scene-1', 'scene-2', 'scene-3'],
      missingIds: ['scene-2', 'scene-3'],
      providerResults: new Map([['scene-1', 'Repeated visual prompt'], ['scene-2', 'Repeated visual prompt']]),
    })

    assert.deepEqual(issues, [
      { scene_id: 'scene-2', kind: 'duplicate-prompt', detail: 'duplicate prompt matches scene-1' },
      { scene_id: 'scene-3', kind: 'provider-omitted', detail: 'provider omitted the scene ID from its response' },
    ])
  })

  it('audits motion prompts independently from visual prompt state', async () => {
    const file = await makePlan()
    await checkpointScenePrompt(file, 'scene-1', 'Visual one', 'visual')
    await checkpointScenePrompt(file, 'scene-1', 'Motion one', 'motion')

    const audit = await auditScenePromptCompletion(file, ['scene-1', 'scene-2'], 'motion')
    assert.deepEqual(audit.completed_ids, ['scene-1'])
    assert.deepEqual(audit.missing_ids, ['scene-2'])
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { selectSceneImageBatch } from '../services/scene-image-batch-selection.js'

const scenes = [
  { id: 'scene-1', scene_index: 1, visual_prompt: 'First scene' },
  { id: 'scene-2', scene_index: 2, visual_prompt: 'Second scene' },
  { id: 'scene-3', scene_index: 3, visual_prompt: 'Third scene' },
]

describe('Scene Review GenStudio batch selection', () => {
  test('missing-only retry submits only selected scenes still absent on disk', () => {
    const existing = new Set(['scene-1', 'scene-2'])
    const selected = selectSceneImageBatch(scenes, {
      sceneIds: scenes.map((scene) => scene.id),
      missingOnly: true,
      hasRenderedImage: (id) => existing.has(id),
    })

    assert.deepEqual(selected.map((scene) => scene.id), ['scene-3'])
  })

  test('manual explicit selection still regenerates existing images', () => {
    const selected = selectSceneImageBatch(scenes, {
      sceneIds: ['scene-1', 'scene-3'],
      hasRenderedImage: () => true,
    })

    assert.deepEqual(selected.map((scene) => scene.id), ['scene-1', 'scene-3'])
  })

  test('ordinary resume without a selection renders only missing images', () => {
    const selected = selectSceneImageBatch(scenes, {
      hasRenderedImage: (id) => id !== 'scene-2',
    })

    assert.deepEqual(selected.map((scene) => scene.id), ['scene-2'])
  })
})

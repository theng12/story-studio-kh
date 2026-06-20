import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSceneAssetImportItems,
  isSupportedSceneAssetPath,
} from '../utils/video-assembly-assets'

describe('video assembly extra scene assets', () => {
  test('accepts supported image and video formats', () => {
    for (const file of ['a.png', 'b.JPG', 'c.webp', 'd.mp4', 'e.MOV', 'f.webm', 'g.mkv', 'h.m4v']) {
      assert.equal(isSupportedSceneAssetPath(file), true, file)
    }
    assert.equal(isSupportedSceneAssetPath('notes.txt'), false)
  })

  test('appends after the highest classic scene number', () => {
    const items = buildSceneAssetImportItems(
      [
        { number: 2, source: 'classic' },
        { number: 7, source: 'classic' },
      ],
      ['/tmp/extra.png', '/tmp/extra.mp4'],
    )

    assert.deepEqual(items, [
      { type: 'scene', source_path: '/tmp/extra.png', scene_number: 8 },
      { type: 'scene', source_path: '/tmp/extra.mp4', scene_number: 9 },
    ])
  })

  test('ignores scene-plan synthetic numbers when assigning classic slots', () => {
    const items = buildSceneAssetImportItems(
      [
        { number: 40, source: 'scene_plan' },
        { number: 3, source: 'classic' },
      ],
      ['/tmp/new.jpg'],
    )

    assert.equal(items[0]?.scene_number, 4)
  })

  test('filters unsupported and duplicate paths without leaving number gaps', () => {
    const items = buildSceneAssetImportItems(
      [],
      ['/tmp/a.png', '/tmp/readme.pdf', '/tmp/a.png', '/tmp/b.mov'],
    )

    assert.deepEqual(items, [
      { type: 'scene', source_path: '/tmp/a.png', scene_number: 1 },
      { type: 'scene', source_path: '/tmp/b.mov', scene_number: 2 },
    ])
  })
})

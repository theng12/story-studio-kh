import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTitleImagePreset,
  snapshotTitleImagePreset,
  type TitleImageState,
} from '../utils/video-assembly-presets.js'

describe('Video Assembly title-image preset boundary', () => {
  test('snapshot keeps reusable settings but never stores the episode image', () => {
    const state: TitleImageState = {
      enabled: true,
      image_path: '/episodes/DK0033/title.png',
      duration: 7,
      transition_type: 'crossfade',
      transition_duration: 1.2,
    }

    assert.deepEqual(snapshotTitleImagePreset(state), {
      enabled: true,
      duration: 7,
      transition_type: 'crossfade',
      transition_duration: 1.2,
    })
    assert.equal('image_path' in snapshotTitleImagePreset(state), false)
  })

  test('legacy preset image paths cannot replace the current episode image', () => {
    const current: TitleImageState = {
      enabled: true,
      image_path: '/episodes/DK0040/current-title.png',
      duration: 5,
      transition_type: '',
      transition_duration: 0,
    }

    applyTitleImagePreset(current, {
      enabled: false,
      image_path: '/episodes/DK0033/stale-title.png',
      duration: 8,
      transition_type: 'fade-black',
      transition_duration: 1.5,
    })

    assert.equal(current.image_path, '/episodes/DK0040/current-title.png')
    assert.equal(current.enabled, false)
    assert.equal(current.duration, 8)
    assert.equal(current.transition_type, 'fade-black')
    assert.equal(current.transition_duration, 1.5)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyClosingMusicPreset,
  applyTitleImagePreset,
  CLOSING_MUSIC_DEFAULTS,
  snapshotClosingMusic,
  snapshotTitleImagePreset,
  type ClosingMusicState,
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

describe('Video Assembly closing music preset boundary', () => {
  test('the controls round-trip through a saved timeline preset', () => {
    const live: ClosingMusicState = { volume: 70, duck_release_sec: 2.5, fade_out_sec: 8 }

    const stored = snapshotClosingMusic(live)
    assert.deepEqual(stored, live, 'nothing reusable is dropped on save')

    const applied: ClosingMusicState = { ...CLOSING_MUSIC_DEFAULTS }
    applyClosingMusicPreset(applied, stored)
    assert.deepEqual(applied, live, 'and nothing is lost on apply')
  })

  test('the snapshot is a copy, so moving a slider after saving cannot rewrite the preset', () => {
    const live: ClosingMusicState = { ...CLOSING_MUSIC_DEFAULTS }
    const stored = snapshotClosingMusic(live)
    live.volume = 5
    assert.equal(stored.volume, CLOSING_MUSIC_DEFAULTS.volume)
  })

  test('a preset saved before the controls existed restores the tuned defaults', () => {
    const applied: ClosingMusicState = { volume: 12, duck_release_sec: 9, fade_out_sec: 1 }
    applyClosingMusicPreset(applied, undefined)
    assert.deepEqual(applied, CLOSING_MUSIC_DEFAULTS)
    // …and so does a partial block, rather than leaving one field undefined.
    applyClosingMusicPreset(applied, { volume: 50 })
    assert.deepEqual(applied, { ...CLOSING_MUSIC_DEFAULTS, volume: 50 })
  })

  test('out-of-range and non-numeric values are clamped, never carried into the mix', () => {
    assert.deepEqual(snapshotClosingMusic({ volume: 900, duck_release_sec: -3, fade_out_sec: 999 }), {
      volume: 200, duck_release_sec: 0, fade_out_sec: 20,
    })
    assert.deepEqual(snapshotClosingMusic({ volume: NaN, duck_release_sec: '2' as any, fade_out_sec: null as any }), CLOSING_MUSIC_DEFAULTS)
  })

  test('the defaults sound right with nothing touched: the normal BGM level, a short rise, a long fade', () => {
    assert.equal(CLOSING_MUSIC_DEFAULTS.volume, 100, '100% IS the level Audio Assembly already set')
    assert.ok(CLOSING_MUSIC_DEFAULTS.duck_release_sec > 0, 'the bed rises rather than jumping')
    assert.ok(CLOSING_MUSIC_DEFAULTS.fade_out_sec >= 3, 'the music never stops with a cut')
  })
})

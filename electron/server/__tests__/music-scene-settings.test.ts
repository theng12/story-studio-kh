/**
 * 1.4.271 music scene pictures: the song title drawn on each per-song picture, and the
 * formula's own scene settings list (one different place per picture, never side by side).
 * All pure.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STARTING_EPISODE_SETTINGS,
  assignSceneSettings,
  buildScenePrompt,
  normalizeEpisodeSettings,
  settingsFromEpisodeDefaults,
} from '../services/music-episode.js'
import { MusicFormatPatchSchema, SceneSettingsSchema } from '../contracts/song-formula.js'
import { buildScenePolishPrompt } from '../generators/music-scene-polish.js'

const CAFES = Array.from({ length: 30 }, (_, i) => `Café ${i + 1}`)
const ids = (n: number, tag = 's') => Array.from({ length: n }, (_, i) => `ms-${tag}${String(i).padStart(10, '0')}`)
const neighboursRepeat = (xs: string[]) => xs.some((x, i) => i > 0 && x === xs[i - 1])

describe('song title on each picture', () => {
  test('off (the starting value): the prompt is unchanged and keeps "no people, no text"', () => {
    assert.equal(STARTING_EPISODE_SETTINGS.scenes.title_on_scene, false)
    assert.equal(
      buildScenePrompt({ sceneIdea: 'Paper lanterns on a frozen pier.', title: 'Velvet Hours', theme: 'Cosy' }),
      'Paper lanterns on a frozen pier, Cosy mood, no people, no text',
    )
  })

  test('on: asks for the exact title as legible lettering, drops "no text", keeps "no people"', () => {
    const p = buildScenePrompt({ sceneIdea: 'A rainy window booth', title: 'Velvet Hours', theme: 'Cosy', titleOnScene: true })
    assert.match(p, /no people/)
    assert.doesNotMatch(p, /no text/)
    assert.match(p, /the title "Velvet Hours" written once as clean, legible lettering/)
    assert.match(p, /chalkboard sign, window lettering or a menu card/)
    assert.match(p, /spelled exactly "Velvet Hours", no other text$/)
  })

  test('the option is read from the formula and kept per episode', () => {
    assert.equal(settingsFromEpisodeDefaults({ scenes: { mode: 'per-song', title_on_scene: true } }).scenes.title_on_scene, true)
    const base = settingsFromEpisodeDefaults({ scenes: { mode: 'per-song', title_on_scene: true } })
    assert.equal(normalizeEpisodeSettings({ scenes: { mode: 'per-song' } }, base).scenes.title_on_scene, true, 'an old episode file follows the channel')
    assert.equal(normalizeEpisodeSettings({ scenes: { title_on_scene: false } }, base).scenes.title_on_scene, false)
    assert.equal(normalizeEpisodeSettings({ scenes: { title_on_scene: 'yes' } }, base).scenes.title_on_scene, true, 'junk keeps the base')
  })

  test('Polish Scene Prompts keeps the title for titled scenes and "no text" for the rest', () => {
    const titled = buildScenePolishPrompt({ theme: '', style: '', never: [], scenes: [{ id: 'ms-a', prompt: 'A booth', songs: ['Velvet Hours'], title: 'Velvet Hours' }] })
    assert.doesNotMatch(titled, /Keep "no people, no text"/)
    assert.match(titled, /Keep "no people"/)
    assert.match(titled, /- ms-a \[Velvet Hours\] \(title on picture: "Velvet Hours"\): A booth/)
    assert.match(titled, /legible lettering/)
    const plain = buildScenePolishPrompt({ theme: '', style: '', never: [], scenes: [{ id: 'ms-a', prompt: 'A booth', songs: ['Velvet Hours'] }] })
    assert.match(plain, /Keep "no people, no text"/)
  })
})

describe('scene settings list', () => {
  test('a setting replaces the song scene idea, with the song mood', () => {
    const p = buildScenePrompt({ sceneIdea: 'Frost covered pine needles', setting: 'Kyoto kissaten', mood: 'Warm', title: 'x', theme: 'Morning Coffee' })
    assert.equal(p, 'Kyoto kissaten, warm atmosphere, Morning Coffee mood, no people, no text')
  })

  test('no list: every scene gets no setting, so prompts stay as before', () => {
    assert.deepEqual(assignSceneSettings(ids(3), []), ['', '', ''])
  })

  test('17 pictures from 30 cafés are all different', () => {
    const got = assignSceneSettings(ids(17), CAFES)
    assert.equal(new Set(got).size, 17)
    assert.ok(got.every(g => CAFES.includes(g)))
  })

  test('a reorder keeps every picture setting (it follows the scene, not the position)', () => {
    const list = ids(17)
    const a = assignSceneSettings(list, CAFES)
    const reversed = [...list].reverse()
    const b = assignSceneSettings(reversed, CAFES)
    assert.deepEqual(Object.fromEntries(reversed.map((id, i) => [id, b[i]])), Object.fromEntries(list.map((id, i) => [id, a[i]])))
  })

  test('a short list (3 settings, 12 pictures) is spread evenly and never repeats side by side', () => {
    const list = ['Booth', 'Rooftop', 'Bistro']
    for (const tag of ['a', 'b', 'c', 'd']) {
      const got = assignSceneSettings(ids(12, tag), list)
      assert.equal(neighboursRepeat(got), false, got.join(','))
      const counts = list.map(s => got.filter(g => g === s).length)
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, counts.join(','))
    }
    assert.equal(neighboursRepeat(assignSceneSettings(ids(9), ['A', 'B'])), false, 'two settings alternate')
    assert.deepEqual(assignSceneSettings(ids(2), ['Only']), ['Only', 'Only'], 'one setting is all there is')
  })

  test('the list is validated: trimmed, deduplicated, non-empty, length-limited', () => {
    assert.deepEqual(SceneSettingsSchema.parse([' Kyoto kissaten ', 'kyoto KISSATEN', 'Bookshop café']), ['Kyoto kissaten', 'Bookshop café'])
    assert.equal(SceneSettingsSchema.safeParse([]).success, false)
    assert.equal(SceneSettingsSchema.safeParse(['x']).success, false)
    assert.equal(SceneSettingsSchema.safeParse(['a'.repeat(161)]).success, false)
    assert.equal(SceneSettingsSchema.safeParse(Array.from({ length: 201 }, (_, i) => `Café ${i}`)).success, false)
    assert.equal(MusicFormatPatchSchema.safeParse({ sceneSettings: null }).success, true, 'null = remove the list')
    assert.equal(MusicFormatPatchSchema.safeParse({}).success, false)
  })
})

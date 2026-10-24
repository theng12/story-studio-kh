/**
 * Music episodes, 'duration' scene mode (owner, 2026-10-24): each picture lasts a random length in
 * the owner's range and may change mid-song, so a long song gets several pictures. Every other mode
 * still changes picture only on a song start.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import type { BuilderSong, EpisodeSettings } from '../services/music-episode.js'

await useTempDataDir()
const {
  STARTING_EPISODE_SETTINGS, normalizeEpisodeSettings, sceneIdFor, scenePieceIdFor, settingsFromEpisodeDefaults, songKey, songPieces,
} = await import('../services/music-episode.js')
const { planEpisode } = await import('../services/music-episode-store.js')

const lengths = (pieces: Array<{ start: number; end: number }>) => pieces.map(p => p.end - p.start)

describe('cutting one song', () => {
  test('every picture is between min and max, except the last, which takes the remainder', () => {
    for (const [len, min, max] of [[200, 10, 20], [181, 50, 60], [65, 10, 12], [3600, 2, 600]] as const) {
      const pieces = songPieces(`pool/s-${len}`, 100, 100 + len, min, max)
      const l = lengths(pieces)
      l.slice(0, -1).forEach(x => assert.ok(x >= min && x <= max, `${x} in ${min}-${max}`))
      assert.ok(l.at(-1)! >= min, 'no sliver at the end of a song')
      assert.ok(l.at(-1)! < max + min, 'the last picture runs at most max + min')
      assert.equal(pieces[0]!.start, 100)
      assert.ok(Math.abs(pieces.at(-1)!.end - (100 + len)) < 1e-9, 'the pictures cover the whole song')
      pieces.slice(1).forEach((p, i) => assert.equal(p.start, pieces[i]!.end, 'no gaps or overlaps'))
    }
  })

  test('the same song is cut the same way wherever it sits; different songs are cut differently', () => {
    const at0 = lengths(songPieces('pool/a', 0, 200, 10, 20))
    assert.deepEqual(lengths(songPieces('pool/a', 777, 977, 10, 20)).map(x => +x.toFixed(9)), at0.map(x => +x.toFixed(9)))
    assert.notDeepEqual(lengths(songPieces('pool/b', 0, 200, 10, 20)), at0)
  })

  test('a song shorter than the range is one picture', () => {
    assert.deepEqual(songPieces('pool/a', 0, 8, 10, 20), [{ start: 0, end: 8 }])
    assert.deepEqual(songPieces('pool/a', 0, 20, 10, 20), [{ start: 0, end: 20 }])
  })

  test('picture ids: the first keeps the song\'s scene id, the rest are new ids of the same shape', () => {
    const ref = { pool_id: 'pool', song_id: 'a' }
    assert.equal(scenePieceIdFor(ref, 0), sceneIdFor(ref))
    const ids = [1, 2, 3].map(k => scenePieceIdFor(ref, k))
    ids.forEach(id => assert.match(id, /^ms-[0-9a-f]{12}$/))
    assert.equal(new Set([sceneIdFor(ref), ...ids]).size, 4)
  })
})

describe('the setting', () => {
  test('starts at 10–20 s, is kept, clamped to 2–600 s, and the longest is never shorter than the shortest', () => {
    assert.equal(STARTING_EPISODE_SETTINGS.scenes.min_seconds, 10)
    assert.equal(STARTING_EPISODE_SETTINGS.scenes.max_seconds, 20)
    const kept = normalizeEpisodeSettings({ scenes: { mode: 'duration', min_seconds: 50, max_seconds: 60 } })
    assert.deepEqual([kept.scenes.mode, kept.scenes.min_seconds, kept.scenes.max_seconds], ['duration', 50, 60])
    const clamped = normalizeEpisodeSettings({ scenes: { mode: 'duration', min_seconds: 1, max_seconds: 9999 } })
    assert.deepEqual([clamped.scenes.min_seconds, clamped.scenes.max_seconds], [2, 600])
    const flipped = normalizeEpisodeSettings({ scenes: { mode: 'duration', min_seconds: 30, max_seconds: 10 } })
    assert.deepEqual([flipped.scenes.min_seconds, flipped.scenes.max_seconds], [30, 30])
    const round = normalizeEpisodeSettings(JSON.parse(JSON.stringify(kept)))
    assert.deepEqual(round.scenes, kept.scenes)
  })

  test('a Formula can start a channel on it', () => {
    const s = settingsFromEpisodeDefaults({ scenes: { mode: 'duration', min_seconds: 15, max_seconds: 25 } })
    assert.deepEqual([s.scenes.mode, s.scenes.min_seconds, s.scenes.max_seconds], ['duration', 15, 25])
  })
})

describe('planning an episode', () => {
  const songs: BuilderSong[] = [180, 45, 8].map((duration_s, i) => ({
    pool_id: 'jazz', id: `s${i}`, title: `Song ${i}`, duration_s, drawable: true, plays: 0,
  }))
  const byKey = new Map(songs.map(s => [songKey({ pool_id: s.pool_id, song_id: s.id }), s] as const))
  const doc = (scenes: Partial<EpisodeSettings['scenes']>) => ({
    schema_version: 1 as const, episode_code: 'CJ0001', draw_round: 0, scene_breaks: [], prompt_overrides: {}, updated_at: '',
    songs: songs.map(s => ({ pool_id: s.pool_id, song_id: s.id })),
    settings: normalizeEpisodeSettings({ join: { style: 'butt', seconds: 0.5 }, scenes: { ...scenes } }),
  })

  test("'duration' cuts long songs into several pictures that tile the episode, titles only on each song's first", () => {
    const { scenes, timeline } = planEpisode(doc({ mode: 'duration', min_seconds: 10, max_seconds: 20, title_on_scene: true }) as any, byKey)
    const perSong = songs.map(s => scenes.filter(scene => scene.song_keys[0] === songKey({ pool_id: s.pool_id, song_id: s.id })))
    assert.ok(perSong[0]!.length >= 9 && perSong[0]!.length <= 18, `180 s song: ${perSong[0]!.length} pictures`)
    assert.ok(perSong[1]!.length >= 2, '45 s song is cut too')
    assert.equal(perSong[2]!.length, 1, 'an 8 s song is one picture')
    assert.equal(scenes[0]!.start_sec, 0)
    assert.ok(Math.abs(scenes.at(-1)!.end_sec - timeline.total) < 1e-6)
    scenes.slice(1).forEach((scene, i) => assert.ok(Math.abs(scene.start_sec - scenes[i]!.end_sec) < 1e-6))
    scenes.forEach(scene => assert.equal(scene.song_keys.length, 1, 'a picture never spans two songs'))
    assert.deepEqual(scenes.map(s => s.scene_index), scenes.map((_, i) => i + 1))
    assert.equal(new Set(scenes.map(s => s.id)).size, scenes.length)
    perSong.forEach(list => list.forEach((scene, k) => assert.equal(scene.title_on_scene, k === 0)))
  })

  test('re-ordering the songs keeps every picture id; a rebuild gives the same plan', () => {
    const d = doc({ mode: 'duration', min_seconds: 10, max_seconds: 20 })
    const first = planEpisode(d as any, byKey).scenes
    assert.deepEqual(planEpisode(d as any, byKey).scenes, first)
    const reordered = planEpisode({ ...d, songs: [...d.songs].reverse() } as any, byKey).scenes
    assert.deepEqual(new Set(reordered.map(s => s.id)), new Set(first.map(s => s.id)))
  })

  test('the other modes are unchanged: one picture per song', () => {
    const { scenes } = planEpisode(doc({ mode: 'per-song' }) as any, byKey)
    assert.equal(scenes.length, 3)
    assert.deepEqual(scenes.map(s => s.id), songs.map(s => sceneIdFor({ pool_id: s.pool_id, song_id: s.id })))
  })
})

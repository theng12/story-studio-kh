/**
 * Episode Builder decisions (SPEC §4–5 + owner decisions 2026-10-03): draw with a
 * no-repeat window across one or more pools, locks, ordering modes, swap, joins,
 * scene modes, prompts, settings. All pure — nothing here can spend or generate.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  STARTING_EPISODE_SETTINGS,
  buildScenePrompt,
  buildTimeline,
  drawEpisode,
  groupScenes,
  normalizeEpisodeSettings,
  orderEpisode,
  renderEpisodeTracklist,
  sceneIdFor,
  settingsFromEpisodeDefaults,
  smoothFlowBreaks,
  songKey,
  swapCandidates,
  windowEpisodeCodes,
  type BuilderSong,
} from '../services/music-episode.js'

const song = (id: string, over: Partial<BuilderSong> = {}): BuilderSong => ({
  pool_id: 'cello', id, title: `Song ${id}`, duration_s: 200, drawable: true, plays: 0, ...over,
})
const pool = (n: number, over: (i: number) => Partial<BuilderSong> = () => ({})) =>
  Array.from({ length: n }, (_, i) => song(`s${i}`, over(i)))
const draw = (songs: BuilderSong[], extra: Partial<Parameters<typeof drawEpisode>[0]> = {}) => drawEpisode({
  songs, current: [], targetSec: 1000, seed: 'CE0001:0', theme: '', blocked: new Map(), order: 'manual', ...extra,
})

describe('settings', () => {
  test('owner-decided starting values: crossfade, 24 fps, 720p, -14 LUFS / -1 dBTP, one scene per song', () => {
    const s = STARTING_EPISODE_SETTINGS
    assert.equal(s.join.style, 'crossfade')
    assert.equal(s.frame_rate, 24)
    assert.equal(s.resolution, '720p')
    assert.equal(s.loudness_lufs, -14)
    assert.equal(s.true_peak_db, -1)
    assert.equal(s.scenes.mode, 'per-song')
    assert.equal(s.target_length_s, 3900)
  })

  test('every value is changeable, and one bad field never resets the others', () => {
    const s = normalizeEpisodeSettings({
      join: { style: 'silence', seconds: 1.5 }, frame_rate: 30, resolution: '1080p',
      loudness_lufs: -16, true_peak_db: 'loud', order: 'sideways', pools: ['a', 'a', '', 'b'],
    })
    assert.deepEqual(s.join, { style: 'silence', seconds: 1.5 })
    assert.equal(s.frame_rate, 30)
    assert.equal(s.resolution, '1080p')
    assert.equal(s.loudness_lufs, -16)
    assert.equal(s.true_peak_db, -1, 'unreadable value falls back to the base, field by field')
    assert.equal(s.order, 'smooth')
    assert.deepEqual(s.pools, ['a', 'b'])
    assert.equal(normalizeEpisodeSettings({ frame_rate: 23.976 }).frame_rate, 24, 'only the frame rates Video Assembly renders')
  })

  test("the formula's episodeDefaults (feat/music-pool shape) become the channel starting values", () => {
    const s = settingsFromEpisodeDefaults({
      target_length_s: 3600, no_repeat_episodes: 50, loudness_lufs: -16, true_peak_db: -1.5,
      join: { style: 'butt', seconds: 0 }, scenes: { mode: 'every-minutes', minutes: 8 },
      scene_themes: ['', 'Cosy'], scene_change: { transition: 'fadeblack', seconds: 2 },
      frame_rate: 30, resolution: '1080p', pools: ['pool_a', 'pool_b'], effects_look: ['x'],
    })
    assert.equal(s.target_length_s, 3600)
    assert.equal(s.no_repeat_episodes, 50)
    assert.equal(s.join.style, 'butt')
    assert.equal(s.scenes.mode, 'every-minutes')
    assert.equal(s.scenes.minutes, 8)
    assert.equal(s.theme, 'Cosy')
    assert.deepEqual(s.scene_change, { transition: 'fadeblack', seconds: 2 })
    assert.equal(s.frame_rate, 30)
    assert.deepEqual(s.pools, ['pool_a', 'pool_b'])
    assert.deepEqual(settingsFromEpisodeDefaults(undefined), STARTING_EPISODE_SETTINGS)
  })
})

describe('no-repeat window', () => {
  test('the last N other episodes of this channel, in order, newest last', () => {
    const uses = [
      { code: 'CE0001', at: '2026-01-01' }, { code: 'CE0002', at: '2026-01-02' },
      { code: 'CE0003', at: '2026-01-03' }, { code: 'CE0004', at: '2026-01-04' },
      { code: 'CE0002', at: '2026-01-02' },
    ]
    assert.deepEqual(windowEpisodeCodes(uses, 'CE0005', 2), ['CE0003', 'CE0004'])
    assert.deepEqual(windowEpisodeCodes(uses, 'CE0004', 2), ['CE0002', 'CE0003'], 'never the episode being built')
    assert.deepEqual(windowEpisodeCodes(uses, 'CE0005', 0), [])
  })
})

describe('draw', () => {
  test('fills to the target and finishes the last song rather than cutting it', () => {
    const r = draw(pool(10))
    assert.equal(r.songs.length, 5)
    assert.equal(r.total_sec, 1000)
    const r2 = draw(pool(10), { targetSec: 1050 })
    assert.equal(r2.songs.length, 6, 'overshoots by a whole song')
    assert.equal(r2.shortfall_sec, 0)
  })

  test('a crossfade overlap counts against the target; a short silence adds to it', () => {
    assert.equal(draw(pool(10), { join: { style: 'crossfade', seconds: 10 } }).songs.length, 6)
    assert.equal(draw(pool(10), { join: { style: 'silence', seconds: 50 } }).songs.length, 5)
    assert.equal(draw(pool(10), { join: { style: 'silence', seconds: 50 }, targetSec: 1150 }).songs.length, 5)
  })

  test('a short pool reports the shortfall and never invents songs', () => {
    const r = draw(pool(3))
    assert.equal(r.songs.length, 3)
    assert.equal(r.shortfall_sec, 400)
  })

  test('songs inside the no-repeat window, rejected, switched-off and unmeasured songs are never drawn', () => {
    const songs = [...pool(6), song('rej', { drawable: false }), song('nolen', { duration_s: 0 })]
    const blocked = new Map([[songKey(songs[0]!), 'CE0009'], [songKey(songs[1]!), 'CE0010']])
    const r = draw(songs, { blocked, targetSec: 10_000 })
    const keys = r.songs.map(songKey)
    assert.equal(keys.length, 4)
    for (const banned of ['cello/s0', 'cello/s1', 'cello/rej', 'cello/nolen']) assert.ok(!keys.includes(banned), banned)
    assert.equal(r.free_count, 4)
  })

  test('several pools are all providers, with one window across them', () => {
    const songs = [...pool(3), ...pool(3).map(s => ({ ...s, pool_id: 'piano' }))]
    const blocked = new Map([['piano/s0', 'CE0002']])
    const keys = draw(songs, { targetSec: 10_000, blocked }).songs.map(songKey)
    assert.equal(keys.length, 5)
    assert.ok(keys.some(k => k.startsWith('piano/')) && keys.some(k => k.startsWith('cello/')))
    assert.ok(!keys.includes('piano/s0'))
  })

  test('least played first; seeded, so the same episode draws the same songs and a new round differs', () => {
    const songs = pool(40, i => ({ plays: i < 20 ? 3 : 0 }))
    const a = draw(songs)
    assert.ok(a.songs.every(ref => Number(ref.song_id.slice(1)) >= 20), 'only unplayed songs while there are enough')
    assert.deepEqual(draw(songs).songs, a.songs)
    assert.notDeepEqual(draw(songs, { seed: 'CE0001:1' }).songs, a.songs)
  })

  test('rating and the episode theme pull a song forward', () => {
    const songs = [song('plain'), song('cosy', { theme: 'Cosy' }), song('loved', { rating: 5 })]
    const keys = draw(songs, { targetSec: 400, theme: 'cosy' }).songs.map(r => r.song_id)
    assert.ok(!keys.includes('plain'), `expected the themed + rated songs, got ${keys}`)
  })

  test('locked songs keep their place on re-draw; the rest is replaced', () => {
    const songs = pool(30)
    const first = draw(songs, { targetSec: 1000 })
    const current = first.songs.map((ref, i) => (i === 1 || i === 3 ? { ...ref, locked: true } : ref))
    const again = draw(songs, { current, seed: 'CE0001:7', targetSec: 1000 })
    assert.equal(songKey(again.songs[1]!), songKey(current[1]!))
    assert.equal(songKey(again.songs[3]!), songKey(current[3]!))
    assert.ok(again.songs[1]!.locked && again.songs[3]!.locked)
    assert.equal(again.total_sec, 1000)
  })
})

describe('order', () => {
  const flow = [
    song('a', { tempo_bpm: 60, key: 'C major', ensemble: 'solo', energy: 3 }),
    song('b', { tempo_bpm: 96, key: 'D minor', ensemble: 'solo', energy: 2 }),
    song('c', { tempo_bpm: 66, key: 'F major', ensemble: 'solo', energy: 2 }),
    song('g', { tempo_bpm: 64, key: 'C major', ensemble: 'solo', energy: 2 }),
    song('d', { tempo_bpm: 72, key: 'G major', ensemble: 'quartet', energy: 2 }),
    song('e', { tempo_bpm: 84, key: 'A minor', ensemble: 'duo', energy: 1 }),
    song('f', { tempo_bpm: 90, key: 'E minor', ensemble: 'solo', energy: 1 }),
  ]
  const refs = flow.map(s => ({ pool_id: s.pool_id, song_id: s.id }))
  const resolved = (list: { song_id: string }[]) => list.map(r => flow.find(s => s.id === r.song_id)!)

  test('smooth flow keeps tempo steps within 12 BPM and never repeats key + ensemble when the pool allows', () => {
    const ordered = resolved(orderEpisode(refs, flow, 'smooth', 'x'))
    assert.deepEqual(smoothFlowBreaks(ordered), { tempo: 0, keyAndEnsemble: 0 }, ordered.map(s => `${s.id}:${s.tempo_bpm}`).join(' '))
    assert.ok(smoothFlowBreaks(flow).tempo > 0, 'the input order did break it')
  })

  test('manual keeps the order exactly; random is seeded; locks never move', () => {
    assert.deepEqual(orderEpisode(refs, flow, 'manual', 'x'), refs)
    const locked = refs.map((r, i) => (i === 2 ? { ...r, locked: true } : r))
    const random = orderEpisode(locked, flow, 'random', 'seed')
    assert.equal(random[2]!.song_id, 'c')
    assert.deepEqual(orderEpisode(locked, flow, 'random', 'seed'), random)
  })

  test('swap offers the five closest free songs by length and mood', () => {
    const target = song('t', { duration_s: 240, mood: 'tender' })
    const songs = [
      target, song('near', { duration_s: 238, mood: 'tender' }), song('far', { duration_s: 400, mood: 'tender' }),
      song('othermood', { duration_s: 240, mood: 'hopeful' }), song('inep', { duration_s: 240, mood: 'tender' }),
      song('blocked', { duration_s: 240, mood: 'tender' }), ...pool(6, () => ({ duration_s: 300, mood: 'tender' })),
    ]
    const out = swapCandidates(target, songs, new Set(['cello/t', 'cello/inep']), new Map([['cello/blocked', 'CE0001']]))
    assert.equal(out.length, 5)
    assert.equal(out[0]!.id, 'near')
    assert.ok(!out.some(s => ['t', 'inep', 'blocked'].includes(s.id)))
  })
})

describe('joins and the tracklist', () => {
  test('butt-join, short silence and crossfade place songs where the stitch will', () => {
    assert.deepEqual(buildTimeline([100, 200, 50], { style: 'butt', seconds: 3 }), { starts: [0, 100, 300], total: 350, join_seconds: 0 })
    assert.deepEqual(buildTimeline([100, 200, 50], { style: 'silence', seconds: 2 }), { starts: [0, 102, 304], total: 354, join_seconds: 2 })
    assert.deepEqual(buildTimeline([100, 200, 50], { style: 'crossfade', seconds: 3 }), { starts: [0, 97, 294], total: 344, join_seconds: 3 })
    assert.equal(buildTimeline([100, 4], { style: 'crossfade', seconds: 3 }).join_seconds, 2, 'never longer than half the shortest song')
  })

  test('chapters are "0:00 Title" lines; past an hour they read H:MM:SS', () => {
    assert.equal(renderEpisodeTracklist(['A', 'B', 'C'], [0, 229, 3725]), '0:00 A\n3:49 B\n1:02:05 C')
  })
})

describe('scenes', () => {
  const starts = [0, 200, 400, 600, 800, 1000]
  const total = 1200
  test('one per song (starting value), a fixed count, every N minutes, manual — always on song starts', () => {
    assert.equal(groupScenes(starts, total, { mode: 'per-song', count: 0, minutes: 0 }).length, 6)
    assert.deepEqual(groupScenes(starts, total, { mode: 'count', count: 3, minutes: 0 }), [[0, 1], [2, 3], [4, 5]])
    assert.deepEqual(groupScenes(starts, total, { mode: 'every-minutes', count: 0, minutes: 7 }), [[0, 1], [2, 3], [4, 5]])
    assert.deepEqual(groupScenes(starts, total, { mode: 'every-minutes', count: 0, minutes: 12 }), [[0, 1, 2, 3], [4, 5]])
    assert.deepEqual(groupScenes(starts, total, { mode: 'manual', count: 0, minutes: 0 }, new Set([4, 99])), [[0, 1, 2, 3], [4, 5]])
    assert.equal(groupScenes(starts, total, { mode: 'count', count: 50, minutes: 0 }).length, 6, 'never more scenes than songs')
  })

  test('a scene id follows its first song, so its picture survives reorders', () => {
    assert.equal(sceneIdFor({ pool_id: 'p', song_id: 's1' }), sceneIdFor({ pool_id: 'p', song_id: 's1' }))
    assert.notEqual(sceneIdFor({ pool_id: 'p', song_id: 's1' }), sceneIdFor({ pool_id: 'p', song_id: 's2' }))
    assert.match(sceneIdFor({ pool_id: 'p', song_id: 's1' }), /^ms-[0-9a-f]{12}$/)
  })

  test('prompt = scene idea + theme + "no people, no text"', () => {
    assert.equal(
      buildScenePrompt({ sceneIdea: 'Paper lanterns on a frozen pier.', title: 'x', theme: 'Cosy' }),
      'Paper lanterns on a frozen pier, Cosy mood, no people, no text',
    )
    assert.match(buildScenePrompt({ title: 'Wool and Woodsmoke' }), /Wool and Woodsmoke.*no people, no text$/)
  })
})

test('the builder imports no provider or generation client', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const file of ['../services/music-episode.ts', '../services/music-episode-store.ts', '../generators/music-episode-build.ts']) {
    const body = await readFile(path.join(here, file), 'utf8')
    for (const forbidden of ['genstudio-client', 'callAi', 'providers/registry']) {
      assert.ok(!body.includes(forbidden), `${file} must not reach ${forbidden}: building an episode never makes or buys anything`)
    }
  }
})

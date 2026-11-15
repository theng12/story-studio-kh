/**
 * Music format phase 1 — the pure parts of the song pool engine (SPEC §2.2) and the
 * library.json store (SPEC §3, INTERFACES.md B).
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { useTempDataDir } from './_helpers.js'
import { STARTING_SONG_FORMULA, comboCount, comboKey, poolNeeds, singleEpisodeNeed, nextEpisodeShortfall, windowStockDeficit, SongFormulaSchema, ALL_KEYS } from '../contracts/song-formula.js'
import { planCells } from '../services/song-coverage.js'
import { assemblePrompt, checkBrief, trigrams, writeBriefs, BRIEFS_PER_CALL } from '../services/song-brief.js'
import { parseAnalysis, planTrim } from '../services/song-audio.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const sp = await import('../services/song-pool.js')

after(async () => { await temp.cleanup() })

describe('the formula', () => {
  test('the SPEC Cello example has 7,560 combinations, so 1,000 songs never repeat one', () => {
    assert.equal(ALL_KEYS.length, 24)
    assert.equal(comboCount(STARTING_SONG_FORMULA), 3 * 7 * 3 * 24 * 5)
    assert.ok(SongFormulaSchema.safeParse(STARTING_SONG_FORMULA).success)
  })
  test('pool math matches the SPEC table (18 songs × 30 episodes = 540)', () => {
    assert.equal(poolNeeds(3900, 30, 3900 / 18).needed, 540)
    assert.equal(poolNeeds(3900, 50, 3900 / 18).needed, 900)
  })
  test('a tempo band that starts above its end is refused', () => {
    const bad = { ...STARTING_SONG_FORMULA, tempo_bands: [{ id: 'x', label: 'X', min_bpm: 90, max_bpm: 60, weight: 1 }] }
    assert.equal(SongFormulaSchema.safeParse(bad).success, false)
  })
})

describe('coverage planner', () => {
  test('is seeded: the same pool and seed give the same plan', () => {
    assert.deepEqual(planCells(STARTING_SONG_FORMULA, [], 30, 'b1'), planCells(STARTING_SONG_FORMULA, [], 30, 'b1'))
    assert.notDeepEqual(planCells(STARTING_SONG_FORMULA, [], 30, 'b1'), planCells(STARTING_SONG_FORMULA, [], 30, 'b2'))
  })
  test('never reuses a combination already in the pool or in the batch', () => {
    const first = planCells(STARTING_SONG_FORMULA, [], 400, 'a')
    const second = planCells(STARTING_SONG_FORMULA, first, 400, 'b')
    const keys = [...first, ...second].map(c => c.combo_key)
    assert.equal(new Set(keys).size, keys.length)
  })
  test('fills the least-filled values first (relative to weight)', () => {
    const f = { ...STARTING_SONG_FORMULA, ensembles: STARTING_SONG_FORMULA.ensembles.map(e => ({ ...e, weight: 1 })) }
    const existing = Array.from({ length: 10 }, () => ({ ensemble: 'Solo cello', mood: 'Tender', tempo_band: 'slow', key: 'C major', structure: 'ABA' }))
    const cells = planCells(f, existing, 2, 's')
    assert.ok(cells.every(c => c.ensemble !== 'Solo cello'), 'the over-filled ensemble waits')
    assert.ok(cells.every(c => c.mood !== 'Tender'))
  })
  test('weight 0 is never drawn; bpm stays inside its band; length inside the range', () => {
    const f = { ...STARTING_SONG_FORMULA, moods: [{ value: 'Tender', weight: 0 }, { value: 'Cosy', weight: 1 }] }
    for (const c of planCells(f, [], 50, 'w')) {
      assert.equal(c.mood, 'Cosy')
      const band = f.tempo_bands.find(b => b.id === c.tempo_band)!
      assert.ok(c.tempo_bpm >= band.min_bpm && c.tempo_bpm <= band.max_bpm)
      assert.ok(c.length_s >= f.length_s.min && c.length_s <= f.length_s.max)
      assert.ok(c.energy >= 1 && c.energy <= 5)
      assert.equal(c.combo_key, comboKey(c))
    }
  })
  test('once every combination is used it starts again instead of stopping', () => {
    const tiny = { ...STARTING_SONG_FORMULA, ensembles: [{ value: 'A', weight: 1 }], moods: [{ value: 'M', weight: 1 }],
      tempo_bands: [STARTING_SONG_FORMULA.tempo_bands[0]!], keys: ['C major'], structures: [{ value: 'S', weight: 1 }] }
    assert.equal(planCells(tiny, [], 3, 't').length, 3)
  })
})

describe('brief checks', () => {
  const ctx = { never: ['vocals', 'journey'], maxTitleWordShare: 0.03, maxSimilarity: 0.5 }
  const pool = { titles: ['Lanterns Over the Frozen Pier', 'Ferry Bells at Low Tide'], lineGrams: [trigrams('a hymn-like theme in the low register that returns warmer')], sceneGrams: [] as Set<string>[] }
  const ok = { title: 'Orchard Wind, Late September', line: 'long held notes over slow piano chords', scene_idea: 'an orchard at dusk' }
  test('a clean brief passes', () => assert.equal(checkBrief(ok, pool, ctx), ''))
  test('a title already in the pool fails (normalised)', () => assert.match(checkBrief({ ...ok, title: 'lanterns over the frozen pier!' }, pool, ctx), /already in the pool/))
  test('a never-word fails', () => assert.match(checkBrief({ ...ok, line: 'A long journey home' }, pool, ctx), /journey/))
  test('a line that reads like one in the pool fails', () => assert.match(checkBrief({ ...ok, line: 'a hymn-like theme in the low register that returns warmer' }, pool, ctx), /descriptive line/))
  test('a title word over its share fails', () => {
    const many = { ...pool, titles: ['Pier One', 'Pier Two', 'Pier Three'] }
    assert.match(checkBrief({ ...ok, title: 'Pier Four' }, many, ctx), /"pier"/)
  })
  test('the prompt is code-assembled from the fields, tag style', () => {
    const [c] = planCells(STARTING_SONG_FORMULA, [], 1, 'p')
    const p = assemblePrompt(c!, 'A hymn returns.')
    assert.equal(p, `${c!.ensemble}, ${c!.mood}, ${c!.texture}, ${c!.structure}, ${c!.tempo_bpm} BPM, ${c!.key}. A hymn returns.`)
    assert.equal(assemblePrompt(c!, 'x'.repeat(3000), 2000).length, 2000)
  })
})

describe('brief writer', () => {
  const ctx = { titles: [], lines: [], sceneIdeas: [], never: [], maxTitleWordShare: 0.03, maxSimilarity: 0.5 }
  const W = ['Amber', 'Birch', 'Cinder', 'Dune', 'Ember', 'Fjord', 'Glade', 'Heron', 'Isle', 'Juniper', 'Kestrel', 'Lagoon', 'Meadow', 'Nettle', 'Oriel', 'Pine', 'Quarry', 'Rook', 'Sorrel', 'Thistle', 'Umber', 'Vale', 'Willow', 'Yarrow', 'Zephyr']
  let used = 0
  const answer = (n: number) => JSON.stringify({ songs: Array.from({ length: n }, (_, i) => {
    const k = used++
    return { n: i + 1, title: W[k]!, line: `${W[k]} ${W[(k + 7) % 25]} ${W[(k + 13) % 25]}`.toLowerCase(), scene_idea: `${W[(k + 3) % 25]} ${W[(k + 19) % 25]} ${W[(k + 11) % 25]}`.toUpperCase() }
  }) })
  test('writes 20 per call', async () => {
    const cells = planCells(STARTING_SONG_FORMULA, [], 25, 'w')
    let calls = 0
    // Similarity is tested on its own below; this test is about batching.
    const r = await writeBriefs(cells, { ...ctx, maxSimilarity: 0.95 }, async (_s, user) => { calls++; return answer(user.split('\n').filter(l => /^\d+\. /.test(l)).length) })
    assert.equal(BRIEFS_PER_CALL, 20)
    assert.equal(calls, 2)
    assert.equal(r.briefs.length, 25)
    assert.ok(r.briefs.every(b => b.prompt.startsWith(b.ensemble)))
  })
  test('a failing answer is rewritten once, then dropped and reported', async () => {
    const cells = planCells(STARTING_SONG_FORMULA, [], 2, 'd')
    const notes: string[] = []
    const r = await writeBriefs(cells, { ...ctx, titles: ['Same Title'] }, async (_s, user) => {
      notes.push(user)
      return JSON.stringify({ songs: [{ n: 1, title: 'Same Title', line: 'l one', scene_idea: 's one' }, { n: 2, title: 'Fresh Morning', line: 'l two', scene_idea: 's two' }].slice(0, user.split('\n').filter(l => /^\d+\. /.test(l)).length) })
    })
    assert.equal(r.briefs.length, 1)
    assert.equal(r.dropped.length, 1)
    assert.match(r.dropped[0]!.reason, /already in the pool/)
    assert.equal(notes.length, 2, 'one rewrite attempt, no more')
    assert.match(notes[1]!, /rewrite: the title "Same Title"/)
  })
})

describe('audio checks', () => {
  const stderr = [
    '[silencedetect] silence_start: 0', '[silencedetect] silence_end: 0.78 | silence_duration: 0.78',
    '[silencedetect] silence_start: 120.5', '[silencedetect] silence_end: 128.0 | silence_duration: 7.5',
    '[silencedetect] silence_start: 223.6', '[silencedetect] silence_end: 225.0 | silence_duration: 1.4',
    'Summary:', '  Integrated loudness:', '    I:         -21.2 LUFS', '  True peak:', '    Peak:       -2.1 dBFS',
    'size=N/A time=00:03:45.00 bitrate=N/A',
  ].join('\n')
  test('parses loudness, peak, duration and silences', () => {
    const a = parseAnalysis(stderr)
    assert.equal(a.lufs, -21.2); assert.equal(a.true_peak_db, -2.1); assert.equal(a.duration_s, 225)
    assert.equal(a.silences.length, 3)
  })
  test('trims both ends, flags the inner gap, no fade when it decays', () => {
    const t = planTrim(parseAnalysis(stderr))
    assert.equal(t.lead_s, 0.78); assert.ok(Math.abs(t.tail_s - 1.4) < 1e-9); assert.equal(t.fade, false)
    assert.deepEqual(t.gap, { length: 7.5, at: 120.5 })
  })
  test('an abrupt end gets the fade', () => {
    const t = planTrim(parseAnalysis(stderr.replace(/silence_start: 223.6[\s\S]*?duration: 1.4/, '')))
    assert.equal(t.fade, true)
  })
  test('an all-silent file is flagged whole, not trimmed to nothing', () => {
    const t = planTrim({ duration_s: 10, lufs: null, true_peak_db: null, silences: [{ start: 0, end: 10 }] })
    assert.deepEqual(t, { lead_s: 0, tail_s: 0, fade: false, gap: { length: 10, at: 0 } })
  })
  test('checkSong trims a real file with ffmpeg and measures it', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
    const { checkSong } = await import('../services/song-audio.js')
    const file = path.join(temp.dir, 'tone.m4a')
    // 2 s silence + 6 s tone, cut off abruptly.
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=6:r=44100',
      '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-c:a', 'aac', '-b:a', '128k', '-f', 'ipod', file])
    assert.equal(r.status, 0, String(r.stderr))
    const c = await checkSong(file, { trim: true })
    assert.ok(c.trimmed && c.trimmed.lead_s > 1.5, JSON.stringify(c))
    assert.equal(c.trimmed!.faded, true)
    assert.ok(c.duration_s > 5 && c.duration_s < 6.5, String(c.duration_s))
    assert.ok(c.lufs !== null && c.lufs < 0)
  })
})

describe('library.json store', () => {
  const SLUG = 'song-pool-store'
  const projectDir = () => path.join(pm.projectsRoot(), SLUG)
  const libDir = () => path.join(projectDir(), 'music-library')
  before(async () => {
    await fs.mkdir(libDir(), { recursive: true })
    await fs.writeFile(path.join(projectDir(), 'project.json'), JSON.stringify({ slug: SLUG, name: 'Cello Evenings' }))
    await fs.writeFile(path.join(projectDir(), 'config.json'), JSON.stringify({
      slug: SLUG,
      music_library_tracks: [{ filename: 'old.m4a', title: 'Old Song', enabled: true, duration_sec: 200, added_at: '2026-09-01T00:00:00.000Z' }],
      music_library_usage_log: [{ filename: 'old.m4a', episode_code: 'CE0001', used_at: '2026-09-02T00:00:00.000Z' }],
    }))
    await fs.writeFile(path.join(libDir(), 'old.m4a'), 'x')
    await fs.writeFile(path.join(libDir(), 'dropped.m4a'), 'x')
  })

  test('first read migrates the old rows + usage, adds Finder drops, and is self-contained', async () => {
    const pool = await sp.readPool(SLUG)
    assert.equal(pool.schema, 'story-studio.song-pool')
    assert.match(pool.pool_id, /^pool_/)
    assert.equal(pool.name, 'Cello Evenings')
    const old = pool.songs.find(s => s.file === 'old.m4a')!
    assert.equal(old.title, 'Old Song'); assert.equal(old.duration_s, 200)
    assert.deepEqual(old.episodes, [{ code: 'CE0001', project_slug: SLUG, used_at: '2026-09-02T00:00:00.000Z' }])
    assert.ok(pool.songs.some(s => s.file === 'dropped.m4a' && s.source === 'folder'))
    const disk = JSON.parse(await fs.readFile(path.join(libDir(), 'library.json'), 'utf8'))
    assert.equal(disk.pool_id, pool.pool_id, 'the id is minted once and kept')
    const cfg = JSON.parse(await fs.readFile(path.join(projectDir(), 'config.json'), 'utf8'))
    assert.equal(cfg.music_library_tracks.length, 1, 'config is left untouched')
  })

  test('a file deleted in Finder is marked missing and never drawable, history kept', async () => {
    await fs.writeFile(path.join(libDir(), 'gone.m4a'), 'x')
    await sp.readPool(SLUG)
    await sp.updatePool(SLUG, p => { p.songs.find(s => s.file === 'gone.m4a')!.duration_s = 100 })
    await fs.rm(path.join(libDir(), 'gone.m4a'))
    const s = (await sp.readPool(SLUG)).songs.find(x => x.file === 'gone.m4a')!
    assert.equal(s.file_missing, true)
    assert.equal(sp.isDrawable(s), false)
  })

  test('plays are recorded per rendered episode, idempotently, with no cap', async () => {
    const pool = await sp.readPool(SLUG)
    const old = pool.songs.find(s => s.file === 'old.m4a')!
    for (let i = 2; i <= 60; i++) {
      await sp.recordEpisodeUse(SLUG, [old.id], { code: `CE${String(i).padStart(4, '0')}`, project_slug: SLUG, used_at: `2026-09-${String(Math.min(28, i)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}.000Z` })
    }
    await sp.recordEpisodeUse(SLUG, [old.id], { code: 'CE0060', project_slug: SLUG, used_at: '2026-09-30T00:00:00.000Z' })
    const after = (await sp.readPool(SLUG)).songs.find(s => s.id === old.id)!
    assert.equal(after.episodes.length, 60, 'every episode kept, the same episode counted once')
    assert.equal(sp.lastUse(after)!.code, 'CE0060')
  })

  test('the no-repeat window counts this channel\'s last N episodes, across several pools', async () => {
    const pool = await sp.readPool(SLUG)
    const other = { ...pool, pool_id: 'pool_other', songs: [{ ...pool.songs[0]!, id: 's_other', episodes: [{ code: 'MX0009', project_slug: 'mix', used_at: '2026-10-01T00:00:00.000Z' }, { code: 'CE0061', project_slug: SLUG, used_at: '2026-10-02T00:00:00.000Z' }] }] }
    const w = sp.episodeWindow([pool, other], SLUG, 3)
    assert.equal(w[0], 'CE0061'); assert.equal(w.length, 3); assert.ok(!w.includes('MX0009'))
    const old = pool.songs.find(s => s.file === 'old.m4a')!
    assert.equal(sp.inWindow(old, w, SLUG), true)
    assert.equal(sp.inWindow(old, sp.episodeWindow([pool], SLUG, 0), SLUG), false)
  })

  test('reject: an unused song goes to the project _trash; a used one is archived and kept', async () => {
    const pool = await sp.readPool(SLUG)
    const used = pool.songs.find(s => s.file === 'old.m4a')!
    const fresh = pool.songs.find(s => s.file === 'dropped.m4a')!
    const r = await sp.rejectSongs(SLUG, [used.id, fresh.id])
    assert.deepEqual(r, { trashed: [fresh.id], archived: [used.id] })
    await fs.access(path.join(path.dirname(projectDir()), '_trash', path.basename(projectDir()), 'music-library', 'dropped.m4a'))
    await fs.access(path.join(libDir(), 'old.m4a'))
    const after = await sp.readPool(SLUG)
    assert.equal(after.songs.find(s => s.id === used.id)!.status, 'archived')
    assert.equal(after.songs.find(s => s.id === fresh.id)!.status, 'rejected')
    assert.equal(after.songs.filter(sp.isDrawable).some(s => s.id === used.id || s.id === fresh.id), false)
  })

  test('pools are addressable across projects', async () => {
    const pool = await sp.readPool(SLUG)
    const listed = await sp.listPools()
    assert.ok(listed.some(p => p.pool_id === pool.pool_id && p.project_slug === SLUG))
    assert.equal((await sp.findPool(pool.pool_id))!.slug, SLUG)
    assert.equal(await sp.findPool('pool_nope'), null)
  })
})

describe('the seed travels to the Gateway', () => {
  test('a key without a seed is byte-identical to before; a different seed is a different request', async () => {
    const { buildGenStudioMusicIdempotencyKey } = await import('../lib/genstudio-client.js')
    const base = { title: 't', prompt: 'p', instrumental: true, modelId: 'm', requestIdentity: 'r' }
    const before = buildGenStudioMusicIdempotencyKey(base)
    assert.equal(buildGenStudioMusicIdempotencyKey({ ...base, seed: undefined }), before)
    assert.notEqual(buildGenStudioMusicIdempotencyKey({ ...base, seed: 1 }), before)
    assert.notEqual(buildGenStudioMusicIdempotencyKey({ ...base, seed: 1 }), buildGenStudioMusicIdempotencyKey({ ...base, seed: 2 }))
  })
})

describe('window stock and next-episode readiness are two different numbers', () => {
  // The production shape: 500 drawable, 490 blocked by the no-repeat window (10 free), the
  // channel-default window target is 413 songs, and one channel-default episode needs ~32.
  const WINDOW_NEED = 413
  const DRAWABLE = 500
  const FREE = 10
  const SINGLE = 32

  test('a full window stock can still leave the next episode short', () => {
    assert.equal(windowStockDeficit(WINDOW_NEED, DRAWABLE), 0,
      'the pool holds the whole window target')
    assert.equal(nextEpisodeShortfall(SINGLE, FREE), 22,
      'one episode needs 32 songs and only 10 are free for it — never the 403 a window-minus-free count would give')
  })

  test('no-repeat off means every drawable song is free, so the episode is short only by its own need', () => {
    assert.equal(nextEpisodeShortfall(SINGLE, DRAWABLE), 0)
    assert.equal(windowStockDeficit(WINDOW_NEED, 100), 313)
  })

  test('a single episode need comes from one episode, not the window', () => {
    assert.equal(singleEpisodeNeed(3_900, 122), SINGLE)
    assert.equal(singleEpisodeNeed(9_000, 122), Math.ceil(9_000 / 122),
      'a saved 150-minute episode needs its own, larger figure')
  })

  test('an unmeasured pool answers null, never a made-up zero', () => {
    assert.equal(singleEpisodeNeed(3_900, 0), null)
    assert.equal(nextEpisodeShortfall(null, FREE), null)
    assert.equal(windowStockDeficit(null, DRAWABLE), null)
  })
})

/**
 * v1.4.37 — the channel's music library.
 *
 * The two properties worth pinning are the ones that would fail silently:
 *
 * 1. **A Finder-dropped file is a usable track.** The owner reorganises through
 *    Finder — that is how the narration-bed pool has always worked and he
 *    expects the same here. A file that needed a second "register it" step
 *    would look like the library had lost it.
 * 2. **Metadata never outlives its file.** A row for a deleted track would put
 *    a phantom into a mix, which fails at render time long after the cause.
 *
 * Sibling grouping is pinned too, because it is derived rather than minted: the
 * two takes of one request must land in the same group whether the id is
 * computed during the run or recomputed after a crash.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

// project-manager resolves the projects root at module load, so the temp data
// dir has to be in place BEFORE the service is imported.
const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const {
  listLibrary, upsertTrackMeta, removeTrack, recordMixUsage, siblingGroupForJob, MUSIC_LIBRARY_DIRNAME,
} = await import('../services/music-library.js')

const SLUG = 'music-lib-test'
const projectDir = path.join(pm.projectsRoot(), SLUG)
const libDir = path.join(projectDir, MUSIC_LIBRARY_DIRNAME)

async function writeTrack(name: string) {
  await fs.mkdir(libDir, { recursive: true })
  await fs.writeFile(path.join(libDir, name), Buffer.from([0x49, 0x44, 0x33]))
}

before(async () => {
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ slug: SLUG, name: 'Music Lib Test' }, null, 2))
  await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify({ slug: SLUG }, null, 2))
})

after(async () => { await temp.cleanup() })

describe('the library reads disk, not a registry', () => {
  test('a file dropped in via Finder is a usable track with no extra step', async () => {
    await writeTrack('rainy-window.mp3')
    const state = await listLibrary(SLUG)
    const track = state.tracks.find(t => t.filename === 'rainy-window.mp3')
    assert.ok(track, 'a dropped file must appear')
    assert.equal(track!.enabled, true, 'and be usable immediately')
    assert.equal(track!.title, 'rainy-window', 'falling back to its filename for a title')
    assert.equal(track!.times_used, 0)
    assert.equal(track!.last_used_at, null)
  })

  test('non-audio files are ignored', async () => {
    await fs.writeFile(path.join(libDir, 'notes.txt'), 'not music')
    const state = await listLibrary(SLUG)
    assert.ok(!state.tracks.some(t => t.filename === 'notes.txt'))
  })

  test('metadata decorates the disk view rather than replacing it', async () => {
    await upsertTrackMeta(SLUG, 'rainy-window.mp3', {
      title: 'Rainy Window', duration_sec: 182, tags: ['lofi', 'calm'],
    })
    const track = (await listLibrary(SLUG)).tracks.find(t => t.filename === 'rainy-window.mp3')!
    assert.equal(track.title, 'Rainy Window')
    assert.equal(track.duration_sec, 182)
    assert.deepEqual(track.tags, ['lofi', 'calm'])
  })
})

describe('what a mix can actually draw on', () => {
  test('available seconds counts only enabled tracks', async () => {
    await writeTrack('disabled-take.mp3')
    await upsertTrackMeta(SLUG, 'disabled-take.mp3', { duration_sec: 200, enabled: false })
    const state = await listLibrary(SLUG)
    assert.equal(state.available_seconds, 182,
      'a disabled track stays on disk and in the list, but a mix must not count on it')
    assert.equal(state.unmeasured_enabled_tracks, 0, 'this library measured every enabled track')
  })

  /**
   * v1.4.199 — an enabled track whose length could not be probed added 0 to the
   * total while still counting as available, so "usable" was silently LOW and
   * was presented as the whole answer. AGENTS.md §6.
   */
  test('a track with no measured length makes the total a floor, and says so', async () => {
    const before = await listLibrary(SLUG)
    assert.equal(before.unmeasured_enabled_tracks, 0)

    // Enabled, on disk, playable — but no duration was ever recorded for it.
    await writeTrack('unmeasured-take.mp3')
    const after = await listLibrary(SLUG)

    assert.equal(
      after.unmeasured_enabled_tracks, 1,
      'the app must account for an enabled track it could not measure',
    )
    assert.equal(
      after.available_seconds, before.available_seconds,
      'the unmeasured track contributes no seconds, so the total must not move',
    )
    assert.ok(
      after.available_seconds > 0,
      'and the total must still be a real measurement, not flattened to zero',
    )
  })
})

describe('siblings', () => {
  test('both takes of one request share a group, derived from the job id', () => {
    const a = siblingGroupForJob('job_music_abc')
    assert.equal(a, siblingGroupForJob('job_music_abc'),
      'derived, not minted — a crash-replay must land in the same group')
    assert.notEqual(a, siblingGroupForJob('job_music_xyz'))
  })

  test('the group and take number survive a read', async () => {
    await writeTrack('adagio-take-1.mp3')
    await writeTrack('adagio-take-2.mp3')
    const group = siblingGroupForJob('job_music_adagio')
    await upsertTrackMeta(SLUG, 'adagio-take-1.mp3', { sibling_group: group, sibling_index: 1, duration_sec: 170 })
    await upsertTrackMeta(SLUG, 'adagio-take-2.mp3', { sibling_group: group, sibling_index: 2, duration_sec: 189 })
    const tracks = (await listLibrary(SLUG)).tracks.filter(t => t.sibling_group === group)
    assert.equal(tracks.length, 2)
    assert.deepEqual(tracks.map(t => t.sibling_index).sort(), [1, 2])
  })
})

describe('metadata never outlives its file', () => {
  test('a Finder delete leaves no phantom row behind', async () => {
    await writeTrack('ghost.mp3')
    await upsertTrackMeta(SLUG, 'ghost.mp3', { title: 'Ghost', duration_sec: 120 })
    // Delete the file the way the owner would — outside the app entirely.
    await fs.rm(path.join(libDir, 'ghost.mp3'))
    // Any write prunes; the read never shows it.
    await upsertTrackMeta(SLUG, 'rainy-window.mp3', { tags: ['lofi'] })
    const state = await listLibrary(SLUG)
    assert.ok(!state.tracks.some(t => t.filename === 'ghost.mp3'),
      'a row for a track nobody has would put a phantom into a mix and fail at render time')
    const cfg = JSON.parse(await fs.readFile(path.join(projectDir, 'config.json'), 'utf8'))
    assert.ok(!(cfg.music_library_tracks || []).some((r: any) => r.filename === 'ghost.mp3'),
      'and it must be pruned from disk, not merely hidden by the reader')
  })

  test('removeTrack takes the track out of the library and moves the file to the project trash', async () => {
    await writeTrack('unwanted.mp3')
    await upsertTrackMeta(SLUG, 'unwanted.mp3', { title: 'Unwanted' })
    await removeTrack(SLUG, 'unwanted.mp3')
    assert.equal(await fs.access(path.join(libDir, 'unwanted.mp3')).then(() => true, () => false), false)
    assert.ok(!(await listLibrary(SLUG)).tracks.some(t => t.filename === 'unwanted.mp3'))
    // A paid track is never hard-deleted (2026-10-03 audit): it waits in _trash for the owner.
    await fs.access(path.join(path.dirname(projectDir), '_trash', path.basename(projectDir), MUSIC_LIBRARY_DIRNAME, 'unwanted.mp3'))
  })

  test('the music pool moves a removed bed to the project trash too', async () => {
    const pool = await import('../services/music-pool.js')
    const poolDir = path.join(projectDir, 'music')
    await fs.mkdir(poolDir, { recursive: true })
    await fs.writeFile(path.join(poolDir, 'bed.mp3'), Buffer.from([0x49, 0x44, 0x33]))
    assert.deepEqual(await pool.removeTrack(SLUG, 'bed.mp3'), { removed: true })
    assert.equal(await fs.access(path.join(poolDir, 'bed.mp3')).then(() => true, () => false), false)
    await fs.access(path.join(path.dirname(projectDir), '_trash', path.basename(projectDir), 'music', 'bed.mp3'))
  })

  test('a filename that tries to escape the library folder is refused', async () => {
    await assert.rejects(() => removeTrack(SLUG, '../../config.json'))
    assert.ok(await fs.access(path.join(projectDir, 'config.json')).then(() => true, () => false),
      'the project config must still be there')
  })
})

describe('usage is recorded only by a real render', () => {
  test('recording a mix marks every track it used', async () => {
    await recordMixUsage(SLUG, 'EP0001', ['rainy-window.mp3', 'adagio-take-1.mp3'])
    const state = await listLibrary(SLUG)
    const used = state.tracks.find(t => t.filename === 'rainy-window.mp3')!
    assert.equal(used.times_used, 1)
    assert.ok(used.last_used_at)
    const untouched = state.tracks.find(t => t.filename === 'adagio-take-2.mp3')!
    assert.equal(untouched.times_used, 0, 'a track the mix did not use is not marked')
  })

  test('a second use accumulates rather than replacing', async () => {
    await recordMixUsage(SLUG, 'EP0002', ['rainy-window.mp3'])
    const track = (await listLibrary(SLUG)).tracks.find(t => t.filename === 'rainy-window.mp3')!
    assert.equal(track.times_used, 2)
  })

  test('recording nothing is a no-op, not an empty entry', async () => {
    const before = (await listLibrary(SLUG)).recent_usage.length
    await recordMixUsage(SLUG, 'EP0003', [])
    assert.equal((await listLibrary(SLUG)).recent_usage.length, before)
  })
})

/**
 * The channel music-options standard (owner, 2026-10-27): "all of regular channel must have
 * background music. They need at least 10 music options."
 *
 * The count is a TYPED measurement (AGENTS.md §6): "this channel has no tracks" and "the music
 * folder could not be read" must never both arrive as 0. It is a standard to SHOW — assembly is
 * never blocked for falling short (§8).
 */
import { after, before, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import {
  MIN_CHANNEL_MUSIC_OPTIONS,
  musicOptionsNotice,
  type MusicOptionsMeasurement,
} from '../contracts/music-bed-defaults.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let mp: typeof import('../services/music-pool.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  pm = await import('../services/project-manager.js')
  mp = await import('../services/music-pool.js')
})
after(async () => { await cleanup() })

async function channelWith(files: string[]): Promise<string> {
  const proj = await pm.createProject({ name: `MusicOptions${Math.random().toString(36).slice(2, 8)}` })
  if (files.length) {
    const dir = path.join(pm.getProjectDir(proj.slug)!, 'music')
    await fs.mkdir(dir, { recursive: true })
    for (const name of files) await fs.writeFile(path.join(dir, name), 'x')
  }
  return proj.slug
}

describe('the wording', () => {
  test('0 usable options says the count and the standard, and is the only warning it makes', () => {
    const notice = musicOptionsNotice({ measured: true, usable: 0, enabled: 0, from_library: 0 })
    assert.equal(notice.level, 'warn')
    assert.equal(notice.text, 'This channel has 0 background music options; the standard is at least 10.')
  })

  test('meeting the standard is quiet', () => {
    const notice = musicOptionsNotice({ measured: true, usable: MIN_CHANNEL_MUSIC_OPTIONS, enabled: 10, from_library: 0 })
    assert.equal(notice.level, 'ok')
    assert.match(notice.text, /^10 background music options for this channel\.$/)
  })

  test('an UNMEASURABLE count is never spoken as zero', () => {
    const notice = musicOptionsNotice({ measured: false, reason: 'its music folder could not be read' })
    assert.equal(notice.level, 'unknown')
    assert.match(notice.text, /could not be counted/)
    assert.doesNotMatch(notice.text, /\b0\b/)
  })

  test('files switched off for rotation are named when the channel still falls short', () => {
    const notice = musicOptionsNotice({ measured: true, usable: 4, enabled: 1, from_library: 0 })
    assert.equal(notice.level, 'warn')
    assert.match(notice.text, /4 background music options/)
    assert.match(notice.text, /Only 1 of them is switched on for automatic rotation/)
  })

  test('songs that exist but are in no pool yet are named — otherwise the merge would get no music', () => {
    const none = musicOptionsNotice({ measured: true, usable: 12, enabled: 0, from_library: 12 })
    assert.equal(none.level, 'ok', 'the count meets the standard, so no shortfall warning')
    assert.match(none.text, /None of them is in the Music Pool yet, so nothing is rotating automatically/)
    assert.match(none.text, /12 of them from your Music Library, not yet in the pool/)
  })
})

describe('the measurement', () => {
  test('counts audio files on disk and ignores other file types', async () => {
    const slug = await channelWith(['one.mp3', 'two.wav', 'three.m4a', 'four.flac', 'notes.txt', 'cover.jpg'])
    const measured = await mp.measureMusicOptions(slug)
    assert.deepEqual(measured, { measured: true, usable: 4, enabled: 4, from_library: 0 })
  })

  test('ten or more options meet the standard', async () => {
    const files = Array.from({ length: 10 }, (_, i) => `track-${i + 1}.mp3`)
    const slug = await channelWith(files)
    const measured = await mp.measureMusicOptions(slug)
    assert.equal(measured.measured, true)
    assert.equal((measured as { usable: number }).usable, 10)
    assert.equal(musicOptionsNotice(measured).level, 'ok')
  })

  test('a track switched off is still an option, but not one the cycler may draw', async () => {
    const slug = await channelWith(['a.mp3', 'b.mp3', 'c.mp3'])
    await mp.updateTrackMeta(slug, 'b.mp3', { enabled: false })
    assert.deepEqual(await mp.measureMusicOptions(slug), { measured: true, usable: 3, enabled: 2, from_library: 0 })
  })

  test('a channel with no music folder has NO options — that is a measured zero', async () => {
    const slug = await channelWith([])
    assert.deepEqual(await mp.measureMusicOptions(slug), { measured: true, usable: 0, enabled: 0, from_library: 0 })
  })

  test('Music Library songs this channel may use count too, and are named as such', async () => {
    const slug = await channelWith(['pool-a.mp3', 'pool-b.mp3'])
    const libraryDir = path.join(pm.getProjectDir(slug)!, 'music-library')
    await fs.mkdir(libraryDir, { recursive: true })
    for (const name of ['song-1.mp3', 'song-2.wav', 'pool-a.mp3']) await fs.writeFile(path.join(libraryDir, name), 'x')
    // `pool-a.mp3` is in both folders: it is ONE option, not two — two pool
    // tracks plus the two Library songs the pool does not have = four.
    assert.deepEqual(await mp.measureMusicOptions(slug), { measured: true, usable: 4, enabled: 2, from_library: 2 })
    const notice = musicOptionsNotice(await mp.measureMusicOptions(slug))
    assert.match(notice.text, /2 of them from your Music Library, not yet in the pool/)
  })

  test('an unreadable Music Library folder is unmeasurable too — never silently a smaller count', async () => {
    const slug = await channelWith(['a.mp3'])
    await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'music-library'), 'not a folder')
    assert.deepEqual(await mp.measureMusicOptions(slug), { measured: false, reason: 'its Music Library folder could not be read' })
  })

  test('a retired Library song is not an option, and measuring never rewrites the sidecar', async () => {
    const slug = await channelWith([])
    const libraryDir = path.join(pm.getProjectDir(slug)!, 'music-library')
    await fs.mkdir(libraryDir, { recursive: true })
    await fs.writeFile(path.join(libraryDir, 'keep.mp3'), 'x')
    await fs.writeFile(path.join(libraryDir, 'retired.mp3'), 'x')
    const sidecar = path.join(libraryDir, 'library.json')
    const document = {
      schema: 'story-studio.song-pool', project_slug: slug, songs: [
        { id: 's_keep', file: 'keep.mp3', status: 'ready', enabled: true, title: 'Keep', tags: [], episodes: [] },
        { id: 's_retired', file: 'retired.mp3', status: 'rejected', enabled: true, title: 'Retired', tags: [], episodes: [] },
      ],
    }
    await fs.writeFile(sidecar, JSON.stringify(document))
    const before = await fs.readFile(sidecar, 'utf8')

    assert.deepEqual(await mp.measureMusicOptions(slug), { measured: true, usable: 1, enabled: 0, from_library: 1 })
    assert.equal(await fs.readFile(sidecar, 'utf8'), before, 'a page load never migrates or saves the pool')
  })

  test('a music path that cannot be read is UNMEASURABLE, not empty', async () => {
    const slug = await channelWith([])
    // A file where the folder should be: readdir fails with ENOTDIR, and the
    // honest answer is "could not be read", never "0 options".
    await fs.writeFile(path.join(pm.getProjectDir(slug)!, 'music'), 'not a folder')
    const measured = await mp.measureMusicOptions(slug)
    assert.equal(measured.measured, false)
    assert.equal(musicOptionsNotice(measured).level, 'unknown')
  })

  test('an unknown channel is unmeasurable too', async () => {
    const measured: MusicOptionsMeasurement = await mp.measureMusicOptions('no-such-channel')
    assert.deepEqual(measured, { measured: false, reason: 'the channel folder could not be found' })
  })

  test('the Music Pool state carries the measurement the page reads', async () => {
    const slug = await channelWith(['a.mp3', 'b.mp3'])
    const state = await mp.getPoolState(slug)
    assert.deepEqual(state?.music_options, { measured: true, usable: 2, enabled: 2, from_library: 0 })
  })
})

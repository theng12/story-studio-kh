/**
 * Path traversal on the destructive routes — the class that could delete the
 * owner's entire Library from a single URL.
 *
 * WHY THESE TESTS LOOK LIKE THIS. Every one asserts a CONSEQUENCE, not a thrown
 * message: a sentinel file outside the intended directory must still exist
 * afterwards. A test that only checks "it rejected the input" passes just as
 * happily when the rejection happens after the `fs.rm`, which is exactly the
 * shape that made these defects invisible.
 *
 * The incidents, all verified against the code before being fixed:
 *
 *   DELETE /api/character-library/%2e%2e
 *     `libraryDir('..')` === `path.join(<projectsRoot>, '.character-library', '..')`
 *     === `<projectsRoot>` — the Library root, holding every project and, on the
 *     owner's Mac, 107 GB of media. `deleteLibraryCharacter` then ran
 *     `fs.rm(dir, { recursive: true, force: true })`. `validateId()` already
 *     existed in that file and `createLibraryCharacter` called it; delete did not.
 *
 *   DELETE /api/projects/<slug>/characters/..%2F..
 *     The same shape through `characterDir(slug, id)`: `..%2F..` reached
 *     `<projectsRoot>` and deleted every project.
 *
 *   DELETE /api/niches/..%2F<project>%2Fconfig
 *     `nicheFilePath(id)` joined the raw id onto the user-niches directory and
 *     `fs.unlink`'d it. The loader's id pattern ran only on its MISS branch, so
 *     an id naming an existing file skipped every guard.
 *
 *   DELETE /api/formats/custom/..%2F..%2Ftmp%2Fvictim
 *     The sibling POST validated the identical id; this DELETE did not.
 *
 *   DELETE /api/projects/<slug>/music-pool/tracks/..%2F..%2FDocuments%2Fsong.mp3
 *     `removeTrack` joined the raw filename and unlinked it.
 *
 *   PUT /api/projects/<slug>/settings/subfolder-config
 *     Only asserted each value CONTAINS `{code}`, so a value of
 *     `../../../../tmp/escape/{code}` was persisted into project.json and every
 *     later resolution for that project escaped from INSIDE the episode folder.
 *
 * Each fix validates at the PATH BUILDER, not at the route. A per-route guard is
 * the arrangement that allowed this class to exist: `createCharacter` validated
 * while `deleteCharacter` did not, and the two live three lines apart.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let utils: typeof import('../services/utils.js')
let cl: typeof import('../services/character-library.js')
let cm: typeof import('../services/character-manager.js')
let nl: typeof import('../services/niche-loader.js')
let tpl: typeof import('../services/topic-pack-loader.js')
let musicPool: typeof import('../services/music-pool.js')
let pm: typeof import('../services/project-manager.js')

const SLUG = 'traversal-project'
/** A file OUTSIDE every directory these routes are meant to touch. */
let sentinel = ''

before(async () => {
  tmp = await useTempDataDir()
  utils = await import('../services/utils.js')
  cl = await import('../services/character-library.js')
  cm = await import('../services/character-manager.js')
  nl = await import('../services/niche-loader.js')
  tpl = await import('../services/topic-pack-loader.js')
  musicPool = await import('../services/music-pool.js')
  pm = await import('../services/project-manager.js')

  // Sits one level ABOVE the Library, which is exactly where `..` points.
  sentinel = path.join(tmp.dir, 'SENTINEL-DO-NOT-DELETE.txt')
  await fs.writeFile(sentinel, 'this file must survive every test in this file')

  await pm.createProject({ name: 'Traversal Project' })
})

after(async () => { await tmp?.cleanup() })

async function sentinelSurvives(): Promise<void> {
  await fs.access(sentinel)
}

describe('an episode code or title cannot escape the episodes folder', () => {
  test('a code containing a path separator is refused', async () => {
    // Rejected before it reaches the folder template — `episodeNumber` refuses a
    // code that does not match the project's prefix. The assertion is that it is
    // REFUSED, whichever guard gets there first; what matters is the sentinel.
    await assert.rejects(
      () => utils.resolveEpisodePaths(SLUG, '../../../../tmp', 'Title'),
      /Invalid episode code|path separator|outside the episodes/i,
    )
    await sentinelSurvives()
  })

  test('a title containing a path separator is refused', async () => {
    // `EP0001 - ../../../../tmp/pwn` is the shape an idea title took; every
    // caller then wrote, renamed or recursively deleted at the resolved path.
    await assert.rejects(
      () => utils.resolveEpisodePaths(SLUG, 'EP0001', '../../../../tmp/pwn'),
      /path separator|outside the episodes/i,
    )
    await sentinelSurvives()
  })

  test('a bare `..` is refused as either field', async () => {
    await assert.rejects(
      () => utils.resolveEpisodePaths(SLUG, '..', 'Title'),
      /Invalid episode code|outside the episodes|separator/i,
    )
    await assert.rejects(
      () => utils.resolveEpisodePaths(SLUG, 'EP0001', '..'),
      /Invalid episode code|outside the episodes|separator/i,
    )
    await sentinelSurvives()
  })

  test('an ordinary code and title still resolve, and stay inside the project', async () => {
    // The control: the containment must not reject legitimate episodes.
    const paths = await utils.resolveEpisodePaths(SLUG, 'EP0001', 'A Normal Title')
    const root = path.resolve(path.join(tmp.dir, 'projects', SLUG, 'episodes'))
    assert.ok(path.resolve(paths.episode_dir).startsWith(root + path.sep),
      `a normal episode resolved outside the root: ${paths.episode_dir}`)
    assert.ok(paths.episode_dir.includes('EP0001 - A Normal Title'))
  })
})

describe('a subfolder name from project.json cannot escape its episode folder', () => {
  test('the persisted-template escape is refused at resolution', async () => {
    // What `PUT /settings/subfolder-config` used to allow through: the value
    // only had to CONTAIN `{code}`.
    const projectJson = path.join(tmp.dir, 'projects', SLUG, 'project.json')
    const original = JSON.parse(await fs.readFile(projectJson, 'utf-8'))
    try {
      await fs.writeFile(projectJson, JSON.stringify({
        ...original,
        subfolder_names: { ...(original.subfolder_names || {}), video: '../../../../tmp/escape/{code}' },
      }))
      // Containment is asserted on the RESOLVED paths, so this must throw
      // rather than hand callers a directory outside the Library. (A fresh
      // cache each call — the request-scoped cache would otherwise serve the
      // pre-edit project.json, which is its documented job.)
      await assert.rejects(
        () => utils.resolveEpisodePaths(SLUG, 'EP0001', 'A Normal Title'),
        /outside the episode folder/i,
      )
      await sentinelSurvives()
    } finally {
      await fs.writeFile(projectJson, JSON.stringify(original))
    }
  })
})

describe('the destructive character routes refuse a traversal id', () => {
  test('deleteLibraryCharacter refuses `..` and deletes nothing', async () => {
    await assert.rejects(() => cl.deleteLibraryCharacter('..'), /Invalid character id/i)
    await sentinelSurvives()
    // The Library itself — every project — must still be there.
    await fs.access(path.join(tmp.dir, 'projects', SLUG))
  })

  test('deleteLibraryCharacter refuses an encoded separator', async () => {
    await assert.rejects(() => cl.deleteLibraryCharacter('../..'), /Invalid character id/i)
    await sentinelSurvives()
    await fs.access(path.join(tmp.dir, 'projects', SLUG))
  })

  test('deleteCharacter refuses `..` and leaves the project intact', async () => {
    await assert.rejects(() => cm.deleteCharacter(SLUG, '..'), /Invalid character id/i)
    await sentinelSurvives()
    await fs.access(path.join(tmp.dir, 'projects', SLUG))
  })

  test('deleteCharacter refuses a nested traversal', async () => {
    await assert.rejects(() => cm.deleteCharacter(SLUG, '../../..'), /Invalid character id/i)
    await sentinelSurvives()
    await fs.access(path.join(tmp.dir, 'projects', SLUG))
  })

  test('a legitimate character id still resolves (the control)', async () => {
    const created = await cm.createCharacter(SLUG, {
      scope: 'project', name: 'Aria Vane', description: 'lead',
    })
    assert.equal(created.id, 'aria-vane')
    // And a real delete still works — the guard must not break the feature.
    assert.equal(await cm.deleteCharacter(SLUG, created.id), true)
  })
})

describe('the *.json delete routes cannot leave their directory', () => {
  test('nicheFilePath refuses a traversal id', () => {
    assert.throws(() => nl.nicheFilePath('../../myproj/config'), /Invalid niche id/i)
    assert.throws(() => nl.nicheFilePath('..'), /Invalid niche id/i)
  })

  test('topicPackFilePath refuses a traversal id', () => {
    assert.throws(() => tpl.topicPackFilePath('../../myproj/config'), /Invalid topic pack id/i)
    assert.throws(() => tpl.topicPackFilePath('..'), /Invalid topic pack id/i)
  })

  test('a legitimate niche id still resolves (the control)', () => {
    assert.ok(nl.nicheFilePath('my-niche').endsWith(`${path.sep}my-niche.json`))
    assert.ok(tpl.topicPackFilePath('my-pack').endsWith(`${path.sep}my-pack.json`))
  })
})

describe('the episode-folder delete cannot be aimed at a season', () => {
  test('a season name is refused and the season folder survives', async () => {
    // `deleteEpisodeFolder` matched `entry.name === episodeCode`, so a bare
    // directory name matched: `DELETE /episodes/Season%20001` recursively
    // removed the season folder and every episode inside it. The code is now
    // required to be this project's prefix + digits first.
    const episodesRoot = path.join(tmp.dir, 'projects', SLUG, 'episodes')
    const season = path.join(episodesRoot, 'Season 001')
    const episode = path.join(season, 'EP0001 - A Real Episode')
    await fs.mkdir(episode, { recursive: true })
    await fs.writeFile(path.join(episode, 'keep-me.txt'), 'an episode worth keeping')

    const im = await import('../services/idea-manager.js')
    await assert.rejects(() => im.deleteEpisodeFolder(SLUG, 'Season 001'), /not an episode code/i)
    // The season and its episode are both still on disk.
    await fs.access(season)
    await fs.access(path.join(episode, 'keep-me.txt'))

    // A subfolder inside an episode is not an episode either.
    // The one an unanchored `EP(\d+)` test would have let through — and the
    // matcher's `entry.name === episodeCode` branch would then have deleted it.
    await assert.rejects(() => im.deleteEpisodeFolder(SLUG, 'EP0001 - A Real Episode'), /not an episode code/i)
    await fs.access(path.join(episode, 'keep-me.txt'))
    await sentinelSurvives()
  })
})

describe('the music pool cannot unlink outside its own folder', () => {
  test('removeTrack refuses a traversal filename and the target survives', async () => {
    const victim = path.join(tmp.dir, 'victim.mp3')
    await fs.writeFile(victim, 'not music, but it is the owner\'s file')
    // What the route used to accept: `..%2F..%2Fvictim.mp3` after Express
    // decoded it, joined onto the pool directory and unlinked. The pool folder
    // is resolved from the project config, so an absolute escape is what a
    // traversal filename produced; the guard is that the name is not a bare
    // basename, whatever it points at.
    const result = await musicPool.removeTrack(SLUG, '../../../../victim.mp3')
    assert.deepEqual(result, { removed: false })
    await fs.access(victim)
    // An encoded separator must not sneak through either.
    assert.deepEqual(await musicPool.removeTrack(SLUG, '..%2F..%2Fvictim.mp3'), { removed: false })
    await fs.access(victim)
  })
})

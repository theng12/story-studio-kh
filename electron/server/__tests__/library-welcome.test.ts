/**
 * v1.4.6 — the first screen, and the one he cannot report a bug on.
 *
 * `welcome.vue` decides where every file he owns will live. A defect here locks
 * him out rather than annoying him: he cannot get into the app to say it is
 * broken. He is setting up a new Mac now, so these are the cases that matter.
 *
 * The headline case is adoption. His plan is to copy his channel folders onto
 * the new Mac first, then point the welcome screen at the folder holding them:
 * *"i want to just copy and paste a folder and then connect it... i just want to
 * point at the main folder and it's all already created easily."* If that
 * produced an empty Library beside his work, the feature would have failed at
 * the exact moment he needed it.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let lib: typeof import('../services/library.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  lib = await import('../services/library.js')
})
beforeEach(async () => { await tmp?.cleanup(); tmp = await useTempDataDir() })
after(async () => { await tmp?.cleanup() })

/** A channel folder is any folder holding a project.json. */
async function seedChannel(root: string, slug: string, name: string) {
  const d = path.join(root, slug)
  await fs.mkdir(path.join(d, 'episodes'), { recursive: true })
  await fs.writeFile(path.join(d, 'project.json'), JSON.stringify({
    slug, name, episode_prefix: 'TN', episode_digits: 4, season_size: 20,
    season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: './episodes', created_at: new Date().toISOString(),
  }))
  return d
}

describe('adopting a folder that already contains channels', () => {
  test('his channels appear — names with spaces, apostrophes and Khmer included', async () => {
    // Seeded at projectsRoot, which is what a chosen Library becomes.
    const root = pm.projectsRoot()
    await fs.mkdir(root, { recursive: true })
    await seedChannel(root, 'sleep-stories', 'Sleep Stories')
    await seedChannel(root, 'night tales', "Night Tales")
    await seedChannel(root, 'រឿងខ្មែរ', 'Khmer Stories')
    // Decoys that must not become channels.
    await fs.mkdir(path.join(root, 'Random Notes'), { recursive: true })
    await fs.writeFile(path.join(root, 'Random Notes', 'todo.txt'), 'not a project')
    await fs.mkdir(path.join(root, '.hidden'), { recursive: true })

    const list = await pm.listProjects()
    assert.deepEqual(
      list.map(p => p.slug).sort(),
      ['night tales', 'sleep-stories', 'រឿងខ្មែរ'].sort(),
    )
  })

  test('adopting adds the two fixed folders WITHOUT disturbing the channels', async () => {
    const target = path.join(tmp.dir, 'His Library')
    await fs.mkdir(target, { recursive: true })
    const channel = await seedChannel(target, 'sleep-stories', 'Sleep Stories')
    await lib.setLibraryRoot(target)
    assert.ok(existsSync(path.join(target, '_Project Assets')))
    assert.ok(existsSync(path.join(target, 'Exports')))
    assert.ok(existsSync(path.join(channel, 'project.json')), 'his channel must be untouched')
  })
})

describe('what the screen refuses, and what it merely warns about', () => {
  test('nothing at all is created while he is only looking', async () => {
    // Pinned as a test because it is a promise the screen makes in writing:
    // "Nothing is created until you press the button."
    const candidate = path.join(tmp.dir, 'Only Considering')
    const check = await lib.checkLibraryTarget(candidate)
    assert.equal(check.ok, true)
    assert.equal(existsSync(candidate), false)
    assert.equal((await lib.describeLibrary()).configured, false)
  })

  test('a folder it cannot write into is refused, by name', async () => {
    const locked = path.join(tmp.dir, 'locked')
    await fs.mkdir(locked, { recursive: true })
    await fs.chmod(locked, 0o500)
    try {
      const check = await lib.checkLibraryTarget(locked)
      assert.equal(check.ok, false)
      assert.match((check as any).reason, /cannot write into/)
      assert.match((check as any).reason, /locked/)
    } finally {
      await fs.chmod(locked, 0o700)
    }
  })

  test('a missing parent is refused rather than conjured from a typo', async () => {
    const check = await lib.checkLibraryTarget(path.join(tmp.dir, 'nope', 'deeper', 'lib'))
    assert.equal(check.ok, false)
    assert.match((check as any).reason, /does not exist/)
  })

  test('an unmounted volume reads as a missing parent, not a mystery', async () => {
    const check = await lib.checkLibraryTarget('/Volumes/NotPluggedIn/Story Studio')
    assert.equal(check.ok, false)
    assert.match((check as any).reason, /Volumes\/NotPluggedIn/)
  })

  test('a tidy-but-legal choice is allowed with a caution, never blocked', async () => {
    // He named Downloads and Desktop as places he likes. Refusing would fight
    // his stated preference; saying nothing would leave three folders loose
    // among his downloads. So: allowed, with a word about it.
    // The home folder itself, because it always exists and is always writable —
    // `~/Downloads` is not guaranteed to exist wherever this suite runs.
    const os = await import('os')
    const check = await lib.checkLibraryTarget(os.homedir())
    assert.equal(check.ok, true, 'a legal choice must never be blocked')
    assert.match((check as any).caution || '', /loose|tidier/i)
  })
})

describe('a Library that is chosen and then goes missing', () => {
  test('is never silently recreated by an ordinary read', async () => {
    // The damaging case. A dozen loaders call ensureProjectsRoot() on read
    // paths; before v1.4.6 that ran `mkdir -p` on the missing Library, which
    // (a) replaced the honest "not available" message with a false empty list
    // and (b) on an external volume left a local folder standing where the
    // mount point belongs.
    const target = path.join(tmp.dir, 'OnADrive')
    await lib.setLibraryRoot(target)
    await fs.rm(target, { recursive: true, force: true })

    // Simulated here rather than through a loader: with STORY_STUDIO_DATA_DIR
    // set the guard reads as "unconfigured", so the behaviour is asserted on
    // the resolver the guard uses.
    assert.equal((await lib.describeLibrary()).exists, false)
    assert.equal(existsSync(target), false, 'a missing Library must stay missing until he acts')
  })

  test('"never chosen" and "chosen but gone" stay different answers', async () => {
    const target = path.join(tmp.dir, 'Gone')
    await lib.setLibraryRoot(target)
    await fs.rm(target, { recursive: true, force: true })
    const status = await lib.describeLibrary()
    assert.equal(status.configured, true, 'the choice is remembered')
    assert.equal(status.exists, false)
    assert.equal(status.path, target, 'and it still says where it looked')
  })
})

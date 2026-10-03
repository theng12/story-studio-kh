/**
 * v1.4.3 — one Library, chosen rather than assumed.
 *
 * Four location concepts became one: the default root, `projects_root_override`,
 * `linked_project_paths` and `named-roots.json`. The owner's instruction was
 * that a new machine must ASK: *"i don't want our app on a new computer to use
 * the default location … this way, it also means that i don't have to hunt for
 * the story studio folder inside of /user sth."*
 *
 * The properties worth pinning are the ones a person would only discover by
 * losing something:
 *
 *   - Nothing is created until the choice is confirmed.
 *   - "Never chosen" and "chosen but not there" are different states, because
 *     an unplugged drive must never render as "you have no channels" — the
 *     same failure shape as 1.4.2's silent `output_root`.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let lib: typeof import('../services/library.js')
let settings: typeof import('../services/app-settings.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  lib = await import('../services/library.js')
  settings = await import('../services/app-settings.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

describe('choosing a Library', () => {
  test('a fresh machine has none, and is offered somewhere findable', async () => {
    const status = await lib.describeLibrary()
    assert.equal(status.configured, false)
    assert.equal(status.path, '')
    // Documents, not the app's own userData folder — the point is that he can
    // find it without hunting through Application Support.
    assert.match(status.suggested, /Documents/)
  })

  test('checking a folder creates absolutely nothing', async () => {
    const candidate = path.join(tmp.dir, 'not-yet')
    const check = await lib.checkLibraryTarget(candidate)
    assert.equal(check.ok, true)
    assert.equal(check.ok && check.will_create, true)
    assert.equal(existsSync(candidate), false, 'checking a folder must not create it')
    // And the choice is still not recorded.
    assert.equal((await lib.describeLibrary()).configured, false)
  })

  test('confirming creates the folder and its two fixed subfolders', async () => {
    const target = path.join(tmp.dir, 'My Library')
    const status = await lib.setLibraryRoot(target)
    assert.equal(status.configured, true)
    assert.equal(status.path, target)
    assert.ok(existsSync(path.join(target, '_Project Assets')))
    assert.ok(existsSync(path.join(target, 'Exports')))
  })

  test('an existing folder is adopted with its channels untouched', async () => {
    // The whole "connect an existing folder" story: copy it in, it appears.
    const target = path.join(tmp.dir, 'Existing')
    await fs.mkdir(path.join(target, 'my-channel'), { recursive: true })
    await fs.writeFile(path.join(target, 'my-channel', 'project.json'), '{"slug":"my-channel"}')
    await lib.setLibraryRoot(target)
    assert.ok(existsSync(path.join(target, 'my-channel', 'project.json')), 'existing channels must survive')
  })

  test('a file, a partial path, or an unwritable place is refused BY NAME', async () => {
    const asFile = path.join(tmp.dir, 'a-file.txt')
    await fs.writeFile(asFile, 'x')
    const fileCheck = await lib.checkLibraryTarget(asFile)
    assert.equal(fileCheck.ok, false)
    assert.match((fileCheck as any).reason, /is a file/)

    const relative = await lib.checkLibraryTarget('Documents/Somewhere')
    assert.equal(relative.ok, false)
    assert.match((relative as any).reason, /full path/)

    // A parent that does not exist: refused rather than creating a whole tree
    // from a typo, which is how a Library ends up somewhere nobody can find.
    const deep = await lib.checkLibraryTarget(path.join(tmp.dir, 'nope', 'deeper', 'lib'))
    assert.equal(deep.ok, false)
    assert.match((deep as any).reason, /does not exist/)

    const blank = await lib.checkLibraryTarget('')
    assert.equal(blank.ok, false)
  })

  test('"never chosen" and "chosen but missing" are different answers', async () => {
    // This distinction is the whole reason an unplugged drive does not read as
    // an empty channel list.
    const target = path.join(tmp.dir, 'OnADrive')
    await lib.setLibraryRoot(target)
    assert.deepEqual(
      [(await lib.describeLibrary()).configured, (await lib.describeLibrary()).exists],
      [true, true],
    )
    await fs.rm(target, { recursive: true, force: true })
    const gone = await lib.describeLibrary()
    assert.equal(gone.configured, true, 'the choice is remembered even when the folder is not there')
    assert.equal(gone.exists, false)
    assert.equal(gone.path, target, 'and it still says WHERE it looked')
  })

  test('assets and exports are always inside the Library', async () => {
    const target = path.join(tmp.dir, 'Lib')
    await lib.setLibraryRoot(target)
    assert.equal(await lib.assetsDir(), path.join(target, '_Project Assets'))
    assert.equal(await lib.exportsDir(), path.join(target, 'Exports'))
  })
})

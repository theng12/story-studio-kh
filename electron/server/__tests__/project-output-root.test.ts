/**
 * v1.4.2 — a project whose episodes folder does not resolve says so.
 *
 * ── The defect ──
 *
 * `listProjects` has computed `output_root_exists` via `existsSync` since long
 * before this release, and NOTHING read it — only the TypeScript declaration
 * referenced the field. So a project whose episode folder had moved rendered as
 * a perfectly normal card, opened to a perfectly normal page, and every episode
 * inside it silently vanished. The app had already worked out that the folder
 * was missing and threw the answer away.
 *
 * That is the same shape as the silent lead-in zero fixed in 1.3.4: the system
 * knew, and spelled "I could not find it" identically to "nothing is there".
 * Two of the owner's real projects were in this state.
 *
 * ── What is deliberately NOT here ──
 *
 * There is no auto-repair, and no test asks for one. `origin-field`'s own
 * `./episodes` existed and was EMPTY while the correct target was a sibling
 * directory — anything that guessed a replacement path would have silently
 * adopted the empty folder and reported success. Warn, name the path, let a
 * person decide.
 *
 * Both surfaces resolve through ONE function, because a home page and a project
 * page that disagree about whether a project is reachable are worse than
 * neither saying anything.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => { pm = await import('../services/project-manager.js') })
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

/** A project whose `output_root` is whatever the caller wants to test. */
async function seedProject(slug: string, outputRoot: string): Promise<string> {
  const dir = path.join(pm.projectsRoot(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({ slug, name: slug, episode_prefix: 'EP', output_root: outputRoot }),
  )
  return dir
}

describe('resolving a project’s episodes folder', () => {
  test('a relative root resolves against the PROJECT dir, not the cwd', async () => {
    const dir = await seedProject('rel', './episodes')
    await fs.mkdir(path.join(dir, 'episodes'), { recursive: true })
    const resolved = pm.resolveOutputRoot(dir, './episodes')
    assert.equal(resolved.path, path.join(dir, 'episodes'))
    assert.equal(resolved.exists, true)
  })

  test('a relative root can point OUTSIDE the project dir and still work', async () => {
    // This is the owner's `origin-field` shape: `../Origin Field/episodes`.
    // The note that used to sit in `listProjects` claimed relative paths "live
    // inside the project dir and are always present", which is how this case
    // came to be treated as impossible.
    const dir = await seedProject('sibling', '../Origin Field/episodes')
    const target = path.join(pm.projectsRoot(), 'Origin Field', 'episodes')
    await fs.mkdir(target, { recursive: true })
    const resolved = pm.resolveOutputRoot(dir, '../Origin Field/episodes')
    assert.equal(resolved.path, target)
    assert.equal(resolved.exists, true)
  })

  test('a relative root CAN be missing — both forms break', async () => {
    const dir = await seedProject('gone', './episodes')
    assert.equal(pm.resolveOutputRoot(dir, './episodes').exists, false)
  })

  test('an absolute root that no longer exists is reported missing', async () => {
    const dir = await seedProject('abs', '/nowhere/at/all/episodes')
    const resolved = pm.resolveOutputRoot(dir, '/nowhere/at/all/episodes')
    assert.equal(resolved.path, '/nowhere/at/all/episodes')
    assert.equal(resolved.exists, false)
  })

  test('an empty root falls back to `episodes` under the project dir', async () => {
    const dir = await seedProject('blank', '')
    assert.equal(pm.resolveOutputRoot(dir, '').path, path.join(dir, 'episodes'))
    assert.equal(pm.resolveOutputRoot(dir, undefined).path, path.join(dir, 'episodes'))
  })
})

describe('a broken project reports itself rather than rendering clean', () => {
  test('listProjects marks the missing folder and names the path it wanted', async () => {
    const dir = await seedProject('broken', './episodes')
    const list = await pm.listProjects()
    const row = list.find(p => p.slug === 'broken')
    assert.ok(row, 'the project must still be listed — the record is fine, the folder is not')
    assert.equal((row as any).output_root_exists, false)
    // The path is the whole point: a warning that does not say WHERE it looked
    // leaves the person with nothing to act on.
    assert.equal((row as any).output_root, path.join(dir, 'episodes'))
  })

  test('a healthy project is not accused', async () => {
    const dir = await seedProject('healthy', './episodes')
    await fs.mkdir(path.join(dir, 'episodes'), { recursive: true })
    const row = (await pm.listProjects()).find(p => p.slug === 'healthy')
    assert.equal((row as any).output_root_exists, true)
  })

  test('the home page and the project page cannot disagree', async () => {
    // Both read through `resolveOutputRoot`. Before v1.4.2 only the list
    // computed this at all, and it computed it inline.
    const dir = await seedProject('split', './episodes')
    const listed = (await pm.listProjects()).find(p => p.slug === 'split')
    const direct = pm.resolveOutputRoot(dir, './episodes')
    assert.equal((listed as any).output_root_exists, direct.exists)
    assert.equal((listed as any).output_root, direct.path)
  })

  test('nothing is repaired, moved, or created by looking', async () => {
    // A check that fixes things is a check nobody can trust. `origin-field`
    // proves why: its own `./episodes` existed and was empty while the real
    // episodes were in a sibling folder, so a repair would have adopted the
    // empty one and called it done.
    const dir = await seedProject('untouched', './episodes')
    const before = await fs.readdir(dir)
    await pm.listProjects()
    pm.resolveOutputRoot(dir, './episodes')
    assert.deepEqual(await fs.readdir(dir), before, 'inspecting a project must not change it')
    assert.equal(
      await fs.access(path.join(dir, 'episodes')).then(() => true, () => false),
      false,
      'the missing folder must NOT have been created',
    )
  })
})

describe('storing an episodes folder portably', () => {
  test('a folder inside the project dir is stored relative', () => {
    const dir = path.join(pm.projectsRoot(), 'p')
    assert.equal(pm.normalizeOutputRootForStorage(dir, path.join(dir, 'episodes')), './episodes')
  })

  test('the project dir itself becomes `.`', () => {
    // The shape an imported folder produces: the folder IS the episodes root.
    const dir = path.join(pm.projectsRoot(), 'p')
    assert.equal(pm.normalizeOutputRootForStorage(dir, dir), '.')
  })

  test('a sibling inside the projects root becomes a `../` path', () => {
    // The owner's own `origin-field` shape, and it survives a move because the
    // project and its episodes travel together.
    const dir = path.join(pm.projectsRoot(), 'origin-field')
    const target = path.join(pm.projectsRoot(), 'Origin Field', 'episodes')
    assert.equal(pm.normalizeOutputRootForStorage(dir, target), '../Origin Field/episodes')
  })

  test('a folder OUTSIDE the projects root stays absolute', () => {
    // Expressing an external volume as a chain of `../` would be fragile and
    // would not survive the move either. Absolute is the honest answer.
    const dir = path.join(pm.projectsRoot(), 'p')
    assert.equal(pm.normalizeOutputRootForStorage(dir, '/Volumes/Big/episodes'), '/Volumes/Big/episodes')
  })

  test('an already-relative value is left exactly as it is', () => {
    const dir = path.join(pm.projectsRoot(), 'p')
    assert.equal(pm.normalizeOutputRootForStorage(dir, './episodes'), './episodes')
    assert.equal(pm.normalizeOutputRootForStorage(dir, ''), './episodes')
  })

  test('what is stored round-trips back to the same folder', () => {
    // The property that actually matters: normalising must not move anything.
    const dir = path.join(pm.projectsRoot(), 'p')
    for (const target of [path.join(dir, 'episodes'), path.join(pm.projectsRoot(), 'Other', 'episodes'), '/Volumes/Big/eps']) {
      const stored = pm.normalizeOutputRootForStorage(dir, target)
      assert.equal(pm.resolveOutputRoot(dir, stored).path, path.resolve(target))
    }
  })
})

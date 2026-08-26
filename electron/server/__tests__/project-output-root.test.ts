/**
 * A channel's episodes live in the channel's folder. Full stop.
 *
 * ── What this file used to be, and why it changed ──
 *
 * It exercised a stored `output_root` that could name any folder: relative,
 * absolute, a sibling reached through `../`. That capability is gone. It was
 * exercised by exactly one project in the wild — `origin-field`, pointing at
 * `../Origin Field/episodes`, a folder that did not exist — and the result was
 * a channel that opened completely empty with nothing on screen to explain it.
 * Every other real project stored the default. A setting whose only non-default
 * use was a bug is not a capability, so it was deleted rather than defended.
 *
 * The v1.4.2 reporting behaviour it was written alongside is NOT deleted, and
 * that is the point of keeping a test here rather than removing the file:
 *
 *   - the folder's existence is still computed, and still reported honestly;
 *   - both surfaces still resolve through ONE function, so the home page and
 *     the project page cannot disagree about whether a channel is reachable;
 *   - nothing repairs, adopts, or creates the folder to make a warning go away.
 *
 * That last one is load-bearing. `origin-field`'s own `./episodes` existed and
 * was EMPTY while the real episodes sat in a sibling directory, so anything
 * that "helpfully" created or adopted a folder would have reported success over
 * a channel with no episodes in it. Warn, name the path, let a person decide.
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

/**
 * `extra` lets a test write a stale `output_root` into project.json — the shape
 * every existing project on disk still has. It must make no difference.
 */
async function seedProject(slug: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(pm.projectsRoot(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({ slug, name: slug, episode_prefix: 'EP', ...extra }),
  )
  return dir
}

describe('the episodes folder is fixed, not chosen', () => {
  test('it is always `episodes` inside the project dir', async () => {
    const dir = await seedProject('fixed')
    await fs.mkdir(path.join(dir, 'episodes'), { recursive: true })
    const resolved = pm.resolveOutputRoot(dir)
    assert.equal(resolved.path, path.join(dir, 'episodes'))
    assert.equal(resolved.exists, true)
  })

  test('a leftover `output_root` in project.json is ignored, not honoured', async () => {
    // The Origin Field shape, still sitting in a real project.json somewhere.
    // Reading it is what broke that channel; the folder it named is not even
    // consulted now.
    const dir = await seedProject('origin-field', { output_root: '../Origin Field/episodes' })
    const stray = path.join(pm.projectsRoot(), 'Origin Field', 'episodes')
    await fs.mkdir(stray, { recursive: true })
    await fs.mkdir(path.join(dir, 'episodes'), { recursive: true })

    assert.equal(pm.resolveOutputRoot(dir).path, path.join(dir, 'episodes'))
    assert.equal(await pm.getProjectOutputRoot('origin-field'), path.join(dir, 'episodes'))
  })

  test('an absolute leftover is ignored too', async () => {
    const dir = await seedProject('abs', { output_root: '/nowhere/at/all/episodes' })
    assert.equal(pm.resolveOutputRoot(dir).path, path.join(dir, 'episodes'))
  })

  test('the sync and async resolvers agree, always', async () => {
    // `getProjectOutputRoot(slug)` has ~40 callers across the generators and
    // `resolveOutputRoot(dir)` backs the two UI surfaces. They used to agree by
    // both reading the same field carefully; now they agree by construction.
    const dir = await seedProject('twins', { output_root: './somewhere-else' })
    assert.equal(await pm.getProjectOutputRoot('twins'), pm.resolveOutputRoot(dir).path)
  })

  test('an unreadable project.json cannot change the answer', async () => {
    const dir = await seedProject('corrupt')
    await fs.writeFile(path.join(dir, 'project.json'), '{ not json')
    assert.equal(await pm.getProjectOutputRoot('corrupt'), path.join(dir, 'episodes'))
  })

  test('a project that is not there resolves to nothing, not to a guess', async () => {
    assert.equal(await pm.getProjectOutputRoot('never-existed'), null)
  })
})

describe('a missing folder is still reported honestly', () => {
  test('listProjects marks the missing folder and names the path it wanted', async () => {
    const dir = await seedProject('broken')
    const list = await pm.listProjects()
    const row = list.find(p => p.slug === 'broken')
    assert.ok(row, 'the project must still be listed — the record is fine, the folder is not')
    assert.equal(row.output_root_exists, false)
    // The path is the whole point: a warning that does not say WHERE it looked
    // leaves the person with nothing to act on.
    assert.equal(row.output_root, path.join(dir, 'episodes'))
  })

  test('a healthy project is not accused', async () => {
    const dir = await seedProject('healthy')
    await fs.mkdir(path.join(dir, 'episodes'), { recursive: true })
    const row = (await pm.listProjects()).find(p => p.slug === 'healthy')
    assert.equal(row?.output_root_exists, true)
  })

  test('the home page and the project page cannot disagree', async () => {
    const dir = await seedProject('split')
    const listed = (await pm.listProjects()).find(p => p.slug === 'split')
    const direct = pm.resolveOutputRoot(dir)
    assert.equal(listed?.output_root_exists, direct.exists)
    assert.equal(listed?.output_root, direct.path)
  })

  test('nothing is repaired, moved, or created by looking', async () => {
    const dir = await seedProject('untouched')
    const before = await fs.readdir(dir)
    await pm.listProjects()
    pm.resolveOutputRoot(dir)
    await pm.getProjectOutputRoot('untouched')
    assert.deepEqual(await fs.readdir(dir), before, 'inspecting a project must not change it')
    assert.equal(
      await fs.access(path.join(dir, 'episodes')).then(() => true, () => false),
      false,
      'the missing folder must NOT have been created',
    )
  })
})

describe('nothing writes the folder back into project.json', () => {
  test('a created project stores no episodes location at all', async () => {
    const meta = await pm.createProject({ name: 'Fresh Channel' } as any)
    const raw = JSON.parse(
      await fs.readFile(path.join(pm.projectsRoot(), meta.slug, 'project.json'), 'utf-8'),
    )
    assert.equal('output_root' in raw, false, 'the deleted field must not come back')
    assert.equal(
      await pm.getProjectOutputRoot(meta.slug),
      path.join(pm.projectsRoot(), meta.slug, 'episodes'),
    )
  })

  test('a channel named "Episodes" still gets its episodes folder', async () => {
    // The slug is 'episodes', so the project dir is `<root>/episodes` — the
    // one case an old guard in createProject skipped the mkdir for, aimed at a
    // nested-import shape this function never produces. The resolver looks for
    // `<projectDir>/episodes` unconditionally, so skipping it left that
    // channel reporting "Folder missing" from the day it was made.
    const meta = await pm.createProject({ name: 'Episodes' } as any)
    assert.equal(meta.slug, 'episodes')
    const row = (await pm.listProjects()).find(p => p.slug === 'episodes')
    assert.equal(row?.output_root_exists, true)
    assert.equal(row?.output_root, path.join(pm.projectsRoot(), 'episodes', 'episodes'))
  })

  test('a stale `output_root` on disk is left exactly as it is', async () => {
    // Never rewrite a person's project.json to tidy up after ourselves — the
    // field is inert, and silently mutating saved files is its own disease.
    const dir = await seedProject('legacy', { output_root: '/Volumes/Big/episodes' })
    await pm.listProjects()
    await pm.getProjectOutputRoot('legacy')
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf-8'))
    assert.equal(raw.output_root, '/Volumes/Big/episodes')
  })
})

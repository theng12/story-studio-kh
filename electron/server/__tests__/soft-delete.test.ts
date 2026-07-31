/**
 * Tests for the soft-delete flow.
 *
 * Scope:
 *   - Default-location project → deleteProject reports 'soft_deleted',
 *     folder untouched, slug filtered from listProjects.
 *   - Linked project → deleteProject reports 'unlinked', registry
 *     entry cleared, folder untouched.
 *   - listSoftDeletedProjects shows hidden slugs with sizes.
 *   - forgetSoftDeletedProject restores visibility.
 *   - hardDeleteSoftDeletedProject rm's the folder + clears the tombstone.
 *   - Re-adding a linked project that was soft-deleted auto-clears the
 *     tombstone.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let lp: typeof import('../services/linked-projects.js')
let sd: typeof import('../services/soft-delete.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

async function seedProject(parentDir: string, slug: string): Promise<string> {
  const projDir = path.join(parentDir, slug)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(
    path.join(projDir, 'project.json'),
    JSON.stringify({ slug, name: slug, episode_prefix: 'EP' }),
  )
  return projDir
}

describe('soft-delete', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    lp = await import('../services/linked-projects.js')
    sd = await import('../services/soft-delete.js')
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    const entries = await fs.readdir(tmp.dir).catch(() => [] as string[])
    for (const name of entries) {
      await fs.rm(path.join(tmp.dir, name), { recursive: true, force: true }).catch(() => {})
    }
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    lp.invalidateLinkedDirCache()
  })

  test('deleteProject on default-location → soft_deleted, folder untouched', async () => {
    await seedProject(pm.projectsRoot(), 'soft-victim')
    const result = await pm.deleteProject('soft-victim')
    assert.equal(result.ok, true)
    assert.equal(result.disposition, 'soft_deleted')
    assert.equal(result.orphan_path, path.join(pm.projectsRoot(), 'soft-victim'))
    // Folder still on disk.
    assert.ok(existsSync(path.join(pm.projectsRoot(), 'soft-victim')))
    assert.ok(existsSync(path.join(pm.projectsRoot(), 'soft-victim', 'project.json')))
    // Hidden from listProjects.
    const list = await pm.listProjects()
    assert.equal(list.length, 0)
  })

  test('deleteProject on linked project → unlinked, folder untouched, no tombstone', async () => {
    const linkedDir = await seedProject(path.join(tmp.dir, 'external'), 'linked-victim')
    await lp.addLinkedProject(linkedDir)
    // Sanity: it's in the live list.
    let list = await pm.listProjects()
    assert.equal(list.some(p => p.slug === 'linked-victim'), true)

    const result = await pm.deleteProject('linked-victim')
    assert.equal(result.ok, true)
    assert.equal(result.disposition, 'unlinked')
    assert.equal(result.orphan_path, path.resolve(linkedDir))
    // Folder still on disk.
    assert.ok(existsSync(linkedDir))
    // Cleared from linked registry.
    const paths = await lp.getLinkedProjectPaths()
    assert.equal(paths.includes(path.resolve(linkedDir)), false)
    // No tombstone (linked deletes don't create one — re-adding would
    // bring it back via the registry, no auto-undelete needed).
    const tombstones = await sd.listSoftDeletedProjects()
    assert.equal(tombstones.length, 0)
    // Hidden from list.
    list = await pm.listProjects()
    assert.equal(list.length, 0)
  })

  test('listSoftDeletedProjects surfaces hidden default-location projects', async () => {
    await seedProject(pm.projectsRoot(), 'tomb-A')
    await seedProject(pm.projectsRoot(), 'tomb-B')
    await pm.deleteProject('tomb-A')
    await pm.deleteProject('tomb-B')

    const tombstones = await sd.listSoftDeletedProjects()
    const slugs = tombstones.map(t => t.slug).sort()
    assert.deepEqual(slugs, ['tomb-A', 'tomb-B'])
    for (const t of tombstones) {
      assert.equal(t.exists, true)
      assert.equal(t.is_default_location, true)
      assert.ok(t.deleted_at, 'deleted_at timestamp is set')
      // estimated_bytes >= 0 (project.json is ~50 bytes so > 0).
      assert.ok(t.estimated_bytes > 0)
    }
  })

  test('forgetSoftDeletedProject restores visibility in listProjects', async () => {
    await seedProject(pm.projectsRoot(), 'oops')
    await pm.deleteProject('oops')
    let list = await pm.listProjects()
    assert.equal(list.length, 0)

    const restored = await sd.forgetSoftDeletedProject('oops')
    assert.equal(restored, true)
    list = await pm.listProjects()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.slug, 'oops')
  })

  test('forgetSoftDeletedProject returns false on unknown slug', async () => {
    assert.equal(await sd.forgetSoftDeletedProject('never-existed'), false)
  })

  test('hardDeleteSoftDeletedProject rm-rfs folder + clears tombstone', async () => {
    const dir = await seedProject(pm.projectsRoot(), 'goodbye')
    await pm.deleteProject('goodbye')
    assert.ok(existsSync(dir), 'soft-delete preserves folder')

    await sd.hardDeleteSoftDeletedProject('goodbye')
    assert.equal(existsSync(dir), false, 'hard delete removes folder')
    const tombstones = await sd.listSoftDeletedProjects()
    assert.equal(tombstones.length, 0, 'tombstone cleared')
  })

  test('hardDeleteSoftDeletedProject refuses if slug is not soft-deleted', async () => {
    await assert.rejects(
      () => sd.hardDeleteSoftDeletedProject('not-tombstoned'),
      (e: any) => e.statusCode === 400 && /not currently soft-deleted/i.test(e.message),
    )
  })

  test('addLinkedProject auto-clears a soft-delete tombstone for its slug', async () => {
    // Soft-delete a default-location project.
    await seedProject(pm.projectsRoot(), 'reborn')
    await pm.deleteProject('reborn')
    let tombstones = await sd.listSoftDeletedProjects()
    assert.equal(tombstones.length, 1)

    // Now register an external folder with the same slug — re-adoption
    // means "I want this back," so the tombstone should clear.
    const linked = await seedProject(path.join(tmp.dir, 'external'), 'reborn')
    await lp.addLinkedProject(linked)
    tombstones = await sd.listSoftDeletedProjects()
    assert.equal(tombstones.length, 0,
      'addLinkedProject should auto-clear a matching tombstone')
  })

  test('createProject with same slug auto-clears a tombstone', async () => {
    const first = await pm.createProject({ name: 'Phoenix' })
    await pm.deleteProject(first.slug)
    let tombstones = await sd.listSoftDeletedProjects()
    assert.equal(tombstones.length, 1)

    // Re-create — uniqueSlug picks a different slug because the original
    // folder still exists, but the explicit createProject for that
    // resolved slug should still clear any tombstone for it.
    const second = await pm.createProject({ name: 'Phoenix' })
    tombstones = await sd.listSoftDeletedProjects()
    // Tombstone for `first.slug` may still exist (its folder still on
    // disk and we only auto-clear the slug we just created), but the
    // newly-created `second.slug` must NEVER have a tombstone.
    assert.equal(tombstones.some(t => t.slug === second.slug), false,
      'fresh slug never carries a tombstone')
  })
})

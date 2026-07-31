/**
 * Tests for the character unification migration (services/character-migration.ts).
 *
 * Safety-critical coverage:
 *   - planMigration is a pure dry run (writes nothing)
 *   - classification: copy / assign-only / already-assigned / conflict
 *   - runMigration without confirm is a dry run
 *   - runMigration copies + verifies + assigns AND leaves project originals intact
 *   - conflicts are skipped, never overwritten
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let mig: typeof import('../services/character-migration.js')
let cl: typeof import('../services/character-library.js')
let cm: typeof import('../services/character-manager.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG_A = 'mig-a'
const SLUG_B = 'mig-b'

async function makeProject(slug: string) {
  const projDir = path.join(pm.projectsRoot(), slug)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug, name: `Test ${slug}`,
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
  }))
}

describe('character-migration', () => {
  before(async () => {
    tmp = await useTempDataDir()
    mig = await import('../services/character-migration.js')
    cl = await import('../services/character-library.js')
    cm = await import('../services/character-manager.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'), 'projectsRoot() must point at temp dir')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    await makeProject(SLUG_A)
    await makeProject(SLUG_B)
  })

  test('planMigration: dry run writes nothing + classifies as copy', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    const plan = await mig.planMigration()
    assert.equal(plan.totals.copy, 1)
    assert.equal(plan.items[0].status, 'copy')
    // Nothing was written to the library.
    assert.equal(existsSync(path.join(pm.projectsRoot(), '.character-library', 'aria')), false)
    assert.equal(await cl.getLibraryCharacter('aria'), null)
  })

  test('runMigration without confirm is a dry run', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    const result = await mig.runMigration()
    assert.equal(result.dryRun, true)
    assert.equal(result.totals.copied, 1)
    assert.equal(await cl.getLibraryCharacter('aria'), null, 'dry run must not write')
  })

  test('runMigration(confirm): copies + verifies + assigns; original untouched', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cm.addReferenceImage(SLUG_A, 'aria', Buffer.from('png'), 'face.png')

    const result = await mig.runMigration({ confirm: true })
    assert.equal(result.dryRun, false)
    assert.equal(result.totals.copied, 1)
    assert.equal(result.totals.failed, 0)
    assert.deepEqual(result.createdLibraryIds, ['aria'])

    // Library entry exists, verified, assigned to SLUG_A, with the image.
    const lib = await cl.getLibraryCharacter('aria')
    assert.equal(lib?.name, 'Aria')
    assert.deepEqual(lib?.projects, [SLUG_A])
    assert.equal(existsSync(path.join(pm.projectsRoot(), '.character-library', 'aria', 'face.png')), true)

    // Project original is STILL THERE (copy-only, non-destructive).
    const original = await cm.listOwnCharacters(SLUG_A)
    assert.deepEqual(original.map(c => c.id), ['aria'])
    assert.equal(existsSync(path.join(pm.projectsRoot(), SLUG_A, 'characters', 'aria', 'face.png')), true)

    // Unified view shows it once (dedup, project wins).
    const unified = await cm.listCharacters(SLUG_A)
    assert.equal(unified.filter(c => c.id === 'aria').length, 1)
  })

  test('classify: identical existing library entry → assign-only, then already-assigned', async () => {
    // Same character in two projects.
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'shared', scope: 'project' })
    await cm.createCharacter(SLUG_B, { name: 'Aria', description: 'shared', scope: 'project' })
    // First migrate A's copy → creates the library entry assigned to A.
    await mig.runMigration({ confirm: true })

    // Now B's copy is identical → assign-only (just add the tag).
    const plan = await mig.planMigration()
    const bItem = plan.items.find(i => i.slug === SLUG_B && i.characterId === 'aria')
    assert.equal(bItem?.status, 'assign-only')
    const aItem = plan.items.find(i => i.slug === SLUG_A && i.characterId === 'aria')
    assert.equal(aItem?.status, 'already-assigned')

    // Running again assigns B, no new library entry created.
    const run2 = await mig.runMigration({ confirm: true })
    assert.equal(run2.totals.assigned, 1)
    assert.equal(run2.createdLibraryIds.length, 0)
    const lib = await cl.getLibraryCharacter('aria')
    assert.deepEqual(lib?.projects?.sort(), [SLUG_A, SLUG_B])
  })

  test('classify: different character with same id → conflict, skipped', async () => {
    // A 'hero' in both projects but DIFFERENT descriptions.
    await cm.createCharacter(SLUG_A, { name: 'Hero', description: 'A version', scope: 'project' })
    await cm.createCharacter(SLUG_B, { name: 'Hero', description: 'B version — different!', scope: 'project' })
    await mig.runMigration({ confirm: true })  // A wins the library id

    const plan = await mig.planMigration()
    const conflict = plan.items.find(i => i.slug === SLUG_B && i.characterId === 'hero')
    assert.equal(conflict?.status, 'conflict')
    assert.ok(conflict?.detail?.includes('different character'))

    const run = await mig.runMigration({ confirm: true })
    assert.ok(run.totals.skipped >= 1)
    // The library entry still reflects A — NOT overwritten by B.
    const lib = await cl.getLibraryCharacter('hero')
    assert.equal(lib?.description, 'A version')
  })
})

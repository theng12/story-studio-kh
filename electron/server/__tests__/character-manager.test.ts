/**
 * Tests for the character-manager service (services/character-manager.ts).
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let cm: typeof import('../services/character-manager.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'char-test-project'

async function makeProject() {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Char Test',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, created_at: new Date().toISOString(),
  }))
}

describe('character-manager', () => {
  before(async () => {
    tmp = await useTempDataDir()
    cm = await import('../services/character-manager.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(async () => {
    // Wipe characters dir + the app-level library between tests so each
    // starts fresh (the unified-merge tests create library entries).
    const dir = path.join(pm.projectsRoot(), SLUG, 'characters')
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(pm.projectsRoot(), '.character-library'), { recursive: true, force: true }).catch(() => {})
    await makeProject()
  })

  test('createCharacter: episode-scoped requires episode_codes', async () => {
    await assert.rejects(
      cm.createCharacter(SLUG, { name: 'Aria', description: 'a knight', scope: 'episode' }),
      /requires episode_codes/i,
    )
  })

  test('createCharacter: project-scoped persists + reads back', async () => {
    const c = await cm.createCharacter(SLUG, {
      name: 'Aria the Knight',
      description: 'tall, plate armour, silver braid',
      scope: 'project',
      archetype: 'protagonist',
    })
    assert.equal(c.id, 'aria-the-knight', 'id slugified from name')
    assert.equal(c.scope, 'project')
    assert.equal(c.episode_codes, undefined)
    const read = await cm.getCharacter(SLUG, 'aria-the-knight')
    // Compare by JSON round-trip — JSON.stringify drops undefined keys, so
    // the in-memory `c` and the on-disk `read` are equal-modulo-undefined-keys.
    assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(c)))
  })

  test('createCharacter: episode-scoped, listed only for matching episode', async () => {
    await cm.createCharacter(SLUG, {
      name: 'Side Kid', description: 'one-shot',
      scope: 'episode', episode_codes: ['EP001'],
    })
    const ep1 = await cm.listCharacters(SLUG, { episodeCode: 'EP001' })
    const ep2 = await cm.listCharacters(SLUG, { episodeCode: 'EP002' })
    assert.equal(ep1.length, 1)
    assert.equal(ep2.length, 0, 'episode-scoped must not appear under unlisted episodes')
  })

  test('listCharacters: project-scoped appears for every episode', async () => {
    await cm.createCharacter(SLUG, {
      name: 'Brand', description: 'always present', scope: 'project',
    })
    const ep1 = await cm.listCharacters(SLUG, { episodeCode: 'EP001' })
    const ep2 = await cm.listCharacters(SLUG, { episodeCode: 'EP002' })
    assert.equal(ep1.length, 1)
    assert.equal(ep2.length, 1)
    assert.equal(ep1[0].id, 'brand')
  })

  test('createCharacter: collision returns 409', async () => {
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'one', scope: 'project' })
    await assert.rejects(
      cm.createCharacter(SLUG, { name: 'Aria', description: 'two', scope: 'project' }),
      (err: any) => err.status === 409 && /already exists/i.test(err.message),
    )
  })

  test('updateCharacter: patches name + description, immutable fields preserved', async () => {
    const created = await cm.createCharacter(SLUG, {
      name: 'Aria', description: 'old', scope: 'project',
    })
    const updated = await cm.updateCharacter(SLUG, 'aria', { description: 'new' })
    assert.equal(updated!.description, 'new')
    assert.equal(updated!.id, 'aria', 'id immutable')
    assert.equal(updated!.created_at, created.created_at, 'created_at immutable')
    assert.equal(updated!.source, created.source, 'source immutable')
  })

  test('updateCharacter: scope episode→project clears episode_codes', async () => {
    await cm.createCharacter(SLUG, {
      name: 'Aria', description: 'd', scope: 'episode', episode_codes: ['EP001'],
    })
    const updated = await cm.updateCharacter(SLUG, 'aria', { scope: 'project' })
    assert.equal(updated!.scope, 'project')
    assert.equal(updated!.episode_codes, undefined)
  })

  test('promoteToProject: shortcut works', async () => {
    await cm.createCharacter(SLUG, {
      name: 'Aria', description: 'd', scope: 'episode', episode_codes: ['EP001'],
    })
    const promoted = await cm.promoteToProject(SLUG, 'aria')
    assert.equal(promoted!.scope, 'project')
    assert.equal(promoted!.episode_codes, undefined)
  })

  test('deleteCharacter: removes folder + returns true; returns false if missing', async () => {
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'd', scope: 'project' })
    assert.equal(await cm.deleteCharacter(SLUG, 'aria'), true)
    assert.equal(await cm.getCharacter(SLUG, 'aria'), null)
    assert.equal(await cm.deleteCharacter(SLUG, 'aria'), false)
  })

  test('resolveCharacters: drops missing ids with a warn (no throw)', async () => {
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'd', scope: 'project' })
    const out = await cm.resolveCharacters(SLUG, ['aria', 'does-not-exist', 'aria'])
    // Two valid ids (aria appears twice — duplicates allowed; consumer can dedupe)
    assert.equal(out.length, 2)
    assert.equal(out[0].id, 'aria')
    assert.equal(out[1].id, 'aria')
  })

  test('addReferenceImage: writes file + appends to references.images', async () => {
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'd', scope: 'project' })
    const buf = Buffer.from('fake png bytes')
    const result = await cm.addReferenceImage(SLUG, 'aria', buf, 'portrait.png')
    assert.equal(result.relativePath, 'portrait.png')
    const c = await cm.getCharacter(SLUG, 'aria')
    assert.deepEqual(c!.references?.images, ['portrait.png'])
    // File on disk
    const onDisk = await fs.readFile(path.join(pm.projectsRoot(), SLUG, 'characters', 'aria', 'portrait.png'))
    assert.equal(onDisk.toString(), 'fake png bytes')
  })

  test('addReferenceImage: filename sanitized (path traversal stripped)', async () => {
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'd', scope: 'project' })
    const result = await cm.addReferenceImage(SLUG, 'aria', Buffer.from('x'), '../../etc/passwd')
    // Path traversal stripped; only basename kept and unsafe chars replaced.
    assert.ok(!result.relativePath.includes('..'))
    assert.ok(!result.relativePath.includes('/'))
  })

  test('listCharacters: project-scoped sorts above episode-scoped, then alphabetically', async () => {
    await cm.createCharacter(SLUG, { name: 'Zara', description: 'd', scope: 'project' })
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'd', scope: 'project' })
    await cm.createCharacter(SLUG, { name: 'Mab', description: 'd', scope: 'episode', episode_codes: ['EP001'] })
    const list = await cm.listCharacters(SLUG, { episodeCode: 'EP001' })
    assert.deepEqual(list.map(c => c.id), ['aria', 'zara', 'mab'])
  })

  // ── Unified-library merge (character-unification) ──────────────────────────

  test('listCharacters: merges library characters assigned to this project', async () => {
    const cl = await import('../services/character-library.js')
    // A native project character + a library character assigned to SLUG.
    await cm.createCharacter(SLUG, { name: 'Native', description: 'on disk', scope: 'project' })
    await cm.createCharacter(SLUG, { name: 'Seed', description: 'lib seed', scope: 'project' })
    await cl.saveToLibrary(SLUG, 'seed')        // auto-assigned to SLUG
    await cm.deleteCharacter(SLUG, 'seed')      // remove the on-disk copy → library-only, still assigned

    const own = await cm.listOwnCharacters(SLUG)
    assert.deepEqual(own.map(c => c.id), ['native'], 'listOwnCharacters stays project-only')

    const unified = await cm.listCharacters(SLUG)
    assert.deepEqual(unified.map(c => c.id).sort(), ['native', 'seed'])
    const seed = unified.find(c => c.id === 'seed')
    assert.equal(seed?.source, 'library', 'assigned-from-library marked source=library')
  })

  test('listCharacters: dedups by id, canonical Channel Character wins', async () => {
    const cl = await import('../services/character-library.js')
    await cm.createCharacter(SLUG, { name: 'Aria', description: 'project version', scope: 'project' })
    await cl.saveToLibrary(SLUG, 'aria')  // library copy assigned to SLUG, same id
    const unified = await cm.listCharacters(SLUG)
    const arias = unified.filter(c => c.id === 'aria')
    assert.equal(arias.length, 1, 'no duplicate when both stores hold the id')
    assert.equal(arias[0].description, 'project version', 'canonical copy preserves the migrated content')
    assert.equal(arias[0].source, 'library')
  })

  test('getCharacter: falls back to an assigned library character', async () => {
    const cl = await import('../services/character-library.js')
    await cm.createCharacter(SLUG, { name: 'Lib', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG, 'lib')   // assigned to SLUG
    await cm.deleteCharacter(SLUG, 'lib') // drop the on-disk copy
    const got = await cm.getCharacter(SLUG, 'lib')
    assert.equal(got?.name, 'Lib')
    assert.equal(got?.source, 'project', 'channel-owned record is canonical')
    // Deleting the channel copy removes it from this channel's view.
    await cl.deleteChannelCharacter(SLUG, 'lib')
    assert.equal(await cm.getCharacter(SLUG, 'lib'), null)
  })

  test('referenceImagePath: falls back to the library folder', async () => {
    const cl = await import('../services/character-library.js')
    await cm.createCharacter(SLUG, { name: 'Ref', description: 'd', scope: 'project' })
    await cm.addReferenceImage(SLUG, 'ref', Buffer.from('img-bytes'), 'face.png')
    await cl.saveToLibrary(SLUG, 'ref')
    await cm.deleteCharacter(SLUG, 'ref')  // project copy gone; library copy remains
    const p = cm.referenceImagePath(SLUG, 'ref', 'face.png')
    assert.ok(p.includes('.character-library'), `expected library path, got ${p}`)
    const onDisk = await fs.readFile(p)
    assert.equal(onDisk.toString(), 'img-bytes')
  })
})

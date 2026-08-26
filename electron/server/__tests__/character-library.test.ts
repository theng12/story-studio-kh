/**
 * Tests for the global character library (services/character-library.ts).
 *
 * Coverage:
 *   - saveToLibrary copies + normalises the character record
 *   - listLibrary + getLibraryCharacter round-trip
 *   - importFromLibrary creates a project-scoped char with source='imported'
 *   - import optionally scoped to specific episodes
 *   - collision returns 409 unless overwrite:true
 *   - delete + update + missing-target paths
 *   - reference image files copy on save AND on import
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let cl: typeof import('../services/character-library.js')
let cm: typeof import('../services/character-manager.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG_A = 'lib-test-a'
const SLUG_B = 'lib-test-b'

async function makeProject(slug: string) {
  const projDir = path.join(pm.projectsRoot(), slug)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug, name: `Test ${slug}`,
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, created_at: new Date().toISOString(),
  }))
}

describe('character-library', () => {
  before(async () => {
    tmp = await useTempDataDir()
    cl = await import('../services/character-library.js')
    cm = await import('../services/character-manager.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at temp dir')
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

  test('saveToLibrary: copies char + normalises scope/source/episode_codes', async () => {
    await cm.createCharacter(SLUG_A, {
      name: 'Aria', description: 'd',
      scope: 'episode', episode_codes: ['EP001'],
    })
    const lib = await cl.saveToLibrary(SLUG_A, 'aria')
    assert.equal(lib.id, 'aria')
    assert.equal(lib.scope, 'project')
    assert.equal(lib.episode_codes, undefined)
    assert.equal(lib.source, 'project')
    // Round-trip
    const read = await cl.getLibraryCharacter('aria')
    assert.equal(read?.name, 'Aria')
  })

  test('createLibraryCharacter: creates one canonical record with channel labels', async () => {
    const created = await cl.createLibraryCharacter({
      name: 'Channel Guide',
      description: 'A calm recurring host',
      projects: [SLUG_A, SLUG_B],
    })
    assert.equal(created.id, 'channel-guide')
    assert.equal(created.scope, 'project')
    assert.deepEqual(created.projects, [SLUG_A, SLUG_B])
    assert.equal(created.episode_codes, undefined)
    assert.equal((await cm.listCharacters(SLUG_A))[0]?.id, 'channel-guide')
  })

  test('channel voice profile overrides the default only for its channel', async () => {
    const created = await cl.createLibraryCharacter({
      name: 'Narrator',
      description: 'A shared narrator',
      projects: [SLUG_A, SLUG_B],
      speech: { voiceId: 'default-voice', voiceProvider: 'elevenlabs' },
    })
    await cl.setChannelProfile(created.id, SLUG_A, {
      speech: { voiceId: 'fish-a', voiceProvider: 'fishaudio', tonation: 'gentle' },
    })
    const forA = await cm.getCharacter(SLUG_A, created.id)
    const forB = await cm.getCharacter(SLUG_B, created.id)
    assert.deepEqual(forA?.speech, { voiceId: 'fish-a', voiceProvider: 'fishaudio', tonation: 'gentle' })
    assert.deepEqual(forB?.speech, { voiceId: 'default-voice', voiceProvider: 'elevenlabs' })
  })

  test('unassign removes the retired channel voice profile without touching other channels', async () => {
    const created = await cl.createLibraryCharacter({
      name: 'Guide', description: 'Shared guide', projects: [SLUG_A, SLUG_B],
      channel_profiles: {
        [SLUG_A]: { speech: { voiceId: 'a' } },
        [SLUG_B]: { speech: { voiceId: 'b' } },
      },
    })
    const updated = await cl.unassignFromProject(created.id, SLUG_A)
    assert.deepEqual(updated?.projects, [SLUG_B])
    assert.equal(updated?.channel_profiles?.[SLUG_A], undefined)
    assert.equal(updated?.channel_profiles?.[SLUG_B]?.speech?.voiceId, 'b')
  })

  test('saveToLibrary: collision returns 409 (unless overwrite:true)', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd1', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    // Re-save should collide.
    await assert.rejects(
      cl.saveToLibrary(SLUG_A, 'aria'),
      (err: any) => err.status === 409,
    )
    // Overwrite succeeds.
    const updated = await cm.updateCharacter(SLUG_A, 'aria', { description: 'd2' })
    assert.ok(updated)
    const lib = await cl.saveToLibrary(SLUG_A, 'aria', { overwrite: true })
    assert.equal(lib.description, 'd2')
  })

  test('importFromLibrary: snapshot copy with source=imported', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')

    const imported = await cl.importFromLibrary('aria', SLUG_B)
    assert.equal(imported.id, 'aria')
    assert.equal(imported.source, 'imported')
    assert.equal(imported.scope, 'project')
    // Project B now has the character.
    const onB = await cm.getCharacter(SLUG_B, 'aria')
    assert.equal(onB?.name, 'Aria')
    assert.equal(onB?.source, 'imported')
  })

  test('importFromLibrary: scope=episode requires episode_codes', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    await assert.rejects(
      cl.importFromLibrary('aria', SLUG_B, { scope: 'episode' }),
      /requires non-empty episode_codes/i,
    )
    const imported = await cl.importFromLibrary('aria', SLUG_B, {
      scope: 'episode', episode_codes: ['EP001'],
    })
    assert.equal(imported.scope, 'episode')
    assert.deepEqual(imported.episode_codes, ['EP001'])
  })

  test('importFromLibrary: collision returns 409 unless overwrite:true', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    await cm.createCharacter(SLUG_B, { name: 'Aria local', description: 'local', scope: 'project' })
    // First import collides because target id 'aria' is the library default;
    // need an existing 'aria' on B. Recreate to ensure collision.
    await cm.createCharacter(SLUG_B, { name: 'Aria', description: 'preexisting', scope: 'project' })
    await assert.rejects(
      cl.importFromLibrary('aria', SLUG_B),
      (err: any) => err.status === 409,
    )
    // overwrite succeeds.
    const ok = await cl.importFromLibrary('aria', SLUG_B, { overwrite: true })
    assert.equal(ok.id, 'aria')
  })

  test('importFromLibrary: targetId rename', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    const imported = await cl.importFromLibrary('aria', SLUG_B, { targetId: 'aria-fork' })
    assert.equal(imported.id, 'aria-fork')
    assert.equal(await cm.getCharacter(SLUG_B, 'aria'), null, 'original id not used')
    assert.ok(await cm.getCharacter(SLUG_B, 'aria-fork'))
  })

  test('listLibrary returns alphabetically sorted', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Zara', description: 'd', scope: 'project' })
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'zara')
    await cl.saveToLibrary(SLUG_A, 'aria')
    const list = await cl.listLibrary()
    assert.deepEqual(list.map(c => c.id), ['aria', 'zara'])
  })

  test('deleteLibraryCharacter: removes folder + returns true; false if missing', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    assert.equal(await cl.deleteLibraryCharacter('aria'), true)
    assert.equal(await cl.getLibraryCharacter('aria'), null)
    assert.equal(await cl.deleteLibraryCharacter('aria'), false)
  })

  test('updateLibraryCharacter: in-place patch + library normalisation', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'old', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    const updated = await cl.updateLibraryCharacter('aria', { description: 'new' })
    assert.equal(updated?.description, 'new')
    assert.equal(updated?.scope, 'project', 'library entries always project-scoped')
    assert.equal(updated?.source, 'project')
  })

  test('saveToLibrary: auto-assigns the source project into projects[]', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    const lib = await cl.saveToLibrary(SLUG_A, 'aria')
    assert.deepEqual(lib.projects, [SLUG_A], 'source project auto-assigned on save')
  })

  test('assign/unassign: idempotent add + remove of project tags', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    // Assign B; idempotent re-assign keeps a single entry.
    await cl.assignToProject('aria', SLUG_B)
    const twice = await cl.assignToProject('aria', SLUG_B)
    assert.deepEqual(twice?.projects, [SLUG_A, SLUG_B])
    // Unassign A.
    const removed = await cl.unassignFromProject('aria', SLUG_A)
    assert.deepEqual(removed?.projects, [SLUG_B])
    // Unassigning a slug that isn't there is a no-op (idempotent).
    const noop = await cl.unassignFromProject('aria', SLUG_A)
    assert.deepEqual(noop?.projects, [SLUG_B])
  })

  test('assign/unassign: missing library character returns null', async () => {
    assert.equal(await cl.assignToProject('ghost', SLUG_A), null)
    assert.equal(await cl.unassignFromProject('ghost', SLUG_A), null)
  })

  test('listForProject: returns assigned chars marked source=library', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cm.createCharacter(SLUG_A, { name: 'Bond', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')   // auto-assigned to A
    await cl.saveToLibrary(SLUG_A, 'bond')   // auto-assigned to A
    await cl.unassignFromProject('bond', SLUG_A)  // now bond is library-only
    const forA = await cl.listForProject(SLUG_A)
    assert.deepEqual(forA.map(c => c.id), ['aria'])
    assert.equal(forA[0].source, 'library')
    assert.equal((await cl.listForProject(SLUG_B)).length, 0)
  })

  test('updateLibraryCharacter: preserves projects[] across edits', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'old', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    await cl.assignToProject('aria', SLUG_B)
    const updated = await cl.updateLibraryCharacter('aria', { description: 'new' })
    assert.deepEqual(updated?.projects, [SLUG_A, SLUG_B], 'edits must not drop assignments')
  })

  test('importFromLibrary: snapshot copy drops projects[] tags', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cl.saveToLibrary(SLUG_A, 'aria')
    await cl.assignToProject('aria', SLUG_B)
    const imported = await cl.importFromLibrary('aria', SLUG_B, { targetId: 'aria-copy' })
    assert.equal(imported.projects, undefined, 'per-project snapshot carries no assignment tags')
  })

  test('reference images copy on save + on import', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'd', scope: 'project' })
    await cm.addReferenceImage(SLUG_A, 'aria', Buffer.from('fake-png'), 'portrait.png')
    await cl.saveToLibrary(SLUG_A, 'aria')
    // Image should now exist in the library folder.
    const libImg = path.join(pm.projectsRoot(), '.character-library', 'aria', 'portrait.png')
    assert.equal(existsSync(libImg), true, 'image copied to library')

    await cl.importFromLibrary('aria', SLUG_B)
    const projImg = path.join(pm.projectsRoot(), SLUG_B, 'characters', 'aria', 'portrait.png')
    assert.equal(existsSync(projImg), true, 'image copied to project on import')
    // Library imports also list it in references.
    const onB = await cm.getCharacter(SLUG_B, 'aria')
    assert.deepEqual(onB?.references?.images, ['portrait.png'])
  })
})

// Tiny helper since we use existsSync sync-style for one-off checks.
import { existsSync } from 'fs'

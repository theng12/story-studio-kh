/**
 * Channel-owned character library + migration.
 *
 * One character belongs to one channel. Legacy flat records are immutable and
 * are copied into `.character-library/_channels/<channel>/<id>/`.
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

async function writeLegacy(id: string, record: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = path.join(pm.projectsRoot(), '.character-library', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'character.json'), `${JSON.stringify(record, null, 2)}\n`)
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body)
}

describe('character-library channel ownership', () => {
  before(async () => {
    tmp = await useTempDataDir()
    cl = await import('../services/character-library.js')
    cm = await import('../services/character-manager.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    await makeProject(SLUG_A)
    await makeProject(SLUG_B)
  })

  test('createChannelCharacter stores one channel, id preserved', async () => {
    const created = await cl.createChannelCharacter(SLUG_A, { name: 'Aria', description: 'guide' })
    assert.equal(created.id, 'aria')
    assert.deepEqual(created.projects, [SLUG_A])
    assert.equal(created.scope, 'project')
    assert.equal(created.channel_profiles, undefined)
    assert.equal((await cl.getChannelCharacter(SLUG_A, 'aria'))?.name, 'Aria')
    assert.equal(await cl.getChannelCharacter(SLUG_B, 'aria'), null)
    assert.equal((await cl.listChannelCharacters(SLUG_A)).length, 1)
  })

  test('channel voice is folded into the owned record', async () => {
    await cl.createChannelCharacter(SLUG_A, {
      name: 'Narrator', description: 'd',
      speech: { voiceId: 'base' },
      channel_profiles: { [SLUG_A]: { speech: { voiceId: 'fish-a' } }, [SLUG_B]: { speech: { voiceId: 'other' } } },
    })
    const got = await cl.getChannelCharacter(SLUG_A, 'narrator')
    assert.deepEqual(got?.speech, { voiceId: 'fish-a' })
    assert.equal(got?.channel_profiles, undefined)
  })

  test('legacy flat records are visible as read-only fallback', async () => {
    await writeLegacy('legacy', { id: 'legacy', name: 'Legacy', description: 'd', scope: 'project', source: 'project', projects: [SLUG_A], schemaVersion: 1 })
    const list = await cl.listForProject(SLUG_A)
    assert.deepEqual(list.map(c => c.id), ['legacy'])
    assert.equal(list[0]?.source, 'library')
    assert.throws(() => cl.rejectLegacyWrite('legacy'), /read-only legacy record/)
  })

  test('preview counts channels, conflicts and missing refs without writing', async () => {
    await writeLegacy('shared', { id: 'shared', name: 'Shared', description: 'd', projects: [SLUG_A, SLUG_B], references: { images: ['one.png'] } }, { 'one.png': 'img' })
    await writeLegacy('unassigned', { id: 'unassigned', name: 'Loose', description: 'd', projects: [] })
    await writeLegacy('missing', { id: 'missing', name: 'Missing', description: 'd', projects: [SLUG_A], references: { images: ['gone.png'] } })
    const report = await cl.previewChannelMigration()
    assert.equal(report.legacy_records, 3)
    assert.equal(report.assigned_records, 2)
    assert.equal(report.unassigned_records, 1)
    assert.equal(report.copies_planned, 2)
    assert.equal(report.missing_references.length, 1)
    assert.equal(report.conflicts.some(c => c.reason === 'missing_reference'), true)
    assert.equal(await cl.getChannelCharacter(SLUG_A, 'shared'), null)
  })

  test('apply copies legacy per channel, preserves id and reference bytes', async () => {
    await writeLegacy('shared', { id: 'shared', name: 'Shared', description: 'd', projects: [SLUG_A, SLUG_B], references: { images: ['one.png'] } }, { 'one.png': 'img' })
    const report = await cl.applyChannelMigration()
    assert.equal(report.copies_created, 2)
    assert.ok(report.run_id)
    const a = await cl.getChannelCharacter(SLUG_A, 'shared')
    const b = await cl.getChannelCharacter(SLUG_B, 'shared')
    assert.deepEqual(a?.projects, [SLUG_A])
    assert.deepEqual(b?.projects, [SLUG_B])
    assert.equal(await fs.readFile(path.join(cl.channelCharacterDir(SLUG_A, 'shared'), 'one.png'), 'utf8'), 'img')
    const legacy = await cl.getLibraryCharacter('shared')
    assert.deepEqual(legacy?.projects, [SLUG_A, SLUG_B], 'legacy source is never rewritten')
    assert.equal((await cl.previewChannelMigration()).already_present, 2)
  })

  test('project-local same id is a loud conflict and copies nothing', async () => {
    await cm.createCharacter(SLUG_A, { name: 'Aria', description: 'local', scope: 'episode', episode_codes: ['EP0001'] })
    await writeLegacy('aria', { id: 'aria', name: 'Aria', description: 'legacy', projects: [SLUG_A] })
    const report = await cl.applyChannelMigration()
    assert.equal(report.copies_created, 0)
    assert.equal(report.conflicts[0]?.reason, 'project_local_conflict')
    assert.equal(await cl.getChannelCharacter(SLUG_A, 'aria'), null)
    assert.equal((await cm.listOwnCharacters(SLUG_A)).length, 1)
  })

  test('undo refuses an edited copy and moves only verified copies to Trash', async () => {
    await writeLegacy('kept', { id: 'kept', name: 'Kept', description: 'd', projects: [SLUG_A] })
    await writeLegacy('edited', { id: 'edited', name: 'Edited', description: 'd', projects: [SLUG_A] })
    const report = await cl.applyChannelMigration()
    await cl.updateChannelCharacter(SLUG_A, 'edited', { description: 'changed after migration' })
    const undo = await cl.undoChannelMigration(report.run_id!)
    assert.equal(undo.removed, 1)
    assert.equal(undo.refused.length, 1)
    assert.equal(undo.refused[0]?.character_id, 'edited')
    assert.equal(await cl.getChannelCharacter(SLUG_A, 'kept'), null)
    assert.equal((await cl.getChannelCharacter(SLUG_A, 'edited'))?.description, 'changed after migration')
  })
})

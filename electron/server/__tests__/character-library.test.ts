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
import { withLock, __pendingLockWaitersForTests } from '../lib/atomic-store.js'

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

function channelRoot(): string {
  return path.join(pm.projectsRoot(), '.character-library', '_channels')
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

async function waitForLockWaiters(key: string, count: number): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (__pendingLockWaitersForTests(key) >= count) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`lock ${key} never reached ${count} waiter(s)`)
}

/** Wait until a held lock's own queued entry has started, so new waiters queue after it. */
async function waitForLockIdle(key: string): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (__pendingLockWaitersForTests(key) === 0) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`lock ${key} never started`)
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

  test('apply copies each channel assignment, preserving id, voice and reference bytes', async () => {
    await writeLegacy('shared', {
      id: 'shared', name: 'Shared', description: 'd', projects: [SLUG_A, SLUG_B],
      speech: { voiceId: 'base' },
      channel_profiles: { [SLUG_A]: { speech: { voiceId: 'voice-a' } }, [SLUG_B]: { speech: { voiceId: 'voice-b' } } },
      references: { images: ['one.png'] },
    }, { 'one.png': 'img' })
    const report = await cl.applyChannelMigration()
    assert.equal(report.copies_created, 2)
    const a = await cl.getChannelCharacter(SLUG_A, 'shared')
    const b = await cl.getChannelCharacter(SLUG_B, 'shared')
    assert.equal(a?.id, 'shared')
    assert.deepEqual(a?.projects, [SLUG_A])
    assert.deepEqual(a?.speech, { voiceId: 'voice-a' })
    assert.deepEqual(b?.projects, [SLUG_B])
    assert.deepEqual(b?.speech, { voiceId: 'voice-b' })
    assert.equal(await fs.readFile(path.join(cl.channelCharacterDir(SLUG_A, 'shared'), 'one.png'), 'utf8'), 'img')
    const legacy = await cl.getLibraryCharacter('shared')
    assert.deepEqual(legacy?.projects, [SLUG_A, SLUG_B], 'legacy source is never rewritten')
    const backup = path.join(channelRoot(), '_migration', report.run_id!, 'backup', 'shared')
    assert.equal(await fs.readFile(path.join(backup, 'character.json'), 'utf8'), await fs.readFile(path.join(pm.projectsRoot(), '.character-library', 'shared', 'character.json'), 'utf8'))
    assert.equal(await fs.readFile(path.join(backup, 'one.png'), 'utf8'), 'img')
  })

  test('repeat apply is idempotent and never overwrites an edited copy', async () => {
    await writeLegacy('idem', { id: 'idem', name: 'Idem', description: 'd', projects: [SLUG_A] })
    assert.equal((await cl.applyChannelMigration()).copies_created, 1)

    const second = await cl.applyChannelMigration()
    assert.equal(second.copies_created, 0)
    assert.equal(second.already_present, 1)

    await cl.updateChannelCharacter(SLUG_A, 'idem', { description: 'edited after migration' })
    const third = await cl.applyChannelMigration()
    assert.equal(third.copies_created, 0)
    assert.equal(third.conflicts[0]?.reason, 'target_changed')
    assert.equal((await cl.getChannelCharacter(SLUG_A, 'idem'))?.description, 'edited after migration')
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

  test('migration rejects traversal, absolute and symlinked reference files', async () => {
    const outside = path.join(pm.projectsRoot(), 'outside.png')
    await fs.writeFile(outside, 'outside')
    await writeLegacy('traversal', { id: 'traversal', name: 'T', description: 'd', projects: [SLUG_A], references: { images: ['../outside.png'] } })
    await writeLegacy('absolute', { id: 'absolute', name: 'A', description: 'd', projects: [SLUG_A], references: { images: [outside] } })
    await writeLegacy('linked', { id: 'linked', name: 'L', description: 'd', projects: [SLUG_A], references: { images: ['link.png'] } })
    await fs.symlink(outside, path.join(pm.projectsRoot(), '.character-library', 'linked', 'link.png'))

    const preview = await cl.previewChannelMigration()
    assert.equal(preview.copies_planned, 0)
    assert.deepEqual(preview.conflicts.map(c => c.reason), ['invalid', 'invalid', 'invalid'])

    const applied = await cl.applyChannelMigration()
    assert.equal(applied.copies_created, 0)
    assert.equal(await exists(path.join(channelRoot(), SLUG_A, 'traversal')), false)
    assert.equal(await exists(path.join(channelRoot(), SLUG_A, 'linked')), false)
  })

  test('an orphan channel assignment is reported and creates no channel folder', async () => {
    await writeLegacy('orphan', { id: 'orphan', name: 'Orphan', description: 'd', projects: ['ghost-channel'] })
    const preview = await cl.previewChannelMigration()
    assert.equal(preview.copies_planned, 0)
    assert.equal(preview.conflicts[0]?.reason, 'channel_missing')
    const applied = await cl.applyChannelMigration()
    assert.equal(applied.copies_created, 0)
    assert.equal(await exists(path.join(channelRoot(), 'ghost-channel')), false)
  })

  test('apply snapshots verified source bytes and leaves the original unchanged', async () => {
    await writeLegacy('snap', {
      id: 'snap', name: 'Snap', description: 'd', projects: [SLUG_A], references: { images: ['pic.png'] },
    }, { 'pic.png': 'pic-bytes' })
    const legacyDir = path.join(pm.projectsRoot(), '.character-library', 'snap')
    const sourceRecord = await fs.readFile(path.join(legacyDir, 'character.json'), 'utf8')

    const report = await cl.applyChannelMigration()
    const backup = path.join(channelRoot(), '_migration', report.run_id!, 'backup', 'snap')
    assert.equal(await fs.readFile(path.join(backup, 'character.json'), 'utf8'), sourceRecord)
    assert.equal(await fs.readFile(path.join(backup, 'pic.png'), 'utf8'), 'pic-bytes')
    assert.equal(await fs.readFile(path.join(legacyDir, 'character.json'), 'utf8'), sourceRecord)
    assert.equal(await fs.readFile(path.join(legacyDir, 'pic.png'), 'utf8'), 'pic-bytes')
  })

  test('concurrent creates cannot overwrite the same channel record', async () => {
    const results = await Promise.allSettled([
      cl.createChannelCharacter(SLUG_A, { id: 'race', name: 'One', description: 'd' }),
      cl.createChannelCharacter(SLUG_A, { id: 'race', name: 'Two', description: 'd' }),
    ])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    assert.equal((rejected.reason as { status?: number }).status, 409)
    assert.ok(['One', 'Two'].includes((await cl.getChannelCharacter(SLUG_A, 'race'))?.name || ''))
  })

  test('migration publish cannot discard a concurrent reference edit', async () => {
    await writeLegacy('race-ref', { id: 'race-ref', name: 'Race', description: 'd', projects: [SLUG_A] })
    const targetJson = path.join(channelRoot(), SLUG_A, 'race-ref', 'character.json')
    let releaseHold!: () => void
    const held = new Promise<void>(resolve => { releaseHold = resolve })
    const hold = withLock(targetJson, () => held)
    let migration: ReturnType<typeof cl.applyChannelMigration> | null = null
    let add: ReturnType<typeof cl.addChannelReferenceImage> | null = null
    let setupError: unknown = null

    try {
      // The holder's own queued entry must start before anything else queues.
      await waitForLockIdle(targetJson)
      migration = cl.applyChannelMigration()
      await waitForLockWaiters(targetJson, 1)
      add = cl.addChannelReferenceImage(SLUG_A, 'race-ref', Buffer.from('edited-bytes'), 'edit.png')
      await waitForLockWaiters(targetJson, 2)
    } catch (e) {
      setupError = e
    } finally {
      // Always release: a failed setup must not strand queued async work.
      releaseHold()
      await hold
      await Promise.allSettled([migration, add].filter(Boolean) as Promise<unknown>[])
    }
    if (setupError) throw setupError

    const [report, added] = await Promise.all([migration!, add!])
    assert.equal(report.copies_created, 1)
    assert.equal(added.relativePath, 'edit.png')
    assert.deepEqual((await cl.getChannelCharacter(SLUG_A, 'race-ref'))?.references?.images, ['edit.png'])
    assert.equal(await fs.readFile(path.join(cl.channelCharacterDir(SLUG_A, 'race-ref'), 'edit.png'), 'utf8'), 'edited-bytes')
  })
})

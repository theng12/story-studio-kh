/**
 * Tests for the soft-delete flow.
 *
 * Scope:
 *   - Default-location project → deleteProject reports 'soft_deleted',
 *     folder untouched, slug filtered from listProjects.
 *   - listSoftDeletedProjects shows hidden slugs with sizes.
 *   - forgetSoftDeletedProject restores visibility.
 *   - hardDeleteSoftDeletedProject rm's the folder + clears the tombstone.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let sd: typeof import('../services/soft-delete.js')
let pm: typeof import('../services/project-manager.js')
let jq: typeof import('../services/job-queue.js')
let tmp: { dir: string; cleanup: () => Promise<void> }
/** What the app's own window sends (main.ts adds it); a request without it is not the owner. */
let OWNER: Record<string, string> = {}
/** Measure the way the route will measure, so a test confirms the number the server will find. */
async function measuredBytes(slug: string): Promise<number> {
  const row = (await sd.listSoftDeletedProjects()).find(r => r.slug === slug)
  if (!row) throw new Error(`${slug} is not listed as soft-deleted`)
  if (!Number.isSafeInteger(row.estimated_bytes) || row.estimated_bytes! < 0) {
    throw new Error(`${slug} could not be measured`)
  }
  return row.estimated_bytes!
}

async function seedProject(parentDir: string, slug: string): Promise<string> {
  const projDir = path.join(parentDir, slug)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(
    path.join(projDir, 'project.json'),
    JSON.stringify({ slug, name: slug, episode_prefix: 'EP' }),
  )
  return projDir
}

async function seedJob(dir: string, status: string, providerState?: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'jobs.json'), JSON.stringify({ jobs: [{
    job_id: `job-${status}`, project_slug: path.basename(dir), type: 'audio', episode_id: 'EP0001', title: 'guard', status,
    created_at: new Date().toISOString(), started_at: status === 'queued' ? null : new Date().toISOString(),
    finished_at: ['done', 'error', 'cancelled'].includes(status) ? new Date().toISOString() : null,
    error: status === 'error' ? 'local error' : null, output_lines: [], params: {},
    ...(providerState ? { genstudio_jobs: [{ id: 'provider-1', operation: 'voice.tts', state: providerState, updated_at: new Date().toISOString() }] } : {}),
  }] }))
}

describe('soft-delete', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    sd = await import('../services/soft-delete.js')
    jq = await import('../services/job-queue.js')
    const auth = await import('../lib/auth-session.js')
    OWNER = { [auth.OWNER_WINDOW_HEADER]: auth.ownerWindowSecret() }
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    const entries = await fs.readdir(tmp.dir).catch(() => [] as string[])
    for (const name of entries) {
      await fs.rm(path.join(tmp.dir, name), { recursive: true, force: true }).catch(() => {})
    }
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
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

  // v1.4.3 — the 'deleteProject on linked project → unlinked' test was removed
  // with the concept. Every project lives in the Library now, so there is one
  // disposition and no registry to unregister from.

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

  /**
   * v1.4.200 — `estimated_bytes: -1` is documented as "unknown", but it was
   * UNREACHABLE: the tally returned 0 for both "empty folder" and "I could not
   * read it", and the caller's `.catch(() => -1)` could never fire because the
   * tally never rejects. So a folder nobody could measure was reported as
   * **0 bytes**. AGENTS.md §6.
   */
  test('a tombstone whose folder cannot be read reports unknown, not zero bytes', async () => {
    const projDir = await seedProject(pm.projectsRoot(), 'tomb-unreadable')
    await pm.deleteProject('tomb-unreadable')

    // The folder is gone and a plain file now occupies its name — the shape a
    // Finder tidy-up or a sync tool leaves behind. `existsSync` still says true.
    await fs.rm(projDir, { recursive: true, force: true })
    await fs.writeFile(projDir, 'not a directory')

    const tombstone = (await sd.listSoftDeletedProjects()).find(t => t.slug === 'tomb-unreadable')
    assert.ok(tombstone, 'a tombstone survives its folder becoming unreadable')
    assert.equal(tombstone.exists, true, 'the path exists — it is simply not a project folder')
    assert.equal(
      tombstone.estimated_bytes, -1,
      'an unmeasurable folder must report unknown (-1), never 0 bytes',
    )
  })

  test('one unreadable child makes the whole total unknown, not a low total', async () => {
    const projDir = await seedProject(pm.projectsRoot(), 'tomb-partial')
    await pm.deleteProject('tomb-partial')
    // Real children with real bytes, plus a child that cannot be read at all.
    await fs.mkdir(path.join(projDir, 'media'), { recursive: true })
    await fs.writeFile(path.join(projDir, 'media', 'clip.bin'), Buffer.alloc(4096))
    await fs.writeFile(path.join(projDir, 'loose.bin'), Buffer.alloc(2048))

    const good = (await sd.listSoftDeletedProjects()).find(t => t.slug === 'tomb-partial')!
    assert.ok(good.estimated_bytes > 0, 'a readable folder is still measured')

    // A directory that cannot be listed — the realistic case, and the one the
    // old code silently skipped while still presenting a total.
    const sealed = path.join(projDir, 'sealed')
    await fs.mkdir(sealed, { recursive: true })
    await fs.writeFile(path.join(sealed, 'hidden.bin'), Buffer.alloc(1024))
    await fs.chmod(sealed, 0o000)
    try {
      // Establish the premise EXPLICITLY. Passing vacuously when the child
      // happens to be readable (e.g. a root test runner) would make this test
      // unable to fail, which is worse than not having it.
      let unreadable = false
      try { await fs.readdir(sealed) } catch { unreadable = true }
      if (!unreadable) return

      const blocked = (await sd.listSoftDeletedProjects()).find(t => t.slug === 'tomb-partial')!
      assert.equal(
        blocked.estimated_bytes, -1,
        'a partial sum presented as a total is the same lie in a smaller font',
      )
    } finally {
      await fs.chmod(sealed, 0o755).catch(() => {})
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

    await sd.hardDeleteSoftDeletedProject('goodbye', await measuredBytes('goodbye'))
    assert.equal(existsSync(dir), false, 'hard delete removes folder')
    const tombstones = await sd.listSoftDeletedProjects()
    assert.equal(tombstones.length, 0, 'tombstone cleared')
  })

  test('hardDeleteSoftDeletedProject refuses if slug is not soft-deleted', async () => {
    await assert.rejects(
      () => sd.hardDeleteSoftDeletedProject('not-tombstoned', 0),
      (e: any) => e.statusCode === 400 && /not currently soft-deleted/i.test(e.message),
    )
  })

  test('active and unsettled provider jobs block soft-delete and hard-delete', async () => {
    for (const status of ['queued', 'running', 'paused']) {
      const slug = `active-${status}`
      const dir = await seedProject(pm.projectsRoot(), slug)
      await sd.softDeleteProject(slug)
      await seedJob(dir, status)
      await assert.rejects(() => pm.deleteProject(slug), (e: any) => e?.statusCode === 409 && /job/i.test(e.message))
      await assert.rejects(() => sd.softDeleteProject(slug), (e: any) => e?.statusCode === 409 && /job/i.test(e.message))
      await assert.rejects(() => sd.hardDeleteSoftDeletedProject(slug, 0), (e: any) => e?.statusCode === 409 && /job|bytes/i.test(e.message))
      assert.ok(existsSync(dir))
    }
  })

  test('fully settled terminal provider evidence permits the existing delete flow', async () => {
    const dir = await seedProject(pm.projectsRoot(), 'settled-delete')
    await seedJob(dir, 'done', 'succeeded')
    assert.equal((await pm.deleteProject('settled-delete')).ok, true)
    await sd.hardDeleteSoftDeletedProject('settled-delete', await measuredBytes('settled-delete'))
    assert.equal(existsSync(dir), false)
  })

  test('delete and hard-delete routes return 409 without removing guarded job evidence', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const projectsRouter = (await import('../routes/projects.js')).router
    const softDeletedRouter = (await import('../routes/soft-deleted-projects.js')).router
    const app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => { req.headers = { ...req.headers, ...OWNER }; next() })
    app.use('/api', projectsRouter, softDeletedRouter)

    const defaultDir = await seedProject(pm.projectsRoot(), 'route-active')
    await sd.softDeleteProject('route-active')
    await seedJob(defaultDir, 'queued')
    const soft = await request(app).delete('/api/projects/route-active')
    assert.equal(soft.status, 409)
    assert.ok(existsSync(path.join(defaultDir, 'jobs.json')))
    const hard = await request(app).delete('/api/soft-deleted-projects/route-active')
      .send({ confirm: true, expected_bytes: await measuredBytes('route-active') })
    assert.equal(hard.status, 409)
    assert.ok(existsSync(defaultDir))
  })

  test('queue insertion blocks immediate soft-delete before its async snapshot reaches disk', async () => {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const projectsRouter = (await import('../routes/projects.js')).router
    const app = express()
    app.use(express.json())
    app.use('/api', projectsRouter)
    await jq.setQueuePaused(true)
    let defaultJob: { job_id: string } | undefined
    try {
      const defaultDir = await seedProject(pm.projectsRoot(), 'immediate-queued-delete')
      defaultJob = jq.enqueuePreparedForTest({ project_slug: 'immediate-queued-delete', type: 'audio', episode_id: 'EP0001', title: 'race', params: {} })
      const soft = await request(app).delete('/api/projects/immediate-queued-delete')
      assert.equal(soft.status, 409)
      assert.ok(existsSync(defaultDir), 'the soft-delete mutation must not win the enqueue/persist race')
    } finally {
      if (defaultJob) await jq.requestJobCancellation('immediate-queued-delete', defaultJob.job_id)
      await jq.setQueuePaused(false)
    }
  })

  // v1.4.3 — the 'addLinkedProject auto-clears a tombstone' test went with the
  // registry. The equivalent path today is `createProject` with the same slug,
  // covered by the test below; re-adopting a folder by copying it into the
  // Library does NOT clear a tombstone, which is deliberate and is why the
  // Hidden channels panel exists.

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

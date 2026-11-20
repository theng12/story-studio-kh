/**
 * Row `20261120-161` — the route that deletes a hidden channel for good had no owner check while
 * its sibling (`POST /trash/delete-permanently`) had one, so a confirmation in the client was the
 * only thing standing between any caller and an irreversible delete.
 *
 * Every one of these assertions fails on the code before the fix: an unkeyed loopback call deleted
 * the folder, an automation key deleted it, and nothing asked what the size was.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: any
let sd: typeof import('../services/soft-delete.js')
let pm: typeof import('../services/project-manager.js')
let OWNER: Record<string, string>

before(async () => {
  tmp = await useTempDataDir()
  sd = await import('../services/soft-delete.js')
  pm = await import('../services/project-manager.js')
  const auth = await import('../lib/auth-session.js')
  OWNER = { [auth.OWNER_WINDOW_HEADER]: auth.ownerWindowSecret() }
  const { router } = await import('../routes/soft-deleted-projects.js')
  const express = (await import('express')).default
  app = express()
  app.use(express.json())
  // An automation-key request, the way the session middleware would mark it.
  app.use((req: any, _res: any, next: any) => {
    if (req.headers['x-test-via-key']) req.user = { via: 'automation_key' }
    next()
  })
  app.use('/api', router)
})
after(async () => { await tmp.cleanup() })

async function hiddenChannel(name: string): Promise<{ slug: string; dir: string; bytes: number }> {
  const { slug } = await pm.createProject({ name })
  const dir = pm.getProjectDir(slug)!
  await fs.mkdir(path.join(dir, 'media'), { recursive: true })
  await fs.writeFile(path.join(dir, 'media', 'clip.mp4'), 'x'.repeat(4096))
  await sd.softDeleteProject(slug)
  const row = (await sd.listSoftDeletedProjects()).find(r => r.slug === slug)
  if (!row) throw new Error(`${slug} is not listed as soft-deleted`)
  if (!Number.isSafeInteger(row.estimated_bytes) || row.estimated_bytes! < 0) {
    throw new Error(`${slug} could not be measured: ${row.estimated_bytes}`)
  }
  return { slug, dir, bytes: row.estimated_bytes! }
}

describe('a hidden channel can only be deleted for good by the owner, with its size confirmed', () => {
  test('a keyless loopback call is refused, names the guard, and deletes nothing', async () => {
    const { slug, dir, bytes } = await hiddenChannel('Keyless attempt')
    const res = await request(app).delete(`/api/soft-deleted-projects/${slug}`)
      .send({ confirm: true, expected_bytes: bytes })
    assert.equal(res.status, 403)
    assert.match(res.body.detail, /Only the owner/i)
    assert.match(res.body.detail, /Nothing was deleted/i)
    assert.ok(existsSync(dir), 'the folder survives a refused delete')
    const stillListed = (await sd.listSoftDeletedProjects()).some(r => r.slug === slug)
    assert.ok(stillListed, 'the tombstone is intact')
  })

  test('an automation key is refused even though it can read the channel list', async () => {
    const { slug, dir, bytes } = await hiddenChannel('Automation attempt')
    const res = await request(app).delete(`/api/soft-deleted-projects/${slug}`)
      .set('x-test-via-key', '1')
      .send({ confirm: true, expected_bytes: bytes })
    assert.equal(res.status, 403)
    assert.match(res.body.detail, /Automation keys never can/i)
    assert.ok(existsSync(dir))
  })

  test('the owner must confirm a size, not just say delete', async () => {
    const { slug, dir } = await hiddenChannel('No confirmation')
    const res = await request(app).delete(`/api/soft-deleted-projects/${slug}`).set(OWNER)
    assert.equal(res.status, 400)
    assert.match(res.body.detail, /Confirm the size/i)
    assert.ok(existsSync(dir))
  })

  test('a size that is not the measured size is refused — the confirmation is compared, not trusted', async () => {
    const { slug, dir, bytes } = await hiddenChannel('Wrong size')
    const res = await request(app).delete(`/api/soft-deleted-projects/${slug}`).set(OWNER)
      .send({ confirm: true, expected_bytes: bytes + 12345 })
    assert.equal(res.status, 409)
    assert.match(res.body.detail, /not the .* you confirmed|is .* bytes now/i)
    assert.ok(existsSync(dir))
  })

  test('the owner with the correct size deletes, and the tombstone is cleared', async () => {
    const { slug, dir, bytes } = await hiddenChannel('Owner confirmed')
    const res = await request(app).delete(`/api/soft-deleted-projects/${slug}`).set(OWNER)
      .send({ confirm: true, expected_bytes: bytes })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(existsSync(dir), false, 'the folder is gone after the confirmed delete')
    assert.equal((await sd.listSoftDeletedProjects()).some(r => r.slug === slug), false)
  })
})

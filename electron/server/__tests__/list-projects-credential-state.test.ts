/**
 * Credential state on metadata-only reads (AGENTS §6, §8).
 *
 * A credential store this Mac cannot decrypt must not take the channel list or
 * the jobs list down with it. `has_api_keys` becomes null — UNKNOWN, never
 * false ("needs key") — while every other metadata field stays exact and the
 * ciphertext on disk stays untouched. True (present) and false (confirmed
 * absent) remain distinguishable from that unknown.
 *
 * WHAT IT CANNOT CATCH: the real Keychain/OS refusal — this runs against the
 * safeStorage test double. The native guard, interaction denial, encrypt and
 * decrypt categorisation without leaks is pinned by keychain-access.test.ts
 * and safe-storage-guarded.test.ts.
 */
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { after, before, beforeEach, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { encryptToBase64 } from '../lib/safe-storage.js'
import { CREDENTIALS_UNAVAILABLE, CredentialsUnavailableError } from '../lib/keychain-access.js'
import { appSecretsPath, readAppSecrets } from '../services/app-secrets-store.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let app: express.Express

before(async () => {
  tmp = await useTempDataDir()
  pm = await import('../services/project-manager.js')
  const { router } = await import('../routes/jobs.js')
  app = express().use(express.json()).use('/api', router)
})

after(async () => { await tmp.cleanup() })

beforeEach(async () => {
  await fs.rm(path.join(tmp.dir, 'projects'), { recursive: true, force: true })
  await fs.rm(appSecretsPath(), { force: true })
})

test('present (true) and confirmed-absent (false) stay distinguishable from unknown', async () => {
  await pm.createProject({ name: 'Cred Distinctions' })

  const [fresh] = await pm.listProjects()
  assert.equal(fresh.has_api_keys, false, 'a missing store is a real "no key configured", not unknown')

  const envelope = {
    __encrypted: true,
    version: 1,
    ciphertext: encryptToBase64(JSON.stringify({ schema_version: 3, providers: { genstudio: { apiKey: 'gsk_list_probe' } } })),
  }
  await fs.writeFile(appSecretsPath(), JSON.stringify(envelope), { mode: 0o600 })

  const [readable] = await pm.listProjects()
  assert.equal(readable.has_api_keys, true, 'a successful read reports the key it actually found')
  assert.equal(readable.name, 'Cred Distinctions')
})

test('an unreadable credential store leaves the channel list usable with unknown keys, ciphertext untouched', async () => {
  const project = await pm.createProject({ name: 'Locked Channel' })
  const ciphertext = Buffer.from(JSON.stringify({
    __encrypted: true,
    version: 1,
    ciphertext: Buffer.from('not-really-ciphertext').toString('base64'),
  }))
  await fs.writeFile(appSecretsPath(), ciphertext, { mode: 0o600 })

  const rows = await pm.listProjects() // must not throw: metadata survives an unreadable store
  assert.equal(rows.length, 1)
  assert.equal(rows[0].slug, project.slug)
  assert.equal(rows[0].name, 'Locked Channel')
  assert.equal(rows[0].has_api_keys, null, 'unknown, never false and never true')

  // The credential read itself stays loud and typed.
  await assert.rejects(readAppSecrets(), (error: unknown) => {
    assert.ok(error instanceof CredentialsUnavailableError)
    assert.equal(error.message, CREDENTIALS_UNAVAILABLE)
    return true
  })
  assert.deepEqual(await fs.readFile(appSecretsPath()), ciphertext, 'a failed read preserves every ciphertext byte')
})

test('GET /jobs/all stays usable while the credential store is unreadable', async () => {
  await pm.createProject({ name: 'Jobs Channel' })
  await fs.writeFile(appSecretsPath(), JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }), { mode: 0o600 })

  const response = await request(app).get('/api/jobs/all').expect(200)
  assert.ok(Array.isArray(response.body.jobs), 'the job list answers instead of 500-ing on credentials')
})

import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { after, before, beforeEach, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { SecretsFileError } from '../services/app-secrets-store.js'
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

  const envelope = { schema_version: 3, providers: { genstudio: { apiKey: 'gsk_list_probe' } } }
  await fs.writeFile(appSecretsPath(), JSON.stringify(envelope), { mode: 0o600 })

  const [readable] = await pm.listProjects()
  assert.equal(readable.has_api_keys, true, 'a successful read reports the key it actually found')
  assert.equal(readable.name, 'Cred Distinctions')
})

test('an invalid credential store leaves the channel list usable with unknown keys, bytes untouched', async () => {
  const project = await pm.createProject({ name: 'Locked Channel' })
  const ciphertext = Buffer.from('{ invalid json')
  await fs.writeFile(appSecretsPath(), ciphertext, { mode: 0o600 })

  const rows = await pm.listProjects() // must not throw: metadata survives an unreadable store
  assert.equal(rows.length, 1)
  assert.equal(rows[0].slug, project.slug)
  assert.equal(rows[0].name, 'Locked Channel')
  assert.equal(rows[0].has_api_keys, null, 'unknown, never false and never true')

  // The credential read itself stays loud and typed.
  await assert.rejects(readAppSecrets(), (error: unknown) => {
    assert.ok(error instanceof SecretsFileError)
    assert.match(error.message, /file is invalid/i)
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

test('a malformed credential store also leaves metadata usable with unknown keys', async () => {
  await pm.createProject({ name: 'Corrupt Store Channel' })
  const bytes = Buffer.from('{ not json')
  await fs.writeFile(appSecretsPath(), bytes)

  const rows = await pm.listProjects()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].has_api_keys, null, 'a corrupt store is unknown, never false')
  assert.deepEqual(await fs.readFile(appSecretsPath()), bytes)
  await assert.rejects(readAppSecrets(), (error: unknown) => error instanceof SecretsFileError && error.stage === 'store-invalid')
})

test('an IO-unreadable credential store also leaves metadata usable with unknown keys', async () => {
  await pm.createProject({ name: 'Unreadable Store Channel' })
  await fs.writeFile(appSecretsPath(), JSON.stringify({ schema_version: 3, providers: { genstudio: { apiKey: 'gsk_synthetic' } } }), { mode: 0o600 })
  const original = (fs as any).readFile
  ;(fs as any).readFile = async (file: unknown, ...args: unknown[]) => {
    if (String(file) === appSecretsPath()) {
      const error: any = new Error('synthetic io failure')
      error.code = 'EACCES'
      throw error
    }
    return original.call(fs, file, ...args)
  }
  try {
    const rows = await pm.listProjects()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].has_api_keys, null, 'an unreadable store is unknown, never false')
  } finally {
    ;(fs as any).readFile = original
  }
})

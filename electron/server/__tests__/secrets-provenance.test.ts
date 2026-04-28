/**
 * Tests for the cross-machine provenance guard on secrets.json.
 *
 * Scenarios:
 *   - Writing stamps the file with the current machine's hash.
 *   - Reading a file with a foreign stamp treats the store as empty.
 *   - Legacy files (no stamp) are accepted and re-stamped on next write.
 *   - Provenance status endpoint reports present/foreign correctly.
 *   - `resetSecretsForCurrentMachine` rewrites the file empty + stamped.
 *
 * Runs under tsx where safeStorage is unavailable, so the on-disk shape is
 * the plaintext fallback (`{ _provenance, schema_version, providers }`).
 * That's the worst case for this feature — encrypted envelopes already get
 * rejected by decryption failure; the plaintext path is where the guard
 * does the real work.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let secrets: typeof import('../services/secrets-store.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  secrets = await import('../services/secrets-store.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

async function mkProject(name = 'Provenance Test'): Promise<string> {
  const p = await pm.createProject({ name })
  return p.slug
}

function secretsFile(slug: string): string {
  return path.join(tempDir, 'projects', slug, 'secrets.json')
}

describe('provenance stamping on write', () => {
  test('writeSecrets stamps the file with a sha256 hex provenance', async () => {
    const slug = await mkProject()
    await secrets.writeSecrets(slug, { openai_api_key: 'sk-one' })
    const raw = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))
    assert.equal(typeof raw._provenance, 'string')
    assert.match(raw._provenance, /^[0-9a-f]{64}$/)
  })

  test('the provenance stamp is the same across two writes on the same machine', async () => {
    const slug = await mkProject()
    await secrets.writeSecrets(slug, { openai_api_key: 'sk-one' })
    const first = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))._provenance
    await secrets.writeSecrets(slug, { fal_api_key: 'fal-two' })
    const second = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))._provenance
    assert.equal(first, second)
  })
})

describe('foreign-provenance reads are refused', () => {
  test('a file stamped with someone else\'s hash reads back as empty', async () => {
    const slug = await mkProject()
    // Simulate a folder copied in from another machine: valid v2 shape,
    // foreign provenance stamp.
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({
        _provenance: 'f'.repeat(64),
        schema_version: 2,
        providers: {
          openai: { accounts: [{ id: 'x', label: 'Default', apiKey: 'sk-foreign', isDefault: true }] },
        },
      }),
      { mode: 0o600 },
    )

    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.openai_api_key, undefined, 'foreign keys must not leak into the read path')
  })

  test('foreign files are NOT silently overwritten on read', async () => {
    const slug = await mkProject()
    const body = {
      _provenance: 'f'.repeat(64),
      schema_version: 2,
      providers: {
        openai: { accounts: [{ id: 'x', label: 'Default', apiKey: 'sk-foreign', isDefault: true }] },
      },
    }
    await fs.writeFile(secretsFile(slug), JSON.stringify(body), { mode: 0o600 })
    await secrets.readSecrets(slug)
    const after = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))
    assert.equal(after._provenance, 'f'.repeat(64), 'foreign file must be left alone for the user to review or reset')
    assert.equal(after.providers.openai.accounts[0].apiKey, 'sk-foreign')
  })

  test('writeSecrets against a foreign file replaces it with a fresh local-stamped file', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({
        _provenance: 'f'.repeat(64),
        schema_version: 2,
        providers: {
          openai: { accounts: [{ id: 'x', label: 'Default', apiKey: 'sk-foreign', isDefault: true }] },
        },
      }),
      { mode: 0o600 },
    )

    await secrets.writeSecrets(slug, { fal_api_key: 'fal-new' })
    const after = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))
    assert.notEqual(after._provenance, 'f'.repeat(64))
    // Foreign openai key must be gone; only the new fal entry should remain.
    assert.equal(after.providers.openai, undefined)
    assert.equal(after.providers.fal.accounts[0].apiKey, 'fal-new')
  })
})

describe('legacy files (no provenance) are accepted', () => {
  test('reading a legacy plaintext v2 file returns the data', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({
        schema_version: 2,
        providers: {
          openai: { accounts: [{ id: 'x', label: 'Default', apiKey: 'sk-legacy', isDefault: true }] },
        },
      }),
      { mode: 0o600 },
    )

    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.openai_api_key, 'sk-legacy')
  })

  test('legacy files get stamped on the next write without losing data', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({
        schema_version: 2,
        providers: {
          openai: { accounts: [{ id: 'x', label: 'Default', apiKey: 'sk-legacy', isDefault: true }] },
        },
      }),
      { mode: 0o600 },
    )
    await secrets.writeSecrets(slug, { fal_api_key: 'fal-new' })
    const after = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))
    assert.match(after._provenance, /^[0-9a-f]{64}$/)
    // Both providers survive — the legacy openai key and the new fal key.
    assert.equal(after.providers.openai.accounts[0].apiKey, 'sk-legacy')
    assert.equal(after.providers.fal.accounts[0].apiKey, 'fal-new')
  })

  test('reading a legacy v1 flat file migrates AND stamps in one step', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({ openai_api_key: 'sk-v1-legacy' }),
      { mode: 0o600 },
    )
    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.openai_api_key, 'sk-v1-legacy')

    const after = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))
    assert.match(after._provenance, /^[0-9a-f]{64}$/)
    assert.equal(after.schema_version, 2)
    assert.equal(after.providers.openai.accounts[0].apiKey, 'sk-v1-legacy')
  })
})

describe('getSecretsProvenanceStatus', () => {
  test('reports a missing file as present=false, foreign=false', async () => {
    const slug = await mkProject()
    // createProject auto-writes an empty secrets.json; delete it so we can
    // exercise the missing-file branch.
    await fs.rm(secretsFile(slug), { force: true })
    const status = await secrets.getSecretsProvenanceStatus(slug)
    assert.deepEqual(status, { present: false, foreign: false, decryptFailed: false })
  })

  test('reports a locally-written file as present=true, foreign=false', async () => {
    const slug = await mkProject()
    await secrets.writeSecrets(slug, { openai_api_key: 'sk-one' })
    const status = await secrets.getSecretsProvenanceStatus(slug)
    assert.deepEqual(status, { present: true, foreign: false, decryptFailed: false })
  })

  test('reports a legacy (unstamped) file as present=true, foreign=false', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({ schema_version: 2, providers: {} }),
      { mode: 0o600 },
    )
    const status = await secrets.getSecretsProvenanceStatus(slug)
    assert.deepEqual(status, { present: true, foreign: false, decryptFailed: false })
  })

  test('reports a foreign-stamped file as present=true, foreign=true', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({
        _provenance: 'f'.repeat(64),
        schema_version: 2,
        providers: {},
      }),
      { mode: 0o600 },
    )
    const status = await secrets.getSecretsProvenanceStatus(slug)
    assert.deepEqual(status, { present: true, foreign: true, decryptFailed: false })
  })
})

describe('resetSecretsForCurrentMachine', () => {
  test('overwrites a foreign file with an empty, locally-stamped store', async () => {
    const slug = await mkProject()
    await fs.writeFile(
      secretsFile(slug),
      JSON.stringify({
        _provenance: 'f'.repeat(64),
        schema_version: 2,
        providers: {
          openai: { accounts: [{ id: 'x', label: 'Default', apiKey: 'sk-foreign', isDefault: true }] },
        },
      }),
      { mode: 0o600 },
    )

    await secrets.resetSecretsForCurrentMachine(slug)

    const after = JSON.parse(await fs.readFile(secretsFile(slug), 'utf-8'))
    assert.notEqual(after._provenance, 'f'.repeat(64))
    assert.deepEqual(after.providers, {})
    // And a subsequent read is clean + empty.
    const legacy = await secrets.readSecrets(slug)
    assert.equal(Object.keys(legacy).length, 0)
  })
})

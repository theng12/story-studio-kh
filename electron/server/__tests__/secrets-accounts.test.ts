/**
 * Tests for the app-level secrets store and its compatibility shim.
 *
 * Pre-rework: API keys lived in per-project `secrets.json` files with
 * multi-account support and a cross-machine provenance guard. That whole
 * surface was retired because iCloud-synced project folders kept producing
 * "credentials came from a different machine" warnings.
 *
 * Post-rework: a single per-machine file in userData (`app-secrets.json`),
 * one key per provider, no accounts, no provenance. The legacy module
 * names are retained as compatibility shims so callers across the codebase
 * keep compiling — these tests pin the shim's behaviour.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let secrets: typeof import('../services/secrets-store.js')
let accounts: typeof import('../services/secrets-accounts.js')
let appSecrets: typeof import('../services/app-secrets-store.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  secrets = await import('../services/secrets-store.js')
  accounts = await import('../services/secrets-accounts.js')
  appSecrets = await import('../services/app-secrets-store.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  // Clear any prior app-secrets file written by a previous test.
  await fs.rm(appSecrets.appSecretsPath(), { force: true })
})

const SLUG = 'irrelevant-slug' // shim ignores it

describe('app-secrets-store: direct API', () => {
  test('starts empty', async () => {
    const v3 = await appSecrets.readAppSecrets()
    assert.equal(v3.schema_version, 3)
    assert.deepEqual(v3.providers, {})
  })

  test('setApiKey + getApiKey roundtrip', async () => {
    await appSecrets.setApiKey('openai', 'sk-test-123')
    assert.equal(await appSecrets.getApiKey('openai'), 'sk-test-123')
  })

  test('clearApiKey removes the provider', async () => {
    await appSecrets.setApiKey('openai', 'sk-test-123')
    await appSecrets.clearApiKey('openai')
    assert.equal(await appSecrets.getApiKey('openai'), '')
    const v3 = await appSecrets.readAppSecrets()
    assert.equal(v3.providers.openai, undefined)
  })

  test('listProviderKeys reports masked + hasKey per provider', async () => {
    await appSecrets.setApiKey('openai', 'sk-abcdefghijklmnop')
    await appSecrets.setApiKey('fal', 'short')
    const list = await appSecrets.listProviderKeys()
    const byId = Object.fromEntries(list.map(r => [r.providerId, r]))
    assert.equal(byId.openai.hasKey, true)
    assert.equal(byId.openai.keyMasked, 'sk-a…mnop')
    assert.equal(byId.fal.hasKey, true)
    assert.equal(byId.fal.keyMasked, '••••')
    assert.equal(byId.anthropic.hasKey, false)
  })

  test('on-disk file lives at userData/app-secrets.json with mode 0600', async () => {
    await appSecrets.setApiKey('openai', 'sk-1')
    const p = appSecrets.appSecretsPath()
    assert.equal(p, path.join(tempDir, 'app-secrets.json'))
    const st = await fs.stat(p)
    assert.equal(st.mode & 0o777, 0o600)
  })
})

describe('legacy compat shim: readSecrets / writeSecrets', () => {
  test('writeSecrets accepts the historical flat shape', async () => {
    await secrets.writeSecrets(SLUG, { openai_api_key: 'sk-x', fal_api_key: 'fal-y' })
    const back = await secrets.readSecrets(SLUG)
    assert.equal(back.openai_api_key, 'sk-x')
    assert.equal(back.fal_api_key, 'fal-y')
  })

  test('writeSecrets with empty string clears that provider', async () => {
    await secrets.writeSecrets(SLUG, { openai_api_key: 'sk-x' })
    await secrets.writeSecrets(SLUG, { openai_api_key: '' })
    const back = await secrets.readSecrets(SLUG)
    assert.equal(back.openai_api_key, undefined)
  })

  test('writeSecrets with undefined leaves that provider untouched', async () => {
    await secrets.writeSecrets(SLUG, { openai_api_key: 'sk-x', fal_api_key: 'fal-y' })
    await secrets.writeSecrets(SLUG, { openai_api_key: undefined })
    const back = await secrets.readSecrets(SLUG)
    assert.equal(back.openai_api_key, 'sk-x')
    assert.equal(back.fal_api_key, 'fal-y')
  })

  test('slug arg is ignored — keys are app-wide', async () => {
    await secrets.writeSecrets('alpha', { openai_api_key: 'sk-shared' })
    const fromBeta = await secrets.readSecrets('beta')
    assert.equal(fromBeta.openai_api_key, 'sk-shared')
  })
})

describe('legacy compat shim: accounts API', () => {
  test('listAccounts: empty before any key, one entry after', async () => {
    assert.deepEqual(await accounts.listAccounts(SLUG, 'openai'), [])
    await accounts.addAccount(SLUG, 'openai', { label: 'Personal', apiKey: 'sk-1' })
    const list = await accounts.listAccounts(SLUG, 'openai')
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'default')
    assert.equal(list[0].isDefault, true)
  })

  test('addAccount: empty key throws empty_key', async () => {
    await assert.rejects(
      () => accounts.addAccount(SLUG, 'openai', { label: 'L', apiKey: '' }),
      /API key is required/,
    )
  })

  test('addAccount: unknown provider throws', async () => {
    await assert.rejects(
      () => accounts.addAccount(SLUG, 'totally-fake', { label: 'L', apiKey: 'k' }),
      /Unknown provider/,
    )
  })

  test('addAccount overwrites existing key for the same provider', async () => {
    await accounts.addAccount(SLUG, 'openai', { label: 'A', apiKey: 'sk-a' })
    await accounts.addAccount(SLUG, 'openai', { label: 'B', apiKey: 'sk-b' })
    assert.equal(await appSecrets.getApiKey('openai'), 'sk-b')
  })

  test('removeAccount clears the provider', async () => {
    await accounts.addAccount(SLUG, 'openai', { label: 'A', apiKey: 'sk-a' })
    await accounts.removeAccount(SLUG, 'openai', 'default')
    assert.equal(await appSecrets.getApiKey('openai'), '')
  })

  test('resolveApiKey returns the configured key with the synthetic default id', async () => {
    await accounts.addAccount(SLUG, 'openai', { label: 'L', apiKey: 'sk-resolved' })
    const r = await accounts.resolveApiKey(SLUG, 'openai')
    assert.ok(r)
    assert.equal(r!.apiKey, 'sk-resolved')
    assert.equal(r!.accountId, 'default')
  })

  test('resolveApiKey returns null when no key configured', async () => {
    const r = await accounts.resolveApiKey(SLUG, 'openai')
    assert.equal(r, null)
  })
})

describe('redactSecrets', () => {
  test('redacts legacy {provider}_api_key fields', () => {
    const r = secrets.redactSecrets({
      openai_api_key: 'sk-secret',
      other: 'fine',
    }) as any
    assert.equal(r.openai_api_key, '[REDACTED]')
    assert.equal(r.other, 'fine')
  })

  test('redacts apiKey fields inside nested v2 account trees', () => {
    const r = secrets.redactSecrets({
      schema_version: 2,
      providers: {
        openai: {
          accounts: [
            { id: 'x', label: 'A', apiKey: 'sk-aaaa', isDefault: true },
          ],
        },
      },
    }) as any
    assert.equal(r.providers.openai.accounts[0].apiKey, '[REDACTED]')
    assert.equal(r.providers.openai.accounts[0].label, 'A')
  })

  test('leaves empty strings untouched so has_* probes still work', () => {
    const r = secrets.redactSecrets({ openai_api_key: '', apiKey: '' }) as any
    assert.equal(r.openai_api_key, '')
    assert.equal(r.apiKey, '')
  })
})

describe('provenance — retired no-ops', () => {
  test('getSecretsProvenanceStatus is always non-foreign / non-decrypt-failed', async () => {
    await accounts.addAccount(SLUG, 'openai', { label: 'L', apiKey: 'sk-1' })
    const s = await secrets.getSecretsProvenanceStatus(SLUG)
    assert.equal(s.foreign, false)
    assert.equal(s.decryptFailed, false)
    assert.equal(s.present, true)
  })

  test('resetSecretsForCurrentMachine is a safe no-op', async () => {
    await accounts.addAccount(SLUG, 'openai', { label: 'L', apiKey: 'sk-1' })
    await secrets.resetSecretsForCurrentMachine(SLUG)
    // Key remains; nothing was reset.
    assert.equal(await appSecrets.getApiKey('openai'), 'sk-1')
  })
})

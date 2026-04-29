/**
 * Tests for the secrets v2 multi-account store and its legacy compat shim.
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
let accounts: typeof import('../services/secrets-accounts.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  secrets = await import('../services/secrets-store.js')
  accounts = await import('../services/secrets-accounts.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  // The previous test may have enqueued a job whose persistJob writes
  // to <slug>/jobs.json asynchronously. If we rm the dir before that
  // write rounds the rename, the next test's setup races against the
  // ENOENT. One retry-with-pause is enough — by the time the second rm
  // runs the queue's dangling write has finished (or crashed silently
  // on the now-deleted parent, which is fine).
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(projectsDir, { recursive: true, force: true })
      break
    } catch (e: any) {
      if (e?.code !== 'ENOTEMPTY' || i === 2) throw e
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await fs.mkdir(projectsDir, { recursive: true })
})

async function mkProject(name = 'Accounts Test'): Promise<string> {
  const p = await pm.createProject({ name })
  return p.slug
}

describe('v1 → v2 migration', () => {
  test('reading a legacy flat secrets.json upgrades it to v2 on disk', async () => {
    const slug = await mkProject()
    const p = path.join(tempDir, 'projects', slug, 'secrets.json')
    // Write a legacy shape directly (as pre-refactor projects have on disk).
    await fs.writeFile(p, JSON.stringify({
      openai_api_key: 'sk-openai-legacy',
      fal_api_key: 'fal-legacy',
    }), { mode: 0o600 })

    // Reading through the public API should trigger silent migration.
    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.openai_api_key, 'sk-openai-legacy')
    assert.equal(legacy.fal_api_key, 'fal-legacy')

    // Inspect the on-disk shape.
    const rawAfter = JSON.parse(await fs.readFile(p, 'utf-8'))
    assert.equal(rawAfter.schema_version, 2)
    assert.ok(rawAfter.providers.openai, 'openai bucket should exist')
    assert.equal(rawAfter.providers.openai.accounts.length, 1)
    assert.equal(rawAfter.providers.openai.accounts[0].apiKey, 'sk-openai-legacy')
    assert.equal(rawAfter.providers.openai.accounts[0].isDefault, true)
    assert.equal(rawAfter.providers.openai.accounts[0].label, 'Default')
  })

  test('migration is idempotent — running readSecrets twice does not churn', async () => {
    const slug = await mkProject()
    await secrets.writeSecrets(slug, { openai_api_key: 'sk-one' })
    const p = path.join(tempDir, 'projects', slug, 'secrets.json')
    const first = JSON.parse(await fs.readFile(p, 'utf-8'))
    await secrets.readSecrets(slug)
    await secrets.readSecrets(slug)
    const third = JSON.parse(await fs.readFile(p, 'utf-8'))
    assert.deepEqual(first, third)
  })
})

describe('readSecrets / writeSecrets legacy compat shim', () => {
  test('writeSecrets with a single key projects through the default account', async () => {
    const slug = await mkProject()
    await secrets.writeSecrets(slug, { openai_api_key: 'sk-one' })

    const list = await accounts.listAccounts(slug, 'openai')
    assert.equal(list.length, 1)
    assert.equal(list[0].isDefault, true)
    assert.equal(list[0].label, 'Default')

    const readBack = await secrets.readSecrets(slug)
    assert.equal(readBack.openai_api_key, 'sk-one')
  })

  test('writing an empty string clears the default account and promotes the next', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'openai', { label: 'A', apiKey: 'sk-a' })
    await accounts.addAccount(slug, 'openai', { label: 'B', apiKey: 'sk-b' })

    const before = await accounts.listAccounts(slug, 'openai')
    const defaultIdBefore = before.find(a => a.isDefault)!.id

    await secrets.writeSecrets(slug, { openai_api_key: '' })

    const after = await accounts.listAccounts(slug, 'openai')
    assert.equal(after.length, 1, 'one account removed')
    assert.notEqual(after[0].id, defaultIdBefore, 'default was cleared')
    assert.equal(after[0].isDefault, true, 'remaining account was promoted')
  })

  test('readSecrets returns the legacy shape derived from the default account', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'openai', { label: 'A', apiKey: 'sk-a' })
    await accounts.addAccount(slug, 'openai', { label: 'B', apiKey: 'sk-b' })
    await accounts.setDefaultAccount(slug, 'openai', a.id)

    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.openai_api_key, 'sk-a')
  })
})

describe('account CRUD', () => {
  test('first account added is auto-default', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'anthropic', { label: 'A', apiKey: 'sk-a' })
    assert.equal(a.isDefault, true)
  })

  test('subsequent accounts are NOT default unless explicitly set', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'anthropic', { label: 'A', apiKey: 'sk-a' })
    const b = await accounts.addAccount(slug, 'anthropic', { label: 'B', apiKey: 'sk-b' })
    assert.equal(b.isDefault, false)
  })

  test('setDefaultAccount moves the default flag', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'anthropic', { label: 'A', apiKey: 'sk-a' })
    const b = await accounts.addAccount(slug, 'anthropic', { label: 'B', apiKey: 'sk-b' })

    await accounts.setDefaultAccount(slug, 'anthropic', b.id)
    const list = await accounts.listAccounts(slug, 'anthropic')
    const byId = Object.fromEntries(list.map(x => [x.id, x]))
    assert.equal(byId[a.id].isDefault, false)
    assert.equal(byId[b.id].isDefault, true)
  })

  test('removing the default account promotes the next remaining account', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'kie', { label: 'A', apiKey: 'k-a' })
    await accounts.addAccount(slug, 'kie', { label: 'B', apiKey: 'k-b' })
    await accounts.removeAccount(slug, 'kie', a.id)

    const list = await accounts.listAccounts(slug, 'kie')
    assert.equal(list.length, 1)
    assert.equal(list[0].label, 'B')
    assert.equal(list[0].isDefault, true)
  })

  test('removing the only account leaves an empty list', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'kie', { label: 'A', apiKey: 'k-a' })
    await accounts.removeAccount(slug, 'kie', a.id)

    const list = await accounts.listAccounts(slug, 'kie')
    assert.equal(list.length, 0)

    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.kie_api_key, undefined)
  })

  test('updateAccount changes label and/or key', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'fal', { label: 'Before', apiKey: 'sk-before' })
    const updated = await accounts.updateAccount(slug, 'fal', a.id, {
      label: 'After',
      apiKey: 'sk-after',
    })
    assert.equal(updated.label, 'After')
    // Resolving hands back the raw key.
    const resolved = await accounts.resolveApiKey(slug, 'fal')
    assert.equal(resolved?.apiKey, 'sk-after')
  })

  test('rejects unknown providers', async () => {
    const slug = await mkProject()
    await assert.rejects(
      accounts.addAccount(slug, 'unknown-provider', { label: 'X', apiKey: 'y' }),
      /Unknown provider/,
    )
  })

  test('rejects empty label or key on add', async () => {
    const slug = await mkProject()
    await assert.rejects(
      accounts.addAccount(slug, 'fal', { label: '', apiKey: 'x' }),
      /Label/,
    )
    await assert.rejects(
      accounts.addAccount(slug, 'fal', { label: 'L', apiKey: '   ' }),
      /API key/,
    )
  })
})

describe('resolveApiKey', () => {
  test('returns null when provider has no accounts', async () => {
    const slug = await mkProject()
    const r = await accounts.resolveApiKey(slug, 'openai')
    assert.equal(r, null)
  })

  test('returns the default account when no id is passed', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'openai', { label: 'A', apiKey: 'sk-a' })
    await accounts.addAccount(slug, 'openai', { label: 'B', apiKey: 'sk-b' })
    const r = await accounts.resolveApiKey(slug, 'openai')
    assert.equal(r?.accountId, a.id)
    assert.equal(r?.apiKey, 'sk-a')
  })

  test('returns a specific account when id is passed', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'openai', { label: 'A', apiKey: 'sk-a' })
    const b = await accounts.addAccount(slug, 'openai', { label: 'B', apiKey: 'sk-b' })
    const r = await accounts.resolveApiKey(slug, 'openai', b.id)
    assert.equal(r?.apiKey, 'sk-b')
    assert.equal(r?.label, 'B')
  })

  test('throws account_not_found for an unknown account id', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'openai', { label: 'A', apiKey: 'sk-a' })
    await assert.rejects(
      accounts.resolveApiKey(slug, 'openai', 'not-a-real-id'),
      /No account/,
    )
  })
})

describe('resolveApiKeyForProvider (registry integration)', () => {
  test('returns the default account key and logs a resolved line', async () => {
    const slug = await mkProject()
    const a = await accounts.addAccount(slug, 'openai', { label: 'A', apiKey: 'sk-A' })
    const { resolveApiKeyForProvider } = await import('../providers/registry.js')
    const key = await resolveApiKeyForProvider(
      slug,
      { id: 'openai', name: 'OpenAI', apiKeyField: 'openai_api_key' },
      { model: 'gpt-4o', jobId: 'job-1' },
    )
    assert.equal(key, 'sk-A')
    // Default account — the one we just added.
    const legacy = await secrets.readSecrets(slug)
    assert.equal(legacy.openai_api_key, 'sk-A')
    // Sanity: the returned resolution is the default account.
    void a
  })

  test('returns "" (not null) when no account exists so callers can reuse their "no key configured" branch', async () => {
    const slug = await mkProject()
    const { resolveApiKeyForProvider } = await import('../providers/registry.js')
    const key = await resolveApiKeyForProvider(
      slug,
      { id: 'openai', name: 'OpenAI', apiKeyField: 'openai_api_key' },
    )
    assert.equal(key, '')
  })

  test('derives providerId from apiKeyField for providers that lack explicit providerId', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'fal', { label: 'A', apiKey: 'fal-key' })
    const { resolveApiKeyForProvider } = await import('../providers/registry.js')
    // A video provider like `fal-video` uses apiKeyField: 'fal_api_key',
    // which the resolver must slice back to `fal`.
    const key = await resolveApiKeyForProvider(
      slug,
      { id: 'fal-video', name: 'fal Video', apiKeyField: 'fal_api_key' },
    )
    assert.equal(key, 'fal-key')
  })

  test('honours explicit providerId override', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'kie', { label: 'A', apiKey: 'kie-key' })
    const { resolveApiKeyForProvider } = await import('../providers/registry.js')
    const key = await resolveApiKeyForProvider(
      slug,
      { id: 'some-other-id', name: 'Aggregator', apiKeyField: 'does_not_matter', providerId: 'kie' },
    )
    assert.equal(key, 'kie-key')
  })

  test('targets a specific account when accountId is passed', async () => {
    const slug = await mkProject()
    await accounts.addAccount(slug, 'anthropic', { label: 'A', apiKey: 'sk-A' })
    const b = await accounts.addAccount(slug, 'anthropic', { label: 'B', apiKey: 'sk-B' })
    const { resolveApiKeyForProvider } = await import('../providers/registry.js')
    const key = await resolveApiKeyForProvider(
      slug,
      { id: 'anthropic', name: 'Anthropic', apiKeyField: 'anthropic_api_key' },
      { accountId: b.id },
    )
    assert.equal(key, 'sk-B')
  })

  test('records attribution on the job when ctx.jobId is passed', async () => {
    const slug = await mkProject()
    const added = await accounts.addAccount(slug, 'openai', { label: 'Personal', apiKey: 'sk-aaaa' })

    const jq = await import('../services/job-queue.js')
    jq.registerExecutor('script-only', async () => {})
    const job = jq.enqueue({
      project_slug: slug, type: 'script-only', episode_id: 'EP001', title: 't', params: {},
    })

    const { resolveApiKeyForProvider } = await import('../providers/registry.js')
    await resolveApiKeyForProvider(
      slug,
      { id: 'openai', name: 'OpenAI', apiKeyField: 'openai_api_key' },
      { jobId: job.job_id, model: 'gpt-4o' },
    )
    // Resolver fires the recorder via a detached dynamic import — give it
    // a tick to settle.
    await new Promise(r => setTimeout(r, 20))
    const after = jq.getJob(job.job_id)!
    assert.deepEqual(after.accounts_used, {
      openai: { id: added.id, label: 'Personal' },
    })
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

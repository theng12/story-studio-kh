import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, test } from 'node:test'

import { encryptToBase64 } from '../lib/safe-storage.js'
import { CREDENTIALS_UNAVAILABLE, CredentialsUnavailableError } from '../lib/keychain-access.js'
import { flushLogLines, getLogDir } from '../services/logger.js'
import {
  appSecretsPath,
  clearApiKey,
  contentStoreAnchorsPath,
  getApiKey,
  getApiKeySnapshot,
  readContentStoreKeyAnchor,
  recordContentStoreKeyAnchor,
  readAppSecrets,
  writeAppSecrets,
  setApiKey,
  verifyStoredCredentialsDecrypt,
} from '../services/app-secrets-store.js'
import { readYouTubeConnectionRegistry } from '../services/youtube-connection-store.js'
import { readSecretsV2, writeSecretsV2 } from '../services/secrets-store.js'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { setTestSafeStorageAvailable } from './safe-storage-test-double.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  setTestSafeStorageAvailable(true)
})

async function isolate(): Promise<string> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return temp.dir
}

function envelope(value: unknown): object {
  return { __encrypted: true, version: 1, ciphertext: encryptToBase64(JSON.stringify(value)) }
}

const anchor = {
  origin: 'https://api.genstudio.example',
  account_id: 'acct_a',
  content_account_id: 'acct_a',
  keys: [{ key_id: 'key_a', public_key_base64: Buffer.alloc(32, 4).toString('base64') }],
}

describe('app-secret mutation input classification', () => {
  test('never promotes plaintext YouTube credentials into the active store', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({
      schema_version: 3,
      providers: { genstudio: { apiKey: 'gsk_plaintext_provider', userSet: true } },
      youtube: {
        oauth_client: { application_id: 'legacy-app', client_secret: 'plaintext-client-secret' },
        channel_tokens: {
          UC_plaintext: {
            application_id: 'legacy-app',
            access_token: 'plaintext-access-token',
            refresh_token: 'plaintext-refresh-token',
            expires_at: Date.now() + 60_000,
          },
        },
      },
    }))
    await fs.writeFile(appSecretsPath(), original)

    const secrets = await readAppSecrets()
    assert.equal(secrets.providers.genstudio?.apiKey, 'gsk_plaintext_provider')
    assert.equal(secrets.youtube, undefined)
    await assert.rejects(
      setApiKey('genstudio', 'gsk_replacement_must_not_erase_plaintext_youtube'),
      /plaintext YouTube secrets/i,
    )
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  const validToken = {
    application_id: 'app-valid',
    access_token: 'access-valid',
    refresh_token: 'refresh-valid',
    expires_at: 1_800_000_000_000,
  }
  const malformedYouTubeBuckets: Array<[string, unknown]> = [
    ['null bucket', null],
    ['array bucket', []],
    ['unknown bucket field', { future_secret: 'keep-me' }],
    ['partial OAuth client', { oauth_client: { application_id: 'app-valid' } }],
    ['unknown OAuth client field', {
      oauth_client: { application_id: 'app-valid', client_secret: 'client-valid', future: 'keep-me' },
    }],
    ['array channel map', { channel_tokens: [] }],
    ['empty channel ID', { channel_tokens: { '': validToken } }],
    ['reserved channel ID', { channel_tokens: { constructor: validToken } }],
    ['partial channel token', {
      channel_tokens: { UC_valid: { ...validToken, refresh_token: undefined } },
    }],
    ['invalid channel scope', {
      channel_tokens: { UC_valid: { ...validToken, scope: 7 } },
    }],
    ['unknown channel token field', {
      channel_tokens: { UC_valid: { ...validToken, future: 'keep-me' } },
    }],
    ['partial pending registry', {
      pending_registry: { transaction_id: 'tx-valid' },
    }],
    ['array pending registry snapshot', {
      pending_registry: { transaction_id: 'tx-valid', registry: [] },
    }],
    ['unknown pending registry field', {
      pending_registry: { transaction_id: 'tx-valid', registry: {}, future: 'keep-me' },
    }],
  ]

  for (const [label, youtube] of malformedYouTubeBuckets) {
    test(`malformed encrypted YouTube state (${label}) aborts provider save byte-for-byte`, async () => {
      await isolate()
      const original = Buffer.from(JSON.stringify(envelope({
        schema_version: 3,
        providers: { genstudio: { apiKey: 'gsk_existing', userSet: true } },
        youtube,
      })))
      await fs.writeFile(appSecretsPath(), original)

      await assert.rejects(setApiKey('genstudio', 'gsk_replacement'), /payload is invalid/i)
      assert.deepEqual(await fs.readFile(appSecretsPath()), original)
    })
  }

  for (const [label, providers] of [
    ['unknown provider', { future_provider: { apiKey: 'future-key' } }],
    ['extra provider field', { genstudio: { apiKey: 'gsk_existing', future: 'keep-me' } }],
    ['invalid userSet', { genstudio: { apiKey: 'gsk_existing', userSet: 'yes' } }],
    ['invalid generation', { genstudio: { apiKey: 'gsk_existing', generation: '' } }],
  ] as Array<[string, unknown]>) {
    test(`invalid provider state (${label}) aborts mutation byte-for-byte`, async () => {
      await isolate()
      const original = Buffer.from(JSON.stringify(envelope({ schema_version: 3, providers })))
      await fs.writeFile(appSecretsPath(), original)
      await assert.rejects(setApiKey('google', 'google-replacement'), /payload is invalid/i)
      assert.deepEqual(await fs.readFile(appSecretsPath()), original)
    })
  }

  test('malformed JSON aborts a provider save without replacing the original bytes', async () => {
    await isolate()
    const original = Buffer.from('{not-json')
    await fs.writeFile(appSecretsPath(), original)

    await assert.rejects(setApiKey('genstudio', 'gsk_test_provider'), /invalid|malformed/i)
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  test('a malformed encrypted-envelope shape aborts a provider save', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1 }))
    await fs.writeFile(appSecretsPath(), original)

    await assert.rejects(setApiKey('genstudio', 'gsk_test_provider'), /envelope.*invalid|invalid.*envelope/i)
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  test('decryptable malformed JSON aborts a provider save without replacing the encrypted bytes', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: encryptToBase64('{not-json') }))
    await fs.writeFile(appSecretsPath(), original)

    await assert.rejects(setApiKey('genstudio', 'gsk_test_provider'), /invalid|malformed/i)
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  test('a non-ENOENT read failure aborts a provider save without replacing the file', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ schema_version: 3, providers: {} }))
    await fs.writeFile(appSecretsPath(), original)
    const readFile = fs.readFile.bind(fs)
    const failure = Object.assign(new Error('synthetic read failure'), { code: 'EIO' })
    ;(fs as any).readFile = async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === appSecretsPath()) throw failure
      return readFile(...args)
    }
    try {
      await assert.rejects(setApiKey('genstudio', 'gsk_test_provider'), (error: unknown) => error === failure)
    } finally {
      ;(fs as any).readFile = readFile
    }
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  test('an undecryptable envelope never reads as an empty credential store', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
    await fs.writeFile(appSecretsPath(), original)
    await assert.rejects(readAppSecrets(), (error: unknown) => {
      assert.ok(error instanceof CredentialsUnavailableError, 'a typed failure, not an empty store')
      assert.equal(error.stage, 'decrypt-failed', 'finite stage, never a native message')
      assert.equal(error.message, CREDENTIALS_UNAVAILABLE)
      assert.ok(!String(error.message).includes('not-decryptable'), 'ciphertext never reaches the message')
      return true
    })
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  test('saving or clearing cannot rename or replace an undecryptable envelope', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
    await fs.writeFile(appSecretsPath(), original)
    await assert.rejects(setApiKey('genstudio', 'gsk_replacement'), /Credentials unavailable/)
    await assert.rejects(clearApiKey('genstudio'), /Credentials unavailable/)
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
    assert.equal((await fs.readdir(path.dirname(appSecretsPath()))).some(name => name.startsWith('app-secrets.json.bak.')), false)
  })

  test('temporarily unavailable encryption preserves credentials for the next readable session', async () => {
    await isolate()
    await setApiKey('genstudio', 'gsk_original')
    const original = await fs.readFile(appSecretsPath())
    setTestSafeStorageAvailable(false)
    await assert.rejects(readAppSecrets(), /Credentials unavailable/)
    await assert.rejects(setApiKey('genstudio', 'gsk_replacement'), /Credentials unavailable/)
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
    setTestSafeStorageAvailable(true)
    assert.equal(await getApiKey('genstudio'), 'gsk_original')
  })
})

test('attended unlock verification: existing ciphertext must really decrypt before success', async () => {
  await isolate()
  // A missing store is a distinct state: nothing to prove, nothing to refuse.
  await fs.rm(appSecretsPath(), { force: true })
  verifyStoredCredentialsDecrypt()

  // A readable store verifies.
  await setApiKey('genstudio', 'gsk_verify_probe')
  verifyStoredCredentialsDecrypt()

  // Unreadable ciphertext: verification rejects with a finite stage, and the
  // bytes on disk are untouched — a failed check never becomes a success.
  const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
  await fs.writeFile(appSecretsPath(), original)
  assert.throws(() => verifyStoredCredentialsDecrypt(), (error: unknown) => {
    assert.ok(error instanceof CredentialsUnavailableError)
    assert.equal(error.stage, 'decrypt-failed')
    assert.equal(error.message, CREDENTIALS_UNAVAILABLE, 'no path, native text or ciphertext')
    return true
  })
  assert.deepEqual(await fs.readFile(appSecretsPath()), original)
})

test('loss of encryption during mutation never downgrades app credentials to plaintext', async () => {
  await isolate()
  await setApiKey('genstudio', 'gsk_original')
  const original = await fs.readFile(appSecretsPath())
  await assert.rejects(writeAppSecrets(value => {
    value.providers.genstudio = { apiKey: 'gsk_replacement' }
    setTestSafeStorageAvailable(false)
  }), /Credentials unavailable/)
  assert.deepEqual(await fs.readFile(appSecretsPath()), original)
})

test('loss of encryption during a project clear preserves the encrypted file', async () => {
  const dir = await isolate()
  const project = path.join(dir, 'projects', 'credential-clear')
  await fs.mkdir(project, { recursive: true })
  const file = path.join(project, 'secrets.json')
  const original = Buffer.from(JSON.stringify(envelope({ upload: { token: 'synthetic' } })))
  await fs.writeFile(file, original)
  await assert.rejects(writeSecretsV2('credential-clear', value => {
    Reflect.deleteProperty(value, 'upload')
    setTestSafeStorageAvailable(false)
  }), /Failed to decrypt secrets/)
  assert.deepEqual(await fs.readFile(file), original)
})

test('unreadable project OAuth credentials refuse reads and mutation without clearing the file', async () => {
  const dir = await isolate()
  const project = path.join(dir, 'projects', 'credential-guard')
  await fs.mkdir(project, { recursive: true })
  const file = path.join(project, 'secrets.json')
  const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
  await fs.writeFile(file, original)
  await assert.rejects(readSecretsV2('credential-guard'), /Failed to decrypt secrets/)
  await assert.rejects(writeSecretsV2('credential-guard', () => assert.fail('must not mutate unreadable credentials')), /Failed to decrypt secrets/)
  assert.deepEqual(await fs.readFile(file), original)
})

describe('dedicated Content Store anchor persistence', () => {
  test('does not promote an encrypted legacy anchor into the dedicated store', async () => {
    await isolate()
    await fs.writeFile(appSecretsPath(), JSON.stringify(envelope({
      schema_version: 3,
      providers: { genstudio: { apiKey: 'gsk_test_provider', userSet: true } },
      contentStoreKeyAnchors: [anchor],
    })))
    assert.equal(await readContentStoreKeyAnchor({
      origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
    }), null)
    assert.notEqual(contentStoreAnchorsPath(), appSecretsPath())
    await assert.rejects(fs.stat(contentStoreAnchorsPath()), /ENOENT/)
  })

  test('never promotes plaintext legacy anchors', async () => {
    await isolate()
    await fs.writeFile(appSecretsPath(), JSON.stringify({
      schema_version: 3, providers: {}, contentStoreKeyAnchors: [anchor],
    }))

    assert.equal(await readContentStoreKeyAnchor({
      origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
    }), null)
    await assert.rejects(fs.stat(contentStoreAnchorsPath()), /ENOENT/)
  })

  test('provider saves never rewrite the dedicated anchor envelope', async () => {
    await isolate()
    await recordContentStoreKeyAnchor(anchor)
    const before = await fs.readFile(contentStoreAnchorsPath())

    await setApiKey('genstudio', 'gsk_test_provider')
    assert.deepEqual(await fs.readFile(contentStoreAnchorsPath()), before)
    await clearApiKey('genstudio')

    assert.deepEqual(await fs.readFile(contentStoreAnchorsPath()), before)
    assert.deepEqual(await readContentStoreKeyAnchor({
      origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
    }), anchor)
  })

  test('concurrent child processes retain both a provider update and a dedicated anchor append', async t => {
    const dataDir = await isolate()
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app-secrets-worker.ts')
    const release = path.join(dataDir, 'release-workers')
    const children = ['provider', 'anchor'].map(action => {
      const ready = path.join(dataDir, `ready-${action}`)
      const child = spawn(process.execPath, ['--import', 'tsx', worker], {
        env: { ...process.env, STORY_STUDIO_DATA_DIR: dataDir, ACTION: action, READY: ready, RELEASE: release },
        stdio: 'pipe',
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      const exited = new Promise<void>((resolve, reject) => {
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`secret worker exited ${code}: ${stderr}`)))
      })
      return { child, ready, exited, readyObserved: false }
    })
    t.after(async () => {
      await fs.writeFile(release, 'release').catch(() => {})
      for (const entry of children) {
        if (!entry.readyObserved && entry.child.exitCode === null) entry.child.kill()
      }
      await Promise.allSettled(children.map(({ exited }) => exited))
    })
    await Promise.all(children.map(async entry => {
      const { ready, exited } = entry
      let earlyExit: unknown
      void exited.catch(error => { earlyExit = error })
      await waitFor(async () => {
        if (earlyExit) throw earlyExit
        return fs.stat(ready).then(() => true, () => false)
      }, { label: `secret worker ${path.basename(ready)} to become ready`, timeoutMs: 2_000, pollMs: 5 })
      entry.readyObserved = true
    }))
    await fs.writeFile(release, 'release')
    await Promise.all(children.map(({ exited }) => exited))

    assert.equal(await getApiKey('genstudio'), 'gsk_child_provider')
    assert.deepEqual(await readContentStoreKeyAnchor({
      origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
    }), anchor)
  })

  test('concurrent provider and YouTube saves preserve provider generation and anchor bytes', async t => {
    const dataDir = await isolate()
    await setApiKey('genstudio', 'gsk_before_concurrent')
    const originalGeneration = (await getApiKeySnapshot('genstudio')).generation
    await recordContentStoreKeyAnchor(anchor)
    const anchorBytes = await fs.readFile(contentStoreAnchorsPath())
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app-secrets-worker.ts')
    const release = path.join(dataDir, 'release-provider-youtube')
    const children = ['provider', 'youtube'].map(action => {
      const ready = path.join(dataDir, `ready-provider-youtube-${action}`)
      const child = spawn(process.execPath, ['--import', 'tsx', worker], {
        env: { ...process.env, STORY_STUDIO_DATA_DIR: dataDir, ACTION: action, READY: ready, RELEASE: release },
        stdio: 'pipe',
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      const exited = new Promise<void>((resolve, reject) => {
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`secret worker exited ${code}: ${stderr}`)))
      })
      return { child, ready, exited }
    })
    t.after(async () => {
      await fs.writeFile(release, 'release').catch(() => {})
      for (const entry of children) if (entry.child.exitCode === null) entry.child.kill()
      await Promise.allSettled(children.map(({ exited }) => exited))
    })
    await Promise.all(children.map(entry => waitFor(
      () => fs.stat(entry.ready).then(() => true, () => false),
      { label: `secret worker ${path.basename(entry.ready)} to become ready`, timeoutMs: 2_000, pollMs: 5 },
    )))
    await fs.writeFile(release, 'release')
    await Promise.all(children.map(({ exited }) => exited))

    const provider = await getApiKeySnapshot('genstudio')
    assert.equal(provider.apiKey, 'gsk_child_provider')
    assert.notEqual(provider.generation, originalGeneration)
    assert.ok((await readYouTubeConnectionRegistry()).application)
    assert.deepEqual(await fs.readFile(contentStoreAnchorsPath()), anchorBytes)
  })

  test('mutation provenance records only bounded nonsecret fields', async () => {
    await isolate()
    const key = 'gsk_test_provenance_never_log_me'
    await setApiKey('genstudio', key)
    await recordContentStoreKeyAnchor(anchor)
    await flushLogLines()
    const logPath = path.join(getLogDir(), `server-${new Date().toISOString().slice(0, 10)}.log`)
    const entries = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => entry.message === 'secret-store mutation')
    assert.equal(entries.length, 2)
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'anchor_key_count_after', 'anchor_key_count_before', 'app_version', 'backup_outcome', 'input_state',
        'level', 'message', 'operation', 'operation_id', 'pid', 'result', 'safe_storage_available', 'ts',
      ])
    }
    assert.equal(entries.find(entry => entry.operation === 'provider-update')?.anchor_key_count_before, 'not-read')
    assert.deepEqual(
      entries.filter(entry => entry.operation === 'anchor-update').map(entry => [entry.anchor_key_count_before, entry.anchor_key_count_after]),
      [[0, 1]],
    )
    const serialized = JSON.stringify(entries)
    assert.ok(!serialized.includes(key))
    assert.ok(!serialized.includes(anchor.origin))
    assert.ok(!serialized.includes(anchor.account_id))
    assert.ok(!serialized.includes(anchor.keys[0]!.public_key_base64))
  })

  test('a corrupt protected anchor is logged as invalid rather than missing', async () => {
    await isolate()
    await fs.writeFile(contentStoreAnchorsPath(), '{not-json')

    await assert.rejects(recordContentStoreKeyAnchor(anchor), /malformed|tampered/i)
    await flushLogLines()
    const logPath = path.join(getLogDir(), `server-${new Date().toISOString().slice(0, 10)}.log`)
    const entry = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .find(row => row.message === 'secret-store mutation' && row.operation === 'anchor-update')
    assert.equal(entry.input_state, 'invalid')
    assert.equal(entry.result, 'refused')
    assert.equal(entry.anchor_key_count_before, 'unavailable')
    assert.equal(entry.anchor_key_count_after, 'unavailable')
  })
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, test } from 'node:test'

import { encryptToBase64 } from '../lib/safe-storage.js'
import { flushLogLines, getLogDir } from '../services/logger.js'
import {
  appSecretsPath,
  clearApiKey,
  contentStoreAnchorsPath,
  getApiKey,
  readContentStoreKeyAnchor,
  recordContentStoreKeyAnchor,
  setApiKey,
} from '../services/app-secrets-store.js'
import { useTempDataDir } from './_helpers.js'
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

  test('an undecryptable envelope is never replaced when preservation fails', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
    await fs.writeFile(appSecretsPath(), original)
    const rename = fs.rename.bind(fs)
    const failure = Object.assign(new Error('synthetic backup failure'), { code: 'ENOSPC' })
    ;(fs as any).rename = async (from: string, to: string) => {
      if (from === appSecretsPath() && to.startsWith(`${appSecretsPath()}.bak.`)) throw failure
      return rename(from, to)
    }
    try {
      await assert.rejects(setApiKey('genstudio', 'gsk_test_provider'), (error: unknown) => error === failure)
    } finally {
      ;(fs as any).rename = rename
    }
    assert.deepEqual(await fs.readFile(appSecretsPath()), original)
  })

  test('a deliberate recovery save durably sidecars an undecryptable envelope before replacing it', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
    await fs.writeFile(appSecretsPath(), original)

    await setApiKey('genstudio', 'gsk_test_provider')

    assert.equal(await getApiKey('genstudio'), 'gsk_test_provider')
    const backup = (await fs.readdir(path.dirname(appSecretsPath()))).find(name => name.startsWith('app-secrets.json.bak.'))
    assert.ok(backup)
    assert.deepEqual(await fs.readFile(path.join(path.dirname(appSecretsPath()), backup)), original)
  })

  test('backup retention cannot delete the just-preserved undecryptable canonical file', async () => {
    await isolate()
    const original = Buffer.from(JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'not-decryptable' }))
    await fs.writeFile(appSecretsPath(), original)
    const old = new Date('2020-01-01T00:00:00Z')
    await fs.utimes(appSecretsPath(), old, old)
    for (let index = 0; index < 3; index += 1) {
      await fs.writeFile(`${appSecretsPath()}.bak.newer-${index}`, `newer-${index}`)
    }

    await setApiKey('genstudio', 'gsk_test_provider')

    const backups = await fs.readdir(path.dirname(appSecretsPath()))
    const preserved = backups.filter(name => name.startsWith('app-secrets.json.bak.'))
      .filter(name => !name.includes('.bak.newer-'))
    assert.equal(preserved.length, 1)
    assert.deepEqual(await fs.readFile(path.join(path.dirname(appSecretsPath()), preserved[0]!)), original)
  })
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

  test('concurrent child processes retain both a provider update and a dedicated anchor append', async () => {
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
      return { ready, exited }
    })
    await Promise.all(children.map(async ({ ready, exited }) => Promise.race([
      (async () => {
        while (true) {
          try { await fs.stat(ready); return } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
        }
      })(),
      exited.then(() => { throw new Error('secret worker exited before release') }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('secret worker did not become ready')), 2_000)),
    ])))
    await fs.writeFile(release, 'release')
    await Promise.all(children.map(({ exited }) => exited))

    assert.equal(await getApiKey('genstudio'), 'gsk_child_provider')
    assert.deepEqual(await readContentStoreKeyAnchor({
      origin: anchor.origin, account_id: anchor.account_id, content_account_id: anchor.content_account_id,
    }), anchor)
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

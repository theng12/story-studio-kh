import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { migrateLegacyKeychain } from '../services/legacy-keychain-migration.js'
import { appSecretsPath, contentStoreAnchorsPath, readAppSecrets, setApiKey, recordContentStoreKeyAnchor } from '../services/app-secrets-store.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })
async function isolate() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return temp.dir
}
const value = { schema_version: 3, providers: { genstudio: { apiKey: 'gsk_migration_fixture' } } }
const anchor = {
  origin: 'https://store.example', account_id: 'account', content_account_id: 'account',
  keys: [{ key_id: 'key', public_key_base64: Buffer.alloc(32, 2).toString('base64') }],
}
function envelope(payload: unknown) {
  return JSON.stringify({ __encrypted: true, version: 1, ciphertext: Buffer.from(JSON.stringify(payload)).toString('base64') })
}
async function marker(dir: string) {
  return JSON.parse(await fs.readFile(path.join(dir, 'app-secrets-migration.json'), 'utf8'))
}
function seam(status = 0, decrypt = (bytes: Buffer) => bytes.toString(), deletion = 0) {
  const calls: string[] = []
  return {
    calls,
    guard: {
      probe(service: string, account: string, interactive: boolean) {
        assert.equal(service, 'Story Studio KH Safe Storage')
        assert.equal(account, 'Story Studio KH Key')
        assert.equal(interactive, false)
        calls.push('probe'); return status
      },
      delete(service: string, account: string) {
        assert.equal(service, 'Story Studio KH Safe Storage')
        assert.equal(account, 'Story Studio KH Key')
        calls.push('delete'); return deletion
      },
    },
    safeStorage: { decryptString(bytes: Buffer) { calls.push('decrypt'); return decrypt(bytes) } },
  }
}

test('bare start records not-needed and empty credentials read without an error', async () => {
  const dir = await isolate()
  const native = seam()
  await migrateLegacyKeychain(native)
  assert.deepEqual(native.calls, [])
  assert.equal((await marker(dir)).keychain_migration, 'not-needed')
  assert.deepEqual(await readAppSecrets(), { schema_version: 3, providers: {} })
  await assert.rejects(fs.stat(appSecretsPath()), /ENOENT/)
  assert.equal((await fs.stat(path.join(dir, 'app-secrets-migration.json'))).mode & 0o777, 0o600)
})

test('plain store is byte-identical and never loads the native seam', async () => {
  const dir = await isolate()
  const bytes = JSON.stringify(value)
  await fs.writeFile(appSecretsPath(), bytes)
  const native = seam()
  await migrateLegacyKeychain(native)
  assert.equal(await fs.readFile(appSecretsPath(), 'utf8'), bytes)
  assert.equal((await marker(dir)).keychain_migration, 'not-needed')
  assert.deepEqual(native.calls, [])
})

test('allowed migration validates and copies all three stores, deletes once, and never runs again', async () => {
  const dir = await isolate()
  const projectFile = path.join(dir, 'projects', 'channel', 'secrets.json')
  const nested = path.join(dir, 'projects', 'channel', 'episode', 'secrets.json')
  await fs.mkdir(path.dirname(nested), { recursive: true })
  await fs.writeFile(appSecretsPath(), envelope(value))
  await fs.writeFile(contentStoreAnchorsPath(), envelope({ schema_version: 1, anchors: [anchor] }))
  await fs.writeFile(projectFile, envelope({ upload: { refresh_token: 'project-token' } }))
  const nestedBytes = envelope({ upload: { refresh_token: 'never-walk-nested' } })
  await fs.writeFile(nested, nestedBytes)
  const native = seam()
  await migrateLegacyKeychain(native)
  assert.deepEqual(await readAppSecrets(), value)
  assert.deepEqual(JSON.parse(await fs.readFile(contentStoreAnchorsPath(), 'utf8')), { schema_version: 1, anchors: [anchor] })
  assert.deepEqual(JSON.parse(await fs.readFile(projectFile, 'utf8')), { upload: { refresh_token: 'project-token' } })
  assert.equal(await fs.readFile(nested, 'utf8'), nestedBytes)
  for (const file of [appSecretsPath(), contentStoreAnchorsPath(), projectFile]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  }
  assert.deepEqual(native.calls, ['probe', 'decrypt', 'decrypt', 'decrypt', 'delete'])
  assert.equal((await marker(dir)).keychain_migration, 'migrated')
  await migrateLegacyKeychain(native)
  assert.equal(native.calls.length, 5)
})

test('prompting guard skips decrypt, preserves bytes, attempts deletion and records finite status', async () => {
  const dir = await isolate()
  const bytes = envelope(value)
  await fs.writeFile(appSecretsPath(), bytes)
  const native = seam(-25308, undefined, -25293)
  await migrateLegacyKeychain(native)
  assert.deepEqual(native.calls, ['probe', 'delete'])
  assert.equal(await fs.readFile(appSecretsPath(), 'utf8'), bytes)
  assert.equal((await marker(dir)).keychain_migration, 'skipped')
  assert.equal((await marker(dir)).delete_status, -25293)
  assert.deepEqual(await readAppSecrets(), { schema_version: 3, providers: {} })
})

for (const [label, bytes, decrypt] of [
  ['invalid envelope', JSON.stringify({ __encrypted: true, ciphertext: 42 }), (value: Buffer) => value.toString()],
  ['invalid payload', envelope({ schema_version: 3, providers: { genstudio: { apiKey: 42 } } }), (value: Buffer) => value.toString()],
  ['decrypt refusal', envelope(value), () => { throw new Error('never exposed') }],
] as const) {
  test(`${label} is skipped untouched and still deletes the item`, async () => {
    const dir = await isolate()
    await fs.writeFile(appSecretsPath(), bytes)
    const native = seam(0, decrypt)
    await migrateLegacyKeychain(native)
    assert.equal(await fs.readFile(appSecretsPath(), 'utf8'), bytes)
    assert.equal((await marker(dir)).keychain_migration, 'skipped')
    assert.equal(native.calls.at(-1), 'delete')
    assert.ok(!JSON.stringify(await marker(dir)).includes('never exposed'))
  })
}

test('unavailable modules skip without touching legacy bytes', async () => {
  const dir = await isolate()
  const bytes = envelope(value)
  await fs.writeFile(appSecretsPath(), bytes)
  await migrateLegacyKeychain({})
  assert.equal(await fs.readFile(appSecretsPath(), 'utf8'), bytes)
  assert.equal((await marker(dir)).keychain_migration, 'skipped')
})

test('explicit app and anchor writes preserve skipped legacy files alongside new plaintext', async () => {
  const dir = await isolate()
  const bytes = envelope(value)
  const anchorBytes = envelope({ schema_version: 1, anchors: [anchor] })
  await fs.writeFile(appSecretsPath(), bytes)
  await fs.writeFile(contentStoreAnchorsPath(), anchorBytes)
  await migrateLegacyKeychain(seam(-25308))
  await setApiKey('genstudio', 'gsk_new_saved_key')
  await recordContentStoreKeyAnchor(anchor)
  const files = await fs.readdir(dir)
  const savedApp = files.find(name => name.startsWith('app-secrets.json.legacy-encrypted-'))!
  const savedAnchors = files.find(name => name.startsWith('content-store-key-anchors.json.legacy-encrypted-'))!
  assert.equal(await fs.readFile(path.join(dir, savedApp), 'utf8'), bytes)
  assert.equal(await fs.readFile(path.join(dir, savedAnchors), 'utf8'), anchorBytes)
  assert.equal((await readAppSecrets()).providers.genstudio?.apiKey, 'gsk_new_saved_key')
})

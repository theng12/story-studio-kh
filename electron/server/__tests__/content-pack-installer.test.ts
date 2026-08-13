import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack, quarantineContentPackBytes } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-installer'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface ArchiveOptions {
  packId?: string
  version?: string
  minAppVersion?: string
  dependencies?: Array<{ pack_id: string; version: string }>
  signature?: Uint8Array
  styleSuffix?: string
}

async function buildArchive(options: ArchiveOptions = {}): Promise<Uint8Array> {
  const packId = options.packId ?? 'com.storystudio.installer-test'
  const version = options.version ?? '1.0.0'
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: `${packId}.style`, name: 'Installer Test',
    description: 'A strict local installer fixture.', category: 'Test', tags: ['test'],
    style_bible: `Keep the scene clear.${options.styleSuffix ?? ''}`, negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version,
    min_app_version: options.minAppVersion ?? '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    dependencies: options.dependencies,
    bundles: [],
    items: [{ id: `${packId}.style`, kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const signature = options.signature ?? sign(null, manifest, keyPair.privateKey)
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', signature, { createFolders: false })
  zip.file('content/visual-style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return getContentPackRuntimePaths()
}

function request(archiveBytes: Uint8Array) {
  return { archiveBytes, source: 'local-import' as const, expectedArchiveSha256: sha256(archiveBytes) }
}

describe('Content Pack local installer', () => {
  test('verifies an archive before atomically activating its immutable version', async () => {
    const paths = await isolated()
    const archiveBytes = await buildArchive()
    const result = await installContentPack(request(archiveBytes), { paths, policy })

    assert.deepEqual(result, {
      pack_id: 'com.storystudio.installer-test', version: '1.0.0', archive_sha256: sha256(archiveBytes),
      activated: true, retained_versions: ['1.0.0'],
    })
    const state = await readContentPackState(paths)
    const installed = state.packs[result.pack_id].versions[result.version]
    assert.equal(state.packs[result.pack_id].active_version, result.version)
    assert.equal(await fs.readFile(path.join(installed.install_path, 'content/visual-style.json'), 'utf8').then(Boolean), true)
    assert.equal(await fs.readFile(path.join(installed.install_path, 'assets/preview.png')).then(bytes => sha256(bytes)), sha256(PNG_1PX))
  })

  test('rejects expected-hash mismatches and bad signatures without materialising content', async () => {
    const paths = await isolated()
    const archiveBytes = await buildArchive({ signature: new Uint8Array(64) })
    await assert.rejects(installContentPack({ ...request(archiveBytes), expectedArchiveSha256: '0'.repeat(64) }, { paths, policy }), /SHA-256/i)
    await assert.rejects(installContentPack(request(archiveBytes), { paths, policy }), /signature/i)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
    await assert.rejects(fs.stat(paths.installedRoot), { code: 'ENOENT' })
  })

  test('enforces app compatibility and exact verified dependencies before activation', async () => {
    const paths = await isolated()
    await assert.rejects(installContentPack(request(await buildArchive({ minAppVersion: '99.0.0' })), { paths, policy }), /requires Story Studio/i)
    await assert.rejects(installContentPack(request(await buildArchive({ dependencies: [{ pack_id: 'com.storystudio.missing', version: '1.0.0' }] })), { paths, policy }), /dependency/i)
    await installContentPack(request(await buildArchive({ packId: 'com.storystudio.dependency' })), { paths, policy })
    await assert.doesNotReject(installContentPack(request(await buildArchive({ dependencies: [{ pack_id: 'com.storystudio.dependency', version: '1.0.0' }] })), { paths, policy }))
  })

  test('refuses a dependency cycle even when a malformed pre-existing state attempted to create one', async () => {
    const paths = await isolated()
    await installContentPack(request(await buildArchive({ packId: 'com.storystudio.cycle-b' })), { paths, policy })
    await installContentPack(request(await buildArchive({ packId: 'com.storystudio.cycle-a', dependencies: [{ pack_id: 'com.storystudio.cycle-b', version: '1.0.0' }] })), { paths, policy })
    await mutateContentPackState(state => {
      state.packs['com.storystudio.cycle-b'].versions['1.0.0'].manifest.dependencies = [{ pack_id: 'com.storystudio.cycle-a', version: '1.0.0' }]
    }, paths)
    await assert.rejects(installContentPack(request(await buildArchive({ packId: 'com.storystudio.unrelated' })), { paths, policy }), /cycle/i)
  })

  test('keeps version identities immutable while allowing a byte-identical re-import', async () => {
    const paths = await isolated()
    const first = await buildArchive()
    const one = await installContentPack(request(first), { paths, policy })
    const again = await installContentPack(request(first), { paths, policy })
    assert.deepEqual(again, one)
    const different = await buildArchive({ styleSuffix: ' A different immutable payload.' })
    await assert.rejects(installContentPack(request(different), { paths, policy }), /immutable|different archive/i)
  })

  test('quarantines only submitted bytes and a bounded failure code', async () => {
    const paths = await isolated()
    const bytes = Buffer.from('not an archive containing customer data')
    const quarantined = await quarantineContentPackBytes(bytes, 'invalid_archive: do not expose detail', paths)
    assert.deepEqual(await fs.readFile(quarantined), bytes)
    const sidecar = JSON.parse(await fs.readFile(`${quarantined}.json`, 'utf8'))
    assert.deepEqual(sidecar, { code: 'invalid_archive' })
  })

  test('never changes a previous active version when every transaction cut point fails', async () => {
    const paths = await isolated()
    await installContentPack(request(await buildArchive({ version: '1.0.0' })), { paths, policy })
    const next = await buildArchive({ version: '1.0.1' })
    for (const hook of ['afterStageWrite', 'beforeVersionRename', 'beforeActivationWrite'] as const) {
      await assert.rejects(installContentPack(request(next), { paths, policy, hooks: { [hook]: async () => { throw new Error(`cut power: ${hook}`) } } }), /cut power/)
      assert.equal((await readContentPackState(paths)).packs['com.storystudio.installer-test'].active_version, '1.0.0')
      const materialisedVersion = path.join(paths.installedRoot, PUBLISHER_ID, 'com.storystudio.installer-test', '1.0.1')
      if (hook === 'beforeActivationWrite') await fs.access(materialisedVersion)
      else await assert.rejects(fs.stat(materialisedVersion), { code: 'ENOENT' })
    }
    const installed = await installContentPack(request(next), { paths, policy })
    assert.equal(installed.version, '1.0.1')
    assert.equal((await readContentPackState(paths)).packs['com.storystudio.installer-test'].active_version, '1.0.1')
  })

  test('serialises concurrent identical imports through state activation without a duplicate tree', async () => {
    const paths = await isolated()
    const archiveBytes = await buildArchive()
    const results = await Promise.all(Array.from({ length: 8 }, () => installContentPack(request(archiveBytes), { paths, policy })))
    assert.ok(results.every(result => result.archive_sha256 === sha256(archiveBytes)))
    const state = await readContentPackState(paths)
    assert.deepEqual(Object.keys(state.packs['com.storystudio.installer-test'].versions), ['1.0.0'])
  })
})

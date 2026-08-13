import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import {
  pruneUnpinnedContentPackVersions,
  recoverContentPackActiveVersion,
  rollbackContentPack,
  setContentPackDiscoveryDisabled,
  uninstallContentPackVersion,
} from '../content-packs/lifecycle.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-lifecycle'
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
  dependencies?: Array<{ pack_id: string; version: string }>
  styleSuffix?: string
}

async function buildArchive(options: ArchiveOptions = {}): Promise<Uint8Array> {
  const packId = options.packId ?? 'com.storystudio.lifecycle-test'
  const version = options.version ?? '1.0.0'
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: `${packId}.style`, name: 'Lifecycle Test',
    description: 'A strict local lifecycle fixture.', category: 'Test', tags: ['test'],
    style_bible: `Keep the scene clear.${options.styleSuffix ?? ''}`, negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version,
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    dependencies: options.dependencies,
    bundles: [],
    items: [{ id: `${packId}.style`, kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
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

function options(paths: Awaited<ReturnType<typeof isolated>>) {
  return { paths, policy }
}

describe('Content Pack lifecycle', () => {
  test('keeps disabled packs available to exact installed-version resolution', async () => {
    const paths = await isolated()
    await installContentPack(request(await buildArchive()), options(paths))

    await setContentPackDiscoveryDisabled('com.storystudio.lifecycle-test', true, options(paths))

    const state = await readContentPackState(paths)
    assert.equal(state.packs['com.storystudio.lifecycle-test'].discovery_disabled, true)
    assert.ok(state.packs['com.storystudio.lifecycle-test'].versions['1.0.0'])
  })

  test('rolls back only discovery after re-verifying the selected retained version and its dependencies', async () => {
    const paths = await isolated()
    const dependencyId = 'com.storystudio.lifecycle-dependency'
    const packId = 'com.storystudio.lifecycle-test'
    await installContentPack(request(await buildArchive({ packId: dependencyId })), options(paths))
    await installContentPack(request(await buildArchive({ packId, version: '1.0.0', dependencies: [{ pack_id: dependencyId, version: '1.0.0' }] })), options(paths))
    await installContentPack(request(await buildArchive({ packId, version: '1.0.1' })), options(paths))

    await rollbackContentPack(packId, '1.0.0', options(paths))
    assert.equal((await readContentPackState(paths)).packs[packId].active_version, '1.0.0')

    const dependencyArchive = path.join((await readContentPackState(paths)).packs[dependencyId].versions['1.0.0'].install_path, 'content', 'archive.sspack')
    await fs.writeFile(dependencyArchive, 'tampered')
    await assert.rejects(rollbackContentPack(packId, '1.0.0', options(paths)), /hash|verification|immutable/i)
    assert.equal((await readContentPackState(paths)).packs[packId].active_version, '1.0.0')
  })

  test('refuses active, pinned, and depended-on immutable versions with exact project evidence', async () => {
    const paths = await isolated()
    const baseId = 'com.storystudio.lifecycle-base'
    const dependentId = 'com.storystudio.lifecycle-dependent'
    await installContentPack(request(await buildArchive({ packId: baseId, version: '1.0.0' })), options(paths))
    await installContentPack(request(await buildArchive({ packId: baseId, version: '1.0.1' })), options(paths))
    await assert.rejects(uninstallContentPackVersion(baseId, '1.0.1', async () => [], options(paths)), /active/i)
    await assert.rejects(uninstallContentPackVersion(baseId, '1.0.0', async () => ['project-one', 'project-two'], options(paths)), /project-one.*project-two/i)

    await installContentPack(request(await buildArchive({ packId: dependentId, dependencies: [{ pack_id: baseId, version: '1.0.0' }] })), options(paths))
    await assert.rejects(uninstallContentPackVersion(baseId, '1.0.0', async () => [], options(paths)), /dependent/i)
  })

  test('persists pending removal through a deletion interruption and completes only contained deletion', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.lifecycle-test'
    await installContentPack(request(await buildArchive({ version: '1.0.0' })), options(paths))
    await installContentPack(request(await buildArchive({ version: '1.0.1' })), options(paths))

    await assert.rejects(uninstallContentPackVersion(packId, '1.0.0', async () => [], {
      ...options(paths), hooks: { beforeRemovalDelete: async () => { throw new Error('cut power') } },
    }), /cut power/)
    const pending = (await readContentPackState(paths)).packs[packId].versions['1.0.0']
    assert.ok(pending.pending_removal)
    assert.ok(await fs.stat(pending.install_path))

    await uninstallContentPackVersion(packId, '1.0.0', async () => [], options(paths))
    assert.equal((await readContentPackState(paths)).packs[packId].versions['1.0.0'], undefined)
    await assert.rejects(fs.stat(pending.install_path), { code: 'ENOENT' })
  })

  test('never follows a swapped inactive install symlink while a pending removal remains durable', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.lifecycle-test'
    await installContentPack(request(await buildArchive({ version: '1.0.0' })), options(paths))
    await installContentPack(request(await buildArchive({ version: '1.0.1' })), options(paths))
    const inactive = (await readContentPackState(paths)).packs[packId].versions['1.0.0']
    const outside = path.join(path.dirname(paths.root), 'content-pack-lifecycle-outside')
    await fs.mkdir(outside)
    await fs.rename(inactive.install_path, `${inactive.install_path}.moved`)
    await fs.symlink(outside, inactive.install_path)

    await assert.rejects(uninstallContentPackVersion(packId, '1.0.0', async () => [], options(paths)), /unsafe/i)
    assert.ok((await readContentPackState(paths)).packs[packId].versions['1.0.0'].pending_removal)
    await assert.rejects(fs.stat(path.join(outside, 'content')), { code: 'ENOENT' })
  })

  test('prunes deterministically while retaining active, two previous versions, pins, and dependency roots', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.lifecycle-test'
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
      await installContentPack(request(await buildArchive({ version })), options(paths))
    }
    const dependentId = 'com.storystudio.lifecycle-dependent'
    await installContentPack(request(await buildArchive({ packId: dependentId, dependencies: [{ pack_id: packId, version: '1.0.0' }] })), options(paths))
    await installContentPack(request(await buildArchive({ packId: dependentId, version: '1.0.1' })), options(paths))

    const removed = await pruneUnpinnedContentPackVersions(packId, async (_id, version) => version === '1.0.1', options(paths))
    assert.deepEqual(removed, [])
    assert.deepEqual(Object.keys((await readContentPackState(paths)).packs[packId].versions).sort(), ['1.0.0', '1.0.1', '1.0.2', '1.0.3'])

    await uninstallContentPackVersion(dependentId, '1.0.0', async () => [], options(paths))
    const later = await pruneUnpinnedContentPackVersions(packId, async (_id, version) => version === '1.0.1', options(paths))
    assert.deepEqual(later, ['1.0.0'])
    assert.deepEqual(Object.keys((await readContentPackState(paths)).packs[packId].versions).sort(), ['1.0.1', '1.0.2', '1.0.3'])
  })

  test('locally rolls a corrupt active version back to the newest healthy retained version without network access', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.lifecycle-test'
    await installContentPack(request(await buildArchive({ version: '1.0.0' })), options(paths))
    await installContentPack(request(await buildArchive({ version: '1.0.1' })), options(paths))
    const active = (await readContentPackState(paths)).packs[packId].versions['1.0.1']
    await fs.writeFile(path.join(active.install_path, 'content', 'visual-style.json'), 'tampered')

    const result = await recoverContentPackActiveVersion(packId, options(paths))
    assert.deepEqual(result, { pack_id: packId, from: '1.0.1', to: '1.0.0' })
    assert.equal((await readContentPackState(paths)).packs[packId].active_version, '1.0.0')
  })
})

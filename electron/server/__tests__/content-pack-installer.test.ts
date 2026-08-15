import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { installContentPack, quarantineContentPackBytes, resolveContentPackAppVersion } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { resolveStoryStudioVersion } from '../lib/app-version.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-installer'
const PACKAGE_VERSION = JSON.parse(await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version
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

  test('checks the expected remote pack identity before activating downloaded bytes', async () => {
    const paths = await isolated()
    const archiveBytes = await buildArchive()
    await assert.rejects(installContentPack({
      ...request(archiveBytes),
      expectedPackId: 'com.storystudio.some-other-pack',
      expectedVersion: '1.0.0',
    }, { paths, policy }), /pack identity/i)
    await assert.rejects(installContentPack({
      ...request(archiveBytes),
      expectedPackId: 'com.storystudio.installer-test',
      expectedVersion: '2.0.0',
    }, { paths, policy }), /pack identity/i)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
  })

  test('enforces app compatibility and exact verified dependencies before activation', async () => {
    const paths = await isolated()
    await assert.rejects(installContentPack(request(await buildArchive({ minAppVersion: '99.0.0' })), { paths, policy }), /requires Story Studio/i)
    await assert.rejects(installContentPack(request(await buildArchive({ dependencies: [{ pack_id: 'com.storystudio.missing', version: '1.0.0' }] })), { paths, policy }), /dependency/i)
    await installContentPack(request(await buildArchive({ packId: 'com.storystudio.dependency' })), { paths, policy })
    await assert.doesNotReject(installContentPack(request(await buildArchive({ dependencies: [{ pack_id: 'com.storystudio.dependency', version: '1.0.0' }] })), { paths, policy }))
  })

  test('excludes a recalled retained Store version from unrelated installs but rejects an exact dependency on it', async () => {
    const paths = await isolated()
    const recalled = await buildArchive({ packId: 'com.storystudio.recalled-dependency' })
    await installContentPack(request(recalled), { paths, policy })
    const raw = JSON.parse(await fs.readFile(paths.statePath, 'utf8'))
    const retained = raw.packs['com.storystudio.recalled-dependency'].versions['1.0.0']
    retained.source = 'genstudio-store'
    retained.delivery_attestation = {
      account_id: 'acct_test', product_id: 'product_test', entitlement_family: 'family_test', release_id: 'release_test',
      pack_id: 'com.storystudio.recalled-dependency', version: '1.0.0', archive_sha256: retained.archive_sha256,
      archive_bytes: recalled.byteLength, genstudio_origin: 'https://genstudio.example', subject: 'receipt-root', closure_members: [],
      key_id: 'key_test', receipt_canonical_json: '{}', receipt_signature: 'signature',
    }
    retained.recalled = { observed_at: new Date().toISOString(), account_id: 'acct_test', genstudio_origin: 'https://genstudio.example' }
    delete raw.packs['com.storystudio.recalled-dependency'].active_version
    await fs.writeFile(paths.statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 })
    await assert.doesNotReject(installContentPack(request(await buildArchive({ packId: 'com.storystudio.unrelated' })), { paths, policy }))
    await assert.rejects(installContentPack(request(await buildArchive({
      packId: 'com.storystudio.depends-on-recalled', dependencies: [{ pack_id: 'com.storystudio.recalled-dependency', version: '1.0.0' }],
    })), { paths, policy }), /dependency/i)
  })

  test('does not trust a forged state manifest when re-verifying the installed dependency graph', async () => {
    const paths = await isolated()
    const cycleB = await buildArchive({ packId: 'com.storystudio.cycle-b' })
    await installContentPack(request(cycleB), { paths, policy })
    await installContentPack(request(await buildArchive({ packId: 'com.storystudio.cycle-a', dependencies: [{ pack_id: 'com.storystudio.cycle-b', version: '1.0.0' }] })), { paths, policy })
    await mutateContentPackState(state => {
      state.packs['com.storystudio.cycle-b'].versions['1.0.0'].manifest.dependencies = [{ pack_id: 'com.storystudio.cycle-a', version: '1.0.0' }]
      state.packs['com.storystudio.cycle-b'].versions['1.0.0'].manifest.lifecycle = 'retired'
    }, paths)
    await assert.doesNotReject(installContentPack(request(cycleB), { paths, policy }))
    const repaired = (await readContentPackState(paths)).packs['com.storystudio.cycle-b'].versions['1.0.0'].manifest
    assert.equal(repaired.lifecycle, 'active')
    assert.deepEqual(repaired.dependencies, undefined)
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

  test('re-verifies the retained archive and rejects state or on-disk archive tampering on re-import', async () => {
    const paths = await isolated()
    const archive = await buildArchive()
    await installContentPack(request(archive), { paths, policy })
    await mutateContentPackState(state => {
      state.packs['com.storystudio.installer-test'].versions['1.0.0'].manifest.lifecycle = 'retired'
    }, paths)
    await assert.doesNotReject(installContentPack(request(archive), { paths, policy }))
    const state = await readContentPackState(paths)
    const archivePath = path.join(state.packs['com.storystudio.installer-test'].versions['1.0.0'].install_path, 'content', 'archive.sspack')
    await fs.writeFile(archivePath, Buffer.from('tampered archive'))
    await assert.rejects(installContentPack(request(archive), { paths, policy }), /archive hash|verification/i)
  })

  test('rejects an over-limit input before hash, staging, or quarantine writes', async () => {
    const paths = await isolated()
    const tooLarge = new Uint8Array(50 * 1024 * 1024 + 1)
    await assert.rejects(installContentPack({ archiveBytes: tooLarge, source: 'local-import' }, { paths, policy }), /exceeds/i)
    await assert.rejects(fs.stat(paths.root), { code: 'ENOENT' })
    await assert.rejects(quarantineContentPackBytes(tooLarge, 'invalid_archive', paths), /will not be retained/i)
  })

  test('resolves the app version from the package in development and Electron metadata when packaged', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../content-packs')
    assert.equal(await resolveContentPackAppVersion({ packaged: false, sourceContentPackRoot: sourceRoot }), PACKAGE_VERSION)
    assert.equal(await resolveContentPackAppVersion({ packaged: true, electronVersion: '8.2.1' }), '8.2.1')
    await assert.rejects(resolveContentPackAppVersion({ packaged: true }), /packaged app version/i)
  })

  test('compares exact-semver components without IEEE-754 rounding at large values', async () => {
    const paths = await isolated()
    const archive = await buildArchive({ minAppVersion: '9007199254740993.0.0' })
    await assert.rejects(
      installContentPack(request(archive), { paths, policy, appVersion: '9007199254740992.999999999999999999.999999999999999999' }),
      /requires Story Studio/i,
    )
    const later = await buildArchive({ version: '9007199254740993.0.0' })
    const earlier = await buildArchive({ version: '9007199254740992.0.0' })
    await installContentPack(request(later), { paths, policy })
    await installContentPack(request(earlier), { paths, policy })
    assert.deepEqual((await readContentPackState(paths)).packs['com.storystudio.installer-test'].active_version, '9007199254740992.0.0')
    assert.deepEqual((await installContentPack(request(earlier), { paths, policy })).retained_versions, ['9007199254740992.0.0', '9007199254740993.0.0'])
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

  test('adopts only a byte-identical orphan and never activates a different same-version candidate', async () => {
    const paths = await isolated()
    const first = await buildArchive()
    await assert.rejects(installContentPack(request(first), {
      paths, policy, hooks: { beforeActivationWrite: async () => { throw new Error('power cut after rename') } },
    }), /power cut/)
    const different = await buildArchive({ styleSuffix: ' A conflicting orphan candidate.' })
    await assert.rejects(installContentPack(request(different), { paths, policy }), /archive hash|orphan conflicts/i)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
    await assert.doesNotReject(installContentPack(request(first), { paths, policy }))
  })

  test('does not activate when mandatory directory durability fails, then permits the next clean install', async () => {
    const paths = await isolated()
    const archive = await buildArchive()
    await assert.rejects(installContentPack(request(archive), {
      paths, policy,
      hooks: { beforeRequiredFsync: async () => { throw new Error('fsync failed') } },
    }), /fsync failed/)
    assert.deepEqual(await readContentPackState(paths), { schema_version: 1, packs: {} })
    let synced: readonly string[] = []
    await assert.doesNotReject(installContentPack(request(archive), {
      paths, policy,
      hooks: { afterRequiredFsync: async directories => { synced = directories } },
    }))
    assert.ok(synced.some(directory => directory.endsWith(`${path.sep}version${path.sep}content`)))
    assert.ok(synced.some(directory => directory.endsWith(`${path.sep}version${path.sep}assets`)))
    assert.ok(synced.some(directory => directory.endsWith(`${path.sep}version`)))
  })

  test('fails closed when a noncooperating process replaces the install root with a symlink before rename', async () => {
    const paths = await isolated()
    const outside = path.join(path.dirname(paths.root), 'content-pack-installer-outside')
    await fs.mkdir(outside)
    await assert.rejects(installContentPack(request(await buildArchive()), {
      paths, policy,
      hooks: {
        beforeVersionRename: async () => {
          await fs.mkdir(paths.installedRoot, { recursive: true })
          await fs.rename(paths.installedRoot, `${paths.installedRoot}.moved`)
          await fs.symlink(outside, paths.installedRoot)
        },
      },
    }), /unsafe/i)
    await assert.rejects(fs.stat(path.join(outside, PUBLISHER_ID)), { code: 'ENOENT' })
  })

  test('does not create a state lock outside userData when the runtime root is already a symlink', async () => {
    const paths = await isolated()
    const outside = path.join(path.dirname(paths.root), 'content-pack-lock-outside')
    await fs.mkdir(outside)
    const events: string[] = []
    const watcher = watch(outside, (_event, filename) => { events.push(filename?.toString() ?? '') })
    try {
      await fs.symlink(outside, paths.root)
      await assert.rejects(installContentPack(request(await buildArchive()), { paths, policy }), /runtime root is unsafe/i)
      await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(events.some(event => /state\.json\.lock|\.recovery/.test(event)), false)
      await assert.rejects(fs.stat(path.join(outside, 'state.json.lock')), { code: 'ENOENT' })
    } finally {
      watcher.close()
    }
  })

  test('serialises concurrent identical imports through state activation without a duplicate tree', async () => {
    const paths = await isolated()
    const archiveBytes = await buildArchive()
    const results = await Promise.all(Array.from({ length: 8 }, () => installContentPack(request(archiveBytes), { paths, policy })))
    assert.ok(results.every(result => result.archive_sha256 === sha256(archiveBytes)))
    const state = await readContentPackState(paths)
    assert.deepEqual(Object.keys(state.packs['com.storystudio.installer-test'].versions), ['1.0.0'])
  })

  test('resolves the app version from the compiled Electron module layout without requiring a prebuilt dist', async () => {
    const paths = await isolated()
    const simulatedProjectRoot = path.dirname(paths.root)
    const simulatedCompiledModuleDir = path.join(simulatedProjectRoot, 'electron', 'dist', 'server', 'lib')
    await fs.writeFile(path.join(simulatedProjectRoot, 'package.json'), JSON.stringify({
      name: 'story-studio-kh',
      version: '9.8.7',
    }))
    assert.equal(await resolveStoryStudioVersion({
      packaged: false,
      moduleDirectory: simulatedCompiledModuleDir,
    }), '9.8.7')
  })
})

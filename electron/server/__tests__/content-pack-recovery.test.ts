import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring, getFirstPartyContentPackVerificationPolicy } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths, resolveContentPackRecoveryRoot } from '../content-packs/runtime-paths.js'
import { listVerifiedRecoveryPacks, verifyContentPackRuntimeAtBoot } from '../content-packs/recovery.js'
import { readContentPackState } from '../content-packs/state.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.key.recovery-test'
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

async function buildArchive(version: string): Promise<Uint8Array> {
  const packId = 'com.storystudio.recovery-test'
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: `${packId}.style`, name: 'Recovery Test',
    description: 'A local recovery test style.', category: 'Test', tags: ['test'],
    style_bible: `Keep recovery at ${version}.`, negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version,
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, bundles: [],
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
  const recoveryRoot = path.join(temp.dir, 'bundled-recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  return { paths: getContentPackRuntimePaths(), recoveryRoot }
}

function request(archiveBytes: Uint8Array) {
  return { archiveBytes, source: 'local-import' as const, expectedArchiveSha256: sha256(archiveBytes) }
}

describe('Content Pack recovery catalog', () => {
  test('resolves recovery resources beneath the immutable recovery directory in development and packaged apps', () => {
    const sourceRoot = '/source/electron/server/content-packs'
    assert.equal(resolveContentPackRecoveryRoot({ packaged: false, sourceContentPackRoot: sourceRoot, resourcesPath: '/Resources' }), '/source/electron/server/content-packs/recovery')
    assert.equal(resolveContentPackRecoveryRoot({ packaged: true, sourceContentPackRoot: sourceRoot, resourcesPath: '/Resources' }), '/Resources/content-packs/recovery')
  })

  test('does not inspect the unpackaged source tree when resolving packaged resources', () => {
    const options = {
      packaged: true,
      resourcesPath: '/Applications/Story Studio KH.app/Contents/Resources',
      get sourceContentPackRoot(): string {
        throw new Error('packaged apps must not inspect the source tree')
      },
    }
    assert.equal(
      resolveContentPackRecoveryRoot(options),
      '/Applications/Story Studio KH.app/Contents/Resources/content-packs/recovery',
    )
  })

  test('loads the source trust resource and verifies its bundled first-party archive', async () => {
    const packs = await listVerifiedRecoveryPacks({ policy: await getFirstPartyContentPackVerificationPolicy() })
    assert.deepEqual(packs.map(pack => `${pack.manifest.pack_id}@${pack.manifest.version}`), ['com.storystudio.pack.free-recovery-test@1.0.0'])
  })

  test('keeps a signed bundled pack available after any downloaded cache is absent', async () => {
    const { paths, recoveryRoot } = await isolated()
    await fs.writeFile(path.join(recoveryRoot, 'free.sspack'), await buildArchive('1.0.0'))
    await fs.rm(path.join(paths.root, 'downloaded-cache'), { recursive: true, force: true })

    const packs = await listVerifiedRecoveryPacks({ recoveryRoot, policy })
    assert.deepEqual(packs.map(pack => `${pack.manifest.pack_id}@${pack.manifest.version}`), ['com.storystudio.recovery-test@1.0.0'])
  })

  test('reports and ignores a corrupt bundled archive without preventing valid recovery discovery', async () => {
    const { recoveryRoot } = await isolated()
    await fs.writeFile(path.join(recoveryRoot, 'a-good.sspack'), await buildArchive('1.0.0'))
    await fs.writeFile(path.join(recoveryRoot, 'z-corrupt.sspack'), 'not a pack')
    const errors: string[] = []

    const summary = await verifyContentPackRuntimeAtBoot({
      recoveryRoot,
      policy,
      report: message => errors.push(message),
    })

    assert.equal(summary.recovery_verified, 1)
    assert.equal(summary.quarantined, 1)
    assert.match(errors.join('\n'), /z-corrupt\.sspack/i)
    assert.doesNotMatch(errors.join('\n'), /not a pack/i)
  })

  test('lists healthy recovery packs when a sibling bundled archive is corrupt', async () => {
    const { recoveryRoot } = await isolated()
    await fs.writeFile(path.join(recoveryRoot, 'a-good.sspack'), await buildArchive('1.0.0'))
    await fs.writeFile(path.join(recoveryRoot, 'z-corrupt.sspack'), 'not a pack')
    const errors: string[] = []

    const packs = await listVerifiedRecoveryPacks({ recoveryRoot, policy, report: message => errors.push(message) })

    assert.deepEqual(packs.map(pack => `${pack.manifest.pack_id}@${pack.manifest.version}`), ['com.storystudio.recovery-test@1.0.0'])
    assert.match(errors.join('\n'), /z-corrupt\.sspack/i)
  })

  test('rolls a damaged active version back to the newest healthy retained version without network work', async () => {
    const { paths, recoveryRoot } = await isolated()
    const first = await buildArchive('1.0.0')
    const second = await buildArchive('1.0.1')
    await installContentPack(request(first), { paths, policy })
    await installContentPack(request(second), { paths, policy })
    const state = await readContentPackState(paths)
    const active = state.packs['com.storystudio.recovery-test'].versions['1.0.1']
    await fs.writeFile(path.join(active.install_path, 'content', 'archive.sspack'), 'tampered')

    const summary = await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy })

    assert.deepEqual(summary.rolled_back, [{ pack_id: 'com.storystudio.recovery-test', from: '1.0.1', to: '1.0.0' }])
    assert.equal((await readContentPackState(paths)).packs['com.storystudio.recovery-test'].active_version, '1.0.0')
  })

  test('removes only stale UUID staging directories during local boot verification', async () => {
    const { paths, recoveryRoot } = await isolated()
    const oldUuid = '77fd6991-0acb-443d-ad26-45ed043d2b58'
    const recentUuid = '8d5fa297-20e6-4f7b-a4bc-16dd09c09c3c'
    const oldNamed = 'not-a-transaction'
    for (const name of [oldUuid, recentUuid, oldNamed]) await fs.mkdir(path.join(paths.stagingRoot, name), { recursive: true })
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(path.join(paths.stagingRoot, oldUuid), old, old)
    await fs.utimes(path.join(paths.stagingRoot, oldNamed), old, old)

    await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy })

    await assert.rejects(fs.stat(path.join(paths.stagingRoot, oldUuid)), { code: 'ENOENT' })
    await fs.stat(path.join(paths.stagingRoot, recentUuid))
    await fs.stat(path.join(paths.stagingRoot, oldNamed))
  })

  test('refuses an unsafe staging-root symlink instead of following it during cleanup', async () => {
    const { paths, recoveryRoot } = await isolated()
    const outside = path.join(path.dirname(paths.root), 'outside-staging')
    const transaction = '77fd6991-0acb-443d-ad26-45ed043d2b58'
    await fs.mkdir(path.join(outside, transaction), { recursive: true })
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(path.join(outside, transaction), old, old)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.symlink(outside, paths.stagingRoot)

    await assert.rejects(verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy }), /staging.*unsafe/i)
    await fs.stat(path.join(outside, transaction))
  })

  test('does not trust an installed version through a swapped ancestor symlink', async () => {
    const { paths, recoveryRoot } = await isolated()
    await installContentPack(request(await buildArchive('1.0.0')), { paths, policy })
    await fs.rename(paths.installedRoot, `${paths.installedRoot}.moved`)
    await fs.symlink(`${paths.installedRoot}.moved`, paths.installedRoot)

    const summary = await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy, report: () => {} })

    assert.equal(summary.installed_verified, 0)
    assert.equal(summary.quarantined, 1)
    assert.equal((await readContentPackState(paths)).packs['com.storystudio.recovery-test'].active_version, undefined)
  })

  test('makes a corrupt active version undiscoverable when no retained rollback exists', async () => {
    const { paths, recoveryRoot } = await isolated()
    await installContentPack(request(await buildArchive('1.0.0')), { paths, policy })
    const active = (await readContentPackState(paths)).packs['com.storystudio.recovery-test'].versions['1.0.0']
    await fs.writeFile(path.join(active.install_path, 'content', 'archive.sspack'), 'tampered')

    await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy, report: () => {} })

    const state = await readContentPackState(paths)
    assert.equal(state.packs['com.storystudio.recovery-test'].active_version, undefined)
    await fs.stat(active.install_path)
  })

  test('contains no remote, secret-store, or renderer dependency', async () => {
    const source = await fs.readFile(new URL('../content-packs/recovery.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
    assert.deepEqual(imports, [
      'node:fs/promises',
      'node:path',
      './archive.js',
      './installer.js',
      './keyring.js',
      './runtime-paths.js',
      './runtime-types.js',
      './state.js',
    ])
  })
})

/**
 * v1.4.44 — an installed pack with no active version is inert, and silent.
 *
 * MEASURED on the owner's Mac, 2026-08-23. All 55 Content Store packs he
 * installed on 2026-08-16 had no `active_version` in state.json. That single
 * absent field meant:
 *
 *   • every catalog lookup skipped them, so a week's worth of owned formulas,
 *     styles and thumbnail templates did nothing at all
 *   • the Content Store reported packs verified on disk as "not installed",
 *     so the nine packs with a newer release published that day offered no
 *     update — the store simply said everything was owned and current
 *
 * Nothing repaired it, because the boot recovery pass began by skipping
 * exactly this case (`if (!pack.active_version) continue`).
 */
describe('an installed pack with no active version is adopted at boot', () => {
  test('the newest verified version becomes active, and is reported', async () => {
    const { paths, recoveryRoot } = await isolated()
    for (const version of ['1.0.0', '1.0.1']) {
      await installContentPack(request(await buildArchive(version)), { paths, policy })
    }
    // Reproduce the owner's state exactly: versions retained, none active.
    const before = await readContentPackState(paths)
    delete before.packs['com.storystudio.recovery-test'].active_version
    await fs.writeFile(paths.statePath, JSON.stringify(before), 'utf8')

    const reports: string[] = []
    const summary = await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy, report: m => reports.push(m) })

    assert.deepEqual(summary.adopted, [{ pack_id: 'com.storystudio.recovery-test', version: '1.0.1' }],
      'the newest retained version that verifies is the one adopted')
    const after = await readContentPackState(paths)
    assert.equal(after.packs['com.storystudio.recovery-test'].active_version, '1.0.1')
    assert.ok(reports.includes('active version adopted: com.storystudio.recovery-test@1.0.1'))
  })

  test('a pack that already has an active version is left exactly as it is', async () => {
    const { paths, recoveryRoot } = await isolated()
    for (const version of ['1.0.0', '1.0.1']) {
      await installContentPack(request(await buildArchive(version)), { paths, policy })
    }
    const pinned = await readContentPackState(paths)
    pinned.packs['com.storystudio.recovery-test'].active_version = '1.0.0'
    await fs.writeFile(paths.statePath, JSON.stringify(pinned), 'utf8')

    const summary = await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy })

    assert.deepEqual(summary.adopted, [], 'adoption must never override a deliberate choice of version')
    assert.equal((await readContentPackState(paths)).packs['com.storystudio.recovery-test'].active_version, '1.0.0')
  })

  test('a version withdrawn from use is never adopted, however new it is', async () => {
    // The reason the active version is cleared on recall or on a pending
    // removal is that those bytes must stop being usable. Adoption must not
    // quietly undo that on the next boot — it skips both and falls back.
    const { paths, recoveryRoot } = await isolated()
    for (const version of ['1.0.0', '1.0.1']) {
      await installContentPack(request(await buildArchive(version)), { paths, policy })
    }
    const state = await readContentPackState(paths)
    const pack = state.packs['com.storystudio.recovery-test']
    delete pack.active_version
    pack.versions['1.0.1'].pending_removal = {
      operation_id: '11111111-2222-4333-8444-555555555555',
      started_at: new Date().toISOString(),
    }
    await fs.writeFile(paths.statePath, JSON.stringify(state), 'utf8')

    const summary = await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy })

    assert.deepEqual(summary.adopted, [{ pack_id: 'com.storystudio.recovery-test', version: '1.0.0' }],
      'it falls back to the older usable version rather than taking the withdrawn one')
    assert.equal((await readContentPackState(paths)).packs['com.storystudio.recovery-test'].active_version, '1.0.0')
  })

  test('when no retained version verifies, the pack stays inactive rather than being forced live', async () => {
    const { paths, recoveryRoot } = await isolated()
    await installContentPack(request(await buildArchive('1.0.0')), { paths, policy })
    const state = await readContentPackState(paths)
    const pack = state.packs['com.storystudio.recovery-test']
    delete pack.active_version
    pack.versions['1.0.0'].archive_sha256 = 'f'.repeat(64) // no longer matches the bytes on disk
    await fs.writeFile(paths.statePath, JSON.stringify(state), 'utf8')

    const summary = await verifyContentPackRuntimeAtBoot({ paths, recoveryRoot, policy })

    assert.deepEqual(summary.adopted, [])
    assert.equal((await readContentPackState(paths)).packs['com.storystudio.recovery-test'].active_version, undefined)
  })
})

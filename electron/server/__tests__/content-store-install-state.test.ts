import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { forgetVerifiedContentPackVersions, installContentPack, verifyInstalledContentPackVersion } from '../content-packs/installer.js'
import { uninstallContentPackVersion } from '../content-packs/lifecycle.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { listCatalogEntries } from '../content-packs/registry.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import { ContentStoreRevalidationRequiredError, recordVerifiedContentRestore, resolveVerifiedContentStoreSigningKey } from '../content-store/commerce-state.js'
import { contentStoreAnchorsPath } from '../services/app-secrets-store.js'
import { canonicalizeContentStoreObject } from '../lib/genstudio-content-store.js'
import { resolveContentStoreInstallSnapshot } from '../services/content-store-install-state.js'
import { useTempDataDir } from './_helpers.js'

type Dependency = { pack_id: string; version: string }
type ClosurePin = Dependency & { product_id: string; entitlement_family: string; release_id: string; archive_sha256: string }

const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.test-store-state'
const pair = generateKeyPairSync('ed25519')
const commercePair = generateKeyPairSync('ed25519')
const commercePublicKey = commercePair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
const policy = createContentPackKeyring([{ keyId, publisherId, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }])
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => { await cleanup?.(); cleanup = undefined })

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const entry = (packId: string, version: string) => `${packId}@${version}`
const signer = async () => commercePublicKey

async function archive(packId: string, version: string, dependencies: Dependency[] = []): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify({ kind: 'visual-style', schema_version: 1, id: `${packId}.style`, name: 'Matrix Test', description: 'test', category: 'Test', tags: ['test'], style_bible: 'test', negative_prompt: 'test', preview_assets: ['assets/preview.png'], compatible_formula_ids: [] }))
  const manifest = Buffer.from(JSON.stringify({ pack_format: 1, pack_id: packId, publisher_id: publisherId, version, min_app_version: '1.0.0', lifecycle: 'active', delivery_profile: 'genstudio-store-receipt-v1', entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, dependencies, bundles: [], items: [{ id: `${packId}.style`, kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }], files: [{ path: 'content/visual-style.json', sha256: sha(content), bytes: content.byteLength, mime: 'application/json' }, { path: 'assets/preview.png', sha256: sha(png), bytes: png.byteLength, mime: 'image/png' }] }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false }); zip.file('content/visual-style.json', content, { createFolders: false }); zip.file('assets/preview.png', png, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function evidence(
  packId: string,
  version: string,
  archiveSha: string,
  archiveBytes: number,
  closure: ClosurePin[],
  accountId = 'acct_test',
  signingKeyId = 'test-key',
  signingPair = commercePair,
) {
  const productId = `product.${packId}`; const family = `${packId}.family`; const releaseId = `release.${packId}.${version}`
  const receipt = { typ: 'genstudio.content.receipt.v1', key_id: signingKeyId, receipt_id: `receipt.${packId}.${version}`, purchase_id: `purchase.${packId}.${version}`, account_id: accountId, entitlement_families: [family, ...closure.map(pin => pin.entitlement_family)], product: { product_id: productId, entitlement_family: family, kind: 'visual_style' }, release: { release_id: releaseId, pack_id: packId, version, archive_sha256: archiveSha, archive_bytes: archiveBytes, min_story_version: '1.0.0', changelog: null, component_summary: {} }, bundle_closure: closure.map(({ pack_id: _packId, ...pin }, position) => ({ position, ...pin })), credits_charged: 0, issued_at: '2026-08-15T00:00:00Z' }
  const canonical = canonicalizeContentStoreObject(receipt).canonicalJson
  return { account_id: accountId, product_id: productId, entitlement_family: family, release_id: releaseId, pack_id: packId, version, archive_sha256: archiveSha, archive_bytes: archiveBytes, genstudio_origin: 'https://genstudio.example', subject: 'receipt-root' as const, closure_members: closure.map((dependency, position) => ({ position, ...dependency })), key_id: signingKeyId, receipt_canonical_json: canonical, receipt_signature: sign(null, Buffer.from(canonical), signingPair.privateKey).toString('base64') }
}

async function isolated() { const temp = await useTempDataDir(); cleanup = temp.cleanup; return getContentPackRuntimePaths() }
async function storeInstall(paths: Awaited<ReturnType<typeof isolated>>, packId: string, version: string, dependencies: Dependency[] = [], closure: ClosurePin[] = []) {
  const bytes = await archive(packId, version, dependencies)
  return installContentPack({ archiveBytes: bytes, source: 'genstudio-store', expectedArchiveSha256: sha(bytes), expectedPackId: packId, expectedVersion: version, deliveryAttestation: evidence(packId, version, sha(bytes), bytes.byteLength, closure) }, { paths, policy, resolveGenStudioSigningKey: signer })
}
function pin(packId: string, version: string, archiveSha256: string): ClosurePin { return { pack_id: packId, version, product_id: `product.${packId}`, entitlement_family: `${packId}.family`, release_id: `release.${packId}.${version}`, archive_sha256: archiveSha256 } }
function release(packId: string, version: string, archiveSha256: string, archiveAvailable = true) { return { releaseId: `release.${packId}.${version}`, packId, version, archiveSha256, archiveBytes: 1, archiveAvailable, minStoryVersion: '1.0.0', changelog: null, componentSummary: {} } as any }
function options(paths: Awaited<ReturnType<typeof isolated>>) { return { paths, policy, resolveSigningKey: signer } }

function publicKeyBase64(pair: typeof commercePair): string {
  return pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
}

async function recordRestore(accountId: string, keyId: string, pair: typeof commercePair) {
  const receipt = {
    typ: 'genstudio.content.restore.v1', key_id: keyId, account_id: accountId,
    content_account_id: accountId, entitlement_families: [],
  }
  const receiptCanonicalJson = canonicalizeContentStoreObject(receipt).canonicalJson
  return recordVerifiedContentRestore({
    account_id: accountId, content_account_id: accountId, genstudio_origin: 'https://genstudio.example',
    key_id: keyId, public_key_base64: publicKeyBase64(pair), receipt_canonical_json: receiptCanonicalJson,
    receipt_signature: sign(null, Buffer.from(receiptCanonicalJson), pair.privateKey).toString('base64'),
    verified_at: new Date().toISOString(),
    key_history: [{ key_id: keyId, public_key_base64: publicKeyBase64(pair) }],
  })
}

describe('Content Store installed-library lifecycle matrix', () => {
  test('keeps account A Store installs and exact pins verifiable after account B restores', async () => {
    const paths = await isolated()
    const accountA = 'acct_a'
    const accountB = 'acct_b'
    const keyA = 'content-key-a'
    const keyB = 'content-key-b'
    const pairB = generateKeyPairSync('ed25519')
    const packId = 'com.storystudio.matrix.account-a'
    const bytes = await archive(packId, '1.0.0')
    const archiveSha256 = sha(bytes)

    await recordRestore(accountA, keyA, commercePair)
    await installContentPack({
      archiveBytes: bytes,
      source: 'genstudio-store',
      expectedArchiveSha256: archiveSha256,
      expectedPackId: packId,
      expectedVersion: '1.0.0',
      deliveryAttestation: evidence(packId, '1.0.0', archiveSha256, bytes.byteLength, [], accountA, keyA),
    }, { paths, policy })

    await recordRestore(accountB, keyB, pairB)

    assert.equal(await resolveVerifiedContentStoreSigningKey({
      accountId: accountA, origin: 'https://genstudio.example', keyId: keyA,
    }), commercePublicKey)
    assert.equal(await resolveVerifiedContentStoreSigningKey({
      accountId: accountB, origin: 'https://genstudio.example', keyId: keyB,
    }), publicKeyBase64(pairB))
    await assert.rejects(resolveVerifiedContentStoreSigningKey({
      accountId: accountB, origin: 'https://genstudio.example', keyId: keyA,
    }), /requested receipt key/i)

    const restartedCommerceState = await import(`${new URL('../content-store/commerce-state.ts', import.meta.url).href}?restart=${randomUUID()}`)
    assert.equal(await restartedCommerceState.resolveVerifiedContentStoreSigningKey({
      accountId: accountA, origin: 'https://genstudio.example', keyId: keyA,
    }), commercePublicKey)

    const entries = await listCatalogEntries('visual-style', {
      paths,
      policy,
      pins: [{ pack_id: packId, version: '1.0.0', archive_sha256: archiveSha256 }],
      appVersion: '1.0.0',
    })
    assert.deepEqual(entries.map(entry => entry.pack), [{ pack_id: packId, version: '1.0.0', archive_sha256: archiveSha256 }])
  })

  test('caps exact public missing dependencies at 100 without paths', async () => {
    const paths = await isolated(); const root = 'com.storystudio.matrix.cap-root'
    const directLeaves = await Promise.all(Array.from({ length: 99 }, async (_, index) => {
      const packId = `com.storystudio.matrix.cap-${index}`
      return { packId, installed: await storeInstall(paths, packId, '1.0.0') }
    }))
    const branchLeaves = await Promise.all(['a', 'b'].map(async suffix => {
      const packId = `com.storystudio.matrix.cap-branch-${suffix}`
      return { packId, installed: await storeInstall(paths, packId, '1.0.0') }
    }))
    const branch = 'com.storystudio.matrix.cap-branch'
    const installedBranch = await storeInstall(paths, branch, '1.0.0', branchLeaves.map(({ packId }) => ({ pack_id: packId, version: '1.0.0' })), branchLeaves.map(({ packId, installed }) => pin(packId, '1.0.0', installed.archive_sha256)))
    const dependencies = [...directLeaves.map(({ packId }) => ({ pack_id: packId, version: '1.0.0' })), { pack_id: branch, version: '1.0.0' }]
    const installedRoot = await storeInstall(paths, root, '1.0.0', dependencies, [...directLeaves.map(({ packId, installed }) => pin(packId, '1.0.0', installed.archive_sha256)), pin(branch, '1.0.0', installedBranch.archive_sha256)])
    await mutateContentPackState(state => { for (const { packId } of [...directLeaves, ...branchLeaves]) delete state.packs[packId] }, paths)

    const snapshot = await resolveContentStoreInstallSnapshot([release(root, '1.0.0', installedRoot.archive_sha256)], options(paths))
    assert.equal(snapshot.owned[0]?.installState, 'incomplete')
    assert.deepEqual(snapshot.owned[0]?.missingDependencies, [...directLeaves.map(({ packId }) => ({ packId, version: '1.0.0', reason: 'not installed' })), { packId: branchLeaves[0]!.packId, version: '1.0.0', reason: 'not installed' }])
    assert.doesNotMatch(JSON.stringify(snapshot), /\/Users\/|install_path|archive\.sspack/i)
  })

  test('deduplicates a shared exact missing dependency across closure branches', async () => {
    const paths = await isolated(); const shared = 'com.storystudio.matrix.shared'; const left = 'com.storystudio.matrix.left'; const right = 'com.storystudio.matrix.right'; const root = 'com.storystudio.matrix.graph'
    const installedShared = await storeInstall(paths, shared, '1.0.0')
    const installedLeft = await storeInstall(paths, left, '1.0.0', [{ pack_id: shared, version: '1.0.0' }], [pin(shared, '1.0.0', installedShared.archive_sha256)])
    const installedRight = await storeInstall(paths, right, '1.0.0', [{ pack_id: shared, version: '1.0.0' }], [pin(shared, '1.0.0', installedShared.archive_sha256)])
    const installedRoot = await storeInstall(paths, root, '1.0.0', [{ pack_id: left, version: '1.0.0' }, { pack_id: right, version: '1.0.0' }], [pin(left, '1.0.0', installedLeft.archive_sha256), pin(right, '1.0.0', installedRight.archive_sha256)])
    await mutateContentPackState(state => { delete state.packs[shared] }, paths)

    const snapshot = await resolveContentStoreInstallSnapshot([release(root, '1.0.0', installedRoot.archive_sha256)], options(paths))
    assert.deepEqual(snapshot.owned[0]?.missingDependencies, [{ packId: shared, version: '1.0.0', reason: 'not installed' }])
  })

  test('distinguishes owned not installed, current install, and a pinned older update', async () => {
    const paths = await isolated(); const currentPackId = 'com.storystudio.matrix.current'; const olderPackId = 'com.storystudio.matrix.older'
    const current = await storeInstall(paths, currentPackId, '1.0.0')
    await storeInstall(paths, olderPackId, '0.9.0')
    const missingRelease = release('com.storystudio.matrix.not-installed', '1.0.0', 'a'.repeat(64))
    const snapshot = await resolveContentStoreInstallSnapshot([missingRelease, release(currentPackId, '1.0.0', current.archive_sha256), release(olderPackId, '1.0.0', 'b'.repeat(64))], options(paths))
    assert.deepEqual(snapshot.owned, [
      { installState: 'not_installed', installedVersion: null, missingDependencies: [] },
      { installState: 'installed_current', installedVersion: '1.0.0', missingDependencies: [] },
      { installState: 'update_available', installedVersion: '0.9.0', missingDependencies: [] },
    ])
  })

  test('keeps signed retained installations when the owned current release is withdrawn', async () => {
    const paths = await isolated(); const packId = 'com.storystudio.matrix.withdrawn'
    const installed = await storeInstall(paths, packId, '1.0.0')
    const snapshot = await resolveContentStoreInstallSnapshot([null], options(paths))
    assert.deepEqual(snapshot.owned, [{ installState: 'unavailable', installedVersion: null, missingDependencies: [] }])
    assert.deepEqual(snapshot.installed.map(item => entry(item.packId, item.version)), [entry(packId, installed.version)])
  })

  test('waits behind removal so overview does not return a stale installed row', async () => {
    const paths = await isolated(); const packId = 'com.storystudio.matrix.removal'; await storeInstall(paths, packId, '1.0.0')
    await mutateContentPackState(state => { delete state.packs[packId]!.active_version }, paths)
    let releaseRemoval!: () => void; const mayRemove = new Promise<void>(resolve => { releaseRemoval = resolve })
    let entered!: () => void; const removalStarted = new Promise<void>(resolve => { entered = resolve })
    const removal = uninstallContentPackVersion(packId, '1.0.0', async () => [], { paths, policy, hooks: { beforeRemovalDelete: async () => { entered(); await mayRemove } } })
    await removalStarted
    let resolved = false
    const overview = resolveContentStoreInstallSnapshot([], options(paths)).then(value => { resolved = true; return value })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(resolved, false)
    releaseRemoval(); await removal
    assert.deepEqual((await overview).installed, [])
  })
})

describe('Store-attested verification memo is keyed on the resolved signing key', () => {
  test('an unchanged key reuses the memo with no time limit; a rotated key misses it at once', async (t) => {
    const paths = await isolated()
    const packId = 'com.storystudio.matrix.memo-key'
    const installed = await storeInstall(paths, packId, '1.0.0')
    const record = (await readContentPackState(paths)).packs[packId]!.versions[installed.version]!
    let key = commercePublicKey
    let calls = 0
    const resolver = async () => { calls += 1; return key }

    forgetVerifiedContentPackVersions()
    const first = await verifyInstalledContentPackVersion(record, policy, resolver)
    // Past the old 60 s TTL: the same key must still hit (no re-hash of every pack once a minute).
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 })
    const second = await verifyInstalledContentPackVersion(record, policy, resolver)
    t.mock.timers.reset()
    assert.equal(second, first, 'same resolved key + same tree must reuse the verification')
    assert.ok(calls >= 2, 'the key is resolved on every check, so rotation is seen immediately')

    // A rotated key misses the memo and re-verifies the installed bytes; the key is a delivery
    // gate, so an installed copy still serves (owner 2026-11-13: installed is done).
    key = publicKeyBase64(generateKeyPairSync('ed25519'))
    await verifyInstalledContentPackVersion(record, policy, resolver)
    // A resolver that throws (revoked or unknown) also cannot refuse an installed copy.
    await verifyInstalledContentPackVersion(record, policy, async () => { throw new Error('revoked') })
  })
})

describe('installed packs serve without a local key anchor (owner 2026-11-13)', () => {
  const legacyEnvelope = JSON.stringify({ __encrypted: true, version: 1, ciphertext: 'AAAA' })

  test('a Store pack installed earlier still verifies with no anchor file at all', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.matrix.no-anchor'
    const installed = await storeInstall(paths, packId, '1.0.0')
    const record = (await readContentPackState(paths)).packs[packId]!.versions[installed.version]!
    assert.equal(await fs.stat(contentStoreAnchorsPath()).then(() => true, () => false), false)
    const verified = await verifyInstalledContentPackVersion(record, policy)
    assert.equal(verified.manifest.pack_id, packId)
    assert.equal(verified.manifest.version, '1.0.0')
  })

  test('an unreadable legacy anchor envelope keeps an installed pack served on a normal refresh', async () => {
    const paths = await isolated()
    const packId = 'com.storystudio.matrix.legacy-anchor'
    const installed = await storeInstall(paths, packId, '1.0.0')
    // The mini's 1.4.399 state: verified restore evidence exists, but the anchor file is the old
    // encrypted envelope, so resolving the receipt key would demand online re-verification.
    await recordRestore('acct_legacy', 'legacy-key', commercePair)
    await fs.writeFile(contentStoreAnchorsPath(), legacyEnvelope, { mode: 0o600 })
    const record = (await readContentPackState(paths)).packs[packId]!.versions[installed.version]!
    const verified = await verifyInstalledContentPackVersion(record, policy)
    assert.equal(verified.manifest.pack_id, packId)
    assert.equal(verified.manifest.version, '1.0.0')
    // The refresh path the page uses: the installed row must be current, not "incomplete".
    const snapshot = await resolveContentStoreInstallSnapshot([
      release(packId, '1.0.0', record.archive_sha256),
    ], { paths, policy })
    assert.deepEqual(snapshot.installed.map(pack => [pack.packId, pack.installState]), [[packId, 'installed_current']])
  })

  test('a NEW Store delivery still requires verified trust when the anchor is unreadable', async () => {
    const paths = await isolated()
    await recordRestore('acct_new', 'new-key', commercePair)
    await fs.writeFile(contentStoreAnchorsPath(), legacyEnvelope, { mode: 0o600 })
    const packId = 'com.storystudio.matrix.new-needs-trust'
    const bytes = await archive(packId, '1.0.0')
    await assert.rejects(installContentPack({
      archiveBytes: bytes,
      source: 'genstudio-store',
      expectedArchiveSha256: sha(bytes),
      expectedPackId: packId,
      expectedVersion: '1.0.0',
      deliveryAttestation: evidence(packId, '1.0.0', sha(bytes), bytes.byteLength, [], 'acct_new', 'new-key'),
    }, { paths, policy }), (error: unknown) => error instanceof ContentStoreRevalidationRequiredError)
  })
})

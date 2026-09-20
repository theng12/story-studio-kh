import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { resolveContentStoreInstallSnapshot } from '../services/content-store-install-state.js'
import { useTempDataDir } from './_helpers.js'

const PACK_ID = 'com.storystudio.task12-exact-version'
const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.task12-exact-version-key'
const keyPair = generateKeyPairSync('ed25519')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
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

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function archive(version: string): Promise<Uint8Array> {
  const document = Buffer.from(JSON.stringify({
    kind: 'visual-style', schema_version: 1, id: `${PACK_ID}.style`, name: `Task 12 ${version}`,
    description: 'Exact installed-version fixture.', category: 'Test', tags: ['test'],
    style_bible: `Exact version ${version}.`, negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [],
  }))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: PACK_ID, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version,
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [], dependencies: [],
    items: [{ id: `${PACK_ID}.style`, kind: 'visual-style', schema_version: 1, path: 'content/visual-style.json' }],
    files: [
      { path: 'content/visual-style.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      { path: 'assets/preview.png', sha256: sha256(PNG), bytes: PNG.byteLength, mime: 'image/png' },
    ],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file('content/visual-style.json', document, { createFolders: false })
  zip.file('assets/preview.png', PNG, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

test('an exact retained release reports its own installed version even when another version is active', async () => {
  // Break caught: the exact archive branch currently returns active_version,
  // which falsely labels the retained exact release as a different version.
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const paths = getContentPackRuntimePaths()
  const oldBytes = await archive('1.0.0')
  const activeBytes = await archive('2.0.0')
  await installContentPack({ archiveBytes: oldBytes, source: 'local-import' }, { paths, policy })
  await installContentPack({ archiveBytes: activeBytes, source: 'local-import' }, { paths, policy })

  const snapshot = await resolveContentStoreInstallSnapshot([{
    releaseId: 'task12-release-1', packId: PACK_ID, version: '1.0.0',
    archiveSha256: sha256(oldBytes), archiveBytes: oldBytes.byteLength,
    archiveAvailable: true, minStoryVersion: '1.0.0', changelog: '',
    componentSummary: { value: {}, canonicalJson: '{}', canonicalBytes: new TextEncoder().encode('{}') },
    raw: { value: {}, canonicalJson: '{}', canonicalBytes: new TextEncoder().encode('{}') },
  }], { paths, policy })

  assert.deepEqual(snapshot.owned, [{
    installState: 'installed_other_version',
    installedVersion: '1.0.0',
    missingDependencies: [],
  }])
})

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const SOURCE_DIRECTORY = new URL('../../../content-packs/paid/archival-ledger/kit/archival-ledger/', import.meta.url)
const PACK_ID = 'com.storystudio.pack.kit.archival-ledger'
const BUNDLE_ID = 'com.storystudio.bundle.archival-ledger'
const FAMILY = 'com.storystudio.family.kit.archival-ledger'
const COMPONENTS = [
  { pack_id: 'com.storystudio.pack.formula.archival-ledger', version: '1.0.1', item_id: 'com.storystudio.formula.archival-ledger', kind: 'series-formula' },
  { pack_id: 'com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse', version: '1.0.0', item_id: 'com.storystudio.topic.archival-ledger.states-revolutions-collapse', kind: 'topic-pack' },
  { pack_id: 'com.storystudio.pack.style.archival-documentary-reconstruction', version: '1.0.0', item_id: 'com.storystudio.style.archival-documentary-reconstruction', kind: 'visual-style' },
  { pack_id: 'com.storystudio.pack.thumbnail.archival-map-investigation', version: '1.0.0', item_id: 'com.storystudio.thumbnail.archival-map-investigation', kind: 'thumbnail-recipe' },
]

// Owner ruling 2026-08-25: "kits must only have 4 piece. one of each. any thing
// extra is just content sold separately and at 300 credit's a pcs." The four
// surplus Topic Packs are stocked individually and are no longer coordinated
// here — which is also the shape already PUBLISHED as Kit 1.0.1.
test('Archival Ledger coordinates exactly four independently stockable components without creative payloads', async () => {
  const coordination = JSON.parse(await readFile(new URL('pack.json', SOURCE_DIRECTORY), 'utf8'))

  assert.equal(coordination.pack_id, PACK_ID)
  assert.equal(coordination.version, '1.0.2')
  assert.equal(coordination.entitlement.sku, 'com.storystudio.sku.kit.archival-ledger')
  assert.equal(coordination.entitlement.family, FAMILY)
  assert.equal(Object.hasOwn(coordination, 'items'), false)
  assert.equal(Object.hasOwn(coordination, 'files'), false)
  assert.equal(coordination.dependencies.length, 4)
  assert.deepEqual(
    COMPONENTS.map(component => component.kind).sort(),
    ['series-formula', 'thumbnail-recipe', 'topic-pack', 'visual-style'],
    'a Channel Kit is exactly one of each kind',
  )
  assert.deepEqual(coordination.dependencies, COMPONENTS.map(({ pack_id, version }) => ({ pack_id, version })))
  assert.equal(coordination.bundles.length, 1)
  assert.equal(coordination.bundles[0].id, BUNDLE_ID)
  assert.deepEqual(coordination.bundles[0].components, COMPONENTS)
  assert.equal(coordination.bundles[0].components.some(component => component.pack_id === 'com.storystudio.pack.archival-ledger'), false,
    'the retired monolith must not be a stockable bundle member')
  assert.deepEqual(await readdir(SOURCE_DIRECTORY), ['pack.json'])
  assert.doesNotMatch(JSON.stringify(coordination), /"(?:price|credits|showcase|purchase|license)"\s*:/i)
})

test('Archival Ledger coordination builds reproducibly and validates with an ephemeral key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'archival-ledger-coordination-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'ephemeral-private.pem')
  const publicKeyPath = join(root, 'ephemeral-public.pem')
  const firstPath = join(root, 'archival-ledger-first.sspack')
  const secondPath = join(root, 'archival-ledger-second.sspack')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))

  const first = await buildContentPack({ sourceDirectory: SOURCE_DIRECTORY.pathname, privateKeyPath, outputPath: firstPath, minAppVersion: '2.3.4' })
  const second = await buildContentPack({ sourceDirectory: SOURCE_DIRECTORY.pathname, privateKeyPath, outputPath: secondPath, minAppVersion: '2.3.4' })
  const verified = await validateContentPack({
    archivePath: firstPath,
    keyId: 'com.storystudio.key.archival-ledger',
    publisherId: 'com.storystudio',
    publicKeyPath,
  })
  const archive = await JSZip.loadAsync(await readFile(firstPath))

  assert.equal(first.packId, PACK_ID)
  assert.equal(first.version, '1.0.2')
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
  assert.deepEqual(verified, { packId: PACK_ID, version: '1.0.2', sha256: first.sha256 })
  assert.deepEqual(Object.keys(archive.files), ['manifest.json', 'signature.ed25519'])
  const manifest = JSON.parse(await archive.file('manifest.json').async('text'))
  assert.equal(manifest.items.length, 0)
  assert.equal(manifest.files.length, 0)
})

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const SOURCE_DIRECTORY = new URL('../../../content-packs/paid/deep-time-field-record/topic/human-origins-ancient-worlds/', import.meta.url)
const PACK_ID = 'com.storystudio.pack.topic.deep-time-field-record.human-origins-ancient-worlds'
const KEY_ID = 'com.storystudio.key.primary'
const ITEM_ID = 'com.storystudio.topic.deep-time-field-record.human-origins-ancient-worlds'

test('Human Origins & Ancient Worlds is an independently stockable Topic component with no commercial payload', async () => {
  const manifest = JSON.parse(await readFile(new URL('pack.json', SOURCE_DIRECTORY), 'utf8'))

  assert.equal(manifest.pack_id, PACK_ID)
  assert.equal(manifest.version, '1.0.0')
  assert.equal(manifest.publisher_id, 'com.storystudio')
  assert.equal(manifest.entitlement.sku, 'com.storystudio.sku.topic.deep-time-field-record.human-origins-ancient-worlds')
  assert.equal(manifest.entitlement.family, 'com.storystudio.family.topic.deep-time-field-record.human-origins-ancient-worlds')

  // Story Studio calculates no price. A source pack that carried one would be
  // asserting a commercial fact that belongs to GenStudio.
  assert.doesNotMatch(JSON.stringify(manifest), /"(?:price|credits|showcase|purchase|license|discount)"\s*:/i)
  assert.deepEqual((await readdir(SOURCE_DIRECTORY)).sort(), ['content', 'pack.json'])
})

test('the pack builds byte-identically twice and validates with an ephemeral key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'deep-time-human-origins-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'ephemeral-private.pem')
  const publicKeyPath = join(root, 'ephemeral-public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))

  const firstPath = join(root, 'human-origins-first.sspack')
  const secondPath = join(root, 'human-origins-second.sspack')
  const first = await buildContentPack({ sourceDirectory: fileURLToPath(SOURCE_DIRECTORY), privateKeyPath, outputPath: firstPath, minAppVersion: '2.3.4', keyId: KEY_ID })
  const second = await buildContentPack({ sourceDirectory: fileURLToPath(SOURCE_DIRECTORY), privateKeyPath, outputPath: secondPath, minAppVersion: '2.3.4', keyId: KEY_ID })

  assert.equal(first.sha256, second.sha256, 'two builds of one source must produce one archive')
  assert.deepEqual(await readFile(firstPath), await readFile(secondPath), 'the archives must be byte-identical, not merely equal in digest')

  const verified = await validateContentPack({
    archivePath: firstPath,
    keyId: KEY_ID,
    publisherId: 'com.storystudio',
    publicKeyPath,
  })
  assert.ok(verified, 'the signed archive must validate against the key that signed it')
})

test('the built archive carries the 100 x 20 the wave proposal sells', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'deep-time-human-origins-shape-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const { privateKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'ephemeral-private.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const archivePath = join(root, 'human-origins.sspack')
  await buildContentPack({ sourceDirectory: fileURLToPath(SOURCE_DIRECTORY), privateKeyPath, outputPath: archivePath, minAppVersion: '2.3.4', keyId: KEY_ID })

  const zip = await JSZip.loadAsync(await readFile(archivePath))
  const entry = Object.keys(zip.files).find(name => name.endsWith('.json') && name.includes('content/'))
  assert.ok(entry, 'the archive must carry its content document')
  const document = JSON.parse(await zip.files[entry].async('string'))

  assert.equal(document.id, ITEM_ID)
  assert.equal(document.subjects.length, 100)
  assert.equal(document.coverage_profiles.length, 100)
  assert.equal(document.max_siblings_per_subject, 20)
  const tuples = document.coverage_profiles.reduce((total, profile) => total + profile.tuples.length, 0)
  assert.equal(tuples, 2000, 'the pack sells 2,000 authored assignments and the archive must contain them')
  assert.deepEqual(document.compatible_formula_ids, ['com.storystudio.formula.deep-time-documentary'],
    'the one required component is the FREE Deep Time Documentary Formula')
})

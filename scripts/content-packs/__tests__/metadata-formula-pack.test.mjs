/**
 * The Editorial Description Formulas pack — six description architectures, the
 * same shape a lettering pack sells in.
 *
 * The owner asked for "5 built in options and then we can sell them in packs of
 * 6 for 300 credits each also if we decide to create many more formats". These
 * pin the half that makes the second clause true: the pack builds, signs and
 * validates through the ordinary publisher tools, it holds exactly six, and its
 * six are six genuinely different SHAPES rather than a renamed built-in.
 *
 * Authored only. No price, no publication, no stocking — GenStudio-side product
 * creation is a later step and nothing here presumes it.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const sourceDirectory = join(repositoryRoot, 'content-packs', 'paid', 'metadata-formulas', 'editorial')
const contentDirectory = join(sourceDirectory, 'content')
const registryPath = join(repositoryRoot, 'content-packs', 'authoring-registry.json')
const packId = 'com.storystudio.pack.metadata-formula.editorial'

async function documents() {
  const names = (await readdir(contentDirectory)).filter(name => name.endsWith('.json')).sort()
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(contentDirectory, name), 'utf8'))))
}

test('the pack holds exactly six metadata formulas', async () => {
  const docs = await documents()
  assert.equal(docs.length, 6)
  for (const doc of docs) {
    assert.equal(doc.kind, 'metadata-formula')
    assert.equal(doc.schema_version, 1)
    assert.ok(doc.id.startsWith('com.storystudio.metadata-formula.'))
    assert.ok(doc.architecture.length > 0)
  }
  assert.equal(new Set(docs.map(doc => doc.id)).size, 6)
})

test('the six are six different shapes, not six wordings of one', async () => {
  const docs = await documents()
  // A formula's shape is its ordered section ids and which of them show a
  // header. Six documents that agreed on that would be one product sold six
  // times, which is the thing the owner already had for free.
  const shapes = docs.map(doc => JSON.stringify(
    doc.description_plan.sections.map(section => `${section.id}:${section.header.render ? 'headed' : 'bare'}`),
  ))
  assert.equal(new Set(shapes).size, 6)
  assert.ok(new Set(docs.map(doc => doc.description_plan.max_chars)).size >= 4)
  assert.ok(new Set(docs.map(doc => doc.description_plan.separator)).size >= 2)
})

test('no pack formula takes a built-in formula id', async () => {
  // Read the shipped built-ins rather than restating their ids here — a list
  // copied into a test is a list that goes stale the day a sixth ships.
  const builtinDirectory = join(repositoryRoot, 'electron', 'server', 'metadata-formulas')
  const builtinIds = await Promise.all(
    (await readdir(builtinDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await readFile(join(builtinDirectory, name), 'utf8')).id),
  )
  assert.ok(builtinIds.length >= 5, 'the built-in formulas were not found')
  for (const doc of await documents()) {
    assert.ok(!builtinIds.includes(doc.id), `${doc.id} shadows a built-in`)
  }
})

test('every section instruction is the document\'s own words, and headers are declared', async () => {
  for (const doc of await documents()) {
    for (const section of doc.description_plan.sections) {
      assert.ok(section.instruction.trim().length > 0, `${doc.id}/${section.id} has no instruction`)
      if (section.header.render) {
        assert.ok(section.header.text && section.header.text.trim().length > 0,
          `${doc.id}/${section.id} renders a header without saying what it says`)
      } else {
        assert.ok(!('text' in section.header) || !section.header.text,
          `${doc.id}/${section.id} carries header text it will never print`)
      }
    }
  }
})

test('the pack is registered as authored in the authoring registry', async () => {
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const record = registry.records.find(row => row.pack_id === packId)
  assert.ok(record, 'the pack has no authoring registry record')
  assert.equal(record.kind, 'metadata-formula')
  assert.equal(record.status, 'authored')
  assert.equal(record.version, '1.0.0')
  assert.equal(record.source_path, 'content-packs/paid/metadata-formulas/editorial')
  const docs = await documents()
  assert.deepEqual([...record.item_ids].sort(), docs.map(doc => doc.id).sort())
  // Authored, not stocked. Family and SKU stay proposals until GenStudio-side
  // product creation actually happens.
  assert.equal(record.stocking_proposal.family.status, 'proposed')
  assert.equal(record.stocking_proposal.sku.status, 'proposed')
})

test('the pack builds, signs, and validates through the ordinary publisher tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-formula-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'private.pem')
  const publicKeyPath = join(root, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const outputPath = join(root, 'editorial.sspack')
  const keyId = 'com.storystudio.key.metadata-formula-test'

  const built = await buildContentPack({
    sourceDirectory, privateKeyPath, outputPath, keyId, minAppVersion: '1.4.74',
  })
  assert.ok(built.output.endsWith('editorial.sspack'))

  const validated = await validateContentPack({
    archivePath: outputPath, keyId, publisherId: 'com.storystudio', publicKeyPath, includeManifest: true,
  })
  const items = validated.manifest?.items ?? validated.items ?? []
  assert.equal(items.length, 6)
  assert.deepEqual([...new Set(items.map(item => item.kind))], ['metadata-formula'])
})

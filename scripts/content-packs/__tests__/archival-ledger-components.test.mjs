import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const REVIEWED_SOURCE = new URL('../../../content-packs/archival-ledger/', import.meta.url)
const PAID_SOURCE = new URL('../../../content-packs/paid/archival-ledger/', import.meta.url)
const COMPONENT_REGISTRY = new URL('../../../content-packs/paid/archival-ledger/registry.mjs', import.meta.url)
const RELEASE_VERSION = '2.3.4'

const COMPONENTS = [
  {
    kind: 'formula',
    slug: 'archival-ledger',
    document: 'series-formula.json',
    packId: 'com.storystudio.pack.formula.archival-ledger',
    itemId: 'com.storystudio.formula.archival-ledger',
    family: 'com.storystudio.family.formula.archival-ledger',
    sku: 'com.storystudio.sku.formula.archival-ledger',
  },
  ...[
    'states-revolutions-collapse',
    'money-debt-financial-institutions',
    'empires-trade-extraction',
    'wars-treaties-world-order',
    'infrastructure-commodities-corporate-power',
  ].map(slug => ({
    kind: 'topic',
    slug,
    document: `topic-${slug}.json`,
    packId: `com.storystudio.pack.topic.archival-ledger.${slug}`,
    itemId: `com.storystudio.topic.archival-ledger.${slug}`,
    family: `com.storystudio.family.topic.archival-ledger.${slug}`,
    sku: `com.storystudio.sku.topic.archival-ledger.${slug}`,
  })),
  {
    kind: 'style',
    slug: 'archival-documentary-reconstruction',
    document: 'visual-style.json',
    packId: 'com.storystudio.pack.style.archival-documentary-reconstruction',
    itemId: 'com.storystudio.style.archival-documentary-reconstruction',
    family: 'com.storystudio.family.style.archival-documentary-reconstruction',
    sku: 'com.storystudio.sku.style.archival-documentary-reconstruction',
  },
  {
    kind: 'thumbnail',
    slug: 'archival-map-investigation',
    document: 'thumbnail-recipe.json',
    packId: 'com.storystudio.pack.thumbnail.archival-map-investigation',
    itemId: 'com.storystudio.thumbnail.archival-map-investigation',
    family: 'com.storystudio.family.thumbnail.archival-map-investigation',
    sku: 'com.storystudio.sku.thumbnail.archival-map-investigation',
  },
]

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function sourceDirectory(component) {
  return new URL(`${component.kind}/${component.slug}/`, PAID_SOURCE)
}

async function readJson(url, label) {
  try {
    return JSON.parse(await readFile(url, 'utf8'))
  } catch (error) {
    assert.fail(`missing independent component source for ${label}: ${error.message}`)
  }
}

async function readComponentSource(component) {
  const directory = sourceDirectory(component)
  const manifest = await readJson(new URL('pack.json', directory), component.packId)
  const documentNames = await readdir(new URL('content/', directory)).catch(error => assert.fail(`missing component document directory for ${component.packId}: ${error.message}`))
  const documents = await Promise.all(documentNames.map(name => readJson(new URL(`content/${name}`, directory), component.packId)))
  const document = documents.find(candidate => candidate.id === component.itemId)
  assert.ok(document, `component source must declare ${component.itemId}`)
  const assetNames = await readdir(new URL('assets/', directory)).catch(error => error.code === 'ENOENT' ? [] : assert.fail(`unable to read component assets for ${component.packId}: ${error.message}`))
  const assets = await Promise.all((document.preview_assets ?? []).map(async asset => ({
    path: asset,
    bytes: await readFile(new URL(asset, directory)),
  })))
  return { component, directory, manifest, documents, document, assetNames, assets }
}

test('Archival Ledger has eight independently stockable component sources with exact reviewed content', async () => {
  const componentSources = await Promise.all(COMPONENTS.map(readComponentSource))
  const reviewedMonolithDocuments = await Promise.all(COMPONENTS.map(component => readJson(
    new URL(`content/${component.document}`, REVIEWED_SOURCE),
    `reviewed ${component.document}`,
  )))

  assert.equal(componentSources.length, 8)
  assert.equal(componentSources.every(source => source.manifest.version === '1.0.0'), true)
  assert.equal(componentSources.every(source => source.documents.length === 1), true)
  assert.equal(componentSources.every(source => source.manifest.min_app_version === '{{MIN_APP_VERSION}}'), true)
  assert.equal(componentSources.every(source => source.manifest.lifecycle === 'active'), true)
  assert.equal(componentSources.every(source => source.manifest.key_id === 'com.storystudio.key.archival-ledger'), true)
  assert.equal(componentSources.every(source => source.manifest.dependencies === undefined), true)
  assert.equal(componentSources.every(source => source.manifest.bundles === undefined), true)
  assert.equal(componentSources.every(source => source.manifest.price === undefined), true)
  assert.equal(componentSources.every(source => source.manifest.showcase === undefined), true)
  assert.equal(componentSources.every(source => source.manifest.license === undefined), true)
  assert.equal(componentSources.every(source => source.manifest.purchase === undefined), true)
  assert.equal(componentSources.every(source => source.manifest.pack_id === source.component.packId), true)
  assert.equal(componentSources.every(source => source.manifest.entitlement.sku === source.component.sku), true)
  assert.equal(componentSources.every(source => source.manifest.entitlement.family === source.component.family), true)
  assert.equal(componentSources.every(source => source.document.id === source.component.itemId), true)
  assert.equal(componentSources.every(source => source.document.kind === ({ formula: 'series-formula', topic: 'topic-pack', style: 'visual-style', thumbnail: 'thumbnail-recipe' }[source.component.kind])), true)
  assert.equal(componentSources.every(source => source.assetNames.length === source.assets.length), true)
  assert.equal(componentSources.every(source => source.document.preview_assets === undefined || source.assets.length === source.document.preview_assets.length), true)
  assert.equal(componentSources.filter(source => source.component.kind === 'formula' || source.component.kind === 'topic').every(source => source.assets.length === 0), true)
  assert.equal(componentSources.filter(source => source.component.kind === 'style').every(source => source.assets.length === 1), true)
  assert.equal(componentSources.filter(source => source.component.kind === 'thumbnail').every(source => source.assets.length === 3), true)
  assert.equal(componentSources.filter(source => source.component.kind === 'topic').reduce((sum, source) => sum + source.document.subjects.length, 0), 125)
  assert.equal(canonicalHash(componentSources.map(source => source.document)), canonicalHash(reviewedMonolithDocuments))

  for (const source of componentSources) {
    for (const asset of source.assets) {
      const sourceName = asset.path.split('/').pop()
      const reviewedAsset = await readFile(new URL(`assets/${sourceName}`, REVIEWED_SOURCE))
      assert.equal(createHash('sha256').update(asset.bytes).digest('hex'), createHash('sha256').update(reviewedAsset).digest('hex'))
    }
  }

  const { paidComponentRegistry } = await import(COMPONENT_REGISTRY)
  assert.equal(paidComponentRegistry.length, 8)
  assert.deepEqual(paidComponentRegistry, COMPONENTS.map(component => ({
    packId: component.packId,
    itemId: component.itemId,
    kind: ({ formula: 'series-formula', topic: 'topic-pack', style: 'visual-style', thumbnail: 'thumbnail-recipe' }[component.kind]),
    version: '1.0.0',
    sku: component.sku,
    family: component.family,
    sourceDirectory: `${component.kind}/${component.slug}`,
  })))
  assert.equal(paidComponentRegistry.some(row => row.packId === 'com.storystudio.pack.archival-ledger'), false)
  assert.deepEqual(paidComponentRegistry.map(row => row.sourceDirectory), COMPONENTS.map(component => `${component.kind}/${component.slug}`))
})

test('each Archival Ledger component source builds deterministically and validates with an ephemeral key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archival-ledger-components-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyPath = join(root, 'ephemeral-private.pem')
    const publicKeyPath = join(root, 'ephemeral-public.pem')
    await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))

    for (const component of COMPONENTS) {
      const source = await readComponentSource(component)
      const firstPath = join(root, `${component.kind}-${component.slug}-first.sspack`)
      const secondPath = join(root, `${component.kind}-${component.slug}-second.sspack`)
      const first = await buildContentPack({ sourceDirectory: source.directory.pathname, privateKeyPath, outputPath: firstPath, minAppVersion: RELEASE_VERSION })
      const second = await buildContentPack({ sourceDirectory: source.directory.pathname, privateKeyPath, outputPath: secondPath, minAppVersion: RELEASE_VERSION })
      const verified = await validateContentPack({
        archivePath: firstPath,
        keyId: source.manifest.key_id,
        publisherId: source.manifest.publisher_id,
        publicKeyPath,
      })
      const archive = await JSZip.loadAsync(await readFile(firstPath))

      assert.equal(first.packId, component.packId)
      assert.equal(first.version, '1.0.0')
      assert.equal(JSON.parse(await archive.file('manifest.json').async('text')).min_app_version, RELEASE_VERSION)
      assert.equal(first.sha256, second.sha256)
      assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
      assert.deepEqual(verified, { packId: first.packId, version: first.version, sha256: first.sha256 })
      assert.deepEqual(Object.keys(archive.files), [
        'manifest.json',
        'signature.ed25519',
        ...source.assets.map(asset => asset.path),
        `content/${component.document}`,
      ])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

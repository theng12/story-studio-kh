import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const REVIEWED_SOURCE = new URL('../../../content-packs/archival-ledger/', import.meta.url)
const PAID_SOURCE = new URL('../../../content-packs/paid/archival-ledger/', import.meta.url)
const COMPONENT_REGISTRY = new URL('../../../content-packs/paid/archival-ledger/registry.mjs', import.meta.url)
const PREVIEW_PROVENANCE = new URL('../../../content-packs/paid/archival-ledger/PREVIEW-PROVENANCE.md', import.meta.url)
const RELEASE_VERSION = '2.3.4'
const COMPONENT_SOURCE_KINDS = ['formula', 'topic', 'style', 'thumbnail']

const COMPONENTS = [
  {
    kind: 'formula',
    slug: 'archival-ledger',
    // 1.0.1 merged the drifted episode-length range; 1.0.0 stays published and
    // untouched, so the source and the archive it produced still agree.
    version: '1.0.1',
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
    version: '1.0.0',
    document: `topic-${slug}.json`,
    packId: `com.storystudio.pack.topic.archival-ledger.${slug}`,
    itemId: `com.storystudio.topic.archival-ledger.${slug}`,
    family: `com.storystudio.family.topic.archival-ledger.${slug}`,
    sku: `com.storystudio.sku.topic.archival-ledger.${slug}`,
  })),
  {
    kind: 'style',
    slug: 'archival-documentary-reconstruction',
    version: '1.0.0',
    document: 'visual-style.json',
    packId: 'com.storystudio.pack.style.archival-documentary-reconstruction',
    itemId: 'com.storystudio.style.archival-documentary-reconstruction',
    family: 'com.storystudio.family.style.archival-documentary-reconstruction',
    sku: 'com.storystudio.sku.style.archival-documentary-reconstruction',
  },
  {
    kind: 'thumbnail',
    slug: 'archival-map-investigation',
    version: '1.0.0',
    document: 'thumbnail-recipe.json',
    packId: 'com.storystudio.pack.thumbnail.archival-map-investigation',
    itemId: 'com.storystudio.thumbnail.archival-map-investigation',
    family: 'com.storystudio.family.thumbnail.archival-map-investigation',
    sku: 'com.storystudio.sku.thumbnail.archival-map-investigation',
  },
]

// Versioned successors live BESIDE their predecessor rather than replacing it,
// because a published version's bytes must never change. They are deliberately
// not in COMPONENTS: every assertion there proves the eight componentized packs
// still reproduce the retired reviewed monolith exactly, and a successor exists
// precisely because its content is new. Folding one into COMPONENTS would not
// "update a stale expectation", it would delete that proof — the subject total
// would move from 125 to 225 and the monolith hash would stop matching.
// Successors get their own shape checks below and are registered like any other
// stockable source.
const SUCCESSORS = [
  {
    kind: 'topic',
    slug: 'money-debt-financial-institutions-v1.0.1',
    predecessorSlug: 'money-debt-financial-institutions',
    version: '1.0.1',
    document: 'topic-pack.json',
    packId: 'com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions',
    itemId: 'com.storystudio.topic.archival-ledger.money-debt-financial-institutions',
    family: 'com.storystudio.family.topic.archival-ledger.money-debt-financial-institutions',
    sku: 'com.storystudio.sku.topic.archival-ledger.money-debt-financial-institutions',
  },
  {
    kind: 'topic',
    slug: 'states-revolutions-collapse-v1.0.1',
    predecessorSlug: 'states-revolutions-collapse',
    version: '1.0.1',
    document: 'topic-pack.json',
    packId: 'com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse',
    itemId: 'com.storystudio.topic.archival-ledger.states-revolutions-collapse',
    family: 'com.storystudio.family.topic.archival-ledger.states-revolutions-collapse',
    sku: 'com.storystudio.sku.topic.archival-ledger.states-revolutions-collapse',
  },
  {
    kind: 'topic',
    slug: 'wars-treaties-world-order-v1.0.1',
    predecessorSlug: 'wars-treaties-world-order',
    version: '1.0.1',
    document: 'topic-pack.json',
    packId: 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order',
    itemId: 'com.storystudio.topic.archival-ledger.wars-treaties-world-order',
    family: 'com.storystudio.family.topic.archival-ledger.wars-treaties-world-order',
    sku: 'com.storystudio.sku.topic.archival-ledger.wars-treaties-world-order',
  },
  {
    kind: 'topic',
    slug: 'empires-trade-extraction-v1.0.1',
    predecessorSlug: 'empires-trade-extraction',
    version: '1.0.1',
    document: 'topic-pack.json',
    packId: 'com.storystudio.pack.topic.archival-ledger.empires-trade-extraction',
    itemId: 'com.storystudio.topic.archival-ledger.empires-trade-extraction',
    family: 'com.storystudio.family.topic.archival-ledger.empires-trade-extraction',
    sku: 'com.storystudio.sku.topic.archival-ledger.empires-trade-extraction',
  },
  {
    kind: 'topic',
    slug: 'infrastructure-commodities-corporate-power-v1.0.1',
    predecessorSlug: 'infrastructure-commodities-corporate-power',
    version: '1.0.1',
    document: 'topic-pack.json',
    packId: 'com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power',
    itemId: 'com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power',
    family: 'com.storystudio.family.topic.archival-ledger.infrastructure-commodities-corporate-power',
    sku: 'com.storystudio.sku.topic.archival-ledger.infrastructure-commodities-corporate-power',
  },
  // The 2026-09-08 style preview backfill. The Style shipped with one preview
  // and now ships three, which is new content, so it is a successor beside its
  // predecessor for exactly the reason the five Topic successors above are.
  {
    kind: 'style',
    slug: 'archival-documentary-reconstruction-v1.0.1',
    predecessorSlug: 'archival-documentary-reconstruction',
    version: '1.0.1',
    document: 'visual-style.json',
    packId: 'com.storystudio.pack.style.archival-documentary-reconstruction',
    itemId: 'com.storystudio.style.archival-documentary-reconstruction',
    family: 'com.storystudio.family.style.archival-documentary-reconstruction',
    sku: 'com.storystudio.sku.style.archival-documentary-reconstruction',
  },
]

const STOCKABLE = [...COMPONENTS, ...SUCCESSORS]

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

async function discoverComponentSourceDirectories(root = PAID_SOURCE.pathname) {
  const discovered = []
  for (const kind of COMPONENT_SOURCE_KINDS) {
    const entries = await readdir(join(root, kind), { withFileTypes: true }).catch(error => {
      if (error?.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await readFile(join(root, kind, entry.name, 'pack.json'), 'utf8')
        discovered.push(`${kind}/${entry.name}`)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return discovered.sort()
}

function assertRegistryCoversEveryComponentSource(registry, discovered) {
  assert.deepEqual([...registry.map(row => row.sourceDirectory)].sort(), discovered)
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

test('Archival Ledger has eight component sources with exact reviewed content, and registers every versioned successor beside them', async () => {
  const componentSources = await Promise.all(COMPONENTS.map(readComponentSource))
  const reviewedMonolithDocuments = await Promise.all(COMPONENTS.map(component => readJson(
    new URL(`content/${component.document}`, REVIEWED_SOURCE),
    `reviewed ${component.document}`,
  )))

  assert.equal(componentSources.every(source => source.manifest.version === source.component.version), true)
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
  assert.equal(canonicalHash(componentSources.map(source => {
    if (source.component.kind !== 'formula') return source.document
    const { channel_promise, production_kit, ...document } = source.document
    return document
  })), canonicalHash(reviewedMonolithDocuments.map(document => {
    if (document.kind !== 'series-formula') return document
    const { channel_promise, production_kit, ...formula } = document
    return formula
  })))

  for (const source of componentSources) {
    for (const asset of source.assets) {
      const sourceName = asset.path.split('/').pop()
      const reviewedAsset = await readFile(new URL(`assets/${sourceName}`, REVIEWED_SOURCE))
      assert.equal(createHash('sha256').update(asset.bytes).digest('hex'), createHash('sha256').update(reviewedAsset).digest('hex'))
    }
  }

  const { paidComponentRegistry } = await import(COMPONENT_REGISTRY)
  assert.deepEqual(paidComponentRegistry, STOCKABLE.map(component => ({
    packId: component.packId,
    itemId: component.itemId,
    kind: ({ formula: 'series-formula', topic: 'topic-pack', style: 'visual-style', thumbnail: 'thumbnail-recipe' }[component.kind]),
    version: component.version,
    sku: component.sku,
    family: component.family,
    sourceDirectory: `${component.kind}/${component.slug}`,
  })))
  assert.equal(paidComponentRegistry.some(row => row.packId === 'com.storystudio.pack.archival-ledger'), false)
  assertRegistryCoversEveryComponentSource(paidComponentRegistry, await discoverComponentSourceDirectories())
})

test('a ninth paid component source cannot be omitted from the registry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'archival-ledger-component-inventory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const directory of ['formula/archival-ledger', 'topic/ninth-component']) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, 'pack.json'), '{}')
  }
  const discovered = await discoverComponentSourceDirectories(root)
  assert.throws(
    () => assertRegistryCoversEveryComponentSource([{ sourceDirectory: 'formula/archival-ledger' }], discovered),
    /topic\/ninth-component/,
  )
})

test('the standalone Formula promises formula behavior; the Channel Kit carries the whole-channel promise', async () => {
  const formula = await readJson(new URL('formula/archival-ledger/content/series-formula.json', PAID_SOURCE), 'formula')
  const kit = await readJson(new URL('kit/archival-ledger/pack.json', PAID_SOURCE), 'Channel Kit')
  assert.doesNotMatch(formula.channel_promise, /500\+|topic|visual|thumbnail|kit/i)
  assert.equal(formula.production_kit, undefined)
  // The Kit names every kind it coordinates; the Formula names none of them.
  // The old assertion also required "500+", which was the promise of an
  // EIGHT-piece Kit carrying five Topic Packs. Owner ruling 2026-08-25 fixed a
  // Kit at four pieces, one of each, so that number is no longer true of this
  // product and asserting it would hold the copy to a claim it cannot meet.
  for (const term of ['Formula', 'Topic', 'Style', 'Thumbnail']) assert.match(kit.changelog, new RegExp(term, 'i'))
  assert.doesNotMatch(kit.changelog, /500\+/, 'a four-piece Kit must not carry the eight-piece episode-count promise')
})

test('legacy preview bytes have recorded provenance without an invented license claim', async () => {
  const evidence = await readFile(PREVIEW_PROVENANCE, 'utf8')
  for (const hash of [
    'f314283a43c106a44aea6cd779ba7c67e23ba0a357b4c7c0db41dbae126e38b5',
    '47c4e35e83e7fd6a44c82adb0543b4a23a609cc311214df9a71b5666f13288ca',
    '8bb88f199fd9517cdcdd397d175117ec868348d3add20ad2aa14180e9f517c05',
    'ed81d317e34cb74606fae2d0770bfbf33613eaba97ea2bd1e1f5b380ff21d24d',
  ]) assert.match(evidence, new RegExp(hash))
  assert.match(evidence, /badbf3814452dd624d1247c42e4226a5a6efdb79/)
  assert.match(evidence, /1578dcd85e8408e9e721994c45d6cf73d506d782/)
  assert.match(evidence, /Neither those commits nor the available repository handoff evidence grants a\s+separate preview-asset license/i)
})

test('each Archival Ledger component source and successor builds deterministically and validates with an ephemeral key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archival-ledger-components-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyPath = join(root, 'ephemeral-private.pem')
    const publicKeyPath = join(root, 'ephemeral-public.pem')
    await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))

    for (const component of STOCKABLE) {
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
      assert.equal(first.version, component.version)
      assert.equal(JSON.parse(await archive.file('manifest.json').async('text')).min_app_version, RELEASE_VERSION)
      assert.equal(first.sha256, second.sha256)
      assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
      assert.deepEqual(verified, { packId: first.packId, version: first.version, sha256: first.sha256 })
      // manifest and signature lead; the rest is compared as a set, because the
      // builder writes entries in its own order and `source.assets` is in
      // preview_assets order. Those coincided while every pack's previews were
      // named `-1`, `-2`, `-3`; the 2026-09-08 backfill added `-scene` and
      // `-face` behind a hero, and the two orders parted. What the archive owes
      // is the exact set of declared files, not this list's sequence.
      const entries = Object.keys(archive.files)
      assert.deepEqual(entries.slice(0, 2), ['manifest.json', 'signature.ed25519'])
      assert.deepEqual(entries.slice(2).sort(), [
        ...source.assets.map(asset => asset.path),
        `content/${component.document}`,
      ].sort())
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a versioned successor ships beside its predecessor rather than replacing it', async () => {
  for (const successor of SUCCESSORS) {
    const predecessor = COMPONENTS.find(component => component.slug === successor.predecessorSlug)
    assert.ok(predecessor, `${successor.slug} must name a predecessor that is still published`)

    const predecessorSource = await readComponentSource(predecessor)
    const successorSource = await readComponentSource(successor)

    // The predecessor is still on disk, still at its own version, still itself.
    assert.equal(predecessorSource.manifest.version, predecessor.version)
    assert.notEqual(successorSource.manifest.version, predecessorSource.manifest.version)
    assert.equal(successorSource.directory.pathname === predecessorSource.directory.pathname, false)

    // Same product, same entitlement, new version — not a different pack.
    assert.equal(successorSource.manifest.pack_id, predecessorSource.manifest.pack_id)
    assert.equal(successorSource.manifest.entitlement.sku, predecessorSource.manifest.entitlement.sku)
    assert.equal(successorSource.manifest.entitlement.family, predecessorSource.manifest.entitlement.family)
    assert.equal(successorSource.document.id, predecessorSource.document.id)
    assert.equal(successorSource.document.kind, predecessorSource.document.kind)

    // The successor carries the family's own publishing conventions.
    assert.equal(successorSource.manifest.key_id, 'com.storystudio.key.archival-ledger')
    assert.equal(successorSource.manifest.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(successorSource.manifest.lifecycle, 'active')
    assert.equal(successorSource.documents.length, 1)

    // A successor exists to carry more content than the version it succeeds.
    // What "more" means depends on the kind: a Topic Pack gains subjects, a
    // Visual Style gains previews. Asserting subjects for everything read as a
    // general rule but was only ever true of the five Topic successors, and it
    // threw rather than failed the moment a Style successor arrived.
    const [measure, countOf] = successorSource.document.kind === 'topic-pack'
      ? ['subjects', document => document.subjects.length]
      : ['previews', document => document.preview_assets.length]
    assert.ok(countOf(successorSource.document) > countOf(predecessorSource.document),
      `${successor.slug} must not ship fewer ${measure} than ${predecessor.slug}`)
  }
})

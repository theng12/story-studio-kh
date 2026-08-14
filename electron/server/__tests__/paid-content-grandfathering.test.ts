import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import {
  applyLegacyHiddenMechanicsMigration,
  planLegacyHiddenMechanicsMigration,
} from '../content-packs/project-pins.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { forkLegacyContentForEdit } from '../content-packs/user-forks.js'
import { useTempDataDir } from './_helpers.js'
import * as nicheLoader from '../services/niche-loader.js'
import * as projectManager from '../services/project-manager.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-grandfathering'
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const LEGACY = {
  formula: 'hidden-mechanics-history',
  topics: [
    'historical-states-revolutions-collapse',
    'historical-money-debt-financial-institutions',
    'historical-empires-trade-extraction',
    'historical-wars-treaties-world-order',
    'historical-infrastructure-commodities-corporate-power',
  ],
  style: 'builtin-archival-documentary-reconstruction',
  recipe: 'archival-map-investigation',
} as const

const COMPONENTS = [
  ['formula/archival-ledger', 'com.storystudio.pack.formula.archival-ledger', 'com.storystudio.formula.archival-ledger'],
  ['topic/states-revolutions-collapse', 'com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse', 'com.storystudio.topic.archival-ledger.states-revolutions-collapse'],
  ['topic/money-debt-financial-institutions', 'com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions', 'com.storystudio.topic.archival-ledger.money-debt-financial-institutions'],
  ['topic/empires-trade-extraction', 'com.storystudio.pack.topic.archival-ledger.empires-trade-extraction', 'com.storystudio.topic.archival-ledger.empires-trade-extraction'],
  ['topic/wars-treaties-world-order', 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order', 'com.storystudio.topic.archival-ledger.wars-treaties-world-order'],
  ['topic/infrastructure-commodities-corporate-power', 'com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power', 'com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power'],
  ['style/archival-documentary-reconstruction', 'com.storystudio.pack.style.archival-documentary-reconstruction', 'com.storystudio.style.archival-documentary-reconstruction'],
  ['thumbnail/archival-map-investigation', 'com.storystudio.pack.thumbnail.archival-map-investigation', 'com.storystudio.thumbnail.archival-map-investigation'],
] as const

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  return { paths, options: { paths, policy, appVersion: '1.0.0' } }
}

async function archiveFor(sourceDirectory: string, packId: string): Promise<Uint8Array> {
  const root = fileURLToPath(new URL('../../../content-packs/paid/archival-ledger/', import.meta.url))
  const source = path.join(root, sourceDirectory)
  const [documentName] = await fs.readdir(path.join(source, 'content'))
  const documentPath = `content/${documentName}`
  const document = await fs.readFile(path.join(source, documentPath))
  const assetNames = await fs.readdir(path.join(source, 'assets')).catch(() => [])
  const assets = await Promise.all(assetNames.map(async name => ({
    path: `assets/${name}`,
    bytes: await fs.readFile(path.join(source, 'assets', name)),
  })))
  const parsed = JSON.parse(document.toString('utf8')) as { id: string; kind: string; schema_version: number }
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: packId,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: parsed.id, kind: parsed.kind, schema_version: parsed.schema_version, path: documentPath }],
    files: [
      { path: documentPath, sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
      ...assets.map(asset => ({
        path: asset.path,
        sha256: sha256(asset.bytes),
        bytes: asset.bytes.byteLength,
        mime: asset.path.endsWith('.webp') ? 'image/webp' : 'image/png',
      })),
    ],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file(documentPath, document, { createFolders: false })
  for (const asset of assets) zip.file(asset.path, asset.bytes, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function installComponentizedArchivalFixture(options: Awaited<ReturnType<typeof isolated>>['options']): Promise<void> {
  for (const [sourceDirectory, packId] of COMPONENTS) {
    const archiveBytes = await archiveFor(sourceDirectory, packId)
    await installContentPack({ archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) }, options)
  }
}

test('claim and install do not rewrite an HMH project, while explicit migration writes exact component pins', async () => {
  const { options } = await isolated()
  const project = await projectManager.createProject({
    name: 'Grandfathered HMH',
    niche_id: LEGACY.formula,
    topic_pack_ids: [...LEGACY.topics],
  })
  await projectManager.updateConfigAndProjectMetaConsistently(project.slug, {
    active_style_preset_id: LEGACY.style,
    thumbnail_template_id: LEGACY.recipe,
  }, meta => {
    meta.active_style_preset_id = LEGACY.style
    meta.thumbnail_template_id = LEGACY.recipe
  })
  await projectManager.mutateProjectMetaConsistently(project.slug, meta => {
    meta.content_pack_versions = { 'com.storystudio.pack.unrelated-current': '3.2.1' }
    meta.content_pack_items = {
      'com.storystudio.unrelated-current.recipe': {
        pack_id: 'com.storystudio.pack.unrelated-current',
        kind: 'thumbnail-recipe',
      },
    }
  })
  const before = await projectManager.readProjectMetaConsistently(project.slug)

  await installComponentizedArchivalFixture(options)
  assert.deepEqual(await projectManager.readProjectMetaConsistently(project.slug), before)

  const plan = await planLegacyHiddenMechanicsMigration(project.slug, options)
  assert.deepEqual(plan.selections.map(selection => [selection.kind, selection.from_id, selection.to_id]), [
    ['series-formula', LEGACY.formula, COMPONENTS[0][2]],
    ...LEGACY.topics.map((id, index) => ['topic-pack', id, COMPONENTS[index + 1][2]]),
    ['visual-style', LEGACY.style, COMPONENTS[6][2]],
    ['thumbnail-recipe', LEGACY.recipe, COMPONENTS[7][2]],
  ])
  assert.equal(plan.selections.every(selection => (
    selection.to.version === '1.0.0' && /^[a-f0-9]{64}$/.test(selection.to.archive_sha256)
  )), true)
  assert.deepEqual(await projectManager.readProjectMetaConsistently(project.slug), before, 'a preview must never mutate project metadata')

  await applyLegacyHiddenMechanicsMigration(project.slug, plan, options)
  const migrated = await projectManager.readProjectMetaConsistently(project.slug)
  assert.equal(migrated?.niche_id, COMPONENTS[0][2])
  assert.deepEqual(migrated?.topic_pack_ids, COMPONENTS.slice(1, 6).map(component => component[2]))
  assert.equal(migrated?.active_style_preset_id, COMPONENTS[6][2])
  assert.equal(migrated?.thumbnail_template_id, COMPONENTS[7][2])
  assert.deepEqual(Object.keys(migrated?.content_pack_versions ?? {}).sort(), [
    'com.storystudio.pack.unrelated-current',
    ...COMPONENTS.map(component => component[1]),
  ].sort())
  assert.deepEqual(Object.keys(migrated?.content_pack_items ?? {}).sort(), [
    'com.storystudio.unrelated-current.recipe',
    ...COMPONENTS.map(component => component[2]),
  ].sort())
})

test('legacy HMH lookup and a user fork retain precedence until the user explicitly migrates', async () => {
  const { options } = await isolated()
  const project = await projectManager.createProject({ name: 'Forked HMH', niche_id: LEGACY.formula })
  const fork = await forkLegacyContentForEdit({
    kind: 'series-formula',
    legacyId: LEGACY.formula,
    projectSlug: project.slug,
  }, options)
  assert.equal((await nicheLoader.loadNiche(fork.fork_id, options))?.id, fork.fork_id)
  await installComponentizedArchivalFixture(options)
  const before = await projectManager.readProjectMetaConsistently(project.slug)

  await assert.rejects(planLegacyHiddenMechanicsMigration(project.slug, options), /does not select.*legacy Hidden Mechanics Formula/i)
  assert.deepEqual(await projectManager.readProjectMetaConsistently(project.slug), before)
})

test('an explicit migration rejects a stale preview rather than replacing a later legacy selection', async () => {
  const { options } = await isolated()
  const project = await projectManager.createProject({
    name: 'Stale HMH Migration',
    niche_id: LEGACY.formula,
    topic_pack_ids: [LEGACY.topics[0]],
  })
  await installComponentizedArchivalFixture(options)
  const preview = await planLegacyHiddenMechanicsMigration(project.slug, options)
  await projectManager.mutateProjectMetaConsistently(project.slug, meta => {
    meta.topic_pack_ids = [LEGACY.topics[1]]
  })

  await assert.rejects(
    applyLegacyHiddenMechanicsMigration(project.slug, preview, options),
    /selections changed since.*preview/i,
  )
  const current = await projectManager.readProjectMetaConsistently(project.slug)
  assert.deepEqual(current?.topic_pack_ids, [LEGACY.topics[1]])
  assert.equal(current?.content_pack_versions, undefined)
})

test('an explicit migration rejects a tampered preview version and archive hash', async () => {
  const { options } = await isolated()
  const project = await projectManager.createProject({
    name: 'Tampered HMH Migration',
    niche_id: LEGACY.formula,
    topic_pack_ids: [LEGACY.topics[0]],
  })
  await installComponentizedArchivalFixture(options)
  const preview = await planLegacyHiddenMechanicsMigration(project.slug, options)
  const tampered = structuredClone(preview)
  tampered.selections[1]!.to.version = '9.9.9'
  tampered.selections[1]!.to.archive_sha256 = 'f'.repeat(64)

  await assert.rejects(
    applyLegacyHiddenMechanicsMigration(project.slug, tampered, options),
    /preview is not recognized/i,
  )
  const current = await projectManager.readProjectMetaConsistently(project.slug)
  assert.equal(current?.niche_id, LEGACY.formula)
  assert.deepEqual(current?.topic_pack_ids, [LEGACY.topics[0]])
  assert.equal(current?.content_pack_versions, undefined)
})

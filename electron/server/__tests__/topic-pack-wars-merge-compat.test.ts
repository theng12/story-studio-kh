/**
 * The merged Wars, Treaties & World Order Topic Pack and the Formulas that read it.
 *
 * DEFECT THIS PINS. `LEGACY_TOPIC_PACK_ALIASES` sends the old Wars ids to the
 * merged `…-v2` item. Merged 1.0.1 named only two `-v2` Formula ids that no
 * published Series Formula carries, so a channel on a first-generation Formula
 * loaded 1.0.1, failed the compatibility test, and silently lost its Wars topic.
 * Worse, the merged pack's row is COMPATIBLE with nothing those Formulas allow,
 * while `hidden-mechanics-of-history` channels store the BARE legacy id, which
 * the archival-ledger Formula's allow-list never named — dropped even with no
 * merged pack installed.
 *
 * The rules pinned here:
 *   1. the allow-list is compared through `resolveTopicPackAlias` on both sides;
 *   2. a merged item that cannot serve this Formula falls back to the pack the
 *      stored id came from (never to a pack that was not the selection's source);
 *   3. the list offers one row per topic, unless the merged item cannot serve the
 *      Formula it is read for;
 *   4. every dropped selection is reported, so a job can say what happened;
 *   5. composing writes nothing.
 *
 * The pack documents are the REAL authored sources, so the 122-subject figure is
 * the shipped content, not a fixture.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import * as niches from '../services/niche-loader.js'
import * as topics from '../services/topic-pack-loader.js'
import { useTempDataDir } from './_helpers.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.wars-merge-test'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const MERGED_PACK_ID = 'com.storystudio.pack.topic.wars-treaties-world-order-v2'
const MERGED_ITEM_ID = 'com.storystudio.topic.wars-treaties-world-order-v2'
const LEGACY_SHORT_ID = 'historical-wars-treaties-world-order'
const FREE_ITEM_ID = 'com.storystudio.topic.historical-wars-treaties-world-order'
const ARCHIVAL_ITEM_ID = 'com.storystudio.topic.archival-ledger.wars-treaties-world-order'

const SOURCES = {
  merged_1_0_1: 'content-packs/rebuilt/topic/wars-treaties-world-order-v2-v1.0.1/content/topic-pack.json',
  merged_1_0_2: 'content-packs/rebuilt/topic/wars-treaties-world-order-v2-v1.0.2/content/topic-pack.json',
  free_old: 'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.3/content/topic-pack.json',
  archival_old: 'content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.2/content/topic-pack.json',
  history_formula: 'content-packs/free-starters/formula/history-explained-v1.0.2/content/series-formula.json',
  archival_formula: 'content-packs/paid/archival-ledger/formula/archival-ledger/content/series-formula.json',
} as const

async function sourceDocument(relativePath: string): Promise<ContentPackDocument> {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), 'utf8'))
}

async function signedArchive(document: ContentPackDocument, packId: string, version: string): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify(document))
  const contentPath = 'content/topic-pack.json'
  const contentDocument = document as unknown as Record<string, unknown>
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: packId,
    publisher_id: publisherId,
    key_id: keyId,
    version,
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: contentDocument.id, kind: 'topic-pack', schema_version: 1, path: contentPath }],
    files: [{ path: contentPath, sha256: digest(content), bytes: content.byteLength, mime: 'application/json' }],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  zip.file(contentPath, content, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function freshDataDir() {
  const temporary = await useTempDataDir()
  topics.invalidateTopicPackCache()
  const options = { paths: getContentPackRuntimePaths(), policy, appVersion: '1.4.371' }
  return { temporary, options }
}

async function install(options: Awaited<ReturnType<typeof freshDataDir>>['options'], relativePath: string, packId: string, version: string) {
  const archiveBytes = await signedArchive(await sourceDocument(relativePath), packId, version)
  await installContentPack({ archiveBytes, source: 'local-import' }, options)
}

async function historyFormula() {
  return contentPackDocumentToNiche((await sourceDocument(SOURCES.history_formula)) as never)
}

async function archivalFormula() {
  return contentPackDocumentToNiche((await sourceDocument(SOURCES.archival_formula)) as never)
}

function assertUsableSubjects(pack: { subjects?: string[] } | undefined, expected: number): void {
  assert.ok(pack, 'a Topic Pack was composed')
  assert.equal(pack.subjects?.length, expected, `the pack carries ${expected} subjects`)
  assert.ok((pack.subjects ?? []).some(subject => typeof subject === 'string' && subject.trim().length > 0),
    'the subjects are real text, not an empty list that happens to count')
}

// ── 1. the merged pack serves the v1 Formulas ──────────────────────────────

test('a v1 History channel with the bare legacy Wars id composes merged 1.0.2 (122 subjects)', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_2, MERGED_PACK_ID, '1.0.2')

  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await historyFormula(), [LEGACY_SHORT_ID], options)

  assert.deepEqual(composed.droppedTopicPacks, [], 'nothing was dropped')
  assert.equal(composed.niche.activeTopicPacks?.length, 1)
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 122)
})

test('a v1 History channel naming the merged item id composes merged 1.0.2', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_2, MERGED_PACK_ID, '1.0.2')

  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await historyFormula(), [MERGED_ITEM_ID], options)

  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 122)
})

test('a v1 archival-ledger channel with the bare legacy Wars id composes merged 1.0.2', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_2, MERGED_PACK_ID, '1.0.2')

  // `hidden-mechanics-of-history` channels store the BARE legacy id, and the
  // archival-ledger Formula's allow-list names only its own `archival-ledger.*`
  // ids — so before this fix the id was dropped by the allow-list check itself.
  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await archivalFormula(), [LEGACY_SHORT_ID], options)

  assert.deepEqual(composed.droppedTopicPacks, [])
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 122)
})

// ── 2. the compatibility fallback ──────────────────────────────────────────

test('with merged 1.0.1 installed a v1 History channel composes the OLD pack instead of losing the topic', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')

  for (const stored of [LEGACY_SHORT_ID, FREE_ITEM_ID]) {
    const composed = await niches.composeNicheWithTopicPacksDetailed(await historyFormula(), [stored], options)
    assert.deepEqual(composed.droppedTopicPacks, [], `${stored}: the fallback is not a drop`)
    assert.equal(composed.niche.activeTopicPacks?.[0]?.id, FREE_ITEM_ID, `${stored}: the old pack answers`)
    assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 50)
  }
})

test('with no merged pack at all a v1 archival-ledger channel composes the OLD archival pack', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.archival_old, 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order', '1.0.2')

  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await archivalFormula(), [LEGACY_SHORT_ID], options)

  assert.deepEqual(composed.droppedTopicPacks, [])
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, ARCHIVAL_ITEM_ID)
  assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 100)
})

test('a pack the Formula never allowed is dropped and reported, not substituted', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  const foreign = await sourceDocument(SOURCES.free_old)
  foreign.id = 'com.storystudio.topic.natural-world-animals'
  foreign.name = 'Some Other Subject'
  await installContentPack({
    archiveBytes: await signedArchive(foreign, 'com.storystudio.pack.topic.natural-world-animals', '1.0.0'),
    source: 'local-import',
  }, options)

  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await historyFormula(), [foreign.id, 'com.storystudio.topic.not-installed'], options)

  assert.deepEqual(composed.niche.activeTopicPacks, [], 'nothing served a Formula it was never allowed by')
  assert.deepEqual(composed.droppedTopicPacks, [
    { id: foreign.id, reason: 'not-allowed' },
    { id: 'com.storystudio.topic.not-installed', reason: 'not-found' },
  ])
})

// ── 3. the list offers one row per topic ───────────────────────────────────

test('the list hides the two superseded rows while the merged pack is listed', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')
  await install(options, SOURCES.archival_old, 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order', '1.0.2')
  await install(options, SOURCES.merged_1_0_2, MERGED_PACK_ID, '1.0.2')

  const listed = (await topics.listTopicPackCatalogEntries(options)).map(entry => entry.value.id)
  assert.deepEqual(listed, [MERGED_ITEM_ID], 'one row for one topic')
})

test('the list keeps the old rows while the merged pack is not installed', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')
  await install(options, SOURCES.archival_old, 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order', '1.0.2')

  const listed = (await topics.listTopicPackCatalogEntries(options)).map(entry => entry.value.id).sort()
  assert.deepEqual(listed, [ARCHIVAL_ITEM_ID, FREE_ITEM_ID].sort())
})

test('a v1 Formula scope keeps the old row visible when the merged pack cannot serve it', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

  const formulaId = (await historyFormula()).id
  const scoped = (await topics.listTopicPackCatalogEntries(options, formulaId)).map(entry => entry.value.id)
  assert.ok(scoped.includes(FREE_ITEM_ID), 'the pack that serves this Formula is still offered')

  // Once the merged pack can serve the Formula, the old row is hidden again.
  await install(options, SOURCES.merged_1_0_2, MERGED_PACK_ID, '1.0.2')
  const after = (await topics.listTopicPackCatalogEntries(options, formulaId)).map(entry => entry.value.id)
  assert.deepEqual(after, [MERGED_ITEM_ID])
})

// ── 4. composing writes nothing ────────────────────────────────────────────

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.isFile()) out[path.relative(root, target)] = digest(await fs.readFile(target))
    }
  }
  await walk(root)
  return out
}

test('composing a channel writes no project metadata and no pack state', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_2, MERGED_PACK_ID, '1.0.2')

  const before = await snapshot(temporary.dir)
  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await historyFormula(), [LEGACY_SHORT_ID], options)
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assert.deepEqual(await snapshot(temporary.dir), before,
    'resolving a stored id rewrites no file: no state, no pin, no project metadata')
})

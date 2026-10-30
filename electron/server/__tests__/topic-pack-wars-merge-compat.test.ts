/**
 * The merged Wars, Treaties & World Order Topic Pack, the Formulas that read it,
 * and the move every channel is making to the v2 Formulas.
 *
 * OWNER DECISION 2026-10-30: every channel moves to the v2 Formulas and script
 * changes are accepted, so v1 Formulas are no longer first-class and the 1.0.2
 * compatibility widening was retired before publication. What still has to hold:
 *
 *   - EPISODES STORE OLD WARS IDS (Boundful stores the free item id;
 *     hidden-mechanics-of-history stores the BARE legacy id). A v2 Formula must
 *     accept them, which is why the allow-list compares `resolveTopicPackAlias`
 *     on BOTH sides — the old id and the Formula's own allow entry both read as
 *     the merged item.
 *   - Before a channel moves, the merged pack must not vanish from it: the
 *     pre-alias pack answers when the merged item cannot serve that Formula
 *     (`loadSupersededTopicPack`) — including the bare legacy id, which the
 *     archival-ledger v1 Formula's allow-list never named.
 *   - A pack the Formula never allowed is still dropped, and every drop is said.
 *   - The list offers one row per topic; the removal veto reads each episode's
 *     own selection; composing writes nothing.
 *
 * The pack documents are the REAL authored sources, so the 122-subject figure is
 * the shipped content, not a fixture. The v2 Formula sources are published from
 * the shelf and are not in this repository, so the two synthetic v2 Formulas
 * below pin the MECHANISM (either allow-list spelling), not their live content.
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

/** A v1 Formula, as a channel that has not moved yet still reads it. */
async function v1Formula(which: 'history' | 'archival') {
  return contentPackDocumentToNiche((await sourceDocument(which === 'history' ? SOURCES.history_formula : SOURCES.archival_formula)) as never)
}

/**
 * A v2 Formula. The published sources are not in this repository, so each one is
 * the v1 document under the v2 id with a chosen allow-list — the two spellings
 * that exist in the wild: the old Wars id an episode stores, and the merged item
 * its packed successor names.
 */
async function v2Formula(which: 'history' | 'archival', allowedWarsId: string) {
  const base = await sourceDocument(which === 'history' ? SOURCES.history_formula : SOURCES.archival_formula)
  const document = {
    ...base,
    id: which === 'history'
      ? 'com.storystudio.formula.history-explained-v2'
      : 'com.storystudio.formula.archival-ledger-v2',
    compatible_topic_pack_ids: [...new Set([...(base as unknown as { compatible_topic_pack_ids: string[] }).compatible_topic_pack_ids, allowedWarsId])],
  }
  return contentPackDocumentToNiche(document as never)
}

function assertUsableSubjects(pack: { subjects?: string[] } | undefined, expected: number): void {
  assert.ok(pack, 'a Topic Pack was composed')
  assert.equal(pack.subjects?.length, expected, `the pack carries ${expected} subjects`)
  assert.ok((pack.subjects ?? []).some(subject => typeof subject === 'string' && subject.trim().length > 0),
    'the subjects are real text, not an empty list that happens to count')
}

// ── 1. a v2 Formula accepts the ids episodes already store ────────────────

test('a v2 History Formula allows the old Wars item id its episodes store', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

  // The allow-list names the OLD free item id; the merged pack names the v2
  // Formula. Both sides of the check resolve the old Wars ids through the table.
  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await v2Formula('history', FREE_ITEM_ID), [FREE_ITEM_ID], options)

  assert.deepEqual(composed.droppedTopicPacks, [], 'the old id is allowed')
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 122)
})

test('a v2 Formula whose allow-list names the merged item still accepts the BARE legacy id', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

  for (const which of ['history', 'archival'] as const) {
    for (const stored of [LEGACY_SHORT_ID, MERGED_ITEM_ID]) {
      const composed = await niches.composeNicheWithTopicPacksDetailed(
        await v2Formula(which, MERGED_ITEM_ID), [stored], options)
      assert.deepEqual(composed.droppedTopicPacks, [], `${which} + ${stored}`)
      assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID, `${which} + ${stored} reads the merged pack`)
    }
  }
})

test('a v2 archival Formula allows the bare legacy id through its archival-ledger allow entry', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

  // The archival v1 Formula's allow-list names its own `archival-ledger.*` Wars
  // id, never the bare legacy id that its episodes store. Aliases on both sides
  // are what makes the bare id pass.
  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await v2Formula('archival', ARCHIVAL_ITEM_ID), [LEGACY_SHORT_ID], options)

  assert.deepEqual(composed.droppedTopicPacks, [])
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 122)
})

// ── 2. the safe state before a channel moves ──────────────────────────────

test('a v1 History channel with the merged pack installed composes the OLD pack instead of losing the topic', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')

  for (const stored of [LEGACY_SHORT_ID, FREE_ITEM_ID]) {
    const composed = await niches.composeNicheWithTopicPacksDetailed(await v1Formula('history'), [stored], options)
    assert.deepEqual(composed.droppedTopicPacks, [], `${stored}: the fallback is not a drop`)
    assert.equal(composed.niche.activeTopicPacks?.[0]?.id, FREE_ITEM_ID, `${stored}: the old pack answers`)
    assertUsableSubjects(composed.niche.activeTopicPacks?.[0], 50)
  }
})

test('a v1 archival-ledger channel composes the OLD archival pack (its allow-list never named the bare id)', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.archival_old, 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order', '1.0.2')

  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await v1Formula('archival'), [LEGACY_SHORT_ID], options)

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
    await v2Formula('history', MERGED_ITEM_ID), [foreign.id, 'com.storystudio.topic.not-installed'], options)

  assert.deepEqual(composed.niche.activeTopicPacks, [], 'nothing served a Formula it was never allowed by')
  assert.deepEqual(composed.droppedTopicPacks, [
    { id: foreign.id, reason: 'not-allowed' },
    { id: 'com.storystudio.topic.not-installed', reason: 'not-allowed' },
  ])
})

// ── 3. the list offers one row per topic ───────────────────────────────────

test('the list hides the two superseded rows while the merged pack is listed', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')
  await install(options, SOURCES.archival_old, 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order', '1.0.2')
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

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

test('a v1 Formula scope keeps the old row visible while the merged pack cannot serve it', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await install(options, SOURCES.free_old, 'com.storystudio.pack.topic.historical-wars-treaties-world-order', '1.0.3')
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

  const formulaId = (await v1Formula('history')).id
  const scoped = (await topics.listTopicPackCatalogEntries(options, formulaId)).map(entry => entry.value.id)
  assert.ok(scoped.includes(FREE_ITEM_ID), 'the pack that serves this Formula is still offered')

  // A v2 Formula can use the merged pack, so the old row is hidden there.
  const v2 = (await topics.listTopicPackCatalogEntries(options, 'com.storystudio.formula.history-explained-v2'))
    .map(entry => entry.value.id)
  assert.deepEqual(v2, [MERGED_ITEM_ID])
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
  await install(options, SOURCES.merged_1_0_1, MERGED_PACK_ID, '1.0.1')

  const before = await snapshot(temporary.dir)
  const composed = await niches.composeNicheWithTopicPacksDetailed(
    await v2Formula('history', FREE_ITEM_ID), [FREE_ITEM_ID], options)
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, MERGED_ITEM_ID)
  assert.deepEqual(await snapshot(temporary.dir), before,
    'resolving a stored id rewrites no file: no state, no pin, no project metadata')
})

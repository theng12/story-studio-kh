/**
 * The v2 Topic family and the move every channel is making to the v2 Formulas.
 *
 * OWNER DECISION 2026-10-30. Every v2 Formula's allow-list names `-v2` topic
 * items and every v2 Topic Pack accepts only `-v2` Formulas, but an EPISODE keeps
 * the v1 item id it was written with (`episode_info.json`, never rewritten —
 * AGENTS §5). Without a successor lookup, every moved channel's episodes would
 * lose their topic the first time they were read under the v2 Formula.
 *
 * The successor is DATA (`TOPIC_PACK_V2_SUCCESSORS`), never string parsing: an
 * entry is inert unless a pack publishes that exact id. A channel still on a v1
 * Formula keeps its v1 pack, because a v2 pack is not compatible with it and the
 * lookup only runs after the stored pack has been refused.
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

const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.v2-successor-test'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const V1_ITEM = 'com.storystudio.topic.food-histories'
const V2_ITEM = 'com.storystudio.topic.food-histories-v2'
const BARE_LEGACY_ITEM = 'com.storystudio.topic.natural-world-animals'
const BARE_LEGACY_ITEM_V2 = 'com.storystudio.topic.natural-world-animals-v2'
const V1_FORMULA = 'com.storystudio.formula.sleep-history-compilation'
const V2_FORMULA = 'com.storystudio.formula.sleep-history-compilation-v2'

function topicDocument(id: string, compatibleFormulaIds: string[], subject: string): ContentPackDocument {
  return {
    kind: 'topic-pack',
    schema_version: 1,
    id,
    name: `Test ${id.split('.').pop()}`,
    description: 'A test topic pack.',
    compatible_formula_ids: compatibleFormulaIds,
    subjects: [subject],
    episode_objects: [`${subject} object`],
    time_place_scopes: [`${subject} scope`],
    mechanisms: [`${subject} mechanism`],
    evidence_lenses: [`${subject} lens`],
    exclusions: [],
    max_siblings_per_subject: 20,
    prompt_context: 'Explain causes, not spectacle.',
  } as unknown as ContentPackDocument
}

function formulaDocument(id: string, compatibleTopicPackIds: string[]): ContentPackDocument {
  return {
    kind: 'series-formula',
    schema_version: 1,
    id,
    name: `Formula ${id.split('.').pop()}`,
    description: 'A test formula.',
    formula_family: 'Test',
    compatible_topic_pack_ids: compatibleTopicPackIds,
    example_topics: ['An example'],
  } as unknown as ContentPackDocument
}

function packIdFor(itemId: string): string {
  return `com.storystudio.pack${itemId.slice('com.storystudio'.length)}`
}

async function signedArchive(document: ContentPackDocument, packId: string, version: string): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify(document))
  const contentPath = `content/${document.kind === 'topic-pack' ? 'topic-pack' : 'series-formula'}.json`
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
    items: [{ id: (document as unknown as { id: string }).id, kind: document.kind, schema_version: 1, path: contentPath }],
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

async function installTopic(options: Awaited<ReturnType<typeof freshDataDir>>['options'], document: ContentPackDocument) {
  await installContentPack({
    archiveBytes: await signedArchive(document, packIdFor(document.id as unknown as string), '1.0.0'),
    source: 'local-import',
  }, options)
}

const v1Niche = () => contentPackDocumentToNiche(formulaDocument(V1_FORMULA, [V1_ITEM, BARE_LEGACY_ITEM]) as never)
const v2Niche = () => contentPackDocumentToNiche(formulaDocument(V2_FORMULA, [V2_ITEM, BARE_LEGACY_ITEM_V2]) as never)

function assertSubjects(pack: { subjects?: string[] } | undefined, expected: string): void {
  assert.ok(pack, 'a pack was composed')
  assert.deepEqual(pack.subjects, [expected], 'the subjects are the pack\'s real content')
}

// ── a moved channel reads the v2 item for the id its episodes stored ───────

test('a v2 Formula composes the v2 pack for the v1-qualified id, the bare legacy id and the v2 id', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await installTopic(options, topicDocument(V1_ITEM, [V1_FORMULA], 'The history of bread'))
  await installTopic(options, topicDocument(V2_ITEM, [V2_FORMULA], 'The history of bread, rewritten'))
  await installTopic(options, topicDocument(BARE_LEGACY_ITEM, [V1_FORMULA], 'Mammals'))
  await installTopic(options, topicDocument(BARE_LEGACY_ITEM_V2, [V2_FORMULA], 'Mammals, rewritten'))

  for (const stored of [V1_ITEM, V2_ITEM]) {
    const composed = await niches.composeNicheWithTopicPacksDetailed(await v2Niche(), [stored], options)
    assert.deepEqual(composed.droppedTopicPacks, [], `${stored} is not dropped`)
    assert.equal(composed.niche.activeTopicPacks?.[0]?.id, V2_ITEM, `${stored} reads the v2 item`)
    assertSubjects(composed.niche.activeTopicPacks?.[0], 'The history of bread, rewritten')
  }

  // A BARE LEGACY id that the alias table already resolves to a qualified id.
  const bare = await niches.composeNicheWithTopicPacksDetailed(await v2Niche(), ['natural-world-animals'], options)
  assert.equal(bare.niche.activeTopicPacks?.[0]?.id, BARE_LEGACY_ITEM_V2)
  assertSubjects(bare.niche.activeTopicPacks?.[0], 'Mammals, rewritten')
})

test('a v1 Formula keeps its v1 pack even though the v2 pack is installed', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await installTopic(options, topicDocument(V1_ITEM, [V1_FORMULA], 'The history of bread'))
  await installTopic(options, topicDocument(V2_ITEM, [V2_FORMULA], 'The history of bread, rewritten'))

  const composed = await niches.composeNicheWithTopicPacksDetailed(await v1Niche(), [V1_ITEM], options)
  assert.deepEqual(composed.droppedTopicPacks, [])
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, V1_ITEM)
  assertSubjects(composed.niche.activeTopicPacks?.[0], 'The history of bread')
})

test('with no v2 pack installed the moved channel is refused today\'s way and told why', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await installTopic(options, topicDocument(V1_ITEM, [V1_FORMULA], 'The history of bread'))

  const composed = await niches.composeNicheWithTopicPacksDetailed(await v2Niche(), [V1_ITEM], options)
  assert.deepEqual(composed.niche.activeTopicPacks, [])
  assert.equal(composed.droppedTopicPacks.length, 1)
  assert.equal(composed.droppedTopicPacks[0]?.id, V1_ITEM)
  assert.equal(composed.droppedTopicPacks[0]?.reason, 'incompatible')
})

test('a topic the Formula never allowed is still dropped, even with a v2 pack installed', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await installTopic(options, topicDocument(V2_ITEM, [V2_FORMULA], 'The history of bread, rewritten'))

  const composed = await niches.composeNicheWithTopicPacksDetailed(await v2Niche(), ['com.storystudio.topic.fungi-v2'], options)
  assert.deepEqual(composed.niche.activeTopicPacks, [])
  assert.deepEqual(composed.droppedTopicPacks, [{ id: 'com.storystudio.topic.fungi-v2', reason: 'not-allowed' }])
})

// ── the list shows one row per topic ──────────────────────────────────────

test('the list hides the v1 row while the v2 row is listed, and keeps it for a v1 Formula', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await installTopic(options, topicDocument(V1_ITEM, [V1_FORMULA], 'The history of bread'))
  await installTopic(options, topicDocument(V2_ITEM, [V2_FORMULA], 'The history of bread, rewritten'))

  const unscoped = (await topics.listTopicPackCatalogEntries(options)).map(entry => entry.value.id)
  assert.deepEqual(unscoped, [V2_ITEM], 'one row for one topic')

  const v1Scope = (await topics.listTopicPackCatalogEntries(options, V1_FORMULA)).map(entry => entry.value.id)
  assert.deepEqual(v1Scope, [V1_ITEM], 'a channel still on the v1 Formula still sees its pack')

  const v2Scope = (await topics.listTopicPackCatalogEntries(options, V2_FORMULA)).map(entry => entry.value.id)
  assert.deepEqual(v2Scope, [V2_ITEM])
})

// ── composing writes nothing ──────────────────────────────────────────────

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

test('resolving a stored v1 id to its v2 successor rewrites no file', async t => {
  const { temporary, options } = await freshDataDir()
  t.after(temporary.cleanup)
  await installTopic(options, topicDocument(V1_ITEM, [V1_FORMULA], 'The history of bread'))
  await installTopic(options, topicDocument(V2_ITEM, [V2_FORMULA], 'The history of bread, rewritten'))

  const before = await snapshot(temporary.dir)
  const composed = await niches.composeNicheWithTopicPacksDetailed(await v2Niche(), [V1_ITEM], options)
  assert.equal(composed.niche.activeTopicPacks?.[0]?.id, V2_ITEM)
  assert.deepEqual(await snapshot(temporary.dir), before, 'no state, pin or project metadata is written')
})

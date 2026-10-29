/**
 * Legacy Topic Pack ids read as the pack item that now owns the content —
 * WITHOUT a migration, and WITHOUT being listed.
 *
 * Owner ruling, 2026-10-29 — "no custom, no built in, all from packs": the
 * Topic Pack picker lists what the installed Content Packs publish. The shipped
 * `electron/server/topic-packs/*.json` files and the owner's forks stay on disk
 * and still answer a stored id, but they are not offered.
 *
 * Three things this pins, because each one failing is a different defect:
 *   1. the read-time alias table is exactly the `topic:` rows of
 *      `content-packs/legacy-migration-dispositions.json`, so it cannot drift
 *      from the ledger that justifies it;
 *   2. a stored id reads the pack item first and its old source second — never
 *      nothing;
 *   3. a superseded item id reads the merged pack (most context) and still
 *      resolves through the pack that owns it when the merged one is absent.
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
import * as topics from '../services/topic-pack-loader.js'
import { useTempDataDir } from './_helpers.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.topic-alias-test'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// ── the merged pack and its two superseded predecessors ────────────────────

const MERGED_PACK_ID = 'com.storystudio.pack.topic.wars-treaties-world-order-v2'
const MERGED_ITEM_ID = 'com.storystudio.topic.wars-treaties-world-order-v2'
const FREE_ITEM_ID = 'com.storystudio.topic.historical-wars-treaties-world-order'
const ARCHIVAL_ITEM_ID = 'com.storystudio.topic.archival-ledger.wars-treaties-world-order'

/** The two ids below are the aliases that are NOT derived from the ledger. */
const SUPERSEDED_ITEM_ALIASES: Readonly<Record<string, string>> = {
  [FREE_ITEM_ID]: MERGED_ITEM_ID,
  [ARCHIVAL_ITEM_ID]: MERGED_ITEM_ID,
}

function topicDocument(id: string, name: string, subject: string): ContentPackDocument {
  return {
    kind: 'topic-pack',
    schema_version: 1,
    id,
    name,
    description: `${name} test content.`,
    compatible_formula_ids: ['com.storystudio.formula.history-explained'],
    subjects: [subject],
    episode_objects: [`${subject} object`],
    time_place_scopes: [`${subject} period`],
    mechanisms: [`${subject} mechanism`],
    evidence_lenses: [`${subject} evidence`],
    exclusions: [],
    max_siblings_per_subject: 20,
    prompt_context: 'Explain causes, not spectacle.',
  }
}

async function signedArchive(
  packId: string,
  document: ContentPackDocument,
  lifecycle: 'active' | 'replaced' = 'active',
  successor?: string,
): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify(document))
  const contentPath = 'content/topic-pack.json'
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: packId,
    publisher_id: publisherId,
    key_id: keyId,
    version: lifecycle === 'replaced' ? '1.0.2' : '1.0.0',
    min_app_version: '1.0.0',
    lifecycle,
    ...(successor ? { successor_pack_id: successor } : {}),
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: document.id, kind: document.kind, schema_version: 1, path: contentPath }],
    files: [{ path: contentPath, sha256: digest(content), bytes: content.byteLength, mime: 'application/json' }],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  zip.file(contentPath, content, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function installPack(
  document: ContentPackDocument,
  packId: string,
  lifecycle: 'active' | 'replaced' = 'active',
  successor?: string,
) {
  const temporary = await useTempDataDir()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths: getContentPackRuntimePaths(), policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack(
    { archiveBytes: await signedArchive(packId, document, lifecycle, successor), source: 'local-import' },
    options,
  )
  return { temporary, options }
}

// ── 1. the table is the ledger, made executable ────────────────────────────

test('the topic alias table is exactly the migration ledger, plus the two superseded item ids', async () => {
  const ledger = JSON.parse(await fs.readFile(
    path.join(ROOT, 'content-packs', 'legacy-migration-dispositions.json'), 'utf8'))

  const derived: Record<string, string> = {}
  for (const entry of ledger.dispositions) {
    if (typeof entry.legacy_key !== 'string' || !entry.legacy_key.startsWith('topic:')) continue
    const legacyId = entry.legacy_key.slice('topic:'.length)
    const sourceDirectory = path.join(ROOT, entry.target.source_path, 'content')
    const names = (await fs.readdir(sourceDirectory)).filter(name => name.endsWith('.json'))
    const documents = await Promise.all(names.map(async (name) =>
      JSON.parse(await fs.readFile(path.join(sourceDirectory, name), 'utf8'))))
    const documentsOfKind = documents.filter(document => document.kind === 'topic-pack')
    assert.equal(documentsOfKind.length, 1,
      `${entry.legacy_key} must point at a source with exactly one Topic Pack document`)
    derived[legacyId] = documentsOfKind[0].id
  }
  assert.ok(Object.keys(derived).length > 0, 'the ledger must carry topic dispositions')

  const table = topics.LEGACY_TOPIC_PACK_ALIASES
  // Everything the ledger says, minus the entries this change adds on top of it.
  const tableMinusSuperseded = Object.fromEntries(
    Object.entries(table).filter(([legacyId]) => !(legacyId in SUPERSEDED_ITEM_ALIASES)))
  assert.deepEqual(tableMinusSuperseded, derived,
    'the alias table drifted from content-packs/legacy-migration-dispositions.json')

  // The superseded item ids are the one deliberate addition, and they must land
  // on the merged pack — the one with the most context (owner, 2026-10-29).
  for (const [legacyId, target] of Object.entries(SUPERSEDED_ITEM_ALIASES)) {
    assert.equal(table[legacyId], target, `${legacyId} must read as ${target}`)
  }
  assert.equal(table['historical-wars-treaties-world-order'], MERGED_ITEM_ID,
    'the legacy short id must read the merged pack, not the archival-ledger 1.0.1 disposition')
  assert.equal(topics.resolveTopicPackAlias('natural-world-animals'), 'com.storystudio.topic.natural-world-animals')
  assert.equal(topics.resolveTopicPackAlias('no-such-pack'), 'no-such-pack', 'unknown ids pass through')
})

// ── 2. a stored legacy id reads the installed pack ────────────────────────

test('a stored legacy id reads the installed pack item, not the shipped file', async t => {
  const { temporary, options } = await installPack(topicDocument(MERGED_ITEM_ID, 'Merged Wars', 'Treaty of Vienna'), MERGED_PACK_ID)
  t.after(temporary.cleanup)

  const short = await topics.loadTopicPack('historical-wars-treaties-world-order', options)
  assert.equal(short?.id, MERGED_ITEM_ID, 'the bare legacy id must resolve to the pack item')
  assert.equal(short?.name, 'Merged Wars')
  assert.deepEqual(short?.subjects, ['Treaty of Vienna'], 'content must come from the pack, not the legacy file')

  for (const itemId of [FREE_ITEM_ID, ARCHIVAL_ITEM_ID]) {
    const resolved = await topics.loadTopicPack(itemId, options)
    assert.equal(resolved?.id, MERGED_ITEM_ID, `${itemId} must read the merged pack`)
  }
})

// ── 3. without the pack the old source still answers ──────────────────────

test('without the pack installed the legacy file still answers, so a channel keeps its Topic Pack', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  topics.invalidateTopicPackCache()

  const legacy = await topics.loadTopicPack('natural-world-animals')
  assert.equal(legacy?.id, 'natural-world-animals', 'the shipped source is the fallback when no pack is installed')
  assert.ok((legacy?.subjects.length ?? 0) > 0)

  const wars = await topics.loadTopicPack('historical-wars-treaties-world-order')
  assert.equal(wars?.id, 'historical-wars-treaties-world-order', 'the legacy Wars pack still answers')
})

test('a superseded item id falls back to the pack that owns it when the merged pack is absent', async t => {
  const { temporary, options } = await installPack(
    topicDocument(ARCHIVAL_ITEM_ID, 'Archival Wars', 'Congress of Berlin'),
    'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order',
  )
  t.after(temporary.cleanup)

  const resolved = await topics.loadTopicPack(ARCHIVAL_ITEM_ID, options)
  assert.equal(resolved?.id, ARCHIVAL_ITEM_ID, 'with no merged pack the owning pack still serves the selection')
  assert.equal(resolved?.name, 'Archival Wars')
})

// ── 4. a replaced pack is hidden but never withdrawn ──────────────────────

test('a replaced pack is not listed and still resolves, so an installed copy keeps working', async t => {
  const { temporary, options } = await installPack(
    topicDocument(ARCHIVAL_ITEM_ID, 'Superseded Wars', 'Congress of Berlin'),
    'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order',
    'replaced',
    MERGED_PACK_ID,
  )
  t.after(temporary.cleanup)

  const listed = (await topics.listTopicPackCatalogEntries(options)).map(entry => entry.value.id)
  assert.equal(listed.includes(ARCHIVAL_ITEM_ID), false, 'a superseded product is not offered any more')

  const resolved = await topics.loadTopicPack(ARCHIVAL_ITEM_ID, options)
  assert.equal(resolved?.id, ARCHIVAL_ITEM_ID, 'the pack a customer installed still answers')
  assert.equal(resolved?.name, 'Superseded Wars')
})

// ── 5. the picker lists pack items only ───────────────────────────────────

test('the Topic Pack list is the installed packs, and never a built-in or a saved entry', async t => {
  const { temporary, options } = await installPack(topicDocument(MERGED_ITEM_ID, 'Merged Wars', 'Treaty of Vienna'), MERGED_PACK_ID)
  t.after(temporary.cleanup)

  const listed = (await topics.listTopicPackCatalogEntries(options)).map(entry => entry.value.id)
  assert.ok(listed.includes(MERGED_ITEM_ID), 'the installed pack item is listed')
  assert.equal(listed.includes('natural-world-animals'), false,
    'a shipped profile is not listed beside the pack that replaces it (owner, 2026-10-29)')
  assert.equal(listed.includes('historical-wars-treaties-world-order'), false, 'the legacy short id is not listed')
  for (const itemId of [FREE_ITEM_ID, ARCHIVAL_ITEM_ID]) {
    assert.equal(listed.includes(itemId), false, `${itemId} is superseded and must not be offered`)
  }
  // Everything listed still resolves — a list entry the app cannot load is worse
  // than an absent one (AGENTS §6).
  for (const entry of await topics.listTopicPackCatalogEntries(options)) {
    assert.ok(entry.value.subjects.length > 0, `${entry.value.id} must resolve to usable content`)
  }
})

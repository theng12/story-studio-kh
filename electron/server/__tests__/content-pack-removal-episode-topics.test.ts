/**
 * Removing a Content Pack an EPISODE reads.
 *
 * Topic selection is stored per episode: an accepted idea writes its own
 * `topic_pack_ids` and `series_formula_id` into `episode_info.json`, and many
 * channels carry no `topic_pack_ids` in config.json at all (measured on the
 * mini: Boundful EP0145–EP0154 store the free Wars item id;
 * hidden-mechanics-of-history stores the BARE legacy id on 20 episodes).
 *
 * The removal veto therefore has to read the episode files, and it has to apply
 * the same read rules a generator does — the merged item first, the pack the
 * stored id came from when the merged one cannot serve that Formula. And it must
 * NOT over-veto: the old pack is removable while the merged pack is what is
 * actually read.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { ContentPackRemovalError, contentPackUsage, removeContentPack } from '../content-packs/removal.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { projectsRoot } from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.key.wars-episode-removal'
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const MERGED_PACK_ID = 'com.storystudio.pack.topic.wars-treaties-world-order-v2'
const MERGED_ITEM_ID = 'com.storystudio.topic.wars-treaties-world-order-v2'
const LEGACY_SHORT_ID = 'historical-wars-treaties-world-order'
const FREE_PACK_ID = 'com.storystudio.pack.topic.historical-wars-treaties-world-order'
const FREE_ITEM_ID = 'com.storystudio.topic.historical-wars-treaties-world-order'

const SOURCES = {
  merged: 'content-packs/rebuilt/topic/wars-treaties-world-order-v2-v1.0.1/content/topic-pack.json',
  free_old: 'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.3/content/topic-pack.json',
}

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return getContentPackRuntimePaths()
}

async function install(paths: ReturnType<typeof getContentPackRuntimePaths>, sourcePath: string, packId: string, version: string) {
  const document: ContentPackDocument = JSON.parse(await fs.readFile(path.join(ROOT, sourcePath), 'utf8'))
  const content = Buffer.from(JSON.stringify(document))
  const contentPath = 'content/topic-pack.json'
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: packId,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version,
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: (document as unknown as { id: string }).id, kind: 'topic-pack', schema_version: 1, path: contentPath }],
    files: [{ path: contentPath, sha256: sha256(content), bytes: content.byteLength, mime: 'application/json' }],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file(contentPath, content, { createFolders: false })
  const archiveBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
  await installContentPack({ archiveBytes, source: 'local-import' }, { paths, policy, appVersion: '1.4.371' })
}

/** A channel folder as the app finds one: project.json + config.json (no topic packs in config). */
async function channel(slug: string, config: Record<string, unknown>): Promise<void> {
  const dir = path.join(projectsRoot(), slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ slug, name: slug, created_at: new Date(0).toISOString() }))
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
}

/** One accepted episode's own record — where a channel really stores its topic selection. */
async function episode(slug: string, code: string, info: Record<string, unknown>): Promise<void> {
  const dir = path.join(projectsRoot(), slug, 'episodes', 'Season 001', `${code} - Test Episode`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'episode_info.json'), JSON.stringify({ episode_code: code, ...info }))
}

/** A minimal topic document, for the v2-successor case. */
function topicDocument(id: string, compatibleFormulaIds: string[]): ContentPackDocument {
  return {
    kind: 'topic-pack', schema_version: 1, id, name: `Test ${id.split('.').pop()}`, description: 'A test topic pack.',
    compatible_formula_ids: compatibleFormulaIds, subjects: ['A subject'],
    episode_objects: ['object'], time_place_scopes: ['scope'], mechanisms: ['mechanism'],
    evidence_lenses: ['lens'], exclusions: [], max_siblings_per_subject: 20,
    prompt_context: 'Explain causes, not spectacle.',
  } as unknown as ContentPackDocument
}

async function installDocument(
  paths: ReturnType<typeof getContentPackRuntimePaths>,
  document: ContentPackDocument,
  packId: string,
): Promise<void> {
  const content = Buffer.from(JSON.stringify(document))
  const contentPath = 'content/topic-pack.json'
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version: '1.0.0',
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: [{ id: (document as unknown as { id: string }).id, kind: 'topic-pack', schema_version: 1, path: contentPath }],
    files: [{ path: contentPath, sha256: sha256(content), bytes: content.byteLength, mime: 'application/json' }],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file(contentPath, content, { createFolders: false })
  const archiveBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
  await installContentPack({ archiveBytes, source: 'local-import' }, { paths, policy, appVersion: '1.4.371' })
}

describe('an episode-level Topic Pack selection counts as a use', () => {
  test('a bare legacy id on an episode vetoes removing the merged pack it reads', async () => {
    const paths = await isolated()
    await install(paths, SOURCES.merged, MERGED_PACK_ID, '1.0.1')
    // The channel has moved to the v2 Formula (owner, 2026-10-30); its episodes
    // still store the BARE legacy id, which the merged pack accepts through the
    // v2 Formula id it publishes.
    await channel('hidden-mechanics', { niche_id: 'com.storystudio.formula.archival-ledger-v2' })
    await episode('hidden-mechanics', 'HMH0001', {
      series_formula_id: 'com.storystudio.formula.archival-ledger-v2',
      topic_pack_ids: [LEGACY_SHORT_ID],
    })

    const usage = await contentPackUsage([MERGED_PACK_ID], paths, { policy, appVersion: '1.4.371' })
    assert.deepEqual(usage[MERGED_PACK_ID], ['hidden-mechanics'], 'the episode names it through the alias')
    await assert.rejects(
      removeContentPack(MERGED_PACK_ID, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError && error.code === 'CONTENT_PACK_IN_USE',
    )
  })

  test('the old pack stays removable while the merged pack is what the episode reads', async () => {
    const paths = await isolated()
    await install(paths, SOURCES.free_old, FREE_PACK_ID, '1.0.3')
    await install(paths, SOURCES.merged, MERGED_PACK_ID, '1.0.1')
    await channel('boundful', { niche_id: 'com.storystudio.formula.history-explained-v2' })
    await episode('boundful', 'EP0145', { topic_pack_ids: [FREE_ITEM_ID] })

    assert.deepEqual((await contentPackUsage([FREE_PACK_ID], paths, { policy, appVersion: '1.4.371' }))[FREE_PACK_ID], [],
      'nothing reads the superseded pack any more')
    await removeContentPack(FREE_PACK_ID, { paths, policy })
    assert.deepEqual((await contentPackUsage([MERGED_PACK_ID], paths, { policy, appVersion: '1.4.371' }))[MERGED_PACK_ID], ['boundful'],
      'the merged pack is the one the episode actually reads')
  })

  test('a moved channel reads the v2 item for the v1 id its episodes stored', async () => {
    const paths = await isolated()
    const v1Pack = 'com.storystudio.pack.topic.food-histories'
    const v2Pack = 'com.storystudio.pack.topic.food-histories-v2'
    const v1Item = 'com.storystudio.topic.food-histories'
    const v2Item = 'com.storystudio.topic.food-histories-v2'
    await installDocument(paths, topicDocument(v1Item, ['com.storystudio.formula.sleep-history-compilation']), v1Pack)
    await installDocument(paths, topicDocument(v2Item, ['com.storystudio.formula.sleep-history-compilation-v2']), v2Pack)
    await channel('sleep-history', { niche_id: 'com.storystudio.formula.sleep-history-compilation-v2' })
    await episode('sleep-history', 'SH0001', { topic_pack_ids: [v1Item] })

    assert.deepEqual((await contentPackUsage([v1Pack], paths, { policy, appVersion: '1.4.371' }))[v1Pack], [],
      'the v1 pack is not what the episode reads any more')
    assert.deepEqual((await contentPackUsage([v2Pack], paths, { policy, appVersion: '1.4.371' }))[v2Pack], ['sleep-history'],
      'the v2 item is what it reads')
    await assert.rejects(
      removeContentPack(v2Pack, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError && error.code === 'CONTENT_PACK_IN_USE',
    )
  })

  test('a channel not yet moved, with no merged pack, still reads the old pack, so it cannot be removed', async () => {
    const paths = await isolated()
    await install(paths, SOURCES.free_old, FREE_PACK_ID, '1.0.3')
    // The safe state during the move: a v1 Formula channel with no merged pack
    // falls back to the pack it came from.
    await channel('boundful', { niche_id: 'history-narration' })
    await episode('boundful', 'EP0145', { topic_pack_ids: [LEGACY_SHORT_ID] })

    assert.deepEqual((await contentPackUsage([FREE_PACK_ID], paths, { policy, appVersion: '1.4.371' }))[FREE_PACK_ID], ['boundful'],
      'the stored id falls back to this pack, so removing it would take the episode\'s subjects away')
    await assert.rejects(
      removeContentPack(FREE_PACK_ID, { paths, policy }),
      (error: unknown) => error instanceof ContentPackRemovalError && error.code === 'CONTENT_PACK_IN_USE',
    )
  })
})

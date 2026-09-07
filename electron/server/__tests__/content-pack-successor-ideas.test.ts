import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import {
  applyProjectContentUpgrade,
  setProjectContentPin,
} from '../content-packs/project-pins.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { filterGenerated } from '../services/idea-similarity.js'
import * as ideas from '../services/idea-manager.js'
import * as niches from '../services/niche-loader.js'
import * as projects from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'

const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.successor-ideas-test'
const packId = 'com.storystudio.pack.successor-ideas-test'
const formulaId = `${packId}.formula`
const topicId = `${packId}.topic`
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function documents(label: string, includeTopic = true): ContentPackDocument[] {
  const formula: ContentPackDocument = {
    kind: 'series-formula', schema_version: 1, id: formulaId, name: `Formula ${label}`,
    description: 'Test Formula.', channel_promise: 'Explain mechanisms.', audience: 'Curious adults.',
    narrative_rules: [`Narrative ${label}`], title_rules: ['Name a concrete mechanism.'],
    script_structure: {
      default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10,
      length_minutes_range: [5, 15], duration_presets: [5, 10, 15], default_words_per_minute: 120,
      chapters_independent: true, pacing_arc: ['Opening'], additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [topicId], default_topic_pack_ids: [topicId],
    recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [], script_context: `Context ${label}`,
  }
  if (!includeTopic) return [formula]
  return [formula, {
    kind: 'topic-pack', schema_version: 1, id: topicId, name: `Topic ${label}`,
    description: 'Test Topic Pack.', compatible_formula_ids: [formulaId], subjects: ['Canal tolls'],
    episode_objects: ['Ledger'], time_place_scopes: ['1800s'], mechanisms: ['Extraction'],
    evidence_lenses: ['Accounts'], exclusions: [], max_siblings_per_subject: 4, prompt_context: `Topic ${label}`,
  }]
}

async function archive(version: string, label: string, includeTopic = true): Promise<Uint8Array> {
  const items = documents(label, includeTopic).map((document, index) => {
    const bytes = Buffer.from(JSON.stringify(document))
    return { document, bytes, path: `content/item-${index}.json` }
  })
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: publisherId, key_id: keyId, version,
    min_app_version: '1.0.0', lifecycle: 'active', entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, bundles: [],
    items: items.map(item => ({ id: item.document.id, kind: item.document.kind, schema_version: 1, path: item.path })),
    files: items.map(item => ({ path: item.path, sha256: digest(item.bytes), bytes: item.bytes.byteLength, mime: 'application/json' })),
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  for (const item of items) zip.file(item.path, item.bytes, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

test('an explicit successor updates one reopened project pin, and Ideas keeps its history duplicate-free', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }

  const v1 = await installContentPack({ archiveBytes: await archive('1.0.0', 'predecessor'), source: 'local-import' }, options)
  await installContentPack({ archiveBytes: await archive('1.1.0', 'successor'), source: 'local-import' }, options)
  await installContentPack({ archiveBytes: await archive('1.2.0', 'broken successor', false), source: 'local-import' }, options)

  const project = await projects.createProject({ name: 'Successor Ideas', niche_id: formulaId, topic_pack_ids: [topicId] })
  const sibling = await projects.createProject({ name: 'Untouched pinned sibling', niche_id: formulaId, topic_pack_ids: [topicId] })
  await Promise.all([project, sibling].map(item => setProjectContentPin(item.slug, {
    pack_id: packId, version: '1.0.0', archive_sha256: v1.archive_sha256,
  }, options)))
  await ideas.addIdeas(project.slug, [{
    title: 'Canal Tolls at Dawn', logline: 'The old ledger opens.', themes: ['canals', 'tolls'],
    suggested_chapters: 3, suggested_length: '10 min', mood: 'measured',
  }], 'fixture')

  await applyProjectContentUpgrade(project.slug, packId, '1.1.0', options)
  const reopened = await projects.getProject(project.slug)
  const untouched = await projects.getProject(sibling.slug)
  assert.equal(reopened?.content_pack_versions?.[packId], '1.1.0')
  assert.equal(untouched?.content_pack_versions?.[packId], '1.0.0', 'an update changes exactly its selected project')
  const effective = await niches.getEffectiveNicheFor(reopened!, undefined, options)
  assert.equal(effective?.name, 'Formula successor', 'reopening resolves the selected successor bytes')

  const prior = await ideas.getIdeas(project.slug)
  const proposed = [{
    title: 'Canal Tolls at Dawn', logline: 'The old ledger opens again.', themes: ['canals', 'tolls'],
    suggested_chapters: 3, suggested_length: '10 min', mood: 'measured',
  }, {
    title: 'Signals Across the Estuary', logline: 'A new communication system changes trade.', themes: ['telegraph', 'shipping'],
    suggested_chapters: 3, suggested_length: '10 min', mood: 'curious',
  }]
  const filtered = filterGenerated(proposed, prior)
  assert.deepEqual(filtered.kept.map(idea => idea.title), ['Signals Across the Estuary'],
    'Ideas uses this shared history gate before persistence')
  await ideas.addIdeas(project.slug, filtered.kept, 'fixture')
  assert.deepEqual((await ideas.getIdeas(project.slug)).map(idea => idea.title), [
    'Canal Tolls at Dawn', 'Signals Across the Estuary',
  ])

  await assert.rejects(
    applyProjectContentUpgrade(project.slug, packId, '1.2.0', options),
    /removes selected items/i,
  )
  const afterFailedSuccessor = await projects.getProject(project.slug)
  assert.equal(afterFailedSuccessor?.content_pack_versions?.[packId], '1.1.0',
    'a rejected successor leaves the previously selected pin intact')
  assert.equal((await niches.getEffectiveNicheFor(afterFailedSuccessor!, undefined, options))?.name, 'Formula successor')
})

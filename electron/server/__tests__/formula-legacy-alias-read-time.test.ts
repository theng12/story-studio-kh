/**
 * Legacy Formula ids read as the store's Formula — WITHOUT a migration.
 *
 * Owner ruling, 2026-10-25: reconcile the bare legacy ids onto the qualified
 * store Formulas like the art styles were reconciled. No project config,
 * preset, or niche file is rewritten (AGENTS §5); a READ-TIME alias table in
 * the niche loader makes `sleep` load `com.storystudio.formula.sleep-story`'s
 * current content.
 *
 * The proof that matters is two-sided: the content comes from the store pack,
 * AND the project file is byte-identical afterwards. A test that only checked
 * the first could still be passing over a silent rewrite.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import * as niches from '../services/niche-loader.js'
import * as projects from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'

const publisherId = 'com.storystudio'
const keyId = 'com.storystudio.key.formula-alias-test'
const packId = 'com.storystudio.pack.formula-alias-test'
const storeSleepId = 'com.storystudio.formula.sleep-story'
const keys = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId,
  publisherId,
  publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function formula(id: string, name: string): ContentPackDocument {
  return {
    kind: 'series-formula',
    schema_version: 1,
    id,
    name,
    description: `${name} test content.`,
    channel_promise: 'A calm promise.',
    audience: 'Test listeners.',
    narrative_rules: ['Stay calm.'],
    title_rules: ['Name the subject plainly.'],
    script_structure: {
      default_chapter_count: 3,
      chapter_count_range: [2, 4],
      default_length_minutes: 10,
      length_minutes_range: [5, 15],
      duration_presets: [5, 10, 15],
      default_words_per_minute: 120,
      chapters_independent: true,
      pacing_arc: ['Opening'],
      additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [],
    recommended_visual_style_ids: [],
    recommended_thumbnail_recipe_ids: [],
  }
}

async function archive(): Promise<Uint8Array> {
  const documents = [
    formula(storeSleepId, 'Store Sleep Formula'),
    formula('com.storystudio.formula.wildlife-under-pressure', 'Adopted Wildlife Formula'),
  ]
  const items = documents.map((document, index) => {
    const bytes = Buffer.from(JSON.stringify(document))
    return { document, bytes, path: `content/item-${index}.json` }
  })
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: packId,
    publisher_id: publisherId,
    key_id: keyId,
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` },
    bundles: [],
    items: items.map(item => ({ id: item.document.id, kind: item.document.kind, schema_version: 1, path: item.path })),
    files: items.map(item => ({ path: item.path, sha256: digest(item.bytes), bytes: item.bytes.byteLength, mime: 'application/json' })),
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keys.privateKey), { createFolders: false })
  for (const item of items) zip.file(item.path, item.bytes, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

test('a legacy niche id reads the store Formula and leaves the project file byte-identical', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)

  assert.equal(niches.resolveFormulaAlias('sleep'), storeSleepId)
  assert.equal(niches.resolveFormulaAlias('history-narration'), 'com.storystudio.formula.history-explained')
  assert.equal(niches.resolveFormulaAlias('music-mix'), 'music-mix', 'music-mix has no store Formula and must pass through')
  assert.equal(niches.resolveFormulaAlias('com.storystudio.formula.sleep-story'), storeSleepId)

  const project = await projects.createProject({ name: 'Legacy sleep channel', niche_id: 'sleep' })
  const projectFile = path.join(projects.getProjectDir(project.slug)!, 'project.json')
  const before = await fs.readFile(projectFile)

  const loaded = await niches.loadNiche('sleep', options)
  assert.equal(loaded?.id, storeSleepId, 'the bare id must resolve to the store item id')
  assert.equal(loaded?.name, 'Store Sleep Formula', 'content must be the store Formula, not the legacy file')

  const effective = await niches.getEffectiveNicheFor(project, undefined, options)
  assert.equal(effective?.id, storeSleepId)
  assert.equal(effective?.name, 'Store Sleep Formula')

  const after = await fs.readFile(projectFile)
  assert.deepEqual(after, before, 'reading a Formula must not rewrite the project file (AGENTS §5)')
  assert.equal((await projects.getProject(project.slug))?.niche_id, 'sleep', 'the stored id is untouched')
})

test('adopted owner custom Formulas resolve to their store packs at read time', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)

  const customId = 'user:c0293626-910a-4dbd-9c5a-2e0a6c90d798'
  assert.equal(niches.resolveFormulaAlias(customId), 'com.storystudio.formula.wildlife-under-pressure')
  const loaded = await niches.loadNiche(customId, options)
  assert.equal(loaded?.id, 'com.storystudio.formula.wildlife-under-pressure')
  assert.equal(loaded?.name, 'Adopted Wildlife Formula')
})

test('the picker hides a superseded legacy entry only when its store Formula is listed', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temporary.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  await installContentPack({ archiveBytes: await archive(), source: 'local-import' }, options)

  const listed = (await niches.listNicheCatalogEntries(options)).map(entry => entry.value.id)
  assert.ok(listed.includes(storeSleepId))
  assert.equal(listed.includes('sleep'), false, 'the superseded entry must not sit beside its own successor')
  assert.ok(listed.includes('music-mix'), 'a legacy Formula with no store successor stays listed')
})

test('without the store Formula the legacy file still answers, so a channel keeps its Formula', async t => {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const loaded = await niches.loadNiche('hidden-mechanics-history')
  assert.equal(loaded?.id, 'hidden-mechanics-history', 'fallback keeps generation working when archival-ledger is not installed')
  assert.ok(loaded?.scriptSystemPromptRole)
})

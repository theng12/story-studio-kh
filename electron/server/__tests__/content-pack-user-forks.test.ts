import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'
import express from 'express'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { updateProjectContentSelections } from '../content-packs/project-pins.js'
import { resolveCatalogItem } from '../content-packs/registry.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import {
  forkLegacyContentForEdit,
  listLegacyShadowConflicts,
  readUserFork,
  saveUserForkDocument,
  listUserForks,
} from '../content-packs/user-forks.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import * as nicheLoader from '../services/niche-loader.js'
import * as projectManager from '../services/project-manager.js'
import * as thumbnailLoader from '../services/thumbnail-template-loader.js'
import * as topicLoader from '../services/topic-pack-loader.js'
import { router as nichesRouter } from '../routes/niches.js'
import { router as thumbnailRouter } from '../routes/thumbnail-templates.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.key.user-fork-test'
const PACK_ID = 'com.storystudio.user-fork-test'
const SIGNED_FORMULA_ID = `${PACK_ID}.formula`
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  nicheLoader._clearNicheCaches()
  topicLoader.invalidateTopicPackCache()
  thumbnailLoader._clearTemplateCaches()
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function signedArchive(document: ContentPackDocument, contentPath: string): Promise<Uint8Array> {
  const content = Buffer.from(JSON.stringify(document))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: PACK_ID, publisher_id: PUBLISHER_ID, key_id: KEY_ID,
    version: '1.0.0', min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` }, bundles: [],
    items: [{ id: document.id, kind: document.kind, schema_version: 1, path: contentPath }],
    files: [{ path: contentPath, sha256: sha256(content), bytes: content.byteLength, mime: 'application/json' }],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file(contentPath, content, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function signedFormulaArchive(): Promise<Uint8Array> {
  return signedArchive({
    kind: 'series-formula', schema_version: 1, id: SIGNED_FORMULA_ID,
    name: 'Signed restoration Formula', description: 'Restores one project to signed content.',
    channel_promise: 'Explain one bounded system.', audience: 'Curious adults.',
    narrative_rules: ['Stay causal.'], title_rules: ['Name the mechanism.'],
    script_structure: {
      default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10,
      length_minutes_range: [5, 15], duration_presets: [5, 10, 15], default_words_per_minute: 120,
      chapters_independent: true, pacing_arc: ['Opening'], additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [], default_topic_pack_ids: [],
    recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [],
  }, 'content/formula.json')
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temp.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options = { paths, policy, recoveryRoot, appVersion: '1.0.0' }
  return { temp, paths, options }
}

async function writeLegacyShadows() {
  const nicheId = 'hidden-mechanics-history'
  const topicId = 'historical-states-revolutions-collapse'
  const recipeId = 'archival-map-investigation'
  const nicheSource = JSON.parse(await fs.readFile(path.join(nicheLoader.BUILTIN_NICHES_DIR, `${nicheId}.json`), 'utf8'))
  const topicSource = JSON.parse(await fs.readFile(path.join(topicLoader.BUILTIN_TOPIC_PACKS_DIR, `${topicId}.json`), 'utf8'))
  const recipeSource = JSON.parse(await fs.readFile(path.join(thumbnailLoader.BUILTIN_TEMPLATES_DIR, `${recipeId}.json`), 'utf8'))
  const nichePath = nicheLoader.nicheFilePath(nicheId)
  const topicPath = topicLoader.topicPackFilePath(topicId)
  const recipePath = thumbnailLoader.templateFilePath(recipeId)
  nicheSource.name = 'Legacy shadow Formula'
  nicheSource.builtin = false
  topicSource.name = 'Legacy shadow Topic'
  topicSource.builtin = false
  recipeSource.name = 'Legacy shadow Recipe'
  recipeSource.builtin = false
  await Promise.all([
    fs.mkdir(path.dirname(nichePath), { recursive: true }),
    fs.mkdir(path.dirname(topicPath), { recursive: true }),
    fs.mkdir(path.dirname(recipePath), { recursive: true }),
  ])
  await Promise.all([
    fs.writeFile(nichePath, `${JSON.stringify(nicheSource, null, 2)}\n`),
    fs.writeFile(topicPath, `${JSON.stringify(topicSource, null, 2)}\n`),
    fs.writeFile(recipePath, `${JSON.stringify(recipeSource, null, 2)}\n`),
  ])
  nicheLoader._clearNicheCaches()
  topicLoader.invalidateTopicPackCache()
  thumbnailLoader._clearTemplateCaches()
  return {
    ids: { nicheId, topicId, recipeId },
    files: { nichePath, topicPath, recipePath },
    bytes: {
      niche: await fs.readFile(nichePath, 'utf8'),
      topic: await fs.readFile(topicPath, 'utf8'),
      recipe: await fs.readFile(recipePath, 'utf8'),
    },
  }
}

describe('explicit legacy Content Pack user forks', () => {
  test('keeps three legacy shadows unchanged until explicit project-scoped edits create independent user forks', async () => {
    const { paths } = await isolated()
    const legacy = await writeLegacyShadows()
    const first = await projectManager.createProject({
      name: 'First Legacy Project', niche_id: legacy.ids.nicheId, topic_pack_ids: [legacy.ids.topicId],
    })
    const second = await projectManager.createProject({
      name: 'Second Legacy Project', niche_id: legacy.ids.nicheId, topic_pack_ids: [legacy.ids.topicId],
    })
    await projectManager.updateConfig(first.slug, { thumbnail_template_id: legacy.ids.recipeId })
    await projectManager.updateConfig(second.slug, { thumbnail_template_id: legacy.ids.recipeId })

    assert.equal((await nicheLoader.loadNiche(legacy.ids.nicheId))?.name, 'Legacy shadow Formula')
    assert.equal((await topicLoader.loadTopicPack(legacy.ids.topicId))?.name, 'Legacy shadow Topic')
    assert.equal((await thumbnailLoader.loadTemplate(legacy.ids.recipeId))?.name, 'Legacy shadow Recipe')
    await assert.rejects(fs.access(path.join(paths.root, 'user-forks')), { code: 'ENOENT' })

    const formulaFork = await forkLegacyContentForEdit({
      kind: 'series-formula', legacyId: legacy.ids.nicheId, projectSlug: first.slug,
    })
    const topicFork = await forkLegacyContentForEdit({
      kind: 'topic-pack', legacyId: legacy.ids.topicId, projectSlug: first.slug,
    })
    const recipeFork = await forkLegacyContentForEdit({
      kind: 'thumbnail-recipe', legacyId: legacy.ids.recipeId, projectSlug: first.slug,
    })
    for (const result of [formulaFork, topicFork, recipeFork]) {
      assert.match(result.fork_id, /^user:[0-9a-f-]{36}$/)
      assert.equal(result.source, 'legacy-user-fork')
      assert.doesNotMatch(JSON.stringify(result), /(?:\/Users\/|file:|\.niches|\.topic-packs|\.thumbnail-templates)/i)
    }

    const firstUpdated = await projectManager.getProject(first.slug)
    const secondUnchanged = await projectManager.getProject(second.slug)
    assert.equal(firstUpdated?.niche_id, formulaFork.fork_id)
    assert.deepEqual(firstUpdated?.topic_pack_ids, [topicFork.fork_id])
    assert.equal((await projectManager.getConfig(first.slug))?.thumbnail_template_id, recipeFork.fork_id)
    assert.equal(secondUnchanged?.niche_id, legacy.ids.nicheId)
    assert.deepEqual(secondUnchanged?.topic_pack_ids, [legacy.ids.topicId])
    assert.equal((await projectManager.getConfig(second.slug))?.thumbnail_template_id, legacy.ids.recipeId)
    assert.equal((await nicheLoader.loadNiche(formulaFork.fork_id))?.name, 'Legacy shadow Formula')
    assert.equal((await topicLoader.loadTopicPack(topicFork.fork_id))?.name, 'Legacy shadow Topic')
    assert.equal((await thumbnailLoader.loadTemplate(recipeFork.fork_id))?.name, 'Legacy shadow Recipe')

    assert.equal(await fs.readFile(legacy.files.nichePath, 'utf8'), legacy.bytes.niche)
    assert.equal(await fs.readFile(legacy.files.topicPath, 'utf8'), legacy.bytes.topic)
    assert.equal(await fs.readFile(legacy.files.recipePath, 'utf8'), legacy.bytes.recipe)
    const records = await fs.readdir(path.join(paths.root, 'user-forks'))
    assert.equal(records.length, 3)
    for (const name of records) {
      const record = JSON.parse(await fs.readFile(path.join(paths.root, 'user-forks', name), 'utf8'))
      assert.equal(record.schema_version, 1)
      assert.match(record.fork_id, /^user:/)
      assert.equal(record.document.id, record.fork_id)
      assert.doesNotMatch(JSON.stringify(record), /(?:\/Users\/|file:|\.niches|\.topic-packs|\.thumbnail-templates)/i)
    }

    const secondFormulaFork = await forkLegacyContentForEdit({
      kind: 'series-formula', legacyId: legacy.ids.nicheId, projectSlug: second.slug,
    })
    assert.notEqual(secondFormulaFork.fork_id, formulaFork.fork_id)
    assert.equal((await projectManager.getProject(first.slug))?.niche_id, formulaFork.fork_id)
    assert.equal((await projectManager.getProject(second.slug))?.niche_id, secondFormulaFork.fork_id)
  })

  test('lists bounded shadow conflicts and restores signed content for only the requesting project', async () => {
    const { options } = await isolated()
    const legacy = await writeLegacyShadows()
    await fs.writeFile(nicheLoader.nicheFilePath('unique-custom-formula'), JSON.stringify({
      id: 'unique-custom-formula', name: 'Unique custom Formula', description: 'Not a shadow.',
      builtin: false, schemaVersion: 1, exampleTopics: ['Unique'],
    }))
    const first = await projectManager.createProject({ name: 'Restore First', niche_id: legacy.ids.nicheId })
    const second = await projectManager.createProject({ name: 'Restore Second', niche_id: legacy.ids.nicheId })
    const fork = await forkLegacyContentForEdit({
      kind: 'series-formula', legacyId: legacy.ids.nicheId, projectSlug: first.slug,
    })

    const archive = await signedFormulaArchive()
    const installed = await installContentPack({ archiveBytes: archive, source: 'local-import' }, options)
    const signedShadowPath = nicheLoader.nicheFilePath(SIGNED_FORMULA_ID)
    await fs.writeFile(signedShadowPath, JSON.stringify({
      id: SIGNED_FORMULA_ID, name: 'Legacy file conflicting with signed', description: 'Compatibility input.',
      builtin: false, schemaVersion: 1, exampleTopics: ['Conflict'],
    }))

    const conflicts = await listLegacyShadowConflicts(options)
    assert.deepEqual(conflicts.map(conflict => [conflict.kind, conflict.legacy_id]), [
      ['series-formula', SIGNED_FORMULA_ID],
      ['series-formula', legacy.ids.nicheId],
      ['thumbnail-recipe', legacy.ids.recipeId],
      ['topic-pack', legacy.ids.topicId],
    ])
    assert.deepEqual(conflicts.find(conflict => conflict.legacy_id === legacy.ids.nicheId)?.referencing_project_slugs, [second.slug])
    assert.equal(conflicts.find(conflict => conflict.legacy_id === SIGNED_FORMULA_ID)?.signed_item_id, SIGNED_FORMULA_ID)
    assert.doesNotMatch(JSON.stringify(conflicts), /(?:\/Users\/|file:|\.niches|\.topic-packs|\.thumbnail-templates)/i)

    await updateProjectContentSelections(first.slug, {
      replace_kinds: ['series-formula'],
      selections: [{ id: SIGNED_FORMULA_ID, kind: 'series-formula' }],
      update(project) { project.niche_id = SIGNED_FORMULA_ID },
    }, options)

    assert.equal((await projectManager.getProject(first.slug))?.niche_id, SIGNED_FORMULA_ID)
    assert.equal((await projectManager.getProject(second.slug))?.niche_id, legacy.ids.nicheId)
    assert.equal((await resolveCatalogItem(SIGNED_FORMULA_ID, {
      pack_id: PACK_ID, version: '1.0.0', archive_sha256: installed.archive_sha256,
    }, options))?.value.name, 'Signed restoration Formula')
    assert.equal((await nicheLoader.loadNiche(fork.fork_id))?.id, fork.fork_id)
  })

  test('does not report a signed collision when the matching qualified id belongs to another content kind', async () => {
    const { options } = await isolated()
    const sameId = `${PACK_ID}.same-id`
    const archive = await signedArchive({
      kind: 'topic-pack', schema_version: 1, id: sameId, name: 'Signed Topic', description: 'Different kind.',
      compatible_formula_ids: [`${PACK_ID}.formula`], subjects: ['Ledger'], episode_objects: ['Office'], time_place_scopes: ['1800s'],
      mechanisms: ['Extraction'], evidence_lenses: ['Accounts'], exclusions: [], max_siblings_per_subject: 4,
      prompt_context: 'Signed Topic context.',
    }, 'content/topic.json')
    await installContentPack({ archiveBytes: archive, source: 'local-import' }, options)
    await fs.mkdir(path.dirname(nicheLoader.nicheFilePath(sameId)), { recursive: true })
    await fs.writeFile(nicheLoader.nicheFilePath(sameId), JSON.stringify({
      id: sameId, name: 'Legacy Formula', description: 'Same id but a Formula.',
      builtin: false, schemaVersion: 1, exampleTopics: ['Mismatch'],
    }))

    assert.equal((await listLegacyShadowConflicts(options)).some(conflict => (
      conflict.kind === 'series-formula' && conflict.legacy_id === sameId
    )), false)
  })

  test('refuses symlinked stores and a fork record whose durable filename does not match its identity', async () => {
    const { temp, paths } = await isolated()
    const outside = path.join(temp.dir, 'outside-user-forks')
    await fs.mkdir(outside)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.symlink(outside, path.join(paths.root, 'user-forks'))
    const probeId = 'user:11111111-1111-4111-8111-111111111111'
    await assert.rejects(readUserFork(probeId, { paths }), /safe directory|symlink/i)
    await assert.rejects(saveUserForkDocument(probeId, {
      id: probeId, name: 'Unsafe save', description: 'Must not follow a parent symlink.',
      builtin: false, schemaVersion: 1, exampleTopics: ['Unsafe'],
    }, { paths }), /safe directory|symlink/i)

    await fs.unlink(path.join(paths.root, 'user-forks'))
    await fs.mkdir(path.join(paths.root, 'user-forks'))
    const wrongId = 'user:22222222-2222-4222-8222-222222222222'
    await fs.writeFile(path.join(paths.root, 'user-forks', '11111111-1111-4111-8111-111111111111.json'), JSON.stringify({
      schema_version: 1,
      fork_id: wrongId,
      kind: 'series-formula',
      source: { catalog_source: 'legacy-user-fork', legacy_id: 'hidden-mechanics-history' },
      created_at: '2026-08-14T00:00:00.000Z',
      document: {
        id: wrongId, name: 'Wrong identity', description: 'Must not alias another fork.',
        builtin: false, schemaVersion: 1, exampleTopics: ['Mismatch'],
      },
    }))
    await assert.rejects(readUserFork(probeId, { paths }), /identity|match/i)
    await assert.rejects(listUserForks(undefined, { paths }), /identity|match/i)
    await assert.rejects(saveUserForkDocument(probeId, {
      id: probeId, name: 'Identity mismatch save', description: 'Must not rewrite an aliased record.',
      builtin: false, schemaVersion: 1, exampleTopics: ['Mismatch'],
    }, { paths }), /identity|match/i)
  })

  test('refuses a symlinked Content Pack runtime root before reading or writing user forks', async () => {
    const { temp, paths } = await isolated()
    const outsideRoot = path.join(temp.dir, 'outside-runtime')
    await fs.mkdir(path.join(outsideRoot, 'user-forks'), { recursive: true })
    await fs.symlink(outsideRoot, paths.root)
    const probeId = 'user:33333333-3333-4333-8333-333333333333'
    await assert.rejects(readUserFork(probeId, { paths }), /runtime root|symlink/i)
    await assert.rejects(forkLegacyContentForEdit({
      kind: 'series-formula', legacyId: 'hidden-mechanics-history',
    }, { paths }), /runtime root|symlink/i)
  })

  test('does not leave an orphan fork when the requesting project does not select the legacy source', async () => {
    const { paths } = await isolated()
    const legacy = await writeLegacyShadows()
    const project = await projectManager.createProject({ name: 'Unrelated Project', niche_id: 'animals' })
    await assert.rejects(forkLegacyContentForEdit({
      kind: 'series-formula', legacyId: legacy.ids.nicheId, projectSlug: project.slug,
    }), /does not select/i)
    const forkRoot = path.join(paths.root, 'user-forks')
    assert.deepEqual(await fs.readdir(forkRoot).catch(() => []), [])
  })

  test('edit routes fork legacy Formula, Topic, and Thumbnail content without overwriting originals', async () => {
    await isolated()
    const legacy = await writeLegacyShadows()
    const project = await projectManager.createProject({
      name: 'Route Fork Project', niche_id: legacy.ids.nicheId, topic_pack_ids: [legacy.ids.topicId],
    })
    await projectManager.updateConfig(project.slug, { thumbnail_template_id: legacy.ids.recipeId })
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)
    app.use('/api', thumbnailRouter)

    const unrelated = await projectManager.createProject({ name: 'Thumbnail Fork Mismatch' })
    const refused = await request(app)
      .post(`/api/thumbnail-templates/${legacy.ids.recipeId}/fork`)
      .send({ project_slug: unrelated.slug })
      .expect(409)
    assert.match(refused.body.detail, /does not select/i)

    const nicheBody = {
      id: legacy.ids.nicheId, name: 'Edited explicit Formula fork', description: 'A route-edited Formula.',
      builtin: false, schemaVersion: 1, exampleTopics: ['A bounded episode'],
    }
    const nicheResponse = await request(app)
      .put(`/api/niches/${legacy.ids.nicheId}?project_slug=${project.slug}`)
      .send(nicheBody)
      .expect(200)
    assert.match(nicheResponse.body.id, /^user:/)
    assert.equal(nicheResponse.body.name, 'Edited explicit Formula fork')

    const topicBody = {
      id: legacy.ids.topicId, name: 'Edited explicit Topic fork', description: 'A route-edited Topic Pack.',
      builtin: false, schemaVersion: 1, compatibleNicheIds: [legacy.ids.nicheId], subjects: ['Ledger'],
    }
    const topicResponse = await request(app)
      .put(`/api/topic-packs/${legacy.ids.topicId}?project_slug=${project.slug}`)
      .send(topicBody)
      .expect(200)
    assert.match(topicResponse.body.id, /^user:/)

    const recipeResponse = await request(app)
      .post(`/api/thumbnail-templates/${legacy.ids.recipeId}/fork`)
      .send({ project_slug: project.slug })
      .expect(201)
    assert.match(recipeResponse.body.template.id, /^user:/)
    const savedRecipe = await request(app)
      .put(`/api/thumbnail-templates/${encodeURIComponent(recipeResponse.body.template.id)}`)
      .send({ ...recipeResponse.body.template, name: 'Edited explicit Recipe fork' })
      .expect(200)
    assert.equal(savedRecipe.body.template.name, 'Edited explicit Recipe fork')

    const updated = await projectManager.getProject(project.slug)
    assert.equal(updated?.niche_id, nicheResponse.body.id)
    assert.deepEqual(updated?.topic_pack_ids, [topicResponse.body.id])
    assert.equal((await projectManager.getConfig(project.slug))?.thumbnail_template_id, recipeResponse.body.template.id)
    assert.equal(await fs.readFile(legacy.files.nichePath, 'utf8'), legacy.bytes.niche)
    assert.equal(await fs.readFile(legacy.files.topicPath, 'utf8'), legacy.bytes.topic)
    assert.equal(await fs.readFile(legacy.files.recipePath, 'utf8'), legacy.bytes.recipe)
    assert.doesNotMatch(JSON.stringify([nicheResponse.body, topicResponse.body, recipeResponse.body]),
      /(?:\/Users\/|file:|\.niches|\.topic-packs|\.thumbnail-templates)/i)
  })
})

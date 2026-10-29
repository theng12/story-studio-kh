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

  test('refuses a symlinked user-fork store without touching the outside directory', async () => {
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
  })

  test('refuses a fork record whose durable filename does not match its identity', async () => {
    const { paths } = await isolated()
    await fs.mkdir(path.join(paths.root, 'user-forks'), { recursive: true })
    const probeId = 'user:11111111-1111-4111-8111-111111111111'
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

  /**
   * v1.4.18 — the owner edits a Formula's episode shape.
   *
   * "series formula editing ui. do it please then, i thought you already did
   * it." He was right to expect it: 1.4.16 set every Formula's chapters,
   * length and pace, and left him no way to change them without editing JSON.
   *
   * The reason it is a PATCH is the thing this test exists to pin. `NicheSchema`
   * is `.strict()` and lists about a third of a real Formula — no
   * `scriptStructure`, no `narratorStyles`, no `pacingArc`, no
   * `titleShapeRules`. `PUT /niches/:id` saves `parsed.data`, so a whole
   * Formula sent through it is either refused for carrying unknown keys or,
   * had it not been strict, silently stripped of everything unlisted. Editing
   * the sleep Formula would have deleted its ten narrator voices.
   */
  test('editing a Formula episode shape keeps everything the niche schema has never heard of', async () => {
    await isolated()
    const legacy = await writeLegacyShadows()
    const project = await projectManager.createProject({
      name: 'Episode Shape Project', niche_id: legacy.ids.nicheId,
    })
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)

    const before = await nicheLoader.loadNiche(legacy.ids.nicheId)
    assert.ok(before, 'the legacy Formula must load')
    // The real Formula, so this is not a straw fixture: nine named chapters,
    // ten narrator voices, its own title rules.
    assert.ok((before.narratorStyles?.length || 0) > 0)
    assert.ok((before.scriptStructure?.pacingArc?.length || 0) > 0)
    assert.ok((before.titleShapeRules?.length || 0) > 0)

    const patched = await request(app)
      .patch(`/api/niches/${legacy.ids.nicheId}/episode-shape?project_slug=${project.slug}`)
      .send({
        defaultChapterCount: 11,
        chapterCountRange: [9, 13],
        defaultLengthMinutes: 52,
        lengthMinutesRange: [45, 60],
        defaultWordsPerMinute: 138,
        chaptersIndependent: true,
        metadataTitleStyleHint: 'Name the mechanism and the consequence.',
      })
      .expect(200)

    assert.match(patched.body.id, /^user:/)
    assert.equal(patched.body.forked_from, legacy.ids.nicheId)
    const after = patched.body.niche
    assert.equal(after.scriptStructure.defaultLengthMinutes, 52)
    assert.deepEqual(after.scriptStructure.lengthMinutesRange, [45, 60])
    assert.equal(after.scriptStructure.defaultChapterCount, 11)
    assert.equal(after.scriptStructure.defaultWordsPerMinute, 138)
    assert.equal(after.metadataTitleStyleHint, 'Name the mechanism and the consequence.')
    // Derived from the range and the default, so a preset can never sit
    // outside the range it came from.
    assert.deepEqual(after.scriptStructure.durationPresets, [45, 52, 60])

    // THE POINT. None of these are in NicheSchema.
    assert.deepEqual(after.narratorStyles, before.narratorStyles)
    assert.deepEqual(after.scriptStructure.pacingArc, before.scriptStructure?.pacingArc)
    assert.deepEqual(after.titleShapeRules, before.titleShapeRules)
    assert.deepEqual(after.scriptStructure.additionalRules, before.scriptStructure?.additionalRules)

    // And the project actually reads the edit, rather than an orphan fork.
    const reloaded = await projectManager.getProject(project.slug)
    const effective = await nicheLoader.getEffectiveNicheFor(reloaded!)
    assert.equal(effective?.scriptStructure?.defaultLengthMinutes, 52)
    assert.deepEqual(effective?.narratorStyles, before.narratorStyles)
  })

  test('chapter-only edits preserve the authored duration choices and full Formula through first fork and later edits', async () => {
    await isolated()
    const legacy = await writeLegacyShadows()
    const project = await projectManager.createProject({
      name: 'Authored Duration Choices', niche_id: legacy.ids.nicheId, topic_pack_ids: [],
    })
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)
    const before = await nicheLoader.loadNiche(legacy.ids.nicheId)
    assert.ok(before?.scriptStructure)
    assert.deepEqual(before.scriptStructure.durationPresets, [30, 36, 40, 45, 50])
    const shape = before.scriptStructure
    const patch = {
      defaultChapterCount: 11, chapterCountRange: [9, 13],
      defaultLengthMinutes: shape.defaultLengthMinutes,
      lengthMinutesRange: shape.lengthMinutesRange,
      defaultWordsPerMinute: shape.defaultWordsPerMinute,
      chaptersIndependent: shape.chaptersIndependent,
      metadataTitleStyleHint: before.metadataTitleStyleHint || '',
    }
    const first = await request(app)
      .patch(`/api/niches/${legacy.ids.nicheId}/episode-shape?project_slug=${project.slug}`)
      .send(patch)
      .expect(200)
    assert.match(first.body.id, /^user:/)
    assert.equal(first.body.forked_from, legacy.ids.nicheId)
    let expected = {
      ...before, id: first.body.id, builtin: false,
      scriptStructure: { ...shape, defaultChapterCount: 11, chapterCountRange: [9, 13] as [number, number] },
    }
    if (!patch.metadataTitleStyleHint.trim()) delete expected.metadataTitleStyleHint
    // Compare the JSON document that HTTP and durable storage can carry.
    expected = JSON.parse(JSON.stringify(expected))
    assert.deepEqual(first.body.niche, expected)
    assert.deepEqual((await readUserFork(first.body.id))?.document, expected)
    const selected = await projectManager.getProject(project.slug)
    assert.equal(selected?.niche_id, first.body.id)
    assert.deepEqual((await nicheLoader.getEffectiveNicheFor(selected!, []))?.scriptStructure, expected.scriptStructure)

    // The longer authored set is a local fixture, never a production Formula edit.
    expected = {
      ...expected,
      scriptStructure: {
        ...expected.scriptStructure, defaultLengthMinutes: 180,
        lengthMinutesRange: [150, 200], durationPresets: [150, 165, 180, 195, 200],
      },
    }
    await saveUserForkDocument(first.body.id, expected)
    const second = await request(app)
      .patch(`/api/niches/${first.body.id}/episode-shape?project_slug=${project.slug}`)
      .send({ ...patch, defaultChapterCount: 12, defaultLengthMinutes: 180, lengthMinutesRange: [150, 200] })
      .expect(200)
    expected = { ...expected, scriptStructure: { ...expected.scriptStructure, defaultChapterCount: 12 } }
    assert.equal(second.body.id, first.body.id)
    assert.equal(second.body.forked_from, null)
    assert.deepEqual(second.body.niche, expected)
    assert.deepEqual((await readUserFork(first.body.id))?.document, expected)
    nicheLoader._clearNicheCaches()
    assert.deepEqual(await nicheLoader.loadNiche(first.body.id), expected)
    assert.deepEqual((await nicheLoader.getEffectiveNicheFor(selected!, []))?.scriptStructure, expected.scriptStructure)
    assert.equal(await fs.readFile(legacy.files.nichePath, 'utf8'), legacy.bytes.niche)
  })

  test('the full-document route is the reason the episode shape is a patch', async () => {
    await isolated()
    const legacy = await writeLegacyShadows()
    const project = await projectManager.createProject({
      name: 'Strict Schema Project', niche_id: legacy.ids.nicheId,
    })
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)

    const whole = await nicheLoader.loadNiche(legacy.ids.nicheId)
    // Sending a real Formula back through PUT is refused, not silently
    // truncated — which is the only reason no edit has ever destroyed one.
    await request(app)
      .put(`/api/niches/${legacy.ids.nicheId}?project_slug=${project.slug}`)
      .send({ ...whole, builtin: false })
      .expect(400)
  })

  test('editing a built-in without naming the project is refused, not silently orphaned', async () => {
    await isolated()
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)

    // `forkLegacyContentForEdit` only repoints a project when it is given one.
    // Without a slug the fork is written and nothing ever reads it, so the
    // owner sees "saved" and nothing changes — the worst available outcome.
    const refused = await request(app)
      .patch('/api/niches/sleep/episode-shape')
      .send({
        defaultChapterCount: 15, chapterCountRange: [10, 24],
        defaultLengthMinutes: 135, lengthMinutesRange: [120, 150],
        defaultWordsPerMinute: 115, chaptersIndependent: false,
        metadataTitleStyleHint: '',
      })
      .expect(400)
    assert.match(refused.body.detail, /project/i)
  })

  test('a shape that contradicts itself is refused with words, not clamped', async () => {
    await isolated()
    const legacy = await writeLegacyShadows()
    const project = await projectManager.createProject({
      name: 'Bad Shape Project', niche_id: legacy.ids.nicheId,
    })
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)

    const base = {
      defaultChapterCount: 9, chapterCountRange: [9, 9],
      defaultLengthMinutes: 45, lengthMinutesRange: [40, 50],
      defaultWordsPerMinute: 140, chaptersIndependent: true,
      metadataTitleStyleHint: '',
    }
    const url = `/api/niches/${legacy.ids.nicheId}/episode-shape?project_slug=${project.slug}`

    // A default outside its own range is exactly the shape of the defect this
    // whole feature exists to end: an 8-minute default under a 20-minute
    // ceiling meant a two-hour sleep story could not even be requested.
    const outside = await request(app).patch(url)
      .send({ ...base, defaultLengthMinutes: 90 }).expect(400)
    assert.match(outside.body.detail, /usual length/i)

    const inverted = await request(app).patch(url)
      .send({ ...base, lengthMinutesRange: [50, 40] }).expect(400)
    assert.match(inverted.body.detail, /shortest/i)

    // Silently dropping an unknown key is how a typo becomes a setting that
    // never applied.
    await request(app).patch(url)
      .send({ ...base, defaultLenghtMinutes: 45 }).expect(400)
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

/**
 * Owner, 2026-10-29: every Formula comes from a pack, so the id a channel stores
 * is the pack's qualified item id (or a bare id that reads as one). Editing that
 * channel's episode shape or music format forks the Formula it actually uses —
 * reading only `electron/server/niches/*.json` sent every pack-pinned channel to
 * a 404 the moment its own pack was installed.
 *
 * The legacy file stays the fallback, so a Mac without the pack behaves exactly
 * as it did before.
 */
describe('forking a Formula that ships as a Content Pack', () => {
  const SLUG = 'com.storystudio.formula.sleep-story'

  function packFormulaArchive(name = 'Signed Sleep Formula'): Promise<Uint8Array> {
    return signedArchive({
      kind: 'series-formula', schema_version: 1, id: SLUG,
      name, description: 'Sleep content that lives in a pack.',
      channel_promise: 'Quiet nights.', audience: 'Night listeners.',
      narrative_rules: ['Stay calm.'], title_rules: ['Name the hour.'],
      script_structure: {
        default_chapter_count: 2, chapter_count_range: [1, 3], default_length_minutes: 30,
        length_minutes_range: [20, 40], duration_presets: [20, 30, 40], default_words_per_minute: 110,
        chapters_independent: true, pacing_arc: ['Slow open'], additional_rules: ['No shock.'],
      },
      compatible_topic_pack_ids: [],
      recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [],
    } as ContentPackDocument, 'content/sleep.json')
  }

  test('a channel pinned to the pack item forks the pack, through the edit route', async () => {
    const { options } = await isolated()
    await installContentPack({ archiveBytes: await packFormulaArchive(), source: 'local-import' }, options)
    const project = await projectManager.createProject({ name: 'Pack Formula channel', niche_id: SLUG })
    const app = express()
    app.use(express.json())
    app.locals.contentPackOptions = options
    app.use('/api', nichesRouter)

    const response = await request(app)
      .patch(`/api/niches/${encodeURIComponent(SLUG)}/episode-shape?project_slug=${project.slug}`)
      .send({
        defaultChapterCount: 4,
        chapterCountRange: [3, 5],
        defaultLengthMinutes: 35,
        lengthMinutesRange: [30, 40],
        defaultWordsPerMinute: 120,
        chaptersIndependent: true,
        metadataTitleStyleHint: 'Name the hour and the weather.',
      })
      .expect(200)

    assert.match(response.body.id, /^user:/)
    assert.equal(response.body.forked_from, SLUG)
    assert.equal(response.body.niche.scriptStructure.defaultLengthMinutes, 35)
    // The fork carries the PACK's content, not the built-in file's.
    assert.equal(response.body.niche.name, 'Signed Sleep Formula')

    const record = await readUserFork(response.body.id, options)
    assert.equal(record?.source.catalog_source, 'content-pack')
    assert.equal(record?.source.legacy_id, SLUG)
    assert.equal((record?.document as { name?: string }).name, 'Signed Sleep Formula')
    assert.equal((await projectManager.getProject(project.slug))?.niche_id, response.body.id)
    const effective = await nicheLoader.getEffectiveNicheFor((await projectManager.getProject(project.slug))!, undefined, options)
    assert.equal(effective?.scriptStructure?.defaultLengthMinutes, 35)
  })

  test('a bare legacy id forks the installed pack it reads as', async () => {
    const { options } = await isolated()
    await installContentPack({ archiveBytes: await packFormulaArchive(), source: 'local-import' }, options)
    const project = await projectManager.createProject({ name: 'Aliased channel', niche_id: 'sleep' })
    assert.equal((await nicheLoader.loadNiche('sleep', options))?.id, SLUG, 'the bare id reads the pack')

    const fork = await forkLegacyContentForEdit(
      { kind: 'series-formula', legacyId: 'sleep', projectSlug: project.slug },
      options,
    )
    assert.equal(fork.source, 'content-pack')
    const record = await readUserFork(fork.fork_id, options)
    // The id the channel stored is what the record keeps; the content is the pack's.
    assert.equal(record?.source.catalog_source, 'content-pack')
    assert.equal(record?.source.legacy_id, 'sleep')
    assert.equal((record?.document as { name?: string }).name, 'Signed Sleep Formula')
    assert.equal((await projectManager.getProject(project.slug))?.niche_id, fork.fork_id)
  })

  test('without the pack the legacy built-in still answers, exactly as before', async () => {
    const { options } = await isolated()
    const builtin = await nicheLoader.loadNiche('sleep', options)
    assert.equal(builtin?.id, 'sleep', 'no pack installed means the built-in is the Formula')
    const project = await projectManager.createProject({ name: 'Fallback channel', niche_id: 'sleep' })

    const fork = await forkLegacyContentForEdit(
      { kind: 'series-formula', legacyId: 'sleep', projectSlug: project.slug },
      options,
    )
    assert.equal(fork.source, 'legacy-builtin')
    const record = await readUserFork(fork.fork_id, options)
    assert.equal(record?.source.catalog_source, 'legacy-builtin')
    assert.equal(record?.source.legacy_id, 'sleep')
    assert.equal((record?.document as { name?: string }).name, builtin?.name)
  })

  test('a qualified id with nothing installed says the pack is missing, not a legacy file', async () => {
    const { options } = await isolated()
    await assert.rejects(
      () => forkLegacyContentForEdit({ kind: 'series-formula', legacyId: SLUG }, options),
      /not installed on this Mac/,
    )
  })
})

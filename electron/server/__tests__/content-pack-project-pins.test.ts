import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import {
  pruneUnpinnedContentPackVersions,
  setContentPackDiscoveryDisabled,
  uninstallContentPackVersion,
} from '../content-packs/lifecycle.js'
import {
  applyProjectContentBundle,
  applyProjectContentUpgrade,
  applyProjectContentUpgradeToActive,
  ContentPackMissingError,
  isProjectContentPackVersionPinnedLocked,
  listProjectSlugsPinningContentPackVersionLocked,
  planProjectContentUpgrade,
  planProjectContentUpgradeToActive,
  undoProjectContentPinBackup,
  resolveProjectContentPins,
  setProjectContentPin,
  snapshotProjectContentPackProvenance,
  updateProjectContentConfigSelections,
  updateProjectContentSelections,
  createProjectWithContentSelections,
} from '../content-packs/project-pins.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { resolveCatalogPackVersion } from '../content-packs/registry.js'
import { mutateContentPackState, readContentPackState } from '../content-packs/state.js'
import type { ContentPackDocument, ContentPackItemKind } from '../content-packs/types.js'
import * as jobQueue from '../services/job-queue.js'
import * as nicheLoader from '../services/niche-loader.js'
import * as projectManager from '../services/project-manager.js'
import * as formatLoader from '../services/format-loader.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import { errorBoundary } from '../lib/error-boundary.js'
import { router as settingsRouter } from '../routes/settings.js'
import { router as contentPacksRouter } from '../routes/content-packs.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-project-pins'
const PACK_ID = 'com.storystudio.project-pin-test'
const FORMULA_ID = `${PACK_ID}.formula`
const TOPIC_ID = `${PACK_ID}.topic`
const STYLE_ID = `${PACK_ID}.style`
const RECIPE_ID = `${PACK_ID}.recipe`
const BUNDLE_PACK_ID = 'com.storystudio.bundle.symbolic-psychology-test'
const BUNDLE_ID = 'com.storystudio.bundle.symbolic-psychology-test'
type BundleComponent = { pack_id: string; version: string; item_id: string; kind: ContentPackItemKind }

const BUNDLE_COMPONENTS = [
  { pack_id: 'com.storystudio.pack.formula.symbolic-test', version: '1.0.1', item_id: 'com.storystudio.formula.symbolic-test', kind: 'series-formula' },
  { pack_id: 'com.storystudio.pack.topic.symbolic-test', version: '1.0.0', item_id: 'com.storystudio.topic.symbolic-test', kind: 'topic-pack' },
  { pack_id: 'com.storystudio.pack.thumbnail.symbolic-test', version: '1.0.1', item_id: 'com.storystudio.thumbnail.symbolic-test', kind: 'thumbnail-recipe' },
  { pack_id: 'com.storystudio.pack.style.pastel-test', version: '1.0.1', item_id: 'com.storystudio.style.pastel-test', kind: 'visual-style' },
  { pack_id: 'com.storystudio.pack.style.impasto-test', version: '1.0.0', item_id: 'com.storystudio.style.impasto-test', kind: 'visual-style' },
  { pack_id: 'com.storystudio.pack.style.oil-test', version: '1.0.0', item_id: 'com.storystudio.style.oil-test', kind: 'visual-style' },
] as const satisfies readonly BundleComponent[]
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function documents(label: string, includeCreativeSelections = false): ContentPackDocument[] {
  const base: ContentPackDocument[] = [{
    kind: 'series-formula', schema_version: 1, id: FORMULA_ID, name: `Formula ${label}`,
    description: 'A pinned Formula.', channel_promise: 'Explain one bounded system.', audience: 'Curious adults.',
    narrative_rules: [`Narrative ${label}`], title_rules: ['Name the mechanism.'],
    script_structure: {
      default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10,
      length_minutes_range: [5, 15], duration_presets: [5, 10, 15], default_words_per_minute: 120,
      chapters_independent: true, pacing_arc: ['Opening'], additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [TOPIC_ID], default_topic_pack_ids: [TOPIC_ID],
    recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [],
    script_context: `Script context ${label}`,
  }, {
    kind: 'topic-pack', schema_version: 1, id: TOPIC_ID, name: `Topic ${label}`,
    description: 'A pinned Topic Pack.', compatible_formula_ids: [FORMULA_ID], subjects: [`Ledger ${label}`],
    episode_objects: ['Tax office'], time_place_scopes: ['1800s'], mechanisms: ['Extraction'],
    evidence_lenses: ['Accounts'], exclusions: [], max_siblings_per_subject: 4, prompt_context: `Topic context ${label}`,
  }]
  if (includeCreativeSelections) base.push({
    kind: 'visual-style', schema_version: 1, id: STYLE_ID, name: `Style ${label}`,
    description: 'A signed visual style.', category: 'Realistic', tags: ['archive'],
    style_bible: `Style bible ${label}`, negative_prompt: 'No text.',
    preview_assets: ['assets/style.png'], compatible_formula_ids: [FORMULA_ID],
  }, {
    kind: 'thumbnail-recipe', schema_version: 1, id: RECIPE_ID, name: `Recipe ${label}`,
    description: 'A signed recipe.', layout: 'hero', category: 'Documentary', tags: ['evidence'],
    aspect_ratio: '16:9', title_mode: 'ai', composition_guidance: 'One document.',
    required_elements: ['Document'], avoid_elements: ['Clutter'], headline_mode: 'episode-title',
    headline_guidance: 'Use the title.', default_text_style: 'Ivory', default_font_style: 'Serif',
    default_text_position: 'top', headline_formats: ['THE RECORD'], visual_style_guidance: 'Archival.',
    preview_assets: ['assets/recipe.png'], compatible_formula_ids: [FORMULA_ID],
  })
  return base
}

async function buildArchive(version: string, label: string, includeCreativeSelections = false, lifecycle: 'active' | 'retired' = 'active'): Promise<Uint8Array> {
  const docs = documents(label, includeCreativeSelections)
  const content = docs.map((document, index) => ({
    path: `content/item-${index}.json`,
    document,
    bytes: Buffer.from(JSON.stringify(document)),
  }))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: PACK_ID,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version,
    min_app_version: '1.0.0',
    lifecycle,
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [],
    items: content.map(item => ({ id: item.document.id, kind: item.document.kind, schema_version: 1, path: item.path })),
    files: [...content.map(item => ({
      path: item.path,
      sha256: sha256(item.bytes),
      bytes: item.bytes.byteLength,
      mime: 'application/json',
    })), ...(includeCreativeSelections ? [
      { path: 'assets/style.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
      { path: 'assets/recipe.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ] : [])],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  for (const item of content) zip.file(item.path, item.bytes, { createFolders: false })
  if (includeCreativeSelections) {
    zip.file('assets/style.png', PNG_1PX, { createFolders: false })
    zip.file('assets/recipe.png', PNG_1PX, { createFolders: false })
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function bundleDocument(component: BundleComponent, label = component.version): ContentPackDocument {
  const base = documents(label, true).find(document => document.kind === component.kind)!
  if (base.kind === 'series-formula') return {
    ...base,
    id: component.item_id,
    compatible_topic_pack_ids: [BUNDLE_COMPONENTS[1].item_id],
    default_topic_pack_ids: [BUNDLE_COMPONENTS[1].item_id],
  }
  if (base.kind === 'topic-pack') return {
    ...base,
    id: component.item_id,
    compatible_formula_ids: [BUNDLE_COMPONENTS[0].item_id],
  }
  if (base.kind === 'visual-style' || base.kind === 'thumbnail-recipe') return {
    ...base,
    id: component.item_id,
    compatible_formula_ids: [BUNDLE_COMPONENTS[0].item_id],
    preview_assets: ['assets/preview.png'],
  }
  throw new Error(`Unsupported bundle fixture kind: ${component.kind}`)
}

async function buildBundleComponentArchive(
  component: BundleComponent,
  options: { kind?: ContentPackItemKind; label?: string; lifecycle?: 'active' | 'retired' | 'replaced' } = {},
): Promise<Uint8Array> {
  const actual = { ...component, kind: options.kind ?? component.kind }
  const document = bundleDocument(actual, options.label)
  const contentBytes = Buffer.from(JSON.stringify(document))
  const usesPreview = actual.kind === 'visual-style' || actual.kind === 'thumbnail-recipe'
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: component.pack_id,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: component.version,
    min_app_version: '1.0.0',
    lifecycle: options.lifecycle ?? 'active',
    entitlement: { sku: `${component.pack_id}.sku`, family: `${component.pack_id}.family` },
    bundles: [],
    items: [{ id: component.item_id, kind: actual.kind, schema_version: 1, path: 'content/item.json' }],
    files: [
      { path: 'content/item.json', sha256: sha256(contentBytes), bytes: contentBytes.byteLength, mime: 'application/json' },
      ...(usesPreview ? [{ path: 'assets/preview.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' }] : []),
    ],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file('content/item.json', contentBytes, { createFolders: false })
  if (usesPreview) zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function buildBundleRootArchive(components: BundleComponent[] = [...BUNDLE_COMPONENTS]): Promise<Uint8Array> {
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: BUNDLE_PACK_ID,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: '1.0.1',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${BUNDLE_PACK_ID}.sku`, family: `${BUNDLE_PACK_ID}.family` },
    dependencies: components.map(({ pack_id, version }) => ({ pack_id, version })),
    bundles: [{ id: BUNDLE_ID, kind: 'channel-kit', name: 'Symbolic Psychology Test Kit', components }],
    items: [],
    files: [],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function installBundleFixture(
  options: Awaited<ReturnType<typeof isolated>>['options'],
  componentOptions: Partial<Record<string, Parameters<typeof buildBundleComponentArchive>[1]>> = {},
) {
  const refs = new Map<string, Awaited<ReturnType<typeof installContentPack>>>()
  for (const component of BUNDLE_COMPONENTS) {
    const archiveBytes = await buildBundleComponentArchive(component, componentOptions[component.item_id])
    refs.set(component.item_id, await installContentPack({ archiveBytes, source: 'local-import' }, options))
  }
  const archiveBytes = await buildBundleRootArchive()
  const root = await installContentPack({ archiveBytes, source: 'local-import' }, options)
  return { refs, root }
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temp.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  return {
    temp,
    paths,
    options: { paths, policy, recoveryRoot, appVersion: '1.0.0' },
  }
}

async function install(version: string, label: string, options: Awaited<ReturnType<typeof isolated>>['options']) {
  const archiveBytes = await buildArchive(version, label)
  return installContentPack({
    archiveBytes,
    source: 'local-import',
    expectedArchiveSha256: sha256(archiveBytes),
  }, options)
}

async function installCreative(version: string, label: string, options: Awaited<ReturnType<typeof isolated>>['options']) {
  const archiveBytes = await buildArchive(version, label, true)
  return installContentPack({
    archiveBytes,
    source: 'local-import',
    expectedArchiveSha256: sha256(archiveBytes),
  }, options)
}

async function waitForTerminalJob(jobId: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !['done', 'error', 'cancelled'].includes(jobQueue.getJob(jobId)?.status || '')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(
    ['done', 'error', 'cancelled'].includes(jobQueue.getJob(jobId)?.status || ''),
    `job ${jobId} did not reach a terminal state before test cleanup`,
  )
  // Queue persistence follows the terminal in-memory update asynchronously.
  await new Promise(resolve => setTimeout(resolve, 80))
}

describe('exact project Content Pack pins', () => {
  test('pins a signed Formula selected explicitly during project creation', async () => {
    const { options } = await isolated()
    const active = await install('1.0.0', 'v1', options)

    const project = await createProjectWithContentSelections({
      name: 'Created With Signed Formula',
      niche_id: FORMULA_ID,
      topic_pack_ids: [TOPIC_ID],
    }, options)

    assert.deepEqual(project.content_pack_versions, { [PACK_ID]: '1.0.0' })
    assert.equal((await resolveProjectContentPins(project, options))[0]?.archive_sha256, active.archive_sha256)
    await install('1.1.0', 'newer active', options)
    assert.equal((await resolveProjectContentPins((await projectManager.getProject(project.slug))!, options))[0]?.archive_sha256,
      active.archive_sha256,
      'a newer active release must not change the exact Formula/Topic pin created by signed discovery')
  })

  test('pins the active exact versions only when a user explicitly changes selected content', async () => {
    const { options } = await isolated()
    await install('1.0.0', 'v1', options)
    const active = await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Explicit Selection' })

    const updated = await updateProjectContentSelections(project.slug, {
      replace_kinds: ['series-formula', 'topic-pack'],
      selections: [
        { id: FORMULA_ID, kind: 'series-formula' },
        { id: TOPIC_ID, kind: 'topic-pack' },
      ],
      update(projectMeta) {
        projectMeta.niche_id = FORMULA_ID
        projectMeta.topic_pack_ids = [TOPIC_ID]
      },
    }, options)

    assert.equal(updated.content_pack_versions?.[PACK_ID], '1.1.0')
    assert.equal((await resolveProjectContentPins(updated, options))[0]?.archive_sha256, active.archive_sha256)
  })

  test('pins the selected archive until an explicit reviewed upgrade or rollback changes it', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    const project = await projectManager.createProject({
      name: 'Pinned Formula',
      niche_id: FORMULA_ID,
      topic_pack_ids: [TOPIC_ID],
    })
    await setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options)

    await install('1.1.0', 'v1.1', options)
    const pinned = await projectManager.getProject(project.slug)
    assert.deepEqual(pinned?.content_pack_versions, { [PACK_ID]: '1.0.0' })
    assert.deepEqual(pinned?.content_pack_items, {
      [FORMULA_ID]: { pack_id: PACK_ID, kind: 'series-formula' },
      [TOPIC_ID]: { pack_id: PACK_ID, kind: 'topic-pack' },
    })
    const effective = await nicheLoader.getEffectiveNicheFor(pinned!, undefined, options)
    assert.equal(effective?.name, 'Formula v1')
    assert.match(effective?.scriptContext || '', /Script context v1/)
    assert.doesNotMatch(effective?.scriptContext || '', /v1\.1/)

    const reselected = await updateProjectContentSelections(project.slug, {
      replace_kinds: ['series-formula', 'topic-pack'],
      selections: [
        { id: FORMULA_ID, kind: 'series-formula' },
        { id: TOPIC_ID, kind: 'topic-pack' },
      ],
      update(projectMeta) {
        projectMeta.niche_id = FORMULA_ID
        projectMeta.topic_pack_ids = [TOPIC_ID]
      },
    }, options)
    assert.equal(reselected.content_pack_versions?.[PACK_ID], '1.0.0',
      'reselecting a pinned item must resolve its exact owner/version instead of the newer active release')

    const plan = await planProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    assert.equal(plan.from.version, '1.0.0')
    assert.equal(plan.to.version, '1.1.0')
    assert.deepEqual(plan.changed_item_ids, [FORMULA_ID, TOPIC_ID])
    assert.ok(plan.affected_generation_types.includes('idea_campaign'))
    assert.ok(plan.affected_generation_types.includes('chapter-only'))

    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.1.0')
    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.0.0', options)
    const rolledBack = await projectManager.getProject(project.slug)
    assert.equal(rolledBack?.content_pack_versions?.[PACK_ID], '1.0.0')
    assert.ok(rolledBack)
    assert.equal((await resolveProjectContentPins(rolledBack, options))[0]?.archive_sha256,
      v1.archive_sha256,
      'an explicit rollback must restore the retained exact bytes, not rediscover a current release',
    )
  })

  test('reports exact missing requirements and blocks only job types that consume them', async () => {
    const { temp, options } = await isolated()
    const project = await projectManager.createProject({ name: 'Imported Missing Pack', niche_id: FORMULA_ID })
    const projectPath = path.join(temp.dir, 'projects', project.slug, 'project.json')
    const imported = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    imported.content_pack_versions = { [PACK_ID]: '9.9.9' }
    imported.content_pack_items = { [FORMULA_ID]: { pack_id: PACK_ID, kind: 'series-formula' } }
    await fs.writeFile(projectPath, `${JSON.stringify(imported, null, 2)}\n`)

    await assert.rejects(resolveProjectContentPins(imported, options), (error: unknown) => {
      assert.ok(error instanceof ContentPackMissingError)
      assert.equal(error.code, 'content-pack-missing')
      assert.deepEqual(error.requirements, [{
        pack_id: PACK_ID,
        version: '9.9.9',
        item_ids: [FORMULA_ID],
        item_kinds: ['series-formula'],
      }])
      return true
    })

    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'audio', options), [])
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'research_run', options), [])
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'contextual_cues', options), [])
    await assert.rejects(snapshotProjectContentPackProvenance(project.slug, 'chapter-only', options), (error: unknown) => {
      assert.ok(error instanceof ContentPackMissingError)
      assert.equal(error.requirements[0]?.version, '9.9.9')
      return true
    })
  })

  test('missing style and recipe bytes do not block downstream render jobs that consume saved prompts', async () => {
    const { temp, options } = await isolated()
    const project = await projectManager.createProject({ name: 'Imported Missing Creative Pack' })
    const projectPath = path.join(temp.dir, 'projects', project.slug, 'project.json')
    const imported = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    imported.content_pack_versions = { [PACK_ID]: '9.9.9' }
    imported.content_pack_items = {
      [STYLE_ID]: { pack_id: PACK_ID, kind: 'visual-style' },
      [RECIPE_ID]: { pack_id: PACK_ID, kind: 'thumbnail-recipe' },
    }
    await fs.writeFile(projectPath, `${JSON.stringify(imported, null, 2)}\n`)

    for (const jobType of ['thumb_images', 'thumb_images', 'continuity_render', 'composition_generate'] as const) {
      assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, jobType, options), [])
    }
    await assert.rejects(
      snapshotProjectContentPackProvenance(project.slug, 'image_prompts', options),
      (error: unknown) => error instanceof ContentPackMissingError
        && error.requirements[0]?.item_kinds.join(',') === 'thumbnail-recipe,visual-style',
    )
  })

  test('settings selections pin signed visual styles and thumbnail recipes in the same transaction', async () => {
    const { options } = await isolated()
    const active = await installCreative('1.0.0', 'creative', options)
    const project = await projectManager.createProject({ name: 'Signed Creative Selections' })
    const app = express()
    app.locals.contentPackOptions = options
    app.use(express.json())
    app.use('/api', settingsRouter)
    app.use(errorBoundary)

    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ active_style_preset_id: STYLE_ID, thumbnail_template_id: RECIPE_ID })
      .expect(200)

    const saved = await projectManager.getProject(project.slug)
    assert.deepEqual(saved?.content_pack_versions, { [PACK_ID]: '1.0.0' })
    assert.deepEqual(saved?.content_pack_items, {
      [RECIPE_ID]: { pack_id: PACK_ID, kind: 'thumbnail-recipe' },
      [STYLE_ID]: { pack_id: PACK_ID, kind: 'visual-style' },
    })
    assert.equal((saved as any)?.active_style_preset_id, STYLE_ID)
    assert.equal((saved as any)?.thumbnail_template_id, RECIPE_ID)
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'image_prompts', options), [{
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: active.archive_sha256,
      item_ids: [RECIPE_ID, STYLE_ID],
    }])

    await installCreative('1.1.0', 'new active', options)
    const pinnedStyle = (await resolveProjectArtStyle(project.slug, options)).style
    assert.equal(pinnedStyle?.description, 'Style bible creative')
  })

  test('an art style that resolves to nothing is refused with 422, on the way in', async () => {
    const { options } = await isolated()
    await installCreative('1.0.0', 'creative', options)
    const project = await projectManager.createProject({ name: 'Unresolvable Style' })
    const app = express()
    app.locals.contentPackOptions = options
    app.use(express.json())
    app.use('/api', settingsRouter)
    app.use(errorBoundary)

    // The failure this prevents is a quiet one: the id saves, the picker shows
    // a name, and every prompt goes out with no style in it.
    const response = await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ active_style_preset_id: 'com.storystudio.style.never-installed' })
      .expect(422)
    assert.match(String(response.body.detail), /could not be resolved/i)

    const saved = await projectManager.getConfig(project.slug)
    assert.equal((saved as any)?.active_style_preset_id, undefined, 'a refused write must not land')
  })

  test('a thumbnail recipe that resolves to nothing is refused with 422 too', async () => {
    const { options } = await isolated()
    await installCreative('1.0.0', 'creative', options)
    const project = await projectManager.createProject({ name: 'Unresolvable Recipe' })
    const app = express()
    app.locals.contentPackOptions = options
    app.use(express.json())
    app.use('/api', settingsRouter)
    app.use(errorBoundary)

    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ thumbnail_template_id: 'com.storystudio.thumbnail.never-installed' })
      .expect(422)
    assert.equal((await projectManager.getConfig(project.slug) as any)?.thumbnail_template_id, undefined)
  })

  test('a project-local saved preset is a real style, and clearing a selection is always allowed', async () => {
    const { options } = await isolated()
    const project = await projectManager.createProject({ name: 'Local Preset Style' })
    const app = express()
    app.locals.contentPackOptions = options
    app.use(express.json())
    app.use('/api', settingsRouter)
    app.use(errorBoundary)

    // Saved in the SAME payload — that is what the picker does.
    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({
        style_presets: [{ id: 'my-look', name: 'My look', description: 'Soft gouache, warm light.', created_at: '2026-08-25T00:00:00Z' }],
        active_style_preset_id: 'my-look',
      })
      .expect(200)
    assert.equal((await projectManager.getConfig(project.slug) as any)?.active_style_preset_id, 'my-look')

    // A preset that carries no prose is not a style, it is an empty row.
    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ style_presets: [{ id: 'blank', name: 'Blank', description: '   ', created_at: '2026-08-25T00:00:00Z' }], active_style_preset_id: 'blank' })
      .expect(422)

    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ active_style_preset_id: '' })
      .expect(200)
    assert.equal((await projectManager.getConfig(project.slug) as any)?.active_style_preset_id, '')
    assert.equal((await projectManager.getProject(project.slug) as any)?.active_style_preset_id, undefined)
  })

  test('a bare legacy recipe id still saves — the guard refuses the broken, not the old', async () => {
    const { options } = await isolated()
    const project = await projectManager.createProject({ name: 'Legacy Recipe Id' })
    const app = express()
    app.locals.contentPackOptions = options
    app.use(express.json())
    app.use('/api', settingsRouter)
    app.use(errorBoundary)

    // A real project carries exactly this: an unqualified built-in template id from
    // before Content Packs. It resolves through the legacy loader, so refusing
    // it would break a working channel to satisfy a rule about tidiness.
    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ thumbnail_template_id: 'archival-map-investigation' })
      .expect(200)
    assert.equal((await projectManager.getConfig(project.slug) as any)?.thumbnail_template_id, 'archival-map-investigation')
  })

  test('unpinned signed Recipe discovery validates kind before creating an exact pin', async () => {
    const { options } = await isolated()
    await installCreative('1.0.0', 'creative', options)
    const project = await projectManager.createProject({ name: 'Recipe Kind Validation' })
    const beforeProject = await projectManager.getProject(project.slug)
    const beforeConfig = await projectManager.getConfig(project.slug)

    // The wording changed when `assertResolvableSelections` landed, and the new
    // wording is the right one. A Style id offered as a Recipe is not a Recipe
    // by any route — not in the signed catalogue, not in the built-in template
    // library — so the request is refused BEFORE the pin resolver is reached,
    // and the customer is told what to do instead of being handed the internal
    // phrase "kind mismatch". What this test is actually for is unchanged and
    // still enforced below: a wrong-kind id is refused, and nothing is written.
    await assert.rejects(updateProjectContentConfigSelections(project.slug, {
      thumbnail_template_id: STYLE_ID,
    }, options), /thumbnail recipe .* could not be resolved/i)
    assert.deepEqual(await projectManager.getProject(project.slug), beforeProject)
    assert.deepEqual(await projectManager.getConfig(project.slug), beforeConfig)
  })

  test('applies one exact multi-Style bundle in one coordinated operation and keeps a selected alternative pinned', async () => {
    const { options } = await isolated()
    const { refs, root } = await installBundleFixture(options)
    const project = await projectManager.createProject({ name: 'Ordered Bundle Application' })

    const applied = await applyProjectContentBundle(project.slug, {
      root: { pack_id: BUNDLE_PACK_ID, version: '1.0.1', archive_sha256: root.archive_sha256 },
      bundle_id: BUNDLE_ID,
    }, options)

    assert.equal(applied.formula_id, BUNDLE_COMPONENTS[0].item_id)
    assert.deepEqual(applied.topic_pack_ids, [BUNDLE_COMPONENTS[1].item_id])
    assert.equal(applied.thumbnail_recipe_id, BUNDLE_COMPONENTS[2].item_id)
    assert.equal(applied.default_style_id, BUNDLE_COMPONENTS[3].item_id)
    assert.deepEqual(applied.alternative_style_ids, [BUNDLE_COMPONENTS[4].item_id, BUNDLE_COMPONENTS[5].item_id])
    assert.deepEqual(applied.style_refs, BUNDLE_COMPONENTS.slice(3).map(component => ({
      item_id: component.item_id,
      ref: {
        pack_id: component.pack_id,
        version: component.version,
        archive_sha256: refs.get(component.item_id)!.archive_sha256,
      },
    })))

    const saved = await projectManager.getProject(project.slug)
    const config = await projectManager.getConfig(project.slug)
    assert.equal(saved?.niche_id, BUNDLE_COMPONENTS[0].item_id)
    assert.deepEqual(saved?.topic_pack_ids, [BUNDLE_COMPONENTS[1].item_id])
    assert.equal(saved?.active_style_preset_id, BUNDLE_COMPONENTS[3].item_id)
    assert.equal(saved?.thumbnail_template_id, BUNDLE_COMPONENTS[2].item_id)
    assert.equal(config?.active_style_preset_id, BUNDLE_COMPONENTS[3].item_id)
    assert.equal(config?.thumbnail_template_id, BUNDLE_COMPONENTS[2].item_id)
    assert.deepEqual(saved?.content_pack_versions, Object.fromEntries(BUNDLE_COMPONENTS.map(component => [component.pack_id, component.version])))
    assert.deepEqual(Object.keys(saved?.content_pack_items ?? {}), BUNDLE_COMPONENTS.map(component => component.item_id))

    const alternative = BUNDLE_COMPONENTS[4]
    const newerArchive = await buildBundleComponentArchive({ ...alternative, version: '1.0.2' }, { label: 'newer active' })
    await installContentPack({ archiveBytes: newerArchive, source: 'local-import' }, options)
    const selected = await updateProjectContentConfigSelections(project.slug, {
      active_style_preset_id: alternative.item_id,
    }, options)
    assert.equal(selected.content_pack_versions?.[alternative.pack_id], alternative.version)
    assert.equal((await resolveProjectArtStyle(project.slug, options)).style?.description, `Style bible ${alternative.version}`)
  })

  test('bundle application fails closed on missing, disabled, recalled, corrupt, and wrong-kind components without project mutation', async () => {
    for (const failure of ['missing', 'disabled', 'recalled', 'corrupt', 'wrong-kind'] as const) {
      const { options } = await isolated()
      const wrongKind = failure === 'wrong-kind'
        ? { [BUNDLE_COMPONENTS[4].item_id]: { kind: 'thumbnail-recipe' as const } }
        : {}
      const { root } = await installBundleFixture(options, wrongKind)
      const project = await projectManager.createProject({ name: `Bundle Failure ${failure}` })
      const beforeProject = await projectManager.getProject(project.slug)
      const beforeConfig = await projectManager.getConfig(project.slug)
      const target = BUNDLE_COMPONENTS[4]
      const state = await readContentPackState(options.paths)
      const installed = state.packs[target.pack_id].versions[target.version]
      if (failure === 'missing') await fs.rm(installed.install_path, { recursive: true })
      if (failure === 'disabled') await setContentPackDiscoveryDisabled(target.pack_id, true, options)
      if (failure === 'corrupt') {
        await mutateContentPackState(current => {
          current.packs[target.pack_id].versions[target.version].archive_sha256 = '0'.repeat(64)
        }, options.paths)
      }
      if (failure === 'recalled') {
        await mutateContentPackState(current => {
          const retained = current.packs[target.pack_id].versions[target.version]
          current.packs[target.pack_id].active_version = undefined
          retained.source = 'genstudio-store'
          retained.delivery_attestation = {
            account_id: 'acct_test', product_id: 'product_test', entitlement_family: 'family_test', release_id: 'release_test',
            pack_id: target.pack_id, version: target.version, archive_sha256: retained.archive_sha256, archive_bytes: 1,
            genstudio_origin: 'https://genstudio.example', subject: 'bundle-closure-member', closure_members: [], key_id: 'receipt-key',
            receipt_canonical_json: '{}', receipt_signature: 'signature',
          }
          retained.recalled = { observed_at: new Date().toISOString(), account_id: 'acct_test', genstudio_origin: 'https://genstudio.example' }
        }, options.paths)
      }

      await assert.rejects(applyProjectContentBundle(project.slug, {
        root: { pack_id: BUNDLE_PACK_ID, version: '1.0.1', archive_sha256: root.archive_sha256 },
        bundle_id: BUNDLE_ID,
      }, options), /unavailable|disabled|recalled|kind|content pack/i, failure)
      assert.deepEqual(await projectManager.getProject(project.slug), beforeProject, failure)
      assert.deepEqual(await projectManager.getConfig(project.slug), beforeConfig, failure)
      await cleanup?.()
      cleanup = undefined
    }
  })

  test('bundle application refuses an existing different-version pin before writing either file', async () => {
    const { options } = await isolated()
    const { root } = await installBundleFixture(options)
    const project = await projectManager.createProject({ name: 'Bundle Pin Conflict' })
    const pastel = BUNDLE_COMPONENTS[3]
    const newerArchive = await buildBundleComponentArchive({ ...pastel, version: '1.0.2' }, { label: 'conflicting pin' })
    const newer = await installContentPack({ archiveBytes: newerArchive, source: 'local-import' }, options)
    await setProjectContentPin(project.slug, {
      pack_id: pastel.pack_id,
      version: '1.0.2',
      archive_sha256: newer.archive_sha256,
    }, options)
    const beforeProject = await projectManager.getProject(project.slug)
    const beforeConfig = await projectManager.getConfig(project.slug)

    await assert.rejects(applyProjectContentBundle(project.slug, {
      root: { pack_id: BUNDLE_PACK_ID, version: '1.0.1', archive_sha256: root.archive_sha256 },
      bundle_id: BUNDLE_ID,
    }, options), /explicit upgrade|pins.*1\.0\.2/i)
    assert.deepEqual(await projectManager.getProject(project.slug), beforeProject)
    assert.deepEqual(await projectManager.getConfig(project.slug), beforeConfig)
  })

  test('bundle writes expose crash-consistent transitional pins and roll back each injected write-phase failure', async () => {
    for (const failurePhase of ['afterTransitionalProjectWrite', 'afterConfigWrite', 'beforeFinalProjectWrite'] as const) {
      const { options } = await isolated()
      const { root } = await installBundleFixture(options)
      const project = await projectManager.createProject({ name: `Bundle Write Failure ${failurePhase}` })
      const projectPath = path.join(projectManager.ensureProjectsRoot(), project.slug, 'project.json')
      const configPath = path.join(projectManager.ensureProjectsRoot(), project.slug, 'config.json')
      const beforeProject = await projectManager.getProject(project.slug)
      const beforeConfig = await projectManager.getConfig(project.slug)
      const observed: string[] = []
      const inspectPhase = async (phase: typeof failurePhase) => {
        observed.push(phase)
        const currentProject = JSON.parse(await fs.readFile(projectPath, 'utf8'))
        const currentConfig = JSON.parse(await fs.readFile(configPath, 'utf8'))
        assert.deepEqual(currentProject.content_pack_versions,
          Object.fromEntries(BUNDLE_COMPONENTS.map(component => [component.pack_id, component.version])))
        assert.equal(Object.keys(currentProject.content_pack_items).length, BUNDLE_COMPONENTS.length)
        assert.equal(currentProject.active_style_preset_id, BUNDLE_COMPONENTS[3].item_id)
        assert.equal(
          currentConfig.active_style_preset_id,
          phase === 'afterTransitionalProjectWrite' ? beforeConfig?.active_style_preset_id : BUNDLE_COMPONENTS[3].item_id,
        )
        if (phase === failurePhase) throw new Error(`injected ${phase}`)
      }

      await assert.rejects(applyProjectContentBundle(project.slug, {
        root: { pack_id: BUNDLE_PACK_ID, version: '1.0.1', archive_sha256: root.archive_sha256 },
        bundle_id: BUNDLE_ID,
      }, {
        ...options,
        hooks: {
          consistentProjectWrite: {
            afterTransitionalProjectWrite: () => inspectPhase('afterTransitionalProjectWrite'),
            afterConfigWrite: () => inspectPhase('afterConfigWrite'),
            beforeFinalProjectWrite: () => inspectPhase('beforeFinalProjectWrite'),
          },
        },
      }), new RegExp(`injected ${failurePhase}`))
      assert.deepEqual(observed, [
        'afterTransitionalProjectWrite',
        ...(['afterConfigWrite', 'beforeFinalProjectWrite'].includes(failurePhase) ? ['afterConfigWrite'] : []),
        ...(failurePhase === 'beforeFinalProjectWrite' ? ['beforeFinalProjectWrite'] : []),
      ])
      assert.deepEqual(await projectManager.getProject(project.slug), beforeProject, failurePhase)
      assert.deepEqual(await projectManager.getConfig(project.slug), beforeConfig, failurePhase)
      await cleanup?.()
      cleanup = undefined
    }
  })

  test('missing, recalled, owner-mismatched, and hash-mismatched owner pins never fall through to a newer active Style', async () => {
    for (const failure of ['missing', 'recalled', 'owner-mismatched', 'hash-mismatched'] as const) {
      const { options } = await isolated()
      const { root } = await installBundleFixture(options)
      const project = await projectManager.createProject({ name: `Fail Closed Alternative ${failure}` })
      await applyProjectContentBundle(project.slug, {
        root: { pack_id: BUNDLE_PACK_ID, version: '1.0.1', archive_sha256: root.archive_sha256 },
        bundle_id: BUNDLE_ID,
      }, options)
      const alternative = BUNDLE_COMPONENTS[4]
      const newerArchive = await buildBundleComponentArchive({ ...alternative, version: '1.0.2' }, { label: 'newer active' })
      await installContentPack({ archiveBytes: newerArchive, source: 'local-import' }, options)
      const state = await readContentPackState(options.paths)
      const retained = state.packs[alternative.pack_id].versions[alternative.version]
      if (failure === 'missing') await fs.rm(retained.install_path, { recursive: true })
      if (failure === 'hash-mismatched') {
        await mutateContentPackState(current => {
          current.packs[alternative.pack_id].versions[alternative.version].archive_sha256 = 'f'.repeat(64)
        }, options.paths)
      }
      if (failure === 'recalled') {
        await mutateContentPackState(current => {
          const pinned = current.packs[alternative.pack_id].versions[alternative.version]
          pinned.source = 'genstudio-store'
          pinned.delivery_attestation = {
            account_id: 'acct_test', product_id: 'product_test', entitlement_family: 'family_test', release_id: 'release_test',
            pack_id: alternative.pack_id, version: alternative.version, archive_sha256: pinned.archive_sha256, archive_bytes: 1,
            genstudio_origin: 'https://genstudio.example', subject: 'bundle-closure-member', closure_members: [], key_id: 'receipt-key',
            receipt_canonical_json: '{}', receipt_signature: 'signature',
          }
          pinned.recalled = { observed_at: new Date().toISOString(), account_id: 'acct_test', genstudio_origin: 'https://genstudio.example' }
        }, options.paths)
      }
      if (failure === 'owner-mismatched') {
        const projectPath = path.join(projectManager.ensureProjectsRoot(), project.slug, 'project.json')
        const saved = JSON.parse(await fs.readFile(projectPath, 'utf8'))
        saved.content_pack_items[alternative.item_id].pack_id = BUNDLE_COMPONENTS[5].pack_id
        await fs.writeFile(projectPath, JSON.stringify(saved))
      }
      const beforeProject = await projectManager.getProject(project.slug)
      const beforeConfig = await projectManager.getConfig(project.slug)

      await assert.rejects(updateProjectContentConfigSelections(project.slug, {
        active_style_preset_id: alternative.item_id,
      }, options), /required Content Pack version is unavailable/i, failure)
      assert.deepEqual(await projectManager.getProject(project.slug), beforeProject, failure)
      assert.deepEqual(await projectManager.getConfig(project.slug), beforeConfig, failure)
      await cleanup?.()
      cleanup = undefined
    }
  })

  test('legacy config, niche, and topic writes confirm a signed-catalog miss and create no pins', async () => {
    const { options } = await isolated()
    const project = await projectManager.createProject({ name: 'Legacy Local Selections' })
    const resolutions: Array<{ id: string; pin?: unknown }> = []
    const observed = {
      ...options,
      hooks: {
        afterCatalogItemResolution: (id: string, pin: unknown) => { resolutions.push({ id, pin }) },
      },
    }

    // These two ids used to be invented ones. `assertResolvableSelections` now
    // refuses an id that resolves NOWHERE — and it is right to: saving one
    // leaves the project pointing at a style or recipe nothing can render. So
    // the legacy route is now exercised with ids that are genuinely resolvable
    // the legacy way, which is what this test was always about:
    //   • the Style arrives as a local preset in the same payload, exactly as
    //     the picker sends it
    //   • the Recipe is a bare built-in template id, the shape a real
    //     pre-Content-Pack project carries
    // Neither is in the signed catalogue, so both must still confirm a
    // signed-catalogue miss and create no pins.
    await updateProjectContentConfigSelections(project.slug, {
      active_style_preset_id: 'legacy-local-style',
      thumbnail_template_id: 'archival-map-investigation',
      style_presets: [{ id: 'legacy-local-style', description: 'A local preset saved with this project.' }],
    } as any, observed)
    await updateProjectContentSelections(project.slug, {
      replace_kinds: ['series-formula'], selections: [{ id: 'legacy-local-niche', kind: 'series-formula' }],
      update(meta) { meta.niche_id = 'legacy-local-niche' },
    }, observed)
    await updateProjectContentSelections(project.slug, {
      replace_kinds: ['topic-pack'], selections: [{ id: 'legacy-local-topic', kind: 'topic-pack' }],
      update(meta) { meta.topic_pack_ids = ['legacy-local-topic'] },
    }, observed)

    assert.deepEqual(resolutions, [
      { id: 'legacy-local-style', pin: undefined },
      { id: 'archival-map-investigation', pin: undefined },
      { id: 'legacy-local-niche', pin: undefined },
      { id: 'legacy-local-topic', pin: undefined },
    ])
    const saved = await projectManager.getProject(project.slug)
    assert.equal(saved?.active_style_preset_id, 'legacy-local-style')
    assert.equal(saved?.thumbnail_template_id, 'archival-map-investigation')
    assert.equal(saved?.niche_id, 'legacy-local-niche')
    assert.deepEqual(saved?.topic_pack_ids, ['legacy-local-topic'])
    assert.equal(saved?.content_pack_items, undefined)
    assert.equal(saved?.content_pack_versions, undefined)
  })

  test('reports a selected item missing from an available exact archive only to its consumers', async () => {
    const { temp, options } = await isolated()
    const installed = await install('1.0.0', 'v1', options)
    const project = await projectManager.createProject({ name: 'Imported Missing Item' })
    const missingFormulaId = `${PACK_ID}.removed-formula`
    const projectPath = path.join(temp.dir, 'projects', project.slug, 'project.json')
    const imported = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    imported.content_pack_versions = { [PACK_ID]: '1.0.0' }
    imported.content_pack_items = { [missingFormulaId]: { pack_id: PACK_ID, kind: 'series-formula' } }
    await fs.writeFile(projectPath, `${JSON.stringify(imported, null, 2)}\n`)

    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'audio', options), [{
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: installed.archive_sha256,
      item_ids: [missingFormulaId],
    }])
    await assert.rejects(snapshotProjectContentPackProvenance(project.slug, 'chapter-only', options), (error: unknown) => {
      assert.ok(error instanceof ContentPackMissingError)
      assert.deepEqual(error.requirements[0]?.item_ids, [missingFormulaId])
      assert.deepEqual(error.requirements[0]?.item_kinds, ['series-formula'])
      return true
    })
  })

  test('freezes provenance at enqueue even after project upgrade, disable, and uninstall', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Queued Provenance', niche_id: FORMULA_ID })
    await setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options)

    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    jobQueue.registerExecutor('chapter-only', async () => {
      await blocked
      await formatLoader.getEffectiveFormat(project.slug)
    })
    const queued = await jobQueue.enqueue({
      project_slug: project.slug,
      type: 'chapter-only',
      episode_id: 'EP001',
      title: 'Pinned job',
      params: { auto_retry: false },
    }, options)
    assert.deepEqual(queued.content_pack_provenance, [{
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
      item_ids: [FORMULA_ID, TOPIC_ID],
    }])

    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    await setContentPackDiscoveryDisabled(PACK_ID, true, options)
    await uninstallContentPackVersion(
      PACK_ID,
      '1.0.0',
      listProjectSlugsPinningContentPackVersionLocked,
      options,
    )
    assert.deepEqual(jobQueue.getJob(queued.job_id)?.content_pack_provenance, queued.content_pack_provenance)
    release()
    await waitForTerminalJob(queued.job_id)
    assert.equal(jobQueue.getJob(queued.job_id)?.status, 'error')
    assert.match(jobQueue.getJob(queued.job_id)?.error || '', /required Content Pack version is unavailable/i)
  })

  test('executes against the enqueued exact Formula instead of resolving the upgraded project live', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Frozen Formula Execution', niche_id: FORMULA_ID })
    await setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options)

    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let observedFormula = ''
    jobQueue.registerExecutor('chapter-only', async () => {
      await blocked
      observedFormula = (await nicheLoader.loadNiche(FORMULA_ID, options))?.name || ''
    })
    const queued = await jobQueue.enqueue({
      project_slug: project.slug,
      type: 'chapter-only',
      episode_id: 'EP002',
      title: 'Frozen Formula',
      params: { auto_retry: false },
    }, options)

    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    release()
    await waitForTerminalJob(queued.job_id)
    assert.equal(observedFormula, 'Formula v1')
  })

  test('serializes a real pin mutation behind uninstall and refuses a pin to deleted bytes', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Uninstall Barrier' })
    let releaseRemoval!: () => void
    const removalBlocked = new Promise<void>(resolve => { releaseRemoval = resolve })
    let removalEntered!: () => void
    const removalStarted = new Promise<void>(resolve => { removalEntered = resolve })
    const removing = uninstallContentPackVersion(PACK_ID, '1.0.0', listProjectSlugsPinningContentPackVersionLocked, {
      ...options,
      hooks: { beforeRemovalDelete: async () => { removalEntered(); await removalBlocked } },
    })
    await removalStarted

    let pinFinished = false
    const pinning = setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options).finally(() => { pinFinished = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(pinFinished, false)
    releaseRemoval()
    await removing
    await assert.rejects(pinning, /required Content Pack version is unavailable/i)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], undefined)
  })

  test('holds the coordination barrier through the project write so uninstall and prune observe the new pin', async () => {
    const { options } = await isolated()
    const refs = new Map<string, Awaited<ReturnType<typeof install>>>()
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
      refs.set(version, await install(version, version, options))
    }
    const project = await projectManager.createProject({ name: 'Pin Write Barrier' })
    let releasePin!: () => void
    const pinBlocked = new Promise<void>(resolve => { releasePin = resolve })
    let pinEntered!: () => void
    const pinStarted = new Promise<void>(resolve => { pinEntered = resolve })
    const pinning = setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: refs.get('1.0.0')!.archive_sha256,
    }, {
      ...options,
      hooks: { beforeProjectWrite: async () => { pinEntered(); await pinBlocked } },
    })
    await pinStarted

    let uninstallFinished = false
    const uninstall = uninstallContentPackVersion(
      PACK_ID,
      '1.0.0',
      listProjectSlugsPinningContentPackVersionLocked,
      options,
    ).finally(() => { uninstallFinished = true })
    let pruneFinished = false
    const prune = pruneUnpinnedContentPackVersions(
      PACK_ID,
      isProjectContentPackVersionPinnedLocked,
      options,
    ).finally(() => { pruneFinished = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(uninstallFinished, false)
    assert.equal(pruneFinished, false)

    releasePin()
    await pinning
    await assert.rejects(uninstall, /pinned by projects: pin-write-barrier/i)
    assert.deepEqual(await prune, [])
    assert.ok((await readContentPackState(options.paths)).packs[PACK_ID].versions['1.0.0'])
  })
})

describe('Content Pack version exposure', () => {
  test('plan writes nothing and apply moves the pin to the active installed version without touching episode files', async () => {
    const { temp, options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    const project = await projectManager.createProject({ name: 'Pin Move' })
    await setProjectContentPin(project.slug, { pack_id: PACK_ID, version: '1.0.0', archive_sha256: v1.archive_sha256 }, options)
    const episodeInfo = path.join(temp.dir, 'projects', project.slug, 'episodes', 'S1', 'EP001', 'episode_info.json')
    await fs.mkdir(path.dirname(episodeInfo), { recursive: true })
    await fs.writeFile(episodeInfo, '{"topic_pack_ids":["kept"]}\n')
    const before = await fs.readFile(episodeInfo, 'utf8')

    await install('1.1.0', 'v1.1', options)
    const plan = await planProjectContentUpgradeToActive(project.slug, PACK_ID, options)
    assert.equal(plan.from.version, '1.0.0')
    assert.equal(plan.to.version, '1.1.0')
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.0.0',
      'a plan must not move the pin')

    const applied = await applyProjectContentUpgradeToActive(project.slug, PACK_ID, options)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.1.0')
    assert.equal(await fs.readFile(episodeInfo, 'utf8'), before, 'existing episode selections stay untouched')
    assert.ok(applied.backup, 'apply returns a durable backup')
    await fs.stat(applied.backup.project_meta)
    const journal = JSON.parse(await fs.readFile(path.join(applied.backup.backup_dir, 'journal.json'), 'utf8')) as {
      files: Array<{ source: string; backup: string; sha256: string; applied_sha256: string }>
    }
    const metaEntry = journal.files.find(entry => entry.source === path.join(temp.dir, 'projects', project.slug, 'project.json'))
    assert.ok(metaEntry, 'journal records the project file')
    assert.equal(metaEntry.applied_sha256, sha256(await fs.readFile(metaEntry.source)), 'post-apply hash matches the live file')
    assert.equal(metaEntry.sha256, sha256(await fs.readFile(metaEntry.backup)), 'backup hash matches the copied bytes')
    await undoProjectContentPinBackup(project.slug, applied.backup.backup_dir)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.0.0')
  })

  test('undo refuses after the project or config was edited, restoring nothing', async () => {
    const { temp, options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    for (const editedFile of ['project.json', 'config.json'] as const) {
      const project = await projectManager.createProject({ name: `Pin Undo ${editedFile}` })
      await setProjectContentPin(project.slug, { pack_id: PACK_ID, version: '1.0.0', archive_sha256: v1.archive_sha256 }, options)
      const applied = await applyProjectContentUpgradeToActive(project.slug, PACK_ID, options)
      assert.ok(applied.backup)
      const filePath = path.join(temp.dir, 'projects', project.slug, editedFile)
      const document = JSON.parse(await fs.readFile(filePath, 'utf8'))
      document.edited_after_pin_move = true
      await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`)
      await assert.rejects(
        undoProjectContentPinBackup(project.slug, applied.backup.backup_dir),
        /edited after the pin move/i,
        `undo must refuse when ${editedFile} changed`,
      )
      assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.1.0',
        'a refused undo leaves the moved pin untouched')
    }
  })

  test('apply refuses when the project changed between snapshot and write', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Pin Snapshot Race' })
    await setProjectContentPin(project.slug, { pack_id: PACK_ID, version: '1.0.0', archive_sha256: v1.archive_sha256 }, options)
    const metaPath = path.join(projectManager.getProjectDir(project.slug)!, 'project.json')
    await assert.rejects(applyProjectContentUpgradeToActive(project.slug, PACK_ID, {
      ...options,
      hooks: {
        beforeProjectWrite: async () => {
          const document = JSON.parse(await fs.readFile(metaPath, 'utf8'))
          document.edited_during_pin_move = true
          await fs.writeFile(metaPath, `${JSON.stringify(document, null, 2)}\n`)
        },
      },
    }), /changed while the pin move was starting/i)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.0.0',
      'a refused move leaves the old pin in place')
  })

  test('retired archives cannot be installed, resolved, or targeted by a pin move', async () => {
    const { temp, options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    const project = await projectManager.createProject({ name: 'Retired Move' })
    await setProjectContentPin(project.slug, { pack_id: PACK_ID, version: '1.0.0', archive_sha256: v1.archive_sha256 }, options)
    const retiredBytes = await buildArchive('1.1.0', 'retired', false, 'retired')
    await assert.rejects(
      installContentPack({ archiveBytes: retiredBytes, source: 'local-import', expectedArchiveSha256: sha256(retiredBytes) }, options),
      /retired/i,
      'a retired archive cannot be installed',
    )
    await fs.writeFile(path.join(temp.dir, 'recovery', 'retired.sspack'), retiredBytes)
    assert.equal(await resolveCatalogPackVersion(PACK_ID, '1.1.0', options), null, 'retired resolves nowhere, including recovery')
    await assert.rejects(
      planProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options),
      /unavailable/i,
      'a pin move cannot target retired bytes',
    )
  })

  test('routes expose plan/apply and refuse active or pinned versions', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    await install('1.2.0', 'v1.2', options)
    const project = await projectManager.createProject({ name: 'Route Pins' })
    await setProjectContentPin(project.slug, { pack_id: PACK_ID, version: '1.0.0', archive_sha256: v1.archive_sha256 }, options)
    const app = express()
    app.use(express.json())
    app.locals.contentPackOptions = options
    app.use('/api', contentPacksRouter)

    const planned = await request(app)
      .post(`/api/content-packs/${PACK_ID}/pin-move/plan`)
      .send({ project_slug: project.slug })
      .expect(200)
    assert.equal(planned.body.to.version, '1.2.0')
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.0.0')

    await request(app)
      .post(`/api/content-packs/${PACK_ID}/pin-move/apply`)
      .send({ project_slug: project.slug })
      .expect(200)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.2.0')

    const active = await request(app)
      .post(`/api/content-packs/${PACK_ID}/versions/1.2.0/uninstall`)
      .expect(409)
    assert.equal(active.body.code, 'CONTENT_PACK_VERSION_ACTIVE')

    const other = await projectManager.createProject({ name: 'Still Pinned' })
    await setProjectContentPin(other.slug, { pack_id: PACK_ID, version: '1.0.0', archive_sha256: v1.archive_sha256 }, options)
    const pinned = await request(app)
      .post(`/api/content-packs/${PACK_ID}/versions/1.0.0/uninstall`)
      .expect(409)
    assert.equal(pinned.body.code, 'CONTENT_PACK_VERSION_PINNED')
    assert.deepEqual(pinned.body.channels, [other.slug])
  })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { mutateContentPackState, readContentPackState, withContentPackCoordinationLock } from '../content-packs/state.js'
import { setContentPackDiscoveryDisabled } from '../content-packs/lifecycle.js'
import { setProjectContentPin } from '../content-packs/project-pins.js'
import { readContentStoreCommerceState } from '../content-store/commerce-state.js'
import { createContentStoreRouter } from '../routes/content-store.js'
import { setApiKey } from '../services/app-secrets-store.js'
import { setGenStudioUrl } from '../services/app-settings.js'
import { installOwnedContentStoreRelease } from '../services/content-store-delivery.js'
import * as projectManager from '../services/project-manager.js'
import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'

const KEY = 'gsk_delivery_transaction'
const ACCOUNT = 'acct_delivery_transaction'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
type ComponentKind = 'series-formula' | 'topic-pack' | 'thumbnail-recipe' | 'visual-style'
const ROOT = {
  productId: 'product-symbolic-psychology-root',
  family: 'com.storystudio.family.kit.symbolic-psychology-studio',
  packId: 'com.storystudio.pack.kit.symbolic-psychology-studio',
  version: '1.0.1',
}
const COMPONENTS = [
  { name: 'Formula', productId: 'product-symbolic-formula', family: 'com.storystudio.family.formula.human-behavior-explained', packId: 'com.storystudio.pack.formula.human-behavior-explained', version: '1.0.1', itemId: 'com.storystudio.formula.human-behavior-explained', kind: 'series-formula' },
  { name: 'Topic', productId: 'product-symbolic-topic', family: 'com.storystudio.family.topic.human-behavior-social-dynamics', packId: 'com.storystudio.pack.topic.human-behavior-social-dynamics', version: '1.0.0', itemId: 'com.storystudio.topic.human-behavior-social-dynamics', kind: 'topic-pack' },
  { name: 'Recipe', productId: 'product-symbolic-recipe', family: 'com.storystudio.family.thumbnail.editorial-psychology-symbolic-split', packId: 'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split', version: '1.0.1', itemId: 'com.storystudio.thumbnail.editorial-psychology-symbolic-split', kind: 'thumbnail-recipe' },
  { name: 'Pastel', productId: 'product-symbolic-pastel', family: 'com.storystudio.family.style.pastel-surreal-psychological-collage', packId: 'com.storystudio.pack.style.pastel-surreal-psychological-collage', version: '1.0.1', itemId: 'com.storystudio.style.pastel-surreal-psychological-collage', kind: 'visual-style' },
  { name: 'Impasto', productId: 'product-symbolic-impasto', family: 'com.storystudio.family.style.impasto-psychological-animals', packId: 'com.storystudio.pack.style.impasto-psychological-animals', version: '1.0.0', itemId: 'com.storystudio.style.impasto-psychological-animals', kind: 'visual-style' },
  { name: 'Oil', productId: 'product-symbolic-oil', family: 'com.storystudio.family.style.oil-painting-classical', packId: 'com.storystudio.pack.style.oil-painting-classical', version: '1.0.0', itemId: 'com.storystudio.style.oil-painting-classical', kind: 'visual-style' },
] as const satisfies ReadonlyArray<{
  name: string; productId: string; family: string; packId: string; version: string; itemId: string; kind: ComponentKind
}>

let cleanup: (() => Promise<void>) | undefined
let mock: MockGenStudioService | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
  await cleanup?.()
  cleanup = undefined
})

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function product(productId: string, family: string, packId: string, version: string, kind: string, bundleComponents: Array<Record<string, unknown>> = []) {
  return {
    product_id: productId, entitlement_family: family, kind,
    title: productId, summary: 'Transactional delivery fixture.', description: 'Transactional delivery fixture.',
    publisher_id: 'com.storystudio', credit_price: 0, free: true, owned: false,
    retired: false, successor_product_id: null,
    current_release: {
      release_id: `release-${productId}`, pack_id: packId, version,
      archive_sha256: '0'.repeat(64), archive_bytes: 1, archive_available: false,
      min_story_version: '1.0.0', changelog: '', component_summary: {},
    },
    compatible: true, compatibility_reason: null, bundle_components: bundleComponents,
    owned_component_credit_value: 0, showcase_videos: [], cover: null, hero: null, tags: [], license: null, discount: null,
  }
}

function componentDocument(itemId: string, kind: ComponentKind): Record<string, unknown> {
  if (kind === 'series-formula') return {
    kind, schema_version: 1, id: itemId, name: 'Symbolic Psychology Formula', description: 'A delivery fixture Formula.',
    channel_promise: 'Explain one bounded behavior.', audience: 'Curious adults.', narrative_rules: ['Stay non-diagnostic.'],
    title_rules: ['Name the mechanism.'], script_structure: {
      default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10,
      length_minutes_range: [5, 15], duration_presets: [5, 10, 15], default_words_per_minute: 120,
      chapters_independent: true, pacing_arc: ['Question', 'Mechanism', 'Takeaway'], additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [COMPONENTS[1].itemId], default_topic_pack_ids: [COMPONENTS[1].itemId],
    recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [], script_context: 'Use non-diagnostic psychology.',
  }
  if (kind === 'topic-pack') return {
    kind, schema_version: 1, id: itemId, name: 'Human Behavior and Social Dynamics', description: 'A delivery fixture Topic.',
    compatible_formula_ids: [COMPONENTS[0].itemId], subjects: ['Belonging'], episode_objects: ['Social signal'],
    time_place_scopes: ['Everyday life'], mechanisms: ['Norms'], evidence_lenses: ['Observed behavior'], exclusions: [],
    max_siblings_per_subject: 4, prompt_context: 'Keep examples bounded.',
  }
  if (kind === 'thumbnail-recipe') return {
    kind, schema_version: 1, id: itemId, name: 'Editorial Psychology Symbolic Split', description: 'A delivery fixture Recipe.',
    layout: 'hero', category: 'Editorial', tags: ['psychology'], aspect_ratio: '16:9', title_mode: 'ai',
    composition_guidance: 'One symbolic subject.', required_elements: ['Subject'], avoid_elements: ['Clutter'],
    headline_mode: 'episode-title', headline_guidance: 'Keep it short.', default_text_style: 'Ivory',
    default_font_style: 'Serif', default_text_position: 'top', headline_formats: ['HIDDEN MOTIVES'],
    visual_style_guidance: 'Restrained.', preview_assets: ['assets/preview.png'], compatible_formula_ids: [COMPONENTS[0].itemId],
  }
  return {
    kind, schema_version: 1, id: itemId, name: 'Symbolic Psychology Style', description: 'A delivery fixture Style.',
    category: 'Editorial', tags: ['psychology'], style_bible: 'Keep the scene clear.', negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'], compatible_formula_ids: [COMPONENTS[0].itemId],
  }
}

async function archive(options: {
  packId: string
  family: string
  version: string
  component?: { itemId: string; kind: ComponentKind }
  dependencies?: Array<{ pack_id: string; version: string }>
  bundleComponents?: typeof COMPONENTS
  minAppVersion?: string
}): Promise<Uint8Array> {
  const documentValue = options.component ? componentDocument(options.component.itemId, options.component.kind) : undefined
  const document = documentValue ? Buffer.from(JSON.stringify(documentValue)) : undefined
  const contentPath = options.component ? `content/${options.component.kind}.json` : undefined
  const hasPreview = options.component?.kind === 'visual-style' || options.component?.kind === 'thumbnail-recipe'
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: options.packId, publisher_id: 'com.storystudio', version: options.version,
    min_app_version: options.minAppVersion ?? '1.0.0', lifecycle: 'active', delivery_profile: 'genstudio-store-receipt-v1',
    entitlement: { sku: `${options.packId}.sku`, family: options.family }, dependencies: options.dependencies,
    bundles: options.bundleComponents ? [{
      id: 'com.storystudio.bundle.symbolic-psychology-studio', kind: 'channel-kit', name: 'Symbolic Psychology Studio',
      components: options.bundleComponents.map(component => ({
        pack_id: component.packId, version: component.version, item_id: component.itemId, kind: component.kind,
      })),
    }] : [],
    items: options.component ? [{ id: options.component.itemId, kind: options.component.kind, schema_version: 1, path: contentPath }] : [],
    files: document && contentPath ? [
      { path: contentPath, sha256: digest(document), bytes: document.byteLength, mime: 'application/json' },
      ...(hasPreview ? [{ path: 'assets/preview.png', sha256: digest(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' }] : []),
    ] : [],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  if (document && contentPath) zip.file(contentPath, document, { createFolders: false })
  if (hasPreview) zip.file('assets/preview.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

function app(options: { appVersion?: string } = {}): express.Express {
  const instance = express()
  instance.use(express.json({ limit: '10mb' }))
  instance.use('/api', createContentStoreRouter(options))
  return instance
}

async function setupClosure(options: { appVersion?: string } = {}) {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  mock = await startMockGenStudioService()
  mock.registerContentStoreKey(KEY, ACCOUNT)
  await setGenStudioUrl(mock.baseUrl)
  await setApiKey('genstudio', KEY)

  const sentinelId = 'com.storystudio.pack.transaction-sentinel'
  const root = product(ROOT.productId, ROOT.family, ROOT.packId, ROOT.version, 'niche_bundle')
  ;(root.current_release as Record<string, unknown>).min_story_version = '1.4.32'
  const components = COMPONENTS.map(component => product(
    component.productId, component.family, component.packId, component.version, component.kind.replace('-', '_'),
  ))
  const dep1 = components[0]!
  const dep2 = components[3]!
  const dep3 = components[5]!
  const sentinel = product('product-sentinel', 'com.storystudio.family.transaction-sentinel', sentinelId, '1.0.0', 'visual_style')
  const dependencies = COMPONENTS.map(component => ({ pack_id: component.packId, version: component.version }))
  root.bundle_components = components.map(component => ({
    product_id: component.product_id, entitlement_family: component.entitlement_family,
    title: component.title, kind: component.kind, component_credit_value: 0, owned: false,
  }))
  mock.contentProducts = [root, ...components, sentinel]
  mock.configureContentBundle(ROOT.productId, COMPONENTS.map(component => component.productId))
  mock.setContentArchive(`release-${ROOT.productId}`, await archive({
    packId: ROOT.packId, family: ROOT.family, version: ROOT.version, dependencies,
    bundleComponents: COMPONENTS, minAppVersion: '1.4.32',
  }))
  for (const component of COMPONENTS) {
    mock.setContentArchive(`release-${component.productId}`, await archive({
      packId: component.packId, family: component.family, version: component.version,
      component: { itemId: component.itemId, kind: component.kind },
    }))
  }
  mock.setContentArchive('release-product-sentinel', await archive({
    packId: sentinelId, family: 'com.storystudio.family.transaction-sentinel', version: '1.0.0',
    component: { itemId: `${sentinelId}.style`, kind: 'visual-style' },
  }))
  mock.seedContentProductOwnership(ACCOUNT, 'product-sentinel')

  const local = app(options)
  const quoted = await request(local).post('/api/content-store/quotes').send({ product_id: ROOT.productId, release_id: null }).expect(201)
  await request(local).post(`/api/content-store/quotes/${quoted.body.quote_id}/purchase`).send({}).expect(200)

  return {
    local, rootId: ROOT.packId, dep1Id: COMPONENTS[0].packId, dep2Id: COMPONENTS[3].packId,
    dep3Id: COMPONENTS[5].packId, sentinelId, dependencies, dep1, dep2, dep3, root, components,
  }
}

function activationSnapshot(state: Awaited<ReturnType<typeof readContentPackState>>) {
  return Object.fromEntries(Object.entries(state.packs)
    .filter(([, pack]) => pack.active_version !== undefined || pack.discovery_disabled)
    .map(([packId, pack]) => [packId, {
    active_version: pack.active_version, discovery_disabled: pack.discovery_disabled,
  }]))
}

function ownershipIdentity(state: Awaited<ReturnType<typeof readContentStoreCommerceState>>) {
  return (state.verified_restores ?? []).map(restore => ({
    account_id: restore.account_id,
    content_account_id: restore.content_account_id,
    genstudio_origin: restore.genstudio_origin,
    key_id: restore.key_id,
    key_history: restore.key_history,
  }))
}

async function createPinnedBaseline(packId: string, releaseId: string, name: string) {
  const paths = getContentPackRuntimePaths()
  await installOwnedContentStoreRelease(releaseId)
  await setContentPackDiscoveryDisabled(packId, true)
  const installed = (await readContentPackState(paths)).packs[packId]!.versions['1.0.0']!
  const project = await projectManager.createProject({ name })
  const pinned = await setProjectContentPin(project.slug, {
    pack_id: packId, version: '1.0.0', archive_sha256: installed.archive_sha256,
  })
  const ownership = ownershipIdentity(await readContentStoreCommerceState())
  assert.ok(ownership.length > 0, 'the transaction invariant must capture verified ownership identity')
  return {
    projectSlug: project.slug,
    projectPins: structuredClone(pinned.content_pack_versions),
    activation: activationSnapshot(await readContentPackState(paths)),
    ownership,
  }
}

test('binds the exact Formula→Topic→Recipe→Pastel→Impasto→Oil receipt positions and activates the verified closure once', async () => {
  const closure = await setupClosure()
  const paths = getContentPackRuntimePaths()

  const response = await request(closure.local)
    .post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(200)

  assert.equal(response.body.install.pack_id, ROOT.packId)
  assert.equal(response.body.install.version, ROOT.version)
  const state = await readContentPackState(paths)
  assert.equal(state.packs[ROOT.packId]?.active_version, ROOT.version)
  for (const component of COMPONENTS) {
    assert.equal(state.packs[component.packId]?.active_version, component.version)
  }
  assert.deepEqual(
    state.packs[ROOT.packId]!.versions[ROOT.version]!.delivery_attestation?.closure_members,
    COMPONENTS.map((component, position) => ({
      position,
      pack_id: component.packId,
      version: component.version,
      product_id: component.productId,
      entitlement_family: component.family,
      release_id: `release-${component.productId}`,
      archive_sha256: state.packs[component.packId]!.versions[component.version]!.archive_sha256,
    })),
  )
})

test('returns CONTENT_PACK_REQUIRES_NEWER_APP before the exact root downloads or mutates project/runtime state', async () => {
  const closure = await setupClosure({ appVersion: '1.4.31' })
  const paths = getContentPackRuntimePaths()
  const project = await projectManager.createProject({ name: 'Older app delivery refusal' })
  const projectBefore = structuredClone(await projectManager.getProject(project.slug))
  const stateBefore = await readContentPackState(paths)
  const archiveGetsBefore = mock!.contentArchiveGetCount
  const response = await request(closure.local)
    .post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(409)

  assert.equal(response.body.code, 'CONTENT_PACK_REQUIRES_NEWER_APP')
  assert.match(response.body.detail, /requires Story Studio 1\.4\.32 or newer \(this app is 1\.4\.31\)/i)
  assert.equal(mock!.contentArchiveGetCount, archiveGetsBefore)
  assert.deepEqual(await readContentPackState(paths), stateBefore)
  assert.deepEqual(await projectManager.getProject(project.slug), projectBefore)
})

test('keeps activation and project pins unchanged when the third Style receipt hash no longer matches', async () => {
  const closure = await setupClosure()
  const paths = getContentPackRuntimePaths()
  const baseline = await createPinnedBaseline(closure.sentinelId, 'release-product-sentinel', 'Pinned third Style hash failure')
  const before = activationSnapshot(await readContentPackState(paths))
  ;(closure.dep3.current_release as Record<string, unknown>).archive_sha256 = 'f'.repeat(64)

  await request(closure.local)
    .post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(409)

  assert.deepEqual(activationSnapshot(await readContentPackState(paths)), before)
  assert.deepEqual((await projectManager.getProject(baseline.projectSlug))?.content_pack_versions, baseline.projectPins)
})

for (const failure of [
  { name: 'first', index: 0, product: 'dep1' as const },
  { name: 'middle', index: 3, product: 'dep2' as const },
  { name: 'last', index: 5, product: 'dep3' as const },
]) {
  test(`keeps activation, discovery, and project pins unchanged when the ${failure.name} dependency fails`, async () => {
    const closure = await setupClosure()
    const paths = getContentPackRuntimePaths()
    const baseline = await createPinnedBaseline(closure.sentinelId, 'release-product-sentinel', `Pinned ${failure.name} failure`)
    const archiveGetsBefore = mock!.contentArchiveGetCount
    ;(closure[failure.product].current_release as Record<string, unknown>).archive_available = false

    await request(closure.local).post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(409)

    const after = await readContentPackState(paths)
    assert.deepEqual(activationSnapshot(after), baseline.activation)
    assert.deepEqual((await projectManager.getProject(baseline.projectSlug))?.content_pack_versions, baseline.projectPins)
    assert.deepEqual(ownershipIdentity(await readContentStoreCommerceState()), baseline.ownership)
    assert.equal(mock!.contentArchiveGetCount - archiveGetsBefore, failure.index + 1, 'root and only preceding dependencies download')
    assert.equal(after.packs[closure.rootId], undefined, 'downloaded root bytes remain uninstalled until its closure is ready')
    for (const [index, dependency] of closure.dependencies.entries()) {
      const installed = after.packs[dependency.pack_id]?.versions[dependency.version]
      assert.equal(Boolean(installed), index < failure.index, `${dependency.pack_id} install state must match its closure position`)
      if (installed) assert.equal(after.packs[dependency.pack_id]?.active_version, undefined, 'staged dependencies remain inactive')
    }
  })
}

test('does not activate an already-installed inactive dependency when a later dependency fails', async () => {
  const { local, dep1Id, dep2 } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  await installOwnedContentStoreRelease(`release-${COMPONENTS[0].productId}`)
  await mutateContentPackState(state => {
    delete state.packs[dep1Id]!.active_version
  }, paths)
  const before = activationSnapshot(await readContentPackState(paths))
  ;(dep2.current_release as Record<string, unknown>).archive_available = false

  await request(local).post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(409)

  const after = await readContentPackState(paths)
  assert.deepEqual(activationSnapshot(after), before)
  assert.equal(after.packs[dep1Id]?.active_version, undefined)
})

test('keeps the root selection unchanged when the root cannot be committed after every dependency verifies', async () => {
  const { local, rootId, dep1Id, sentinelId } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  const baseline = await createPinnedBaseline(sentinelId, 'release-product-sentinel', 'Pinned root failure')
  for (const component of COMPONENTS) await installOwnedContentStoreRelease(`release-${component.productId}`)
  // Reserve an immutable root slot that fails only after this attempt has
  // re-verified the complete dependency closure.
  const state = await readContentPackState(paths)
  const dependency = state.packs[dep1Id]!.versions[COMPONENTS[0].version]!
  state.packs[rootId] = { discovery_disabled: true, versions: {
    [ROOT.version]: {
      ...dependency,
      manifest: { ...dependency.manifest, pack_id: rootId, version: ROOT.version },
      install_path: dependency.install_path.replace(dep1Id, rootId),
    archive_sha256: 'f'.repeat(64),
    },
  } }
  await mutateContentPackState(current => { current.packs[rootId] = state.packs[rootId]! }, paths)
  const before = activationSnapshot(await readContentPackState(paths))
  const ownershipBefore = ownershipIdentity(await readContentStoreCommerceState())

  await request(local).post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(500)

  const after = await readContentPackState(paths)
  assert.deepEqual(activationSnapshot(after), before)
  assert.deepEqual((await projectManager.getProject(baseline.projectSlug))?.content_pack_versions, baseline.projectPins)
  assert.deepEqual(ownershipIdentity(await readContentStoreCommerceState()), ownershipBefore)
})

test('holds the coordination lock from the first archive download through closure activation', async () => {
  const { local } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  const archiveBarrier = mock!.pauseNextContentArchiveResponse()
  const install = request(local).post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(200)
    .then(response => response)
  await archiveBarrier.started

  const contender = withContentPackCoordinationLock(paths, async () => 'entered')
  const observed = await Promise.race([
    contender,
    new Promise<'still-waiting'>(resolve => setTimeout(() => resolve('still-waiting'), 50)),
  ])
  archiveBarrier.release()
  await install
  await contender

  assert.equal(observed, 'still-waiting', 'no coordinated lifecycle operation may enter during delivery')
})

test('reactivates the complete installed-inactive closure after an interrupted final activation', async () => {
  const { rootId } = await setupClosure()
  const paths = getContentPackRuntimePaths()
  await installOwnedContentStoreRelease(`release-${ROOT.productId}`)
  await mutateContentPackState(state => {
    for (const packId of [rootId, ...COMPONENTS.map(component => component.packId)]) delete state.packs[packId]!.active_version
  }, paths)

  await installOwnedContentStoreRelease(`release-${ROOT.productId}`)

  const state = await readContentPackState(paths)
  assert.equal(state.packs[rootId]?.active_version, ROOT.version)
  for (const component of COMPONENTS) {
    assert.equal(state.packs[component.packId]?.active_version, component.version, `${component.packId} must reactivate with the root`)
  }
})

test('keeps authoritative ownership and recall safety durable when delivery later fails', async () => {
  const closure = await setupClosure()
  const paths = getContentPackRuntimePaths()
  const baseline = await createPinnedBaseline(closure.dep3Id, `release-${COMPONENTS[5].productId}`, 'Pinned recalled third Style')
  ;(closure.dep3 as Record<string, unknown>).recalled_release_versions = [COMPONENTS[5].version]
  mock!.setContentOwnedReleaseState(`release-${COMPONENTS[5].productId}`, {
    state: 'recalled',
    recalledAt: '2026-08-15T17:00:00Z',
    recallReason: 'Unsafe test content.',
  })

  await request(closure.local).post(`/api/content-store/releases/release-${ROOT.productId}/install`).send({}).expect(409)

  const after = await readContentPackState(paths)
  const retained = after.packs[closure.dep3Id]!.versions[COMPONENTS[5].version]!
  assert.equal(after.packs[closure.dep3Id]!.active_version, undefined, 'an authenticated recall remains blocking')
  assert.equal(after.packs[closure.dep3Id]!.discovery_disabled, true, 'the prior discovery choice is preserved')
  assert.equal(retained.recalled?.account_id, ACCOUNT)
  assert.equal(retained.recalled?.genstudio_origin, mock!.baseUrl)
  assert.deepEqual((await projectManager.getProject(baseline.projectSlug))?.content_pack_versions, baseline.projectPins)
  assert.deepEqual(ownershipIdentity(await readContentStoreCommerceState()), baseline.ownership)
})

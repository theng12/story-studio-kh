import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, mock, test } from 'node:test'

import JSZip from 'jszip'
import express from 'express'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { setContentPackDiscoveryDisabled } from '../content-packs/lifecycle.js'
import {
  listCatalogEntries,
  resolveCatalogItem,
  type ContentPackRegistryOptions,
} from '../content-packs/registry.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { useTempDataDir } from './_helpers.js'
import * as nicheLoader from '../services/niche-loader.js'
import * as topicPackLoader from '../services/topic-pack-loader.js'
import * as thumbnailTemplateLoader from '../services/thumbnail-template-loader.js'
import { listVisualStyles, loadVisualStyle } from '../services/visual-style-loader.js'
import { router as nichesRouter } from '../routes/niches.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.key.registry-test'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID, publisherId: PUBLISHER_ID,
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

function documents(
  packId: string,
  suffix: string,
  recipeId = `${packId}.recipe`,
  styleCategory = 'Realistic',
  names: { formula?: string; topic?: string } = {},
): ContentPackDocument[] {
  const formulaId = `${packId}.formula`
  const topicId = `${packId}.topic`
  const styleId = `${packId}.style`
  return [
    {
      kind: 'series-formula', schema_version: 1, id: formulaId, name: names.formula ?? `Formula ${suffix}`, description: 'A signed Formula.',
      channel_promise: 'Explain bounded systems.', audience: 'Curious adults.', narrative_rules: ['Stay causal.'], title_rules: ['Be specific.'],
      script_structure: {
        default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10, length_minutes_range: [5, 15],
        duration_presets: [5, 10, 15], default_words_per_minute: 120, chapters_independent: true,
        pacing_arc: ['Opening'], additional_rules: ['Be precise.'],
      }, compatible_topic_pack_ids: [topicId], default_topic_pack_ids: [topicId],
      recommended_visual_style_ids: [styleId], recommended_thumbnail_recipe_ids: [recipeId],
    },
    {
      kind: 'topic-pack', schema_version: 1, id: topicId, name: names.topic ?? `Topic ${suffix}`, description: 'A signed Topic Pack.',
      compatible_formula_ids: [formulaId], subjects: ['Ledger'], episode_objects: ['Tax office'], time_place_scopes: ['1800s'],
      mechanisms: ['Extraction'], evidence_lenses: ['Accounts'], exclusions: [], max_siblings_per_subject: 4, prompt_context: `Context ${suffix}`,
    },
    {
      kind: 'visual-style', schema_version: 1, id: styleId, name: `Style ${suffix}`, description: 'A signed visual style.',
      category: styleCategory, tags: ['archive'], style_bible: `Style bible ${suffix}`, negative_prompt: 'No text.',
      preview_assets: ['assets/style.png'], compatible_formula_ids: [formulaId],
    },
    {
      kind: 'thumbnail-recipe', schema_version: 1, id: recipeId, name: `Recipe ${suffix}`, description: 'A signed recipe.',
      layout: 'hero', category: 'Documentary', tags: ['evidence'], aspect_ratio: '16:9', title_mode: 'ai',
      composition_guidance: 'One document.', required_elements: ['Document'], avoid_elements: ['Clutter'],
      headline_mode: 'episode-title', headline_guidance: 'Use the title.', default_text_style: 'Ivory', default_font_style: 'Serif',
      default_text_position: 'top', headline_formats: ['THE RECORD'], visual_style_guidance: 'Archival.',
      preview_assets: ['assets/recipe.png'], compatible_formula_ids: [formulaId],
    },
  ]
}

async function buildArchive(
  packId: string,
  version: string,
  suffix: string,
  lifecycle: 'active' | 'retired' = 'active',
  minAppVersion = '1.0.0',
  recipeId?: string,
  styleCategory = 'Realistic',
  names: { formula?: string; topic?: string } = {},
): Promise<Uint8Array> {
  const docs = documents(packId, suffix, recipeId, styleCategory, names)
  const jsonFiles = docs.map((document, index) => ({
    path: `content/item-${index}.json`, bytes: Buffer.from(JSON.stringify(document)), document,
  }))
  const files = [
    ...jsonFiles.map(file => ({ path: file.path, sha256: sha256(file.bytes), bytes: file.bytes.byteLength, mime: 'application/json' })),
    { path: 'assets/style.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    { path: 'assets/recipe.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
  ]
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version, min_app_version: minAppVersion, lifecycle,
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, bundles: [],
    items: jsonFiles.map(file => ({ id: file.document.id, kind: file.document.kind, schema_version: 1, path: file.path })), files,
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  for (const file of jsonFiles) zip.file(file.path, file.bytes, { createFolders: false })
  zip.file('assets/style.png', PNG_1PX, { createFolders: false })
  zip.file('assets/recipe.png', PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temp.dir, 'recovery-fixtures')
  await fs.mkdir(recoveryRoot, { recursive: true })
  const options: ContentPackRegistryOptions = { paths, policy, recoveryRoot }
  return { paths, recoveryRoot, options }
}

describe('verified Content Pack registry', () => {
  test('formula and Topic Pack catalogue routes expose verified source for installed packs only', async () => {
    const { paths, options } = await isolated()
    const packId = 'com.storystudio.registry-catalogue-source'
    const archive = await buildArchive(
      packId,
      '1.0.0',
      'catalogue source',
      'active',
      '1.0.0',
      undefined,
      'Realistic',
      { formula: 'Natural World, Explained', topic: 'Wars, Treaties & World Order' },
    )
    await installContentPack({ archiveBytes: archive, source: 'local-import' }, { paths, policy })
    const projectManager = await import('../services/project-manager.js')
    const project = await projectManager.createProject({
      name: 'Signed Formula Reference', niche_id: `${packId}.formula`,
    })
    const app = express()
    app.locals.contentPackOptions = options
    app.use('/api', nichesRouter)

    const projectMetaPath = path.join(projectManager.projectsRoot(), project.slug, 'project.json')
    const realReadFile = fs.readFile.bind(fs)
    let projectMetadataReads = 0
    const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
      if (String(file) === projectMetaPath) projectMetadataReads++
      return realReadFile(file, ...args as [])
    })
    let formulas: any[]
    try {
      formulas = (await request(app).get('/api/niches').expect(200)).body.niches
    } finally {
      readMock.mock.restore()
    }
    const signedFormula = formulas.find((item: any) => item.id === `${packId}.formula`)
    const legacyFormula = formulas.find((item: any) => item.id === 'animals')
    // Owner ruling, 2026-10-29 — "no custom, no built in, all from packs": the
    // shipped profile is not listed beside a pack, and there is no second row to
    // collapse. It is still readable, which the check below proves.
    assert.equal(legacyFormula, undefined, 'a shipped legacy profile must not be listed any more')
    assert.equal(signedFormula.name, 'Natural World, Explained', 'the pack publishes its own name')
    assert.equal(signedFormula.project_count, 1)
    assert.equal((await nicheLoader.loadNiche('animals', options))?.id, 'animals',
      'a stored legacy id still resolves, through the pack when the pack owns it')
    assert.equal(projectMetadataReads, 1, 'the listing metadata must be reused for niche counts')
    assert.deepEqual(signedFormula.catalog, {
      source: 'signed-installed', pack_id: packId, version: '1.0.0',
    })

    const topics = (await request(app).get('/api/topic-packs').expect(200)).body.topic_packs
    const signedTopic = topics.find((item: any) => item.id === `${packId}.topic`)
    const legacyTopic = topics.find((item: any) => item.id === 'historical-wars-treaties-world-order')
    assert.equal(legacyTopic, undefined, 'a shipped legacy Topic Pack must not be listed any more')
    assert.equal(signedTopic.name, 'Wars, Treaties & World Order')
    assert.deepEqual(signedTopic.catalog, {
      source: 'signed-installed', pack_id: packId, version: '1.0.0',
    })
    assert.equal((await topicPackLoader.loadTopicPack('historical-wars-treaties-world-order', options))?.id,
      'historical-wars-treaties-world-order',
      'a stored legacy id still resolves from its own source when no pack owns it')
    assert.doesNotMatch(JSON.stringify({ formulas, topics }), /archive_sha256|install_path|\/Users\//i)

    const runtimeFormula = (await nicheLoader.listNiches(options))
      .find(item => item.id === `${packId}.formula`)
    const runtimeTopic = (await topicPackLoader.listTopicPacks(options))
      .find(item => item.id === `${packId}.topic`)
    assert.equal('catalog' in (runtimeFormula || {}), false, 'display provenance must not enter planner Formula values')
    assert.equal('catalog' in (runtimeTopic || {}), false, 'display provenance must not enter planner Topic Pack values')
  })

  test('publishes renderer-safe visual styles through the existing catalog router', async () => {
    await isolated()
    const app = express()
    app.use(express.json())
    app.use('/api', nichesRouter)
    const response = await request(app).get('/api/visual-styles').expect(200)
    assert.ok(Array.isArray(response.body.visual_styles))
    assert.doesNotMatch(JSON.stringify(response.body), /(?:\/Users\/|file:)/i)
  })

  test('lists only installed signed styles and preserves author-defined categories', async () => {
    const { paths, recoveryRoot, options } = await isolated()
    const installedPack = 'com.storystudio.registry-natural-world'
    const recoveryPack = 'com.storystudio.registry-editorial-recovery'
    const installedArchive = await buildArchive(
      installedPack, '1.0.0', 'natural world', 'active', '1.0.0', undefined, 'Natural world',
    )
    await installContentPack({ archiveBytes: installedArchive, source: 'local-import' }, { paths, policy })
    const recoveryArchive = await buildArchive(
      recoveryPack, '1.0.0', 'editorial recovery', 'active', '1.0.0', undefined, 'Editorial psychology',
    )
    await fs.writeFile(path.join(recoveryRoot, 'editorial-recovery.sspack'), recoveryArchive)

    const styles = await listVisualStyles(options)
    const pinnedRecoveryStyle = await loadVisualStyle(`${recoveryPack}.style`, {
      ...options,
      pins: [{
        pack_id: recoveryPack,
        version: '1.0.0',
        archive_sha256: sha256(recoveryArchive),
      }],
    })

    assert.deepEqual(styles.map(style => [style.id, style.category]), [
      [`${installedPack}.style`, 'Natural world'],
    ])
    assert.equal(pinnedRecoveryStyle?.category, 'Editorial psychology')
  })

  test('orders pinned, active installed, recovery, then injected legacy fallback', async () => {
    const { paths, recoveryRoot, options } = await isolated()
    const installedPack = 'com.storystudio.registry-installed'
    const recoveryPack = 'com.storystudio.registry-recovery'
    const oldArchive = await buildArchive(installedPack, '1.0.0', 'old')
    const old = await installContentPack({ archiveBytes: oldArchive, source: 'local-import', expectedArchiveSha256: sha256(oldArchive) }, { paths, policy })
    const currentArchive = await buildArchive(installedPack, '1.1.0', 'current')
    await installContentPack({ archiveBytes: currentArchive, source: 'local-import', expectedArchiveSha256: sha256(currentArchive) }, { paths, policy })
    await fs.writeFile(path.join(recoveryRoot, 'recovery.sspack'), await buildArchive(recoveryPack, '1.0.0', 'recovery'))

    const entries = await listCatalogEntries('visual-style', {
      ...options,
      pins: [{ pack_id: installedPack, version: '1.0.0', archive_sha256: old.archive_sha256 }],
      legacy: [{
        value: documents('com.storystudio.registry-legacy', 'legacy')[2], source: 'legacy-builtin',
      }],
    })

    assert.deepEqual(entries.map(entry => [entry.value.name, entry.source]), [
      ['Style old', 'signed-installed'],
      ['Style current', 'signed-installed'],
      ['Style recovery', 'signed-recovery'],
      ['Style legacy', 'legacy-builtin'],
    ])
  })

  test('keeps recovery provenance when an exact pin selects another version of an installed pack', async () => {
    const { paths, recoveryRoot, options } = await isolated()
    const packId = 'com.storystudio.registry-recovery-pin'
    const installedArchive = await buildArchive(packId, '1.0.0', 'installed')
    await installContentPack({ archiveBytes: installedArchive, source: 'local-import' }, { paths, policy })
    const recoveryArchive = await buildArchive(packId, '0.9.0', 'recovery pin')
    await fs.writeFile(path.join(recoveryRoot, 'recovery-pin.sspack'), recoveryArchive)

    const entries = await listCatalogEntries('visual-style', {
      ...options,
      pins: [{ pack_id: packId, version: '0.9.0', archive_sha256: sha256(recoveryArchive) }],
    })

    assert.equal(entries[0]?.value.name, 'Style recovery pin')
    assert.equal(entries[0]?.source, 'signed-recovery')
  })

  test('never discovers or resolves a signed recovery pack requiring a newer app', async () => {
    const { recoveryRoot, options } = await isolated()
    const packId = 'com.storystudio.registry-future-recovery'
    const archive = await buildArchive(packId, '1.0.0', 'future', 'active', '99.0.0')
    await fs.writeFile(path.join(recoveryRoot, 'future.sspack'), archive)
    const incompatibleOptions = { ...options, appVersion: '1.0.832' }

    assert.equal((await listCatalogEntries('visual-style', incompatibleOptions))
      .some(entry => entry.pack?.pack_id === packId), false)
    assert.equal(await resolveCatalogItem(`${packId}.style`, {
      pack_id: packId,
      version: '1.0.0',
      archive_sha256: sha256(archive),
    }, incompatibleOptions), null)
  })

  test('hides disabled and retired packs from discovery but exact pins still resolve them', async () => {
    const { paths, recoveryRoot, options } = await isolated()
    const disabledPack = 'com.storystudio.registry-disabled'
    const retiredPack = 'com.storystudio.registry-retired'
    const disabledArchive = await buildArchive(disabledPack, '1.0.0', 'disabled')
    const disabled = await installContentPack({ archiveBytes: disabledArchive, source: 'local-import' }, { paths, policy })
    await fs.writeFile(path.join(recoveryRoot, 'disabled-recovery.sspack'),
      await buildArchive(disabledPack, '0.9.0', 'disabled recovery'))
    await setContentPackDiscoveryDisabled(disabledPack, true, { paths })
    const retiredArchive = await buildArchive(retiredPack, '1.0.0', 'retired', 'retired')
    const retired = await installContentPack({ archiveBytes: retiredArchive, source: 'local-import' }, { paths, policy })

    assert.deepEqual(await listCatalogEntries('visual-style', options), [])
    const disabledEntry = await resolveCatalogItem(`${disabledPack}.style`, {
      pack_id: disabledPack, version: '1.0.0', archive_sha256: disabled.archive_sha256,
    }, options)
    const retiredEntry = await resolveCatalogItem(`${retiredPack}.style`, {
      pack_id: retiredPack, version: '1.0.0', archive_sha256: retired.archive_sha256,
    }, options)
    assert.equal(disabledEntry?.value.name, 'Style disabled')
    assert.equal(retiredEntry?.value.name, 'Style retired')
    assert.equal(await resolveCatalogItem(`${disabledPack}.style`, undefined, options), null)
  })

  test('qualified signed resolution returns immutable clones and bare IDs stay outside the signed namespace', async () => {
    const { paths, options } = await isolated()
    const packId = 'com.storystudio.registry-clone'
    const archive = await buildArchive(packId, '1.0.0', 'clone')
    await installContentPack({ archiveBytes: archive, source: 'local-import' }, { paths, policy })

    const first = await resolveCatalogItem(`${packId}.style`, undefined, options)
    assert.ok(first)
    ;(first.value as { name: string }).name = 'mutated renderer value'
    const second = await resolveCatalogItem(`${packId}.style`, undefined, options)
    assert.equal(second?.value.name, 'Style clone')
    assert.equal(await resolveCatalogItem('builtin-ms-paint-fantasy', undefined, options), null)
  })

  test('warm listings reverify after nested payload edits, additions and removals', async () => {
    const { paths, options } = await isolated()
    const packId = 'com.storystudio.registry-nested'
    await installContentPack({ archiveBytes: await buildArchive(packId, '1.0.0', 'nested'), source: 'local-import' }, { paths, policy })
    const state = await readContentPackState(paths)
    const root = state.packs[packId].versions['1.0.0'].install_path
    const file = path.join(root, 'assets', 'style.png')
    const original = await fs.readFile(file)
    assert.equal((await listCatalogEntries('visual-style', options)).length, 1)
    await fs.writeFile(file, 'changed nested asset')
    await assert.rejects(listCatalogEntries('visual-style', options))
    await fs.writeFile(file, original)
    assert.equal((await listCatalogEntries('visual-style', options)).length, 1)
    const added = path.join(root, 'assets', 'unexpected.txt')
    await fs.writeFile(added, 'unsigned')
    const realRead = fs.readFile.bind(fs)
    let archiveReads = 0
    const reads = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
      if (String(file).endsWith('/content/archive.sspack')) archiveReads++
      return (realRead as any)(file, ...args)
    })
    try {
      assert.equal((await listCatalogEntries('visual-style', options)).length, 1, 'unsigned extras are not catalogue items')
      assert.ok(archiveReads > 0, 'nested addition rechecks signed bytes')
    } finally { reads.mock.restore() }
    // Removal is recoverable even in fixtures.
    await fs.rename(added, path.join(paths.root, 'removed-unexpected.txt'))
    assert.equal((await listCatalogEntries('visual-style', options)).length, 1)
    await fs.rename(file, path.join(paths.root, 'removed-style.png'))
    await assert.rejects(listCatalogEntries('visual-style', options))
  })

  test('adapter routes never expose local Content Pack trust or install paths', async () => {
    const { paths, options } = await isolated()
    const packId = 'com.storystudio.registry-path-redaction'
    const archive = await buildArchive(packId, '1.0.0', 'path redaction')
    await installContentPack({ archiveBytes: archive, source: 'local-import' }, { paths, policy })
    const state = await readContentPackState(paths)
    await fs.writeFile(state.packs[packId].versions['1.0.0'].install_path + '/content/archive.sspack', 'tampered')
    const app = express()
    app.locals.contentPackOptions = options
    app.use('/api', nichesRouter)

    const response = await request(app).get('/api/visual-styles').expect(500)
    assert.equal(response.body.detail, 'Failed to list visual styles')
    assert.equal(JSON.stringify(response.body).includes(paths.root), false)
  })

  test('existing loaders prefer qualified signed entries while bare legacy IDs retain exact fallback behavior', async () => {
    const { paths, options } = await isolated()
    const packId = 'com.storystudio.registry-loaders'
    const animalHardshipRecipeId = 'com.storystudio.thumbnail.animal-hardship-annotation'
    const archive = await buildArchive(packId, '1.0.0', 'loader', 'active', '1.0.0', animalHardshipRecipeId)
    await installContentPack({ archiveBytes: archive, source: 'local-import' }, { paths, policy })

    const signedNiche = await nicheLoader.loadNiche(`${packId}.formula`, options)
    const signedTopic = await topicPackLoader.loadTopicPack(`${packId}.topic`, options)
    const animalHardshipRecipe = await thumbnailTemplateLoader.loadTemplate(animalHardshipRecipeId, options)
    const styles = await listVisualStyles(options)
    assert.equal(signedNiche?.name, 'Formula loader')
    assert.equal(signedTopic?.promptContext, 'Context loader')
    assert.equal(animalHardshipRecipe?.id, animalHardshipRecipeId)
    assert.equal(animalHardshipRecipe?.recipe?.conceptGuidance, 'One document.')
    assert.deepEqual(animalHardshipRecipe?.previewImages, [
      `/api/content-packs/${packId}/1.0.0/assets/${sha256(PNG_1PX)}`,
    ])
    assert.doesNotMatch(JSON.stringify(animalHardshipRecipe), /(?:\/Users\/|file:|install_path|trust)/i)
    assert.equal(styles.find(style => style.id === `${packId}.style`)?.preview_image,
      `/api/content-packs/${packId}/1.0.0/assets/${sha256(PNG_1PX)}`)
    assert.doesNotMatch(JSON.stringify(styles), /(?:\/Users\/|file:)/i)

    const legacyNiche = await nicheLoader.loadNiche('hidden-mechanics-history', options)
    const legacyTopic = await topicPackLoader.loadTopicPack('historical-states-revolutions-collapse', options)
    const legacyRecipe = await thumbnailTemplateLoader.loadTemplate('archival-map-investigation', options)
    const centeredHero = await thumbnailTemplateLoader.loadTemplate('centered-hero-headline', options)
    const portraitBlock = await thumbnailTemplateLoader.loadTemplate('portrait-block-right', options)
    assert.equal(legacyNiche?.id, 'hidden-mechanics-history')
    assert.equal(legacyTopic?.id, 'historical-states-revolutions-collapse')
    assert.equal(legacyRecipe?.id, 'archival-map-investigation')
    assert.equal(centeredHero?.id, 'centered-hero-headline')
    assert.equal(portraitBlock?.id, 'portrait-block-right')
  })

  test('a repeated listing reuses verified bytes while checking nested identities until state.json changes', async () => {
    const { paths, options } = await isolated()
    const packs = ['com.storystudio.registry-memo-a', 'com.storystudio.registry-memo-b']
    for (const [index, packId] of packs.entries()) {
      await installContentPack({ archiveBytes: await buildArchive(packId, '1.0.0', `memo ${index}`), source: 'local-import' }, { paths, policy })
    }
    const first = await listCatalogEntries('series-formula', options)
    assert.deepEqual(first.map(entry => entry.pack?.pack_id), packs)
    first[0]!.value.name = 'mutated by a caller'

    const realReadFile = fs.readFile.bind(fs)
    let packReads = 0
    const readMock = mock.method(fs, 'readFile', async (file: any, ...args: any[]) => {
      if (String(file).startsWith(paths.installedRoot)) packReads++
      return (realReadFile as any)(file, ...args)
    })
    let second: Awaited<ReturnType<typeof listCatalogEntries>>
    try {
      second = await listCatalogEntries('series-formula', options)
    } finally {
      readMock.mock.restore()
    }
    assert.equal(packReads, 0, 'an unchanged catalogue checks metadata without rereading signed archives or payloads')
    assert.equal(second[0]!.value.name, 'Formula memo 0', 'each caller gets its own copy')

    await setContentPackDiscoveryDisabled(packs[1]!, true, { paths })
    assert.deepEqual((await listCatalogEntries('series-formula', options)).map(entry => entry.pack?.pack_id), [packs[0]],
      'a state change is seen on the next listing')
  })
})

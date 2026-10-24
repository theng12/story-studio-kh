import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import type { ContentPackRegistryOptions } from '../content-packs/registry.js'
import { listTemplates } from '../services/thumbnail-template-loader.js'
import { useTempDataDir } from './_helpers.js'

/**
 * The recipe library lists ONE card per recipe identity (2026-10-24).
 *
 * Found on the owner's mini: "Annotated Business Board", "Archival Map
 * Investigation" and "Documentary Label Tableau" each appeared twice, and a
 * pack that shipped 1.0.0 and 1.0.1 with the same recipe id appeared twice more.
 * The list was keyed by raw id, and the signed id is not the legacy id
 * (`com.storystudio.thumbnail.documentary-label-tableau` vs
 * `documentary-label-tableau`), so the same recipe was two entries.
 *
 * Resolution is read-time: no pack, project pin or preset on disk is touched.
 */

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.key.recipe-library-test'
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
)
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

function recipeDocument(recipeId: string, name: string, previewAssets: string[]): ContentPackDocument {
  return {
    kind: 'thumbnail-recipe', schema_version: 1, id: recipeId, name, description: `Signed ${name}.`,
    layout: 'hero', category: 'Documentary', tags: ['evidence'], aspect_ratio: '16:9', title_mode: 'ai',
    composition_guidance: 'One document.', required_elements: ['Document'], avoid_elements: ['Clutter'],
    headline_mode: 'episode-title', headline_guidance: 'Use the title.', default_text_style: 'Ivory',
    default_font_style: 'Serif', default_text_position: 'top', headline_formats: ['THE RECORD'],
    visual_style_guidance: 'Archival.', preview_assets: previewAssets, compatible_formula_ids: [],
  }
}

async function buildArchive(packId: string, version: string, recipeId: string, name: string): Promise<Uint8Array> {
  const document = recipeDocument(recipeId, name, ['assets/recipe.png'])
  const contentBytes = Buffer.from(JSON.stringify(document))
  const assets = ['assets/recipe.png']
  const files = [
    { path: 'content/recipe.json', sha256: sha256(contentBytes), bytes: contentBytes.byteLength, mime: 'application/json' },
    ...assets.map(asset => ({ path: asset, sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' as const })),
  ]
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1, pack_id: packId, publisher_id: PUBLISHER_ID, key_id: KEY_ID, version,
    min_app_version: '1.0.0', lifecycle: 'active',
    entitlement: { sku: `${packId}.sku`, family: `${packId}.family` }, bundles: [],
    items: [{ id: recipeId, kind: 'thumbnail-recipe', schema_version: 1, path: 'content/recipe.json' }],
    files,
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file('content/recipe.json', contentBytes, { createFolders: false })
  for (const asset of assets) zip.file(asset, PNG_1PX, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated(): Promise<ContentPackRegistryOptions> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temp.dir, 'recovery-fixtures')
  await fs.mkdir(recoveryRoot, { recursive: true })
  return { paths, policy, recoveryRoot }
}

describe('thumbnail recipe library identity', () => {
  test('a signed recipe replaces its legacy bundled twin instead of listing beside it', async () => {
    const options = await isolated()
    // `documentary-label-tableau` is BOTH a shipped bundled template id and the
    // last dot-segment of the signed recipe id that replaced it.
    await installContentPack({
      archiveBytes: await buildArchive(
        'com.storystudio.pack.thumbnail.documentary-label-tableau',
        '1.0.1',
        'com.storystudio.thumbnail.documentary-label-tableau',
        'Documentary Label Tableau',
      ),
      source: 'local-import',
    }, options)

    const listed = await listTemplates(options)
    const cards = listed.filter(template => template.name === 'Documentary Label Tableau')
    assert.equal(cards.length, 1, 'one card per recipe identity, not one per id spelling')
    assert.equal(cards[0]!.id, 'com.storystudio.thumbnail.documentary-label-tableau')
    assert.match(cards[0]!.previewImages![0]!, /^\/api\/content-packs\/com\.storystudio\.pack\.thumbnail\.documentary-label-tableau\/1\.0\.1\/assets\//)
  })

  test('the newest installed pack version is the card, and the same recipe never appears twice', async () => {
    const options = await isolated()
    const packId = 'com.storystudio.pack.thumbnail.prehistoric-discovery'
    const recipeId = 'com.storystudio.thumbnail.prehistoric-discovery'
    await installContentPack({ archiveBytes: await buildArchive(packId, '1.0.0', recipeId, 'Prehistoric Discovery'), source: 'local-import' }, options)
    await installContentPack({ archiveBytes: await buildArchive(packId, '1.0.1', recipeId, 'Prehistoric Discovery'), source: 'local-import' }, options)

    const cards = (await listTemplates(options)).filter(template => template.name === 'Prehistoric Discovery')
    assert.equal(cards.length, 1)
    assert.match(cards[0]!.previewImages![0]!, /\/1\.0\.1\/assets\//, 'the newest installed version supplies the card')
  })

  test('a workspace pin on an older version cannot resurrect a second card', async () => {
    const options = await isolated()
    const packId = 'com.storystudio.pack.thumbnail.animal-hardship-annotation'
    const recipeId = 'com.storystudio.thumbnail.animal-hardship-annotation'
    const older = await buildArchive(packId, '1.0.0', recipeId, 'Animal Hardship Annotation')
    await installContentPack({ archiveBytes: older, source: 'local-import' }, options)
    await installContentPack({ archiveBytes: await buildArchive(packId, '1.0.1', recipeId, 'Animal Hardship Annotation'), source: 'local-import' }, options)

    const { resolveCatalogPackVersion } = await import('../content-packs/registry.js')
    const pinned = await resolveCatalogPackVersion(packId, '1.0.0', options)
    assert.ok(pinned, 'the older version stays resolvable for an existing pin')
    const pinnedOptions: ContentPackRegistryOptions = { ...options, pins: [pinned!.ref] }

    const cards = (await listTemplates(pinnedOptions)).filter(template => template.name === 'Animal Hardship Annotation')
    assert.equal(cards.length, 1, 'a pin adds a version, not a second card')
    assert.match(cards[0]!.previewImages![0]!, /\/1\.0\.1\/assets\//)
  })

  test('the customer copy stays a separate card from the signed recipe it came from', async () => {
    const options = await isolated()
    // The bundled id the copy is forked from, so both names collide on purpose.
    const signedId = 'com.storystudio.thumbnail.documentary-label-tableau'
    await installContentPack({
      archiveBytes: await buildArchive(
        'com.storystudio.pack.thumbnail.documentary-label-tableau', '1.0.1', signedId, 'Documentary Label Tableau',
      ),
      source: 'local-import',
    }, options)

    const { forkLegacyContentForEdit, saveUserForkDocument } = await import('../content-packs/user-forks.js')
    const fork = await forkLegacyContentForEdit(
      { kind: 'thumbnail-recipe', legacyId: 'documentary-label-tableau' },
      { paths: options.paths },
    )
    // A fork's own id is `user:<uuid>`: it can never collide with the signed id
    // it was forked from, so the copy is always its own card.
    assert.equal(fork.fork_id.startsWith('user:'), true)
    const forked = await saveUserForkDocument(fork.fork_id, {
      id: fork.fork_id,
      schemaVersion: 1,
      builtin: false,
      name: 'Documentary Label Tableau',
      description: 'The customer edited this copy.',
      category: 'Documentary',
      previewImages: ['/examples/mine.webp'],
      recipe: { layout: 'hero' },
    } as any, { paths: options.paths })

    const cards = (await listTemplates(options)).filter(template => template.name === 'Documentary Label Tableau')
    assert.equal(cards.length, 2, 'a signed original and the customer copy are two cards')
    const signed = cards.find(card => card.id === signedId)!
    const copy = cards.find(card => card.id === forked.fork_id)!
    // The library badges "Your copy" exactly when builtin is false.
    assert.equal(signed.builtin, true)
    assert.equal(copy.builtin, false)
    assert.deepEqual(copy.previewImages, ['/examples/mine.webp'])
  })

  test('a copy with no examples of its own reports none rather than the placeholder portrait', async () => {
    const options = await isolated()
    const { forkLegacyContentForEdit, saveUserForkDocument } = await import('../content-packs/user-forks.js')
    const fork = await forkLegacyContentForEdit(
      { kind: 'thumbnail-recipe', legacyId: 'documentary-label-tableau' },
      { paths: options.paths },
    )
    // A recipe saved in the workspace may carry no examples. The library must
    // then report none: `/thumbnail-templates/:id/preview.png` would paint a
    // synthetic portrait that reads as a real example of this recipe.
    // (A signed pack cannot be the empty case — its schema requires
    // `preview_assets.min(1)` — so the copy path is where it is reachable.)
    const forked = await saveUserForkDocument(fork.fork_id, {
      id: fork.fork_id,
      schemaVersion: 1,
      builtin: false,
      name: 'My Label Tableau',
      description: 'Saved without examples.',
      category: 'Documentary',
      recipe: { layout: 'hero' },
    } as any, { paths: options.paths })

    const card = (await listTemplates(options)).find(template => template.id === forked.fork_id)!
    assert.equal(card.builtin, false)
    assert.ok(!card.previewImages?.length, 'no example, and no synthetic stand-in URL')
  })
})

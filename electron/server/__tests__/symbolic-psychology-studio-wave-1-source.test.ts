import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import sharp from 'sharp'

import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PSYCHOLOGY_ROOT = path.join(ROOT, 'content-packs', 'psychology-editorial')
const STUDIO_ROOT = path.join(ROOT, 'content-packs', 'symbolic-psychology-studio')
const UNBLOCK_SDD_ROOT = path.join(ROOT, '.superpowers', 'sdd', '2026-08-23-symbolic-psychology-studio-unblock')
const CAPI_ASSETS = [
  'editorial-psychology-symbolic-split-1.webp',
  'editorial-psychology-symbolic-split-2.webp',
  'editorial-psychology-symbolic-split-3.webp',
  'editorial-psychology-symbolic-split-5.webp',
  'pastel-surreal-psychological-collage.webp',
] as const
const CAPI_HASHES = [
  'f82c5659ca989b27af5cf789c6270b4ef40aa24ec6060f1a91e015374a52f277',
  'cf65e48ae0215b3ab8e4a331f91b0cc126ee8fc0dea63724836b6b0bd7a744fb',
  '7d419bf83d807f8ce287040f51e5d620617e595f6bd09dc5ca7ee332252b6290',
  'b816e5ed7fb95eb16e16f95100e1e7b4840ee0f3f046e0d8eca4c766d820e492',
  '398cb595ce5c285570ce057cb81c86b73a739a5d220fc44a85faa7378b2e87ab',
] as const
const RECIPE_V1_SOURCE_HASHES = {
  'pack.json': '09800de2f8112da41eefb9dcdc76901d432643380382f4109ccd941c8323d2e5',
  'content/thumbnail-recipe.json': '74b3192de5c61d796d64f819bca3bb806a30728cdf9b49fddfd19240320a12f8',
  'assets/editorial-psychology-symbolic-split-1.webp': CAPI_HASHES[0],
  'assets/editorial-psychology-symbolic-split-2.webp': CAPI_HASHES[1],
  'assets/editorial-psychology-symbolic-split-3.webp': CAPI_HASHES[2],
  'assets/editorial-psychology-symbolic-split-5.webp': CAPI_HASHES[3],
} as const
const PASTEL_V1_SOURCE_HASHES = {
  'pack.json': '2528f1c88b65a64b86177acffaaabd031a9f671fe0351e9e60000c71dc8131a0',
  'content/visual-style.json': 'd12274ba7f5541226a8a9cdbdefd961679fbc1e90f08c7bfa4a5a75733e5751d',
  'assets/pastel-surreal-psychological-collage.webp': CAPI_HASHES[4],
} as const
const CAPI_PROVENANCE_ROW_HASHES = {
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-1.webp':
    'd59ef8ea529691d8b249b26d9604951e5e134fc871f3471b911645a1913855d9',
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-2.webp':
    'c2294ea7e93f02a261d53534304916a3c7693f52947490215c50cb1277d5ca9c',
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-3.webp':
    '81008d3cde7640ffb67c2b86f554282dc317db0f41de0df383b2f1ad66efe478',
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-5.webp':
    'bbb3dd072cc4ddc1550b0628e4bdc1dd6021a4eb3716a02871335e607c39a515',
  'style/pastel-surreal-psychological-collage/assets/pastel-surreal-psychological-collage.webp':
    '5df384239d53293a76a5c92c4465347b693b1586ce2c2a4a3f7f0ededf9be723',
} as const
const HUMAN_BEHAVIOR = 'com.storystudio.formula.human-behavior-explained'
const IMPASTO_SHA256 = '27050a92b2b71afd9a238ccd8ac9e72497ba2dda576bd4ad05fd01e465178e07'
const OIL_ASSET = 'oil-painting-classical.webp'
const OIL_SHA256 = '721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

async function webpMetadata(file: string) {
  return sharp(file, { failOn: 'error' }).metadata()
}

async function builtInOilContract() {
  const source = await fs.readFile(path.join(ROOT, 'frontend', 'composables', 'useBuiltInStyles.ts'), 'utf8')
  const match = source.match(
    /id: 'builtin-oil-painting-classical',[\s\S]*?style_bible:\s*'([^']*)',[\s\S]*?negative_prompt:\s*'([^']*)',/,
  )
  assert.ok(match, 'the shared built-in catalog must declare Oil Painting Classical')
  return { style_bible: match[1], negative_prompt: match[2] }
}

test('immutable v1.0.0 Recipe and Pastel source and provenance bytes retain exact SHA-256 identities', async () => {
  const recipeRoot = path.join(PSYCHOLOGY_ROOT, 'thumbnail', 'editorial-psychology-symbolic-split')
  const pastelRoot = path.join(PSYCHOLOGY_ROOT, 'style', 'pastel-surreal-psychological-collage')
  const ledger = await fs.readFile(path.join(PSYCHOLOGY_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  for (const [relativePath, expectedHash] of Object.entries(RECIPE_V1_SOURCE_HASHES)) {
    assert.equal(
      sha256(await fs.readFile(path.join(recipeRoot, relativePath))),
      expectedHash,
      `Recipe v1.0.0 ${relativePath} must remain byte-identical`,
    )
  }
  for (const [relativePath, expectedHash] of Object.entries(PASTEL_V1_SOURCE_HASHES)) {
    assert.equal(
      sha256(await fs.readFile(path.join(pastelRoot, relativePath))),
      expectedHash,
      `Pastel v1.0.0 ${relativePath} must remain byte-identical`,
    )
  }
  for (const [runtimePath, expectedHash] of Object.entries(CAPI_PROVENANCE_ROW_HASHES)) {
    const matchingRows = ledger.split('\n').filter(line => line.includes(`\`${runtimePath}\``))
    assert.equal(matchingRows.length, 1, `${runtimePath} must have exactly one immutable provenance row`)
    assert.equal(sha256(Buffer.from(matchingRows[0]!)), expectedHash, `${runtimePath} provenance row must remain byte-identical`)
  }
})

test('leaf successor reservation is one receipt-bound batch with non-discoverable Recipe and Pastel scaffolds', async () => {
  const request = await readJson(path.join(
    UNBLOCK_SDD_ROOT,
    'reservation-requests',
    'formula-recipe-pastel-v1.0.1.json',
  )) as {
    expected_revision: number
    coordinator: { task: string, branch: string }
    records: Array<Record<string, unknown> & { pack_id: string, version: string }>
  }
  assert.equal(request.expected_revision, 16)
  assert.deepEqual(request.coordinator, {
    task: 'symbolic-psychology-studio-unblock-leaf-successors',
    branch: 'codex/content-expansion-portfolio',
  })
  assert.deepEqual(request.records.map(record => `${record.pack_id}@${record.version}`), [
    'com.storystudio.pack.formula.human-behavior-explained@1.0.1',
    'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split@1.0.1',
    'com.storystudio.pack.style.pastel-surreal-psychological-collage@1.0.1',
  ])
  assert.equal(JSON.stringify(request).includes('component_summary'), false)

  const registry = await readJson(path.join(ROOT, 'content-packs', 'authoring-registry.json')) as {
    batches: Array<{
      revision: number
      receipt_ref: string
      request: { coordinator: { task: string }, records: Array<Record<string, unknown> & { pack_id: string }> }
    }>
  }
  const matchingBatches = registry.batches.filter(batch => (
    batch.request.coordinator.task === 'symbolic-psychology-studio-unblock-leaf-successors'
  ))
  assert.equal(matchingBatches.length, 1)
  const batch = matchingBatches[0]!
  assert.equal(batch.revision, 17)
  assert.match(batch.receipt_ref, /^authoring:[a-f0-9]{64}$/)
  assert.deepEqual(batch.request, request)

  for (const record of request.records) {
    const basename = record.pack_id.replace(/^com\.storystudio\.pack\.(?:formula|thumbnail|style)\./, '')
    const identity = await readJson(path.join(
      UNBLOCK_SDD_ROOT,
      'expected-identities',
      `${basename}-v1.0.1.json`,
    ))
    assert.deepEqual(identity, record)
  }

  for (const basename of [
    'editorial-psychology-symbolic-split',
    'pastel-surreal-psychological-collage',
  ]) {
    const scaffold = await readJson(path.join(UNBLOCK_SDD_ROOT, 'source-scaffolds', `${basename}-v1.0.1.json`)) as {
      schema_version: number
      reservation: {
        pack_id: string
        version: string
        registry_revision: number
        receipt_ref: string
        expected_identity_path: string
      }
      future_source_path: string
      predecessor: { version: string, files: unknown[], provenance_rows: unknown[] }
      required_returned_evidence: string[]
      preview_acceptance_contract: string[]
      registry_transition_allowed: boolean
    }
    assert.equal(scaffold.schema_version, 1)
    assert.equal(scaffold.reservation.version, '1.0.1')
    assert.equal(scaffold.reservation.registry_revision, batch.revision)
    assert.equal(scaffold.reservation.receipt_ref, batch.receipt_ref)
    assert.match(scaffold.reservation.expected_identity_path, new RegExp(`${basename}-v1\\.0\\.1\\.json$`))
    assert.match(scaffold.future_source_path, new RegExp(`${basename}-v1\\.0\\.1$`))
    assert.equal(scaffold.predecessor.version, '1.0.0')
    assert.ok(scaffold.predecessor.files.length > 0)
    assert.ok(scaffold.predecessor.provenance_rows.length > 0)
    assert.ok(scaffold.required_returned_evidence.length > 0)
    assert.ok(scaffold.preview_acceptance_contract.length > 0)
    assert.equal(scaffold.registry_transition_allowed, false)
    assert.equal(JSON.stringify(scaffold).includes('component_summary'), false)
  }
})

test('source evidence: Capi preview bytes match the provenance ledger', async () => {
  const recipeRoot = path.join(PSYCHOLOGY_ROOT, 'thumbnail', 'editorial-psychology-symbolic-split')
  const pastelRoot = path.join(PSYCHOLOGY_ROOT, 'style', 'pastel-surreal-psychological-collage')
  const ledger = await fs.readFile(path.join(PSYCHOLOGY_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  const recipe = await readJson(path.join(recipeRoot, 'content', 'thumbnail-recipe.json'))
  const pastel = await readJson(path.join(pastelRoot, 'content', 'visual-style.json'))

  parseContentPackDocument('thumbnail-recipe', recipe)
  parseContentPackDocument('visual-style', pastel)
  assert.deepEqual(recipe.preview_assets, CAPI_ASSETS.slice(0, 4).map(asset => `assets/${asset}`))
  assert.deepEqual(pastel.preview_assets, [`assets/${CAPI_ASSETS[4]}`])

  for (const [index, asset] of CAPI_ASSETS.entries()) {
    const root = index < 4 ? recipeRoot : pastelRoot
    const bytes = await fs.readFile(path.join(root, 'assets', asset))
    assert.equal(sha256(bytes), CAPI_HASHES[index], `${asset} must retain its reviewed source byte`)
    const ledgerEntry = ledger.split('\n').find(line => line.includes(asset))
    assert.ok(ledgerEntry, `${asset} must remain in the Capi provenance ledger`)
    assert.match(ledgerEntry, new RegExp(CAPI_HASHES[index]), `${asset} must retain its paired provenance hash`)
  }
})

test('source evidence: Impasto is a Human Behavior-only decodable WebP', async () => {
  const root = path.join(ROOT, 'content-packs', 'legacy-thumbnail-restoration', 'style', 'impasto-psychological-animals')
  const document = await readJson(path.join(root, 'content', 'visual-style.json'))
  const asset = path.join(root, 'assets', 'impasto-psychological-animals.webp')
  const ledger = await fs.readFile(path.join(ROOT, 'content-packs', 'legacy-thumbnail-restoration', 'PREVIEW-PROVENANCE.md'), 'utf8')

  parseContentPackDocument('visual-style', document)
  assert.deepEqual(document.compatible_formula_ids, [HUMAN_BEHAVIOR])
  assert.equal(sha256(await fs.readFile(asset)), IMPASTO_SHA256)
  const ledgerEntry = ledger.split('\n').find(line => line.includes('impasto-psychological-animals.webp'))
  assert.ok(ledgerEntry, 'Impasto must remain in its preview provenance ledger')
  assert.match(ledgerEntry, new RegExp(IMPASTO_SHA256), 'Impasto provenance must retain its exact preview hash')
  const metadata = await webpMetadata(asset)
  assert.deepEqual(
    { format: metadata.format, width: metadata.width, height: metadata.height },
    { format: 'webp', width: 1672, height: 941 },
  )
})

test('Oil source: Store packaging preserves the built-in contract, qualified asset, and safe runtime document', async () => {
  const root = path.join(STUDIO_ROOT, 'style', 'oil-painting-classical')
  const document = await readJson(path.join(root, 'content', 'visual-style.json'))
  const builtIn = await builtInOilContract()
  const asset = path.join(root, 'assets', OIL_ASSET)

  parseContentPackDocument('visual-style', document)
  assert.equal(document.style_bible, builtIn.style_bible)
  assert.equal(document.negative_prompt, builtIn.negative_prompt)
  assert.deepEqual(document.compatible_formula_ids, [HUMAN_BEHAVIOR])
  assert.deepEqual(document.preview_assets, [`assets/${OIL_ASSET}`])
  assert.equal(sha256(await fs.readFile(asset)), OIL_SHA256)
  const metadata = await webpMetadata(asset)
  assert.deepEqual(
    { format: metadata.format, width: metadata.width, height: metadata.height },
    { format: 'webp', width: 1672, height: 941 },
  )
  assert.doesNotMatch(
    JSON.stringify(document),
    /Capi|episode|provider|model|price|discount|GenStudio|(?:\/Users\/|[A-Za-z]:[\\/])/i,
  )
})

test('Gothic evidence: the blocked proposal remains source-free until all five evidence gaps close', async () => {
  const gothicRoot = path.join(STUDIO_ROOT, 'style', 'gothic-charcoal-animal-editorial')
  const ledger = await fs.readFile(path.join(STUDIO_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  await assert.rejects(fs.access(gothicRoot), { code: 'ENOENT' })
  const gothicSection = ledger.match(/## Gothic Charcoal Animal Editorial[\s\S]*?(?=\n## |$)/i)?.[0]
  assert.ok(gothicSection, 'the provenance ledger must disclose the Gothic qualification block')
  assert.match(gothicSection, /status:\s*blocked/i)
  for (const missing of [
    'original preview bytes',
    'source/rightsholder provenance',
    'rights/license basis',
    'transformation record',
    'independent visual review',
  ]) assert.match(gothicSection, new RegExp(missing, 'i'))
})

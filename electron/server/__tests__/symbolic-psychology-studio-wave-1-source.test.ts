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

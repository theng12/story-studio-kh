import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import sharp from 'sharp'

import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const RESTORATION_ROOT = path.join(ROOT, 'content-packs', 'legacy-thumbnail-restoration')
const FORMULA_ID = 'com.storystudio.formula.natural-world-explained'
const RECIPE_ROOT = path.join(RESTORATION_ROOT, 'thumbnail', 'animal-hardship-annotation')
const STYLE_ROOT = path.join(RESTORATION_ROOT, 'style', 'hand-drawn-hardship-cartoon')
const IMPASTO_STYLE_ROOT = path.join(RESTORATION_ROOT, 'style', 'impasto-psychological-animals')
const CAPI_RECIPE_ROOT = path.join(
  ROOT,
  'content-packs',
  'psychology-editorial',
  'thumbnail',
  'editorial-psychology-symbolic-split',
)
const RECIPE_ASSETS = [
  'animal-hardship-annotation-1.webp',
  'animal-hardship-annotation-2.webp',
  'animal-hardship-annotation-3.webp',
] as const
const STYLE_ASSET = 'hand-drawn-hardship-cartoon.webp'
const IMPASTO_STYLE_ASSET = 'impasto-psychological-animals.webp'
const HUMAN_BEHAVIOR_FORMULA_ID = 'com.storystudio.formula.human-behavior-explained'
const forbiddenRuntimeMetadata = /\/Users\/|\bprovider\b|model_id|\bprice\b|\bdiscount\b|GenStudio/i

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

async function assertPack(root: string, packId: string, sku: string, family: string) {
  assert.deepEqual(await readJson(path.join(root, 'pack.json')), {
    pack_format: 1,
    pack_id: packId,
    publisher_id: 'com.storystudio',
    key_id: '{{KEY_ID}}',
    version: '1.0.0',
    min_app_version: '{{MIN_APP_VERSION}}',
    lifecycle: 'active',
    entitlement: { sku, family },
  })
}

async function assertWebp(root: string, asset: string, ledger: string) {
  const bytes = await fs.readFile(path.join(root, 'assets', asset))
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 1672)
  assert.equal(metadata.height, 941)
  assert.ok(bytes.byteLength > 20_000, `${asset} must be a substantive preview`)
  assert.match(ledger, new RegExp(`\\| .*${asset.replace('.', '\\.')}`))
  assert.match(ledger, new RegExp(sha256(bytes)))
}

test('Animal Hardship Annotation has three ledgered, decodable owner-derived recipe previews', async () => {
  await assertPack(
    RECIPE_ROOT,
    'com.storystudio.pack.thumbnail.animal-hardship-annotation',
    'com.storystudio.sku.thumbnail.animal-hardship-annotation',
    'com.storystudio.family.thumbnail.animal-hardship-annotation',
  )
  const recipe = await readJson(path.join(RECIPE_ROOT, 'content', 'thumbnail-recipe.json'))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  assert.doesNotMatch(JSON.stringify(recipe), forbiddenRuntimeMetadata)
  parseContentPackDocument('thumbnail-recipe', recipe)
  assert.equal(recipe.id, 'com.storystudio.thumbnail.animal-hardship-annotation')
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.deepEqual(recipe.compatible_formula_ids, [FORMULA_ID])
  assert.deepEqual(recipe.preview_assets, RECIPE_ASSETS.map(asset => `assets/${asset}`))
  assert.match(String(recipe.composition_guidance), /one hand-drawn arrow/i)
  assert.match(String(recipe.composition_guidance), /3[–-]6 word handwritten hardship annotation/i)
  assert.match(String(recipe.headline_guidance), /full.*episode title/i)
  for (const asset of RECIPE_ASSETS) await assertWebp(RECIPE_ROOT, asset, ledger)
  assert.match(String(recipe.avoid_elements), /MineePod|multiple arrows|generic curiosity-only|watermarks|logos|malformed text|copied trade dress/i)
})

test('Hand-Drawn Hardship Cartoon has one ledgered, decodable owner-derived style preview', async () => {
  await assertPack(
    STYLE_ROOT,
    'com.storystudio.pack.style.hand-drawn-hardship-cartoon',
    'com.storystudio.sku.style.hand-drawn-hardship-cartoon',
    'com.storystudio.family.style.hand-drawn-hardship-cartoon',
  )
  const style = await readJson(path.join(STYLE_ROOT, 'content', 'visual-style.json'))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  assert.doesNotMatch(JSON.stringify(style), forbiddenRuntimeMetadata)
  parseContentPackDocument('visual-style', style)
  assert.equal(style.id, 'com.storystudio.style.hand-drawn-hardship-cartoon')
  assert.deepEqual(style.compatible_formula_ids, [FORMULA_ID])
  assert.deepEqual(style.preview_assets, [`assets/${STYLE_ASSET}`])
  assert.match(String(style.style_bible), /uneven black ink/i)
  assert.match(String(style.style_bible), /flat limited fills/i)
  assert.match(String(style.style_bible), /anatomically coherent animals/i)
  assert.match(String(style.style_bible), /hand-drawn annotation texture/i)
  assert.match(String(style.style_bible), /sparse paper-like backgrounds/i)
  assert.match(String(style.negative_prompt), /photoreal stock imagery/i)
  assert.match(String(style.negative_prompt), /glossy CGI/i)
  assert.match(String(style.negative_prompt), /copied channel branding/i)
  assert.match(String(style.negative_prompt), /duplicate captions/i)
  assert.match(String(style.negative_prompt), /watermarks\/logos/i)
  assert.match(String(style.negative_prompt), /violent cruelty/i)
  assert.match(String(style.negative_prompt), /malformed anatomy/i)
  assert.match(String(style.negative_prompt), /malformed text/i)
  await assertWebp(STYLE_ROOT, STYLE_ASSET, ledger)
})

test('Impasto Psychological Animals retains the Capi recipe and supplies a distinct text-free style preview', async () => {
  const capiRecipe = await readJson(path.join(CAPI_RECIPE_ROOT, 'content', 'thumbnail-recipe.json'))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  parseContentPackDocument('thumbnail-recipe', capiRecipe)
  assert.equal(capiRecipe.id, 'com.storystudio.thumbnail.editorial-psychology-symbolic-split')
  assert.equal((capiRecipe.preview_assets as unknown[]).length, 5)
  assert.deepEqual(capiRecipe.compatible_formula_ids, [HUMAN_BEHAVIOR_FORMULA_ID])

  await assertPack(
    IMPASTO_STYLE_ROOT,
    'com.storystudio.pack.style.impasto-psychological-animals',
    'com.storystudio.sku.style.impasto-psychological-animals',
    'com.storystudio.family.style.impasto-psychological-animals',
  )
  const impasto = await readJson(path.join(IMPASTO_STYLE_ROOT, 'content', 'visual-style.json'))
  assert.doesNotMatch(JSON.stringify(impasto), forbiddenRuntimeMetadata)
  parseContentPackDocument('visual-style', impasto)
  assert.equal(impasto.id, 'com.storystudio.style.impasto-psychological-animals')
  assert.deepEqual(impasto.compatible_formula_ids, [HUMAN_BEHAVIOR_FORMULA_ID])
  assert.deepEqual(impasto.preview_assets, [`assets/${IMPASTO_STYLE_ASSET}`])
  assert.match(String(impasto.style_bible), /thick impasto oil paint/i)
  assert.match(String(impasto.style_bible), /muted melancholy/i)
  assert.match(String(impasto.style_bible), /anthropomorphic animal/i)
  assert.match(String(impasto.style_bible), /strong figure-ground separation/i)
  assert.match(String(impasto.style_bible), /opposing title-safe band/i)
  assert.doesNotMatch(String(impasto.style_bible), /Emotional Armor|Capi|EP\d{4}/i)
  await assertWebp(IMPASTO_STYLE_ROOT, IMPASTO_STYLE_ASSET, ledger)
})

test('Restoration runtime documents retain no owner paths or commercial/provider metadata', async () => {
  const runtimeDocuments = await Promise.all([
    readJson(path.join(RECIPE_ROOT, 'content', 'thumbnail-recipe.json')),
    readJson(path.join(STYLE_ROOT, 'content', 'visual-style.json')),
    readJson(path.join(IMPASTO_STYLE_ROOT, 'content', 'visual-style.json')),
  ])
  assert.doesNotMatch(JSON.stringify(runtimeDocuments), forbiddenRuntimeMetadata)
})

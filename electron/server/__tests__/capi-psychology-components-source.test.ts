import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import sharp from 'sharp'

import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PSYCHOLOGY_EDITORIAL_ROOT = path.join(ROOT, 'content-packs', 'psychology-editorial')
const FORMULA_ID = 'com.storystudio.formula.human-behavior-explained'

const RECIPE = {
  root: path.join(PSYCHOLOGY_EDITORIAL_ROOT, 'thumbnail', 'editorial-psychology-symbolic-split'),
  packId: 'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split',
  itemId: 'com.storystudio.thumbnail.editorial-psychology-symbolic-split',
  assets: [
    'editorial-psychology-symbolic-split-1.webp',
    'editorial-psychology-symbolic-split-2.webp',
    'editorial-psychology-symbolic-split-3.webp',
    'editorial-psychology-symbolic-split-4.webp',
    'editorial-psychology-symbolic-split-5.webp',
  ],
} as const

const STYLE = {
  root: path.join(PSYCHOLOGY_EDITORIAL_ROOT, 'style', 'pastel-surreal-psychological-collage'),
  packId: 'com.storystudio.pack.style.pastel-surreal-psychological-collage',
  itemId: 'com.storystudio.style.pastel-surreal-psychological-collage',
  assets: ['pastel-surreal-psychological-collage.webp'],
} as const

type Source = typeof RECIPE | typeof STYLE

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function assertSource(source: Source, kind: 'thumbnail-recipe' | 'visual-style'): Promise<Record<string, unknown>> {
  const pack = await readJson(path.join(source.root, 'pack.json'))
  assert.deepEqual(Object.keys(pack).sort(), [
    'entitlement', 'key_id', 'lifecycle', 'min_app_version', 'pack_format', 'pack_id', 'publisher_id', 'version',
  ])
  assert.deepEqual(pack, {
    pack_format: 1,
    pack_id: source.packId,
    publisher_id: 'com.storystudio',
    key_id: '{{KEY_ID}}',
    version: '1.0.0',
    min_app_version: '{{MIN_APP_VERSION}}',
    lifecycle: 'active',
    entitlement: {
      sku: source.packId.includes('.thumbnail.')
        ? 'com.storystudio.sku.thumbnail.editorial-psychology-symbolic-split'
        : 'com.storystudio.sku.style.pastel-surreal-psychological-collage',
      family: source.packId.includes('.thumbnail.')
        ? 'com.storystudio.family.thumbnail.editorial-psychology-symbolic-split'
        : 'com.storystudio.family.style.pastel-surreal-psychological-collage',
    },
  })

  const document = await readJson(path.join(source.root, 'content', `${kind}.json`))
  assert.equal(document.id, source.itemId)
  assert.deepEqual(document.dependencies, undefined)
  assert.deepEqual(document.preview_assets, source.assets.map(asset => `assets/${asset}`))
  parseContentPackDocument(kind, document)

  for (const asset of source.assets) {
    const assetPath = path.join(source.root, 'assets', asset)
    const bytes = await fs.readFile(assetPath)
    assert.ok(bytes.byteLength > 20_000, `${asset} must be a substantive preview`)
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    assert.equal(metadata.format, 'webp')
    assert.equal(metadata.width, 1672)
    assert.equal(metadata.height, 941)
  }
  return document
}

test('Capi-derived component sources carry the exact reserved identities and decodable preview assets', async () => {
  await assertSource(RECIPE, 'thumbnail-recipe')
  await assertSource(STYLE, 'visual-style')
})

test('Editorial Psychology Symbolic Split preserves the reusable direct-title recipe contract', async () => {
  const recipe = await assertSource(RECIPE, 'thumbnail-recipe')
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.deepEqual(recipe.compatible_formula_ids, [FORMULA_ID])
  assert.match(String(recipe.composition_guidance), /mirror|left|right/i)
  assert.match(String(recipe.composition_guidance), /one symbolic/i)
  assert.match(String(recipe.headline_guidance), /2[–-]5 word|two to five word/i)
  assert.match(String(recipe.headline_guidance), /one line[\s\S]*two lines[\s\S]*three lines|1[–/, ]+2[–/, ]+3/i)
  assert.match(String(recipe.headline_guidance), /complete.*headline|headline.*complete/i)
  assert.ok(Array.isArray(recipe.headline_formats) && recipe.headline_formats.length >= 4)
})

test('Pastel Surreal Psychological Collage preserves the reusable visual and safety contract', async () => {
  const style = await assertSource(STYLE, 'visual-style')
  assert.deepEqual(style.compatible_formula_ids, [FORMULA_ID])
  assert.match(String(style.style_bible), /dusty peach/i)
  assert.match(String(style.style_bible), /mauve/i)
  assert.match(String(style.style_bible), /lavender/i)
  assert.match(String(style.style_bible), /pale blue/i)
  assert.match(String(style.style_bible), /matte mixed-media/i)
  assert.match(String(style.style_bible), /fragmented|eroded|mask|mannequin|silhouette|door|flame/i)
  assert.match(String(style.negative_prompt), /glossy CGI/i)
  assert.match(String(style.negative_prompt), /photoreal stock/i)
  assert.match(String(style.negative_prompt), /neon/i)
  assert.match(String(style.negative_prompt), /logos|watermarks/i)
  assert.match(String(style.negative_prompt), /copied trade dress/i)
  assert.match(String(style.negative_prompt), /malformed anatomy|malformed.*text/i)
  assert.doesNotMatch(String(style.style_bible), /The Psychology of|Capi|EP\d{4}/i)
})

test('Capi provenance ledger identifies every copied preview byte without putting owner paths in runtime JSON', async () => {
  const ledger = await fs.readFile(path.join(PSYCHOLOGY_EDITORIAL_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const source of [RECIPE, STYLE]) {
    for (const asset of source.assets) {
      const bytes = await fs.readFile(path.join(source.root, 'assets', asset))
      assert.match(ledger, new RegExp(`\\| .*${asset.replace('.', '\\.')}`))
      assert.match(ledger, new RegExp(sha256(bytes)))
    }
  }
  const runtimeJson = await Promise.all([
    readJson(path.join(RECIPE.root, 'content', 'thumbnail-recipe.json')),
    readJson(path.join(STYLE.root, 'content', 'visual-style.json')),
  ])
  assert.doesNotMatch(JSON.stringify(runtimeJson), /\/Users\/thengmacmini\/Documents|GenStudio|price|discount|provider|model_id/i)
})

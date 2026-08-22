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

const RECIPE_PREVIEW_DIVERSITY = [
  {
    asset: 'editorial-psychology-symbolic-split-1.webp',
    placement: 'left',
    sourceName: 'EP0014_Thumb01_v2.png',
    sha256: 'f82c5659ca989b27af5cf789c6270b4ef40aa24ec6060f1a91e015374a52f277',
  },
  {
    asset: 'editorial-psychology-symbolic-split-2.webp',
    placement: 'left',
    sourceName: 'EP0017_Thumb01_v2.png',
    sha256: 'cf65e48ae0215b3ab8e4a331f91b0cc126ee8fc0dea63724836b6b0bd7a744fb',
  },
  {
    asset: 'editorial-psychology-symbolic-split-3.webp',
    placement: 'center-left',
    sourceName: 'EP0022_Thumb01_v1.png',
    sha256: '7d419bf83d807f8ce287040f51e5d620617e595f6bd09dc5ca7ee332252b6290',
  },
  {
    asset: 'editorial-psychology-symbolic-split-4.webp',
    placement: 'right',
    sourceName: 'EP0043_Thumb02_v1.png',
    sha256: 'fb5be086761b7effc5ae325ac8d2458f7da071c710c3e4dcfb5155fb523b1166',
  },
  {
    asset: 'editorial-psychology-symbolic-split-5.webp',
    placement: 'center-left',
    sourceName: 'EP0050_Thumb04_v1.png',
    sha256: 'b816e5ed7fb95eb16e16f95100e1e7b4840ee0f3f046e0d8eca4c766d820e492',
  },
] as const

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

test('Editorial Psychology Symbolic Split keeps its reviewed left, center-left, and right preview evidence', async () => {
  assert.deepEqual(RECIPE.assets, RECIPE_PREVIEW_DIVERSITY.map(preview => preview.asset))
  assert.deepEqual([...new Set(RECIPE_PREVIEW_DIVERSITY.map(preview => preview.placement))], ['left', 'center-left', 'right'])

  const ledger = await fs.readFile(path.join(PSYCHOLOGY_EDITORIAL_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const preview of RECIPE_PREVIEW_DIVERSITY) {
    const bytes = await fs.readFile(path.join(RECIPE.root, 'assets', preview.asset))
    assert.equal(sha256(bytes), preview.sha256, `${preview.asset} must remain the reviewed owner-derived preview`)

    const evidenceLine = ledger.split('\n').find(line => line.includes(preview.asset))
    assert.ok(evidenceLine?.includes(preview.sourceName), `${preview.asset} must retain its reviewed owner source`)
    assert.ok(evidenceLine?.includes(`Placement: \`${preview.placement}\``), `${preview.asset} must retain its reviewed placement`)
  }

  const rightAsset = await sharp(path.join(RECIPE.root, 'assets', 'editorial-psychology-symbolic-split-4.webp'))
    .resize(192, 108)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let leftDarkPixels = 0
  let rightDarkPixels = 0
  for (let index = 0; index < rightAsset.data.length; index += rightAsset.info.channels) {
    const luminance = (rightAsset.data[index] + rightAsset.data[index + 1] + rightAsset.data[index + 2]) / 3
    if (luminance >= 45) continue
    const x = (index / rightAsset.info.channels) % rightAsset.info.width
    if (x < rightAsset.info.width / 2) leftDarkPixels += 1
    else rightDarkPixels += 1
  }
  assert.ok(rightDarkPixels > leftDarkPixels * 3, 'reviewed right-side preview must retain its right-weighted symbolic figure')
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

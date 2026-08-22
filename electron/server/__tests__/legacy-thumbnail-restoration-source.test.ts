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
const PREHISTORIC_SURVIVAL_ROOT = path.join(
  RESTORATION_ROOT,
  'thumbnail',
  'prehistoric-survival-title-card',
)
const PREHISTORIC_DISCOVERY_ROOT = path.join(
  ROOT,
  'content-packs',
  'free-starters',
  'thumbnail',
  'prehistoric-discovery',
)
const PREHISTORIC_STYLE_ROOT = path.join(
  ROOT,
  'content-packs',
  'free-starters',
  'style',
  'prehistoric-stick-cartoon',
)
const CAPI_RECIPE_ROOT = path.join(
  ROOT,
  'content-packs',
  'psychology-editorial',
  'thumbnail',
  'editorial-psychology-symbolic-split',
)
const CAPI_PASTEL_STYLE_ROOT = path.join(
  ROOT,
  'content-packs',
  'psychology-editorial',
  'style',
  'pastel-surreal-psychological-collage',
)
const RECIPE_ASSETS = [
  'animal-hardship-annotation-1.webp',
  'animal-hardship-annotation-2.webp',
  'animal-hardship-annotation-3.webp',
] as const
const STYLE_ASSET = 'hand-drawn-hardship-cartoon.webp'
const IMPASTO_STYLE_ASSET = 'impasto-psychological-animals.webp'
const PREHISTORIC_SURVIVAL_ASSETS = [
  'prehistoric-survival-title-card-1.webp',
  'prehistoric-survival-title-card-2.webp',
  'prehistoric-survival-title-card-3.webp',
] as const
const ANCIENT_HUMANS_FORMULA_ID = 'com.storystudio.formula.ancient-humans'
const HUMAN_BEHAVIOR_FORMULA_ID = 'com.storystudio.formula.human-behavior-explained'
const CAPI_RECIPE_ASSETS = [
  'editorial-psychology-symbolic-split-1.webp',
  'editorial-psychology-symbolic-split-2.webp',
  'editorial-psychology-symbolic-split-3.webp',
  'editorial-psychology-symbolic-split-4.webp',
  'editorial-psychology-symbolic-split-5.webp',
] as const
const CAPI_RECIPE_ASSET_HASHES = [
  'f82c5659ca989b27af5cf789c6270b4ef40aa24ec6060f1a91e015374a52f277',
  'cf65e48ae0215b3ab8e4a331f91b0cc126ee8fc0dea63724836b6b0bd7a744fb',
  '7d419bf83d807f8ce287040f51e5d620617e595f6bd09dc5ca7ee332252b6290',
  'fb5be086761b7effc5ae325ac8d2458f7da071c710c3e4dcfb5155fb523b1166',
  'b816e5ed7fb95eb16e16f95100e1e7b4840ee0f3f046e0d8eca4c766d820e492',
] as const
const CAPI_PASTEL_ASSET = 'pastel-surreal-psychological-collage.webp'
const CAPI_PASTEL_HASH = '398cb595ce5c285570ce057cb81c86b73a739a5d220fc44a85faa7378b2e87ab'
const DREAMLIKE_RECIPE_ROOT = path.join(
  RESTORATION_ROOT,
  'thumbnail',
  'dreamlike-story-title-card',
)
const DREAMLIKE_STYLE_ROOT = path.join(
  RESTORATION_ROOT,
  'style',
  'dreamlike-luminous-sleep-illustration',
)
const SLEEP_STORY_FORMULA_ID = 'com.storystudio.formula.sleep-story'
const DREAMLIKE_RECIPE_ASSETS = [
  'dreamlike-story-title-card-1.webp',
  'dreamlike-story-title-card-2.webp',
  'dreamlike-story-title-card-3.webp',
] as const
const DREAMLIKE_STYLE_ASSET = 'dreamlike-luminous-sleep-illustration.webp'
const FREE_STARTER_ROOT = path.join(ROOT, 'content-packs', 'free-starters')
const ENRICHED_FREE_STARTER_GALLERIES = [
  {
    slug: 'centered-hero-headline',
    assets: [
      'centered-hero-headline.webp',
      'centered-hero-headline-2.webp',
      'centered-hero-headline-3.webp',
    ],
    firstHash: '330334bf935e06fb8167a4ea8321d37a92f64b12a88e9564ccb9cf45f893d2ab',
  },
  {
    slug: 'portrait-block-right',
    assets: [
      'portrait-block-right.webp',
      'portrait-block-right-2.webp',
      'portrait-block-right-3.webp',
    ],
    firstHash: 'd7f458e7e6a4025e8a52c22fab0827fcae32c3c2d576be1e32bf6da439ecc00f',
  },
  {
    slug: 'dreamscape-story-window',
    assets: [
      'dreamscape-story-window.webp',
      'dreamscape-story-window-2.webp',
      'dreamscape-story-window-3.webp',
    ],
    firstHash: '1c2ea52dfd2677ce59178e308559c2ae7d97a3a7c2a4c6f6b73bdccf37a8d2ce',
  },
  {
    slug: 'prehistoric-discovery',
    assets: [
      'prehistoric-discovery.webp',
      'prehistoric-discovery-2.webp',
      'prehistoric-discovery-3.webp',
    ],
    firstHash: '557f86602b5f96f8d92fc28f981c79eb1121d63b2f7ab1d8bff535e8524dfd14',
  },
] as const
const ESTABLISHED_THREE_PREVIEW_FAMILIES = [
  'annotated-business-board',
  'curiosity-question-cartoon',
  'documentary-label-tableau',
  'archival-map-investigation',
] as const
const CENTERED_HERO_CUSTOM_ID = 'centered-hero-headline-custom'
const forbiddenRuntimeMetadata = /\/Users\/|\bprovider\b|model_id|\bprice\b|\bdiscount\b|GenStudio/i

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

async function sourceJsonFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await sourceJsonFiles(candidate))
    } else if (entry.isFile() && entry.name === 'pack.json') {
      files.push(candidate)
    } else if (entry.isFile() && path.basename(root) === 'content' && entry.name.endsWith('.json')) {
      files.push(candidate)
    }
  }
  return files
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (!value || typeof value !== 'object') return []
  return Object.values(value as Record<string, unknown>).flatMap(stringValues)
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

async function assertFreeStarterWebp(root: string, asset: string, ownerId: string, recordId: string) {
  const bytes = await fs.readFile(path.join(root, 'assets', asset))
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 1672)
  assert.equal(metadata.height, 941)
  assert.ok(bytes.byteLength > 20_000, `${asset} must be a substantive preview`)

  const provenance = await fs.readFile(path.join(FREE_STARTER_ROOT, 'ASSET-PROVENANCE.md'), 'utf8')
  const match = provenance.match(/<!-- free-starter-preview-provenance\n([\s\S]*?)\n-->/)
  assert.ok(match, 'free-starter provenance registry is present')
  const record = (JSON.parse(match[1]) as Array<Record<string, unknown>>).find(candidate => candidate.id === recordId)
  assert.ok(record, `${recordId} provenance is present`)
  assert.equal(record.ownerId, ownerId)
  assert.equal(record.sourcePath, path.relative(ROOT, path.join(root, 'assets', asset)))
  assert.equal(record.sha256, sha256(bytes))
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

test('Prehistoric Survival Title Card remains a full-title survival recipe distinct from Prehistoric Discovery', async () => {
  await assertPack(
    PREHISTORIC_SURVIVAL_ROOT,
    'com.storystudio.pack.thumbnail.prehistoric-survival-title-card',
    'com.storystudio.sku.thumbnail.prehistoric-survival-title-card',
    'com.storystudio.family.thumbnail.prehistoric-survival-title-card',
  )
  const recipe = await readJson(path.join(PREHISTORIC_SURVIVAL_ROOT, 'content', 'thumbnail-recipe.json'))
  const discovery = await readJson(path.join(PREHISTORIC_DISCOVERY_ROOT, 'content', 'thumbnail-recipe.json'))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  assert.doesNotMatch(JSON.stringify(recipe), forbiddenRuntimeMetadata)
  parseContentPackDocument('thumbnail-recipe', recipe)
  assert.equal(recipe.id, 'com.storystudio.thumbnail.prehistoric-survival-title-card')
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.deepEqual(recipe.compatible_formula_ids, [ANCIENT_HUMANS_FORMULA_ID])
  assert.deepEqual(recipe.preview_assets, PREHISTORIC_SURVIVAL_ASSETS.map(asset => `assets/${asset}`))
  assert.match(String(recipe.composition_guidance), /stick-limbed/i)
  assert.match(String(recipe.composition_guidance), /full.*title|full.*question/i)
  assert.match(String(recipe.composition_guidance), /human.*animal|animal.*human|human.*material|material.*human/i)
  assert.match(String(recipe.avoid_elements), /fantasy armor|modern objects|fake archaeology/i)
  assert.match(String(recipe.avoid_elements), /violence|watermarks|logos|copied/i)
  assert.match(String(recipe.headline_guidance), /one.*two.*three|three.*two.*one/i)
  for (const asset of PREHISTORIC_SURVIVAL_ASSETS) await assertWebp(PREHISTORIC_SURVIVAL_ROOT, asset, ledger)

  assert.equal(discovery.headline_mode, 'curiosity-hook')
  assert.notEqual(discovery.headline_mode, recipe.headline_mode)

  await assertPack(
    PREHISTORIC_STYLE_ROOT,
    'com.storystudio.pack.style.prehistoric-stick-cartoon',
    'com.storystudio.sku.style.prehistoric-stick-cartoon',
    'com.storystudio.family.style.prehistoric-stick-cartoon',
  )
  const prehistoricStyle = await readJson(path.join(PREHISTORIC_STYLE_ROOT, 'content', 'visual-style.json'))
  assert.equal(prehistoricStyle.id, 'com.storystudio.style.prehistoric-stick-cartoon')
  assert.deepEqual(prehistoricStyle.compatible_formula_ids, [ANCIENT_HUMANS_FORMULA_ID])
  await assert.rejects(fs.access(path.join(RESTORATION_ROOT, 'style', 'prehistoric-stick-cartoon')), {
    code: 'ENOENT',
  })
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
  assert.deepEqual(capiRecipe.preview_assets, CAPI_RECIPE_ASSETS.map(asset => `assets/${asset}`))
  assert.deepEqual(capiRecipe.compatible_formula_ids, [HUMAN_BEHAVIOR_FORMULA_ID])
  for (let index = 0; index < CAPI_RECIPE_ASSETS.length; index += 1) {
    const bytes = await fs.readFile(path.join(CAPI_RECIPE_ROOT, 'assets', CAPI_RECIPE_ASSETS[index]))
    assert.equal(sha256(bytes), CAPI_RECIPE_ASSET_HASHES[index])
  }
  const capiPastel = await readJson(path.join(CAPI_PASTEL_STYLE_ROOT, 'content', 'visual-style.json'))
  assert.equal(capiPastel.id, 'com.storystudio.style.pastel-surreal-psychological-collage')
  assert.deepEqual(capiPastel.preview_assets, [`assets/${CAPI_PASTEL_ASSET}`])
  assert.deepEqual(capiPastel.compatible_formula_ids, [HUMAN_BEHAVIOR_FORMULA_ID])
  assert.equal(
    sha256(await fs.readFile(path.join(CAPI_PASTEL_STYLE_ROOT, 'assets', CAPI_PASTEL_ASSET))),
    CAPI_PASTEL_HASH,
  )

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

test('Dreamlike Sleep Title Card stays distinct from the framed Dreamscape recipe', async () => {
  await assertPack(
    DREAMLIKE_RECIPE_ROOT,
    'com.storystudio.pack.thumbnail.dreamlike-story-title-card',
    'com.storystudio.sku.thumbnail.dreamlike-story-title-card',
    'com.storystudio.family.thumbnail.dreamlike-story-title-card',
  )
  const recipe = await readJson(path.join(DREAMLIKE_RECIPE_ROOT, 'content', 'thumbnail-recipe.json'))
  const dreamscape = await readJson(path.join(
    ROOT,
    'content-packs',
    'free-starters',
    'thumbnail',
    'dreamscape-story-window',
    'content',
    'thumbnail-recipe.json',
  ))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  assert.doesNotMatch(JSON.stringify(recipe), forbiddenRuntimeMetadata)
  assert.doesNotMatch(
    JSON.stringify(recipe),
    /The Elephant Who Loved the Rain|Paper Lanterns|Cave of Whispers|TerraNash|Story Sprout/i,
  )
  parseContentPackDocument('thumbnail-recipe', recipe)
  assert.equal(recipe.id, 'com.storystudio.thumbnail.dreamlike-story-title-card')
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.deepEqual(recipe.compatible_formula_ids, [SLEEP_STORY_FORMULA_ID])
  assert.deepEqual(recipe.preview_assets, DREAMLIKE_RECIPE_ASSETS.map(asset => `assets/${asset}`))
  assert.match(String(recipe.composition_guidance), /gentle subject|quiet setting/i)
  assert.match(String(recipe.composition_guidance), /amber|moonlit blue|candle gold/i)
  assert.match(String(recipe.headline_guidance), /gold serif/i)
  assert.match(String(recipe.composition_guidance), /low-arousal|title-safe/i)
  assert.doesNotMatch(String(recipe.composition_guidance), /window|doorway|frame/i)
  assert.match(String(recipe.avoid_elements), /violence|urgency|cliffhangers|alarming faces/i)
  assert.match(String(recipe.avoid_elements), /high-contrast spectacle|watermarks|logos|copied story titles|malformed text/i)
  for (const asset of DREAMLIKE_RECIPE_ASSETS) await assertWebp(DREAMLIKE_RECIPE_ROOT, asset, ledger)

  assert.match(String(dreamscape.composition_guidance), /window|doorway|frame/i)
  assert.notEqual(dreamscape.composition_guidance, recipe.composition_guidance)
})

test('Dreamlike Luminous Sleep Illustration supplies a text-free, ledgered style preview', async () => {
  await assertPack(
    DREAMLIKE_STYLE_ROOT,
    'com.storystudio.pack.style.dreamlike-luminous-sleep-illustration',
    'com.storystudio.sku.style.dreamlike-luminous-sleep-illustration',
    'com.storystudio.family.style.dreamlike-luminous-sleep-illustration',
  )
  const style = await readJson(path.join(DREAMLIKE_STYLE_ROOT, 'content', 'visual-style.json'))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  assert.doesNotMatch(JSON.stringify(style), forbiddenRuntimeMetadata)
  assert.doesNotMatch(
    JSON.stringify(style),
    /The Elephant Who Loved the Rain|Paper Lanterns|Cave of Whispers|TerraNash|Story Sprout/i,
  )
  parseContentPackDocument('visual-style', style)
  assert.equal(style.id, 'com.storystudio.style.dreamlike-luminous-sleep-illustration')
  assert.equal(style.category, 'Illustration')
  assert.deepEqual(style.compatible_formula_ids, [SLEEP_STORY_FORMULA_ID])
  assert.deepEqual(style.preview_assets, [`assets/${DREAMLIKE_STYLE_ASSET}`])
  assert.match(String(style.style_bible), /amber|moonlit blue|candle gold/i)
  assert.match(String(style.style_bible), /watercolor|gouache|illustration/i)
  assert.match(String(style.negative_prompt), /visual peril|loud saturated neon|photoreal stock imagery/i)
  assert.match(String(style.negative_prompt), /logos\/watermarks|copied trade dress|malformed anatomy|malformed text/i)
  await assertWebp(DREAMLIKE_STYLE_ROOT, DREAMLIKE_STYLE_ASSET, ledger)
})

test('the restored lineup preserves index-zero bytes and gives every legacy recipe three decodable previews', async () => {
  for (const gallery of ENRICHED_FREE_STARTER_GALLERIES) {
    const root = path.join(FREE_STARTER_ROOT, 'thumbnail', gallery.slug)
    const recipe = await readJson(path.join(root, 'content', 'thumbnail-recipe.json'))
    assert.deepEqual(recipe.preview_assets, gallery.assets.map(asset => `assets/${asset}`))
    assert.equal(
      sha256(await fs.readFile(path.join(root, 'assets', gallery.assets[0]))),
      gallery.firstHash,
      `${gallery.slug} retains its existing first preview byte-for-byte`,
    )
    for (const [index, asset] of gallery.assets.entries()) {
      await assertFreeStarterWebp(root, asset, gallery.slug, index === 0 ? gallery.slug : `${gallery.slug}-${index + 1}`)
    }
  }

  for (const id of ESTABLISHED_THREE_PREVIEW_FAMILIES) {
    const template = await readJson(path.join(ROOT, 'electron', 'server', 'thumbnail-templates', `${id}.json`))
    assert.equal(Array.isArray(template.previewImages) && template.previewImages.length, 3, `${id} keeps three previews`)
    for (const preview of template.previewImages as string[]) {
      const bytes = await fs.readFile(path.join(ROOT, 'frontend', 'public', preview.replace(/^\//, '')))
      const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
      assert.equal(metadata.format, 'webp')
    }
  }
})

test('Restoration runtime documents retain no owner paths or commercial/provider metadata', async () => {
  const runtimeDocuments = await Promise.all([
    readJson(path.join(RECIPE_ROOT, 'content', 'thumbnail-recipe.json')),
    readJson(path.join(STYLE_ROOT, 'content', 'visual-style.json')),
    readJson(path.join(IMPASTO_STYLE_ROOT, 'content', 'visual-style.json')),
    readJson(path.join(DREAMLIKE_RECIPE_ROOT, 'content', 'thumbnail-recipe.json')),
    readJson(path.join(DREAMLIKE_STYLE_ROOT, 'content', 'visual-style.json')),
  ])
  assert.doesNotMatch(JSON.stringify(runtimeDocuments), forbiddenRuntimeMetadata)
})

test('centered 94px headline custom remains outside signed source and authoring identities', async () => {
  const registry = await readJson(path.join(ROOT, 'content-packs', 'authoring-registry.json'))
  const sourceDocuments = await Promise.all(
    (await sourceJsonFiles(path.join(ROOT, 'content-packs'))).map(readJson),
  )

  assert.equal(
    sourceDocuments.flatMap(stringValues).some(value => value.includes(CENTERED_HERO_CUSTOM_ID)),
    false,
    'a user-fork identity must not become a signed source product ID, family, or SKU',
  )
  assert.equal(
    stringValues(registry).some(value => value.includes(CENTERED_HERO_CUSTOM_ID)),
    false,
    'a user-fork identity must not enter the authoring registry as a pack, item, family, or SKU',
  )
})

import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

import sharp from 'sharp'

import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const execFile = promisify(execFileCallback)
const RESTORATION_ROOT = path.join(ROOT, 'content-packs', 'legacy-thumbnail-restoration')
const GENERATION_RECEIPT_ROOT = path.join(
  ROOT,
  '.superpowers',
  'sdd',
  '2026-08-23-legacy-thumbnail-restoration',
  'generated-original-previews',
)
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
const EDITORIAL_RECIPE_ROOT = path.join(
  ROOT,
  'content-packs',
  'psychology-editorial',
  'thumbnail',
  'editorial-psychology-symbolic-split',
)
const EDITORIAL_PASTEL_STYLE_ROOT = path.join(
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
const APPROVED_HAND_DRAWN_HARDSHIP_SHA256 = '75a392a4c5be8786dbdc468ee6f691a15e5cf027aa98988b27d075cb043d3c59'
const IMPASTO_STYLE_ASSET = 'impasto-psychological-animals.webp'
const PREHISTORIC_SURVIVAL_ASSETS = [
  'prehistoric-survival-title-card-1.webp',
  'prehistoric-survival-title-card-2.webp',
  'prehistoric-survival-title-card-3.webp',
] as const
const ANCIENT_HUMANS_FORMULA_ID = 'com.storystudio.formula.ancient-humans'
const HUMAN_BEHAVIOR_FORMULA_ID = 'com.storystudio.formula.human-behavior-explained'
const EDITORIAL_RECIPE_ASSETS = [
  'editorial-psychology-symbolic-split-1.webp',
  'editorial-psychology-symbolic-split-2.webp',
  'editorial-psychology-symbolic-split-3.webp',
  'editorial-psychology-symbolic-split-5.webp',
] as const
const EDITORIAL_RECIPE_ASSET_HASHES = [
  'f82c5659ca989b27af5cf789c6270b4ef40aa24ec6060f1a91e015374a52f277',
  'cf65e48ae0215b3ab8e4a331f91b0cc126ee8fc0dea63724836b6b0bd7a744fb',
  '7d419bf83d807f8ce287040f51e5d620617e595f6bd09dc5ca7ee332252b6290',
  'b816e5ed7fb95eb16e16f95100e1e7b4840ee0f3f046e0d8eca4c766d820e492',
] as const
const EDITORIAL_PASTEL_ASSET = 'pastel-surreal-psychological-collage.webp'
const EDITORIAL_PASTEL_HASH = '398cb595ce5c285570ce057cb81c86b73a739a5d220fc44a85faa7378b2e87ab'
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
const VERSIONED_FREE_STARTER_GALLERIES = [
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
const privateKeyMaterial = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|private[ _-]?key/i
const RESTORED_RECIPE_AUDIT = [
  ['com.storystudio.thumbnail.annotated-business-board', 'content-packs/free-starters/thumbnail/annotated-business-board'],
  ['com.storystudio.thumbnail.curiosity-question-cartoon', 'content-packs/free-starters/thumbnail/curiosity-question-cartoon'],
  ['com.storystudio.thumbnail.documentary-label-tableau', 'content-packs/free-starters/thumbnail/documentary-label-tableau'],
  ['com.storystudio.thumbnail.prehistoric-discovery', 'content-packs/free-starters/thumbnail/prehistoric-discovery-v1.0.1'],
  ['com.storystudio.thumbnail.archival-map-investigation', 'content-packs/paid/archival-ledger/thumbnail/archival-map-investigation'],
  ['com.storystudio.thumbnail.editorial-psychology-symbolic-split', 'content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split'],
  ['com.storystudio.thumbnail.animal-hardship-annotation', 'content-packs/free-starters/thumbnail/animal-hardship-annotation'],
  ['com.storystudio.thumbnail.prehistoric-survival-title-card', 'content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card'],
  ['com.storystudio.thumbnail.dreamlike-story-title-card', 'content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card'],
] as const
const PREPARED_RECORDS = [
  ['com.storystudio.pack.thumbnail.prehistoric-survival-title-card', '1.0.0', PREHISTORIC_SURVIVAL_ROOT],
  ['com.storystudio.pack.thumbnail.dreamlike-story-title-card', '1.0.0', DREAMLIKE_RECIPE_ROOT],
  ['com.storystudio.pack.style.hand-drawn-hardship-cartoon', '1.0.0', STYLE_ROOT],
  ['com.storystudio.pack.style.dreamlike-luminous-sleep-illustration', '1.0.0', DREAMLIKE_STYLE_ROOT],
] as const
const WITHDRAWN_RECORDS = [
  ['com.storystudio.pack.thumbnail.animal-hardship-annotation', '1.0.0', RECIPE_ROOT],
  ['com.storystudio.pack.thumbnail.centered-hero-headline', '1.0.1', path.join(FREE_STARTER_ROOT, 'thumbnail', 'centered-hero-headline-v1.0.1')],
  ['com.storystudio.pack.thumbnail.portrait-block-right', '1.0.1', path.join(FREE_STARTER_ROOT, 'thumbnail', 'portrait-block-right-v1.0.1')],
  ['com.storystudio.pack.thumbnail.dreamscape-story-window', '1.0.1', path.join(FREE_STARTER_ROOT, 'thumbnail', 'dreamscape-story-window-v1.0.1')],
  ['com.storystudio.pack.kit.symbolic-psychology-studio', '1.0.1', path.join(ROOT, 'content-packs', 'symbolic-psychology-studio', 'kit', 'symbolic-psychology-studio-v1.0.1')],
] as const
const WITHDRAWN_FREE_STARTER_DIRECTORIES = new Set([
  'centered-hero-headline-v1.0.1',
  'portrait-block-right-v1.0.1',
  'dreamscape-story-window-v1.0.1',
])

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

function assertOriginalGeneratedPreview(ledger: string, asset: string) {
  const row = ledger.split('\n').find(line => line.includes(`/${asset}\``) || line.includes(`/${asset}|`))
  assert.ok(row, `${asset} provenance row is present`)
  assert.match(row, /publisher-created(?:-tool-generated-| tool-generated )original|text-only generation/i)
  assert.doesNotMatch(row, /saved-output|owner-supplied legacy project output/i)
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

test('prepared sources are authored while obsolete reservations are withdrawn and source-absent', async () => {
  const registry = await readJson(path.join(ROOT, 'content-packs', 'authoring-registry.json')) as {
    records: Array<{ pack_id: string, version: string, receipt_ref: string, status: string }>
    transitions: Array<{ request: { pack_id: string, version: string, receipt_ref: string, changes: { status?: string } } }>
  }
  for (const [packId, version, sourceRoot] of PREPARED_RECORDS) {
    const record = registry.records.find(candidate => candidate.pack_id === packId && candidate.version === version)
    assert.ok(record, `${packId}@${version} remains registered`)
    assert.equal(record.status, 'authored')
    assert.equal(registry.transitions.filter(transition => (
      transition.request.pack_id === packId
      && transition.request.version === version
      && transition.request.receipt_ref === record.receipt_ref
      && transition.request.changes.status === 'authored'
    )).length, 1, `${packId}@${version} has one receipt-bound promotion`)
    await fs.access(sourceRoot)
  }
  for (const [packId, version, sourceRoot] of WITHDRAWN_RECORDS) {
    const record = registry.records.find(candidate => candidate.pack_id === packId && candidate.version === version)
    assert.ok(record, `${packId}@${version} remains a lineage tombstone`)
    assert.equal(record.status, 'withdrawn')
    assert.equal(registry.transitions.filter(transition => (
      transition.request.pack_id === packId
      && transition.request.version === version
      && transition.request.receipt_ref === record.receipt_ref
      && transition.request.changes.status === 'withdrawn'
    )).length, 1, `${packId}@${version} has one receipt-bound withdrawal`)
    await assert.rejects(fs.access(sourceRoot), { code: 'ENOENT' })
  }
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
  for (const asset of PREHISTORIC_SURVIVAL_ASSETS) assertOriginalGeneratedPreview(ledger, asset)

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

test('Hand-Drawn Hardship Cartoon retains the approved complete-animal preview and original-generation provenance', async () => {
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
  assert.equal(
    sha256(await fs.readFile(path.join(STYLE_ROOT, 'assets', STYLE_ASSET))),
    APPROVED_HAND_DRAWN_HARDSHIP_SHA256,
    'the rejected mayfly crop must never return as the Style preview',
  )
  const row = ledger.split('\n').find(line => line.includes(`style/hand-drawn-hardship-cartoon/assets/${STYLE_ASSET}`))
  assert.ok(row, 'the Style preview retains its own provenance row')
  assert.match(row, /nature-prehistoric\/receipt\.json#animal-hardship-annotation-1\.png/)
  assert.match(row, /e7053b3cd0df7a7aebf1419de7a651b90854242ea4583721e78273ea946b18bd/)
  assert.match(row, /publisher-created tool-generated original under recorded owner authorization/i)
  assert.doesNotMatch(row, /saved-output|owner-supplied legacy project output/i)
})

test('Impasto Psychological Animals retains the Editorial recipe and supplies a distinct text-free style preview', async () => {
  const editorialRecipe = await readJson(path.join(EDITORIAL_RECIPE_ROOT, 'content', 'thumbnail-recipe.json'))
  const ledger = await fs.readFile(path.join(RESTORATION_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  parseContentPackDocument('thumbnail-recipe', editorialRecipe)
  assert.equal(editorialRecipe.id, 'com.storystudio.thumbnail.editorial-psychology-symbolic-split')
  assert.deepEqual(editorialRecipe.preview_assets, EDITORIAL_RECIPE_ASSETS.map(asset => `assets/${asset}`))
  assert.deepEqual(editorialRecipe.compatible_formula_ids, [HUMAN_BEHAVIOR_FORMULA_ID])
  for (let index = 0; index < EDITORIAL_RECIPE_ASSETS.length; index += 1) {
    const bytes = await fs.readFile(path.join(EDITORIAL_RECIPE_ROOT, 'assets', EDITORIAL_RECIPE_ASSETS[index]))
    assert.equal(sha256(bytes), EDITORIAL_RECIPE_ASSET_HASHES[index])
  }
  const editorialPastel = await readJson(path.join(EDITORIAL_PASTEL_STYLE_ROOT, 'content', 'visual-style.json'))
  assert.equal(editorialPastel.id, 'com.storystudio.style.pastel-surreal-psychological-collage')
  assert.deepEqual(editorialPastel.preview_assets, [`assets/${EDITORIAL_PASTEL_ASSET}`])
  assert.deepEqual(editorialPastel.compatible_formula_ids, [HUMAN_BEHAVIOR_FORMULA_ID])
  assert.equal(
    sha256(await fs.readFile(path.join(EDITORIAL_PASTEL_STYLE_ROOT, 'assets', EDITORIAL_PASTEL_ASSET))),
    EDITORIAL_PASTEL_HASH,
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
  assert.doesNotMatch(String(impasto.style_bible), /Emotional Armor|EP\d{4}/i)
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
    /The Elephant Who Loved the Rain|Paper Lanterns|Cave of Whispers|Sleep Stories|Story Garden/i,
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
  for (const asset of DREAMLIKE_RECIPE_ASSETS) assertOriginalGeneratedPreview(ledger, asset)

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
    /The Elephant Who Loved the Rain|Paper Lanterns|Cave of Whispers|Sleep Stories|Story Garden/i,
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

/**
 * v1.4.68 — the published-bytes guard, reshaped.
 *
 * WHAT IT USED TO DO, AND WHY THAT WAS WRONG. It read the UNVERSIONED
 * directory of each gallery slug and asserted its bytes still hashed to the
 * values published at commit 46711262 — i.e. it assumed the unversioned
 * directory is permanently the 1.0.0 baseline. It is not. The unversioned
 * directory is the CURRENT version and moves: `b0b984ab` bumped
 * `portrait-block-right` to 1.0.2 for a good reason (stripping our own working
 * notes out of what a customer buys) and that alone broke the guard. The other
 * three slugs were passing by luck, not design — the next bump to any of them
 * would have broken it identically.
 *
 * Re-pinning the constants to the 1.0.2 bytes would have made it green and
 * DEFEATED it: a moving directory re-pinned to a snapshot, guaranteed to
 * re-break, never checking the thing that matters.
 *
 * WHAT IT DOES NOW. Bytes are pinned by IDENTITY, not by directory name:
 *
 *   • every pack directory of these families is looked up in a committed byte
 *     manifest by its directory name, and must match exactly — no changed file,
 *     no added file, no removed file
 *   • a `-vX.Y.Z` directory must declare exactly that version in `pack.json`
 *   • one identity lives in exactly one directory: no two directories of a pack
 *     may declare the same version, and each directory's `pack_id@version` must
 *     be the identity the authoring registry records at that exact source path
 *   • an identity whose directory no longer exists — `portrait-block-right`
 *     1.0.0, whose bytes live only in history — is verified against the commit
 *     that published it
 *
 * MEASURED, and worth writing down because it is the obvious wrong guess: the
 * unversioned directory is NOT reliably the newest version. It is simply the
 * original directory. A `-vX.Y.Z` sibling may be BEHIND it (`portrait-block-right`
 * is 1.0.2 unversioned beside a retained 1.0.1) or AHEAD of it (`centered-hero-headline`
 * is 1.0.0 unversioned beside a reserved 1.0.1 being staged). Asserting an
 * ordering between them would fail on three of these four families today, and
 * would be asserting a convention the repository does not actually keep.
 *
 * So a bump no longer breaks the guard; it requires a deliberate manifest
 * update. And an edit to ANY published version directory is now caught, which
 * is the real rule and something the old shape could not detect at all.
 *
 * The old `preview_assets` equality against the unversioned directory is gone
 * on purpose. That was a claim about how the CURRENT gallery has evolved, not
 * an immutability claim, and it belongs to the successor assertions above.
 */
const PUBLISHED_BYTES_MANIFEST = path.join(
  ROOT, 'electron', 'server', '__tests__', 'fixtures', 'published-free-starter-thumbnail-bytes.json',
)
const VERSION_SUFFIX = /-v(\d+\.\d+\.\d+)$/

type ByteManifest = {
  published_directories: Record<string, { pack_id: string, version: string, files: Record<string, string> }>
  retired_identities: Record<string, { commit: string, path: string, files: Record<string, string> }>
}

async function treeHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative)
      else hashes[relative] = sha256(await fs.readFile(path.join(dir, entry.name)))
    }
  }
  await walk(root)
  return hashes
}

test('every published free-starter Recipe version keeps its exact bytes, whichever directory holds it', async () => {
  const manifest = JSON.parse(await fs.readFile(PUBLISHED_BYTES_MANIFEST, 'utf8')) as ByteManifest
  const thumbnailRoot = path.join(FREE_STARTER_ROOT, 'thumbnail')
  const families: string[] = VERSIONED_FREE_STARTER_GALLERIES.map(gallery => gallery.slug)
  const onDisk = (await fs.readdir(thumbnailRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => families.includes(name.replace(VERSION_SUFFIX, '')))
    .sort()

  assert.deepEqual(onDisk, Object.keys(manifest.published_directories)
    .filter(name => families.includes(name.replace(VERSION_SUFFIX, '')))
    .filter(name => !WITHDRAWN_FREE_STARTER_DIRECTORIES.has(name))
    .sort(), 'every non-withdrawn gallery directory on disk must be pinned')
  for (const name of WITHDRAWN_FREE_STARTER_DIRECTORIES) {
    assert.ok(manifest.published_directories[name], `${name} historical hashes remain ledgered`)
    await assert.rejects(fs.access(path.join(thumbnailRoot, name)), { code: 'ENOENT' })
  }

  const declared = new Map<string, { packId: string, version: string, hashes: Record<string, string> }>()
  for (const name of onDisk) {
    const pinned = manifest.published_directories[name]!
    const packManifest = await readJson(path.join(thumbnailRoot, name, 'pack.json'))
    const suffix = VERSION_SUFFIX.exec(name)?.[1]
    if (suffix) {
      assert.equal(packManifest.version, suffix, `${name} must declare the version its directory name claims`)
    }
    assert.equal(packManifest.pack_id, pinned.pack_id, `${name} must declare its pinned pack id`)
    assert.equal(packManifest.version, pinned.version, `${name} must declare its pinned version`)
    const hashes = await treeHashes(path.join(thumbnailRoot, name))
    assert.deepEqual(hashes, pinned.files,
      `${name} must retain its published bytes exactly — no changed, added, or removed file`)
    declared.set(name, { packId: String(packManifest.pack_id), version: String(packManifest.version), hashes })
  }

  // One identity, one directory — and the authoring registry decides which.
  const registry = JSON.parse(await fs.readFile(
    path.join(ROOT, 'content-packs', 'authoring-registry.json'), 'utf8',
  )) as { records: Array<{ pack_id: string, version: string, source_path: string }> }
  const registeredSource = new Map(registry.records.map(
    record => [`${record.pack_id}@${record.version}`, record.source_path],
  ))
  const seen = new Map<string, string>()
  for (const [name, entry] of declared) {
    const identity = `${entry.packId}@${entry.version}`
    const duplicate = seen.get(identity)
    assert.equal(duplicate, undefined,
      `${identity} is declared by both ${duplicate} and ${name}; one published identity has one source`)
    seen.set(identity, name)
    assert.equal(registeredSource.get(identity), `content-packs/free-starters/thumbnail/${name}`,
      `${identity} must be the identity the authoring registry records for ${name}`)
  }

  for (const [identity, retired] of Object.entries(manifest.retired_identities)) {
    for (const [relative, expected] of Object.entries(retired.files)) {
      const { stdout } = await execFile('git', ['show', `${retired.commit}:${retired.path}/${relative}`], {
        cwd: ROOT, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
      })
      assert.equal(sha256(Buffer.from(stdout)), expected,
        `${identity} no longer has a directory, so ${relative} must still hash to what ${retired.commit.slice(0, 8)} published`)
    }
  }
})

test('the remaining free-starter successor retains its historical bytes and enriched gallery', async () => {
  for (const gallery of VERSIONED_FREE_STARTER_GALLERIES) {
    const successorRoot = path.join(FREE_STARTER_ROOT, 'thumbnail', `${gallery.slug}-v1.0.1`)
    const successorManifest = await readJson(path.join(successorRoot, 'pack.json'))
    const successorRecipe = await readJson(path.join(successorRoot, 'content', 'thumbnail-recipe.json'))
    assert.equal(successorManifest.version, '1.0.1')
    assert.equal(successorManifest.pack_id, `com.storystudio.pack.thumbnail.${gallery.slug}`)
    const entitlement = successorManifest.entitlement as { family: string, sku: string }
    assert.equal(entitlement.family, `com.storystudio.family.thumbnail.${gallery.slug}`)
    assert.equal(entitlement.sku, `com.storystudio.sku.thumbnail.${gallery.slug}`)
    assert.deepEqual(successorRecipe.preview_assets, gallery.assets.map(asset => `assets/${asset}`))
    assert.equal(successorRecipe.id, `com.storystudio.thumbnail.${gallery.slug}`)
    assert.equal(
      sha256(await fs.readFile(path.join(successorRoot, 'assets', gallery.assets[0]))),
      gallery.firstHash,
      `${gallery.slug} successor retains its approved index-zero preview byte-for-byte`,
    )
    for (const [index, asset] of gallery.assets.entries()) {
      await assertFreeStarterWebp(successorRoot, asset, gallery.slug, index === 0 ? `${gallery.slug}-v1.0.1` : `${gallery.slug}-${index + 1}`)
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
    readJson(path.join(STYLE_ROOT, 'content', 'visual-style.json')),
    readJson(path.join(IMPASTO_STYLE_ROOT, 'content', 'visual-style.json')),
    readJson(path.join(DREAMLIKE_RECIPE_ROOT, 'content', 'thumbnail-recipe.json')),
    readJson(path.join(DREAMLIKE_STYLE_ROOT, 'content', 'visual-style.json')),
  ])
  assert.doesNotMatch(JSON.stringify(runtimeDocuments), forbiddenRuntimeMetadata)
})

test('Original-generation receipts remain portable and disclose unavailable model identity', async () => {
  const receipts = await Promise.all(
    ['nature-prehistoric', 'sleep-formats', 'successor-formats']
      .map(batch => readJson(path.join(GENERATION_RECEIPT_ROOT, batch, 'receipt.json'))),
  )

  for (const receipt of receipts) {
    assert.equal(receipt.model, 'not disclosed by the built-in image_gen tool response')
    for (const value of stringValues(receipt)) {
      assert.doesNotMatch(value, /^(?:\/|[A-Za-z]:[\\/])/, 'receipt paths must be repository-relative or logical identifiers')
      assert.doesNotMatch(value, /\.worktrees[\\/]|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/)
    }
  }
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

test('the twelve restored recipe galleries remain decodable, bounded, and free of private-key material', async () => {
  for (const [id, relativeDirectory] of RESTORED_RECIPE_AUDIT) {
    const root = path.join(ROOT, relativeDirectory)
    const recipe = await readJson(path.join(root, 'content', 'thumbnail-recipe.json'))
    parseContentPackDocument('thumbnail-recipe', recipe)
    assert.equal(recipe.id, id)
    assert.doesNotMatch(JSON.stringify(recipe), privateKeyMaterial)
    assert.ok(Array.isArray(recipe.preview_assets))
    assert.ok(recipe.preview_assets.length >= 3 && recipe.preview_assets.length <= 5, `${id} has three to five previews`)
    for (const preview of recipe.preview_assets) {
      assert.match(String(preview), /^assets\/[^/]+\.webp$/)
      const bytes = await fs.readFile(path.join(root, String(preview)))
      assert.doesNotMatch(bytes.toString('latin1'), privateKeyMaterial)
      const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
      assert.deepEqual(
        { format: metadata.format, width: metadata.width, height: metadata.height },
        { format: 'webp', width: 1672, height: 941 },
        `${id} preview ${preview} decodes at the catalog dimensions`,
      )
    }
  }
})

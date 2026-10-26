/**
 * Illustrated History for Sleep — the three prepared standalone packs.
 *
 * This collection exists because the owner approved one reusable history
 * recipe for personal use and again for a versioned pack. The source must keep
 * the personal semantics: a 150-minute default with 120/150/180 choices, no
 * scene rhythm, bold unsoftened imagery, and a large short subject with one
 * fixed FOR SLEEP badge at bottom-left. The thumbnail uses the engine's
 * short-hook mode, not a rewritten curiosity hook.
 *
 * All four declared previews are delivered: one text-free style render and
 * three varied thumbnails. All four sources are owner-approved — the ROME
 * Z-Image sample directly, and the three Qwen 2.1 Turbo renders by the owner's
 * 2026-10-21 review. Every preview must exist, meet the WebP contract and carry
 * its digest in PREVIEW-PROVENANCE.md — there is no pending-preview exemption.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { register } from 'tsx/esm/api'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'
import { SLOTS } from '../../../content-packs/illustrated-history/prepare-previews.mjs'

const ROOT = join(process.cwd(), 'content-packs/illustrated-history')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
// Re-minted 2026-10-27 (`remint-registry.mjs repair --batch 293`): two of these
// three packs stopped being release-bound, so their identities — and therefore
// this receipt and the transitions bound to it — were derived again. The pack
// ids, versions and previews did not move.
const RECEIPT = 'authoring:9d07bac952f05effefc3674b1051f59356c084d6ede1cbe23963e4b8e9c2c118'
/**
 * The floor each pack declares, and why it is not the shared release floor.
 *
 * The document schemas are `.strict()`, so an older build REFUSES a document
 * carrying a field it does not know rather than ignoring it. Measured by
 * parsing each pack's own document with the schema from the release below:
 *   - formula: `starting_scene_seconds` arrives in 1.4.250 (1.4.249 rejects it)
 *   - thumbnail: `headline_mode: 'short-hook'` arrives in 1.4.347
 *   - style: accepted at the shared floor, so it stays release-bound
 */
const FLOORS = {
  'formula/illustrated-history-for-sleep': ['1.4.250', 'fixed'],
  'style/bold-illustrated-history': ['{{MIN_APP_VERSION}}', 'release-bound'],
  'thumbnail/illustrated-subject-sleep-badge': ['1.4.347', 'fixed'],
}
const FORMULA_ID = 'com.storystudio.formula.illustrated-history-for-sleep'
const STYLE_ID = 'com.storystudio.style.bold-illustrated-history'
const RECIPE_ID = 'com.storystudio.thumbnail.illustrated-subject-sleep-badge'

const PACKS = [
  {
    kind: 'series-formula',
    seg: 'formula',
    slug: 'illustrated-history-for-sleep',
    itemId: FORMULA_ID,
    doc: 'series-formula.json',
  },
  {
    kind: 'visual-style',
    seg: 'style',
    slug: 'bold-illustrated-history',
    itemId: STYLE_ID,
    doc: 'visual-style.json',
  },
  {
    kind: 'thumbnail-recipe',
    seg: 'thumbnail',
    slug: 'illustrated-subject-sleep-badge',
    itemId: RECIPE_ID,
    doc: 'thumbnail-recipe.json',
  },
]

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

async function parseDocuments() {
  const unregister = register()
  try {
    const { parseContentPackDocument } = await import(new URL(
      '../../../electron/server/content-packs/schemas.ts', import.meta.url))
    // `return await`, not `return`: the finally must not unregister tsx while
    // the async imports and schema parses are still in flight.
    return await Promise.all(PACKS.map(async pack => ({
      pack,
      document: parseContentPackDocument(pack.kind, await json(join(ROOT, pack.seg, pack.slug, 'content', pack.doc))),
    })))
  } finally {
    unregister()
  }
}

test('all three packs share one receipt-bound batch and are authored by recorded transitions', async () => {
  const registry = await json(REGISTRY)
  const batch = registry.batches.find(entry => entry.revision === 293)
  assert.ok(batch, 'the Illustrated History reservation is revision 293')
  assert.equal(batch.receipt_ref, RECEIPT)
  assert.deepEqual(batch.request.records.map(record => record.pack_id).sort(),
    PACKS.map(pack => `com.storystudio.pack.${pack.seg}.${pack.slug}`).sort())

  // Every record advanced one step at a time from the same original receipt.
  // There is no exemption: all three transitions must be present and authored.
  for (const [index, pack] of PACKS.entries()) {
    const packId = `com.storystudio.pack.${pack.seg}.${pack.slug}`
    const revision = 294 + index
    const transition = registry.transitions.find(entry => entry.revision === revision)
    assert.ok(transition, `${packId} has lifecycle revision ${revision}`)
    assert.equal(transition.request.receipt_ref, RECEIPT)
    assert.equal(transition.request.pack_id, packId)
    assert.equal(transition.request.version, '1.0.0')
    assert.equal(transition.request.changes.status, 'authored')
  }

  for (const pack of PACKS) {
    const packId = `com.storystudio.pack.${pack.seg}.${pack.slug}`
    const record = registry.records.find(entry => entry.pack_id === packId && entry.version === '1.0.0')
    assert.ok(record, `${packId} is registered`)
    assert.equal(record.receipt_ref, RECEIPT)
    assert.equal(record.status, 'authored', 'the coordinator advanced this record from reserved')
    assert.equal(record.item_id, pack.itemId)
    assert.equal(record.kind, pack.kind)
    assert.equal(record.source_path, `content-packs/illustrated-history/${pack.seg}/${pack.slug}`)
    const [floor, floorStatus] = FLOORS[`${pack.seg}/${pack.slug}`]
    assert.equal(record.min_app_version, floor, 'the pack declares the release that can install it')
    assert.equal(record.min_app_version_status, floorStatus)
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.bundle_id, undefined, 'no Channel Kit membership')

    const manifest = await json(join(ROOT, pack.seg, pack.slug, 'pack.json'))
    assert.equal(manifest.pack_format, 1)
    assert.equal(manifest.pack_id, packId)
    assert.equal(manifest.publisher_id, 'com.storystudio')
    assert.equal(manifest.key_id, '{{KEY_ID}}')
    assert.equal(manifest.version, '1.0.0')
    assert.equal(manifest.min_app_version, floor, 'pack.json and the registry record must agree')
    assert.equal(manifest.lifecycle, 'active')
    assert.ok(manifest.changelog.length > 0)
    assert.deepEqual(manifest.entitlement, {
      sku: `com.storystudio.sku.${pack.seg}.${pack.slug}`,
      family: `com.storystudio.family.${pack.seg}.${pack.slug}`,
    })
    assert.deepEqual(manifest.dependencies, [])
    assert.equal(manifest.bundles, undefined)
  }
})

test('the three documents parse against the current shared contract and keep their identities', async () => {
  for (const { pack, document } of await parseDocuments()) {
    assert.equal(document.kind, pack.kind, pack.slug)
    assert.equal(document.id, pack.itemId, pack.slug)
    assert.equal(document.schema_version, 1, pack.slug)
    for (const [keyPath, value] of meaningfulStrings(document)) {
      assert.equal(markIn(value), undefined, `${pack.slug} ${keyPath} carries a third-party mark`)
    }
  }
})

// This pins the 1.0.0 source. The owner's 2026-10-26 tiered Sleep rhythm ships
// as the 1.0.1 successor (`illustrated-history-for-sleep-v1.0.1`), which names a
// starting rhythm; the published 1.0.0 bytes are untouched.
test('the formula keeps the approved personal length, honesty rules and absent scene rhythm', async () => {
  const formula = await json(join(ROOT, 'formula/illustrated-history-for-sleep/content/series-formula.json'))
  const personal = await json(join(ROOT, 'personal/series-formula.json'))
  const structure = formula.script_structure
  assert.equal(structure.default_length_minutes, 150)
  assert.deepEqual(structure.length_minutes_range, [120, 180])
  assert.deepEqual(structure.duration_presets, [120, 150, 180])
  assert.equal(structure.default_chapter_count, 18)
  assert.deepEqual(structure.chapter_count_range, [12, 28])
  assert.equal(structure.default_words_per_minute, 125)
  assert.equal(structure.chapters_independent, false)
  assert.equal(formula.starting_scene_seconds, undefined, 'the formula does not choose an episode rhythm')
  assert.equal(structure.visual_pacing_profile, undefined, 'no pacing override travels in the pack')
  assert.equal(structure.motion_profile_id, undefined)

  // Same approved semantics as the personal document, not a drifted rewrite.
  assert.equal(structure.default_length_minutes, personal.scriptStructure.defaultLengthMinutes)
  assert.deepEqual(structure.length_minutes_range, personal.scriptStructure.lengthMinutesRange)
  assert.deepEqual(structure.duration_presets, personal.scriptStructure.durationPresets)
  assert.equal(structure.default_chapter_count, personal.scriptStructure.defaultChapterCount)
  assert.equal(formula.description, personal.description)

  for (const rule of [...formula.title_rules, ...formula.title_shape_rules, ...formula.metadata_title_hook_rules]) {
    if (/date range|runtime|entire|complete/i.test(rule)) {
      assert.match(rule, /never|no |exact|claim/i, 'the honesty rules forbid, rather than promise, these')
    }
  }
  assert.ok(formula.title_rules.some(rule => /never state an exact date range/i.test(rule)))
  assert.ok(formula.title_rules.some(rule => /exact runtime/i.test(rule)))
  assert.ok(formula.title_rules.some(rule => /entire or complete history/i.test(rule)))
  assert.deepEqual(formula.compatible_topic_pack_ids, personal.compatibleTopicPackIds)
  assert.deepEqual(formula.default_topic_pack_ids, personal.defaultTopicPackIds)
  assert.deepEqual(formula.recommended_visual_style_ids, [STYLE_ID])
  assert.deepEqual(formula.recommended_thumbnail_recipe_ids, [RECIPE_ID])
})

test('the style is the approved bold look, not a calmed sleep variant', async () => {
  const style = await json(join(ROOT, 'style/bold-illustrated-history/content/visual-style.json'))
  const personalStyle = (await json(join(ROOT, 'personal/user-style-pack.json'))).styles[0]
  assert.equal(style.style_bible, personalStyle.style_bible, 'the approved style text is carried verbatim')
  assert.equal(style.negative_prompt, personalStyle.negative_prompt)
  for (const trait of [/strong ink outline/i, /flat, saturated colour/i, /battles, sieges, burning cities/i,
    /must never be muted, pastel, or calmed/i]) {
    assert.match(style.style_bible, trait)
  }
  for (const rejected of ['photoreal', 'soft painterly', 'pastel palette', 'washed out colour',
    'calm empty landscape', 'specific living person']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt rejects ${rejected}`)
  }
  assert.deepEqual(style.preview_assets, ['assets/bold-illustrated-history-hero.webp'])
  assert.deepEqual(style.compatible_formula_ids, [FORMULA_ID])
})

test('the thumbnail recipe is the approved short-subject, bottom-left FOR SLEEP contract', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/illustrated-subject-sleep-badge/content/thumbnail-recipe.json'))
  const personal = (await json(join(ROOT, 'personal/thumbnail-template.json'))).recipe
  assert.equal(recipe.headline_mode, 'short-hook', 'the engine mode the personal recipe uses')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.default_text_position, 'top')
  assert.equal(recipe.headline_mode, personal.headlineMode)
  assert.equal(recipe.composition_guidance, personal.conceptGuidance)
  assert.deepEqual(recipe.composition_rules, personal.compositionRules)
  assert.deepEqual(recipe.required_elements, personal.requiredElements)
  assert.deepEqual(recipe.avoid_elements, personal.avoid)
  assert.equal(recipe.headline_guidance, personal.headlineGuidance)
  assert.equal(recipe.default_text_style, personal.defaultTextStyle)
  assert.equal(recipe.default_font_style, personal.defaultFontStyle)
  assert.deepEqual(recipe.headline_formats, personal.headlineFormats)
  assert.equal(recipe.visual_style_guidance, personal.visualStyleGuidance)

  assert.match(recipe.composition_guidance, /large short subject line/i)
  assert.match(recipe.composition_guidance, /one to four words/i)
  assert.match(recipe.composition_guidance, /bottom-left corner/i)
  assert.match(recipe.composition_guidance, /exactly the words FOR SLEEP/i)
  assert.match(recipe.composition_guidance, /No date range, no runtime figure/i)
  assert.ok(recipe.composition_rules.some(rule => /bottom-left corner/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /exactly the words FOR SLEEP/i.test(rule)))
  assert.ok(recipe.avoid_elements.some(rule => /entire or complete history/i.test(rule)))
  assert.deepEqual(recipe.compatible_formula_ids, [FORMULA_ID])
})

test('all four declared previews exist, meet the contract and are recorded in provenance', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  const declared = []
  for (const pack of PACKS) {
    const document = await json(join(ROOT, pack.seg, pack.slug, 'content', pack.doc))
    for (const asset of document.preview_assets ?? []) declared.push({ pack, asset })
  }
  assert.equal(declared.length, 4, 'one style preview and three varied thumbnail previews')
  const declaredPaths = declared.map(({ pack, asset }) => `${pack.seg}/${pack.slug}/${asset}`).sort()
  assert.deepEqual(declaredPaths, Object.values(SLOTS).map(slot => slot.output).sort())

  for (const { pack, asset } of declared) {
    const relative = `${pack.seg}/${pack.slug}/${asset}`
    const path = join(ROOT, relative)
    assert.ok(await exists(path), `${relative} exists — every declared preview is delivered`)
    const bytes = await readFile(path)
    assert.ok(bytes.byteLength > 20 * 1024, `${relative} clears the 20 KB floor`)
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    assert.deepEqual({ format: metadata.format, width: metadata.width, height: metadata.height },
      { format: 'webp', width: 1672, height: 941 }, `${relative} meets the preview contract`)
    assert.ok(provenance.includes(asset.split('/').pop()), `provenance names ${relative}`)
    assert.ok(provenance.includes(sha256(bytes)), `provenance records the digest of ${relative}`)
    assert.ok(provenance.includes(`${bytes.byteLength}`), `provenance records the byte count of ${relative}`)
  }

  // Every slot carries a real pin: ROME keeps the owner approval, the other
  // three record the coordinator's reviewed render. None is fabricated.
  assert.equal(SLOTS['thumbnail-1'].approved.sha256,
    '749859235ae960661177e61effe98cfb97ff9510d3199f572dcd41eb9d828db3')
  assert.match(SLOTS['thumbnail-1'].approved.label, /^owner-approved /)
  assert.ok(provenance.includes(SLOTS['thumbnail-1'].approved.sha256))
  assert.ok(provenance.includes('--min-app-version 1.4.347'), 'the prepared floor binds the short-hook runtime')
  for (const slot of ['thumbnail-2', 'thumbnail-3', 'style-1']) {
    const pin = SLOTS[slot].approved
    assert.ok(pin, `${slot} pins an approved render`)
    assert.match(pin.label, /^owner-approved /, `${slot} records the owner's approval`)
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${slot} pins a real digest`)
    assert.ok(Number.isInteger(pin.bytes) && pin.bytes > 0, `${slot} pins a byte count`)
    assert.ok(Number.isInteger(pin.width) && Number.isInteger(pin.height), `${slot} pins dimensions`)
  }
})

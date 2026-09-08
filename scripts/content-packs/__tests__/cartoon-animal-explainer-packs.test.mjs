/**
 * The Cartoon Animal Explainer collection — three standalone packs authored
 * 2026-09-09 for an animal channel that covers one group completely in a stated
 * number of minutes. One reservation batch (revision 266), one receipt, three
 * lifecycle promotions (revisions 269-271).
 *
 * Two of the three declare preview assets, and all seven of them now EXIST:
 * they were rendered on 2026-09-09 under an explicit owner authorisation
 * through GenStudio `gpt-image-2`, converted, and committed. So the preview
 * assertions are no longer conditional — every declared preview must be on
 * disk, must decode to its exact contract, and must have its digest and byte
 * count recorded in the collection's PREVIEW-PROVENANCE.md.
 *
 * The fourth recipe preview was rendered TWICE: the first return put a real
 * national flag (France) above the middle bird, which this collection's own
 * acceptance rules reject outright, so it was thrown away and re-rendered from
 * the same unchanged prompt. That rejection is pinned below, because the flags
 * variant is exactly where a later re-run will drift the same way.
 *
 * The three-preview rule for Visual Styles and the four-preview rule for
 * Thumbnail Recipes, both set by the owner on 2026-09-08, are asserted here so
 * a later edit cannot quietly drop this collection below them.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/cartoon-animal-explainer')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:20cc5fec4b8a5e07f1a03a1eeebd504f583ac3025f738401bee782b74bbcc855'
const WILDLIFE_FORMULA = 'com.storystudio.formula.natural-world-explained'
const LISTICLE_FORMULA = 'com.storystudio.formula.counted-explainer'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'flat-cartoon-wildlife', docs: ['visual-style.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'labelled-caricature-trio', docs: ['thumbnail-recipe.json'] },
  {
    kind: 'metadata-formula',
    seg: 'metadata-formula',
    slug: 'every-type-explained-titles',
    docs: ['every-type-explained-titles.json'],
    multi: true,
  },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/flat-cartoon-wildlife/assets/flat-cartoon-wildlife-hero.webp': [1672, 941],
  'style/flat-cartoon-wildlife/assets/flat-cartoon-wildlife-scene.webp': [1672, 941],
  'style/flat-cartoon-wildlife/assets/flat-cartoon-wildlife-face.webp': [1672, 941],
  'thumbnail/labelled-caricature-trio/assets/labelled-caricature-trio-1.webp': [1672, 941],
  'thumbnail/labelled-caricature-trio/assets/labelled-caricature-trio-2.webp': [1672, 941],
  'thumbnail/labelled-caricature-trio/assets/labelled-caricature-trio-3.webp': [1672, 941],
  'thumbnail/labelled-caricature-trio/assets/labelled-caricature-trio-4.webp': [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Cartoon Animal Explainer pack is an authored, receipt-bound standalone source', async () => {
  const registry = await json(REGISTRY)
  for (const p of PACKS) {
    const packId = `com.storystudio.pack.${p.seg}.${p.slug}`
    const itemId = `com.storystudio.${p.seg}.${p.slug}`
    const record = registry.records.find(r => r.pack_id === packId && r.version === '1.0.0')
    assert.ok(record, `${packId} must be registered`)
    assert.equal(record.receipt_ref, RECEIPT)
    assert.equal(record.status, 'authored')
    assert.equal(record.kind, p.kind)
    if (p.multi) {
      assert.deepEqual(record.item_ids, [itemId], `${packId} records its item set`)
      assert.equal(record.item_id, undefined)
    } else {
      assert.equal(record.item_id, itemId)
      assert.equal(record.item_ids, undefined)
    }
    assert.equal(record.source_path, `content-packs/cartoon-animal-explainer/${p.seg}/${p.slug}`)
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.bundle_id, undefined, 'no Channel Kit membership')

    const manifest = await json(join(ROOT, p.seg, p.slug, 'pack.json'))
    assert.equal(manifest.pack_format, 1)
    assert.equal(manifest.pack_id, packId)
    assert.equal(manifest.publisher_id, 'com.storystudio')
    assert.equal(manifest.key_id, '{{KEY_ID}}')
    assert.equal(manifest.version, '1.0.0')
    assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(manifest.lifecycle, 'active')
    assert.ok(manifest.changelog?.length > 0, `${packId} states what its first release ships`)
    assert.deepEqual(manifest.entitlement, {
      sku: `com.storystudio.sku.${p.seg}.${p.slug}`,
      family: `com.storystudio.family.${p.seg}.${p.slug}`,
    })
    assert.deepEqual(manifest.dependencies, [])
    assert.equal(manifest.bundles, undefined, 'a creative component declares no bundle')

    assert.deepEqual((await readdir(join(ROOT, p.seg, p.slug, 'content'))).sort(), p.docs)
    for (const name of p.docs) {
      const doc = await json(join(ROOT, p.seg, p.slug, 'content', name))
      assert.equal(doc.kind, p.kind)
      assert.equal(doc.id, itemId)
      assert.equal(doc.schema_version, 1)
      for (const [keyPath, value] of meaningfulStrings(doc)) {
        assert.equal(markIn(value), undefined, `${packId} ${keyPath} carries a third-party mark`)
      }
    }
  }
})

test('the visual style is outline-first, flat, muted, and one calm animal at a time', async () => {
  const style = await json(join(ROOT, 'style/flat-cartoon-wildlife/content/visual-style.json'))
  assert.equal(style.name, 'Flat Cartoon Wildlife')
  assert.deepEqual(style.compatible_formula_ids, [WILDLIFE_FORMULA, LISTICLE_FORMULA])
  // The six traits the recipe sits on. Losing any one turns this into an
  // ordinary explainer look, which is what the negative prompt spends its
  // length refusing.
  assert.match(style.style_bible, /thick clean outline of even weight/i)
  assert.match(style.style_bible, /every surface is one flat muted colour/i)
  assert.match(style.style_bible, /exactly one animal per frame/i)
  assert.match(style.style_bible, /simple landscape reduced to as few shapes/i)
  assert.match(style.style_bible, /Expressions are calm/i)
  // The single-gradient rule is the whole discipline of the look.
  assert.match(style.style_bible, /exactly one gradient permitted anywhere in this style/i)
  assert.match(style.style_bible, /one soft radial glow/i)
  assert.match(style.style_bible, /never becomes a halo ring or a rim light/i)
  // Anatomy is the product for a wildlife channel, and distress is refused.
  assert.match(style.style_bible, /Anatomy is simplified but honest/i)
  assert.match(style.style_bible, /is ever shown frightened, injured, hunting, bleeding or in distress/i)
  for (const rejected of ['photoreal fur', 'painterly', 'chibi', 'neon', 'gradient background', 'text']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the visual style declares three previews — hero, empty scene, and hardest case', async () => {
  const doc = await json(join(ROOT, 'style/flat-cartoon-wildlife/content/visual-style.json'))
  assert.deepEqual(doc.preview_assets, [
    'assets/flat-cartoon-wildlife-hero.webp',
    'assets/flat-cartoon-wildlife-scene.webp',
    'assets/flat-cartoon-wildlife-face.webp',
  ], 'the style declares the three-preview set the owner asked for')
})

test('the recipe fixes three caricatures on white under one-word labels, with a flags variant', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/labelled-caricature-trio/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'annotated-collage')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.equal(recipe.default_text_position, 'top', 'the labels sit above the animals')
  assert.equal(recipe.preview_assets.length, 4)
  assert.deepEqual(recipe.compatible_formula_ids, [WILDLIFE_FORMULA, LISTICLE_FORMULA])
  // The three fixed parts, stated in the guidance AND as hard rules, because
  // the recurrence of the frame is the entire product.
  assert.match(recipe.composition_guidance, /The white\./)
  assert.match(recipe.composition_guidance, /The trio\./)
  assert.match(recipe.composition_guidance, /The labels\./)
  assert.match(recipe.composition_guidance, /The variant\./)
  assert.ok(recipe.composition_rules.some(rule => /plain flat white across the entire frame/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /three animals of one and the same species/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /heavier outline and bolder, simpler shapes than the in-video style uses/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /exactly one word sits directly above each animal/i.test(rule)))
  // Co-equal animals: this recipe has no hero and no centre anchor, which is the
  // one thing an "annotated-collage" layout could otherwise be read as implying.
  assert.ok(recipe.composition_rules.some(rule => /no hero/i.test(rule)))
  assert.ok(recipe.avoid_elements.some(entry => /one animal treated as the hero/i.test(entry)))
  // The Flags variant, exactly as the owner specified it: three continents, one
  // small flag per animal, and no words at all.
  assert.ok(recipe.composition_rules.some(rule =>
    /three different continents/i.test(rule) && /one small simple flag on a short pole/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /Flags variant carries no words at all/i.test(rule)))
  assert.match(recipe.headline_guidance, /Write each label as one word and nothing more/i)
  assert.match(recipe.headline_guidance, /no two-word phrase, no hyphenated compound/i)
  assert.match(recipe.headline_guidance, /In the Flags variant write nothing at all/i)
  // The default font style is the shipped Marker Slab lettering shape, named in
  // prose because a dotted identifier is not permitted in pack text.
  assert.match(recipe.default_font_style, /fat chisel-tip marker letterforms/i)
  assert.match(recipe.default_font_style, /Marker Slab/)
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
  // An animal channel is not a shock channel, and a flag is not an emblem.
  assert.ok(recipe.avoid_elements.some(entry => /frightened, injured, hunting, bleeding or distressed/i.test(entry)))
  assert.ok(recipe.avoid_elements.some(entry => /invented insignia/i.test(entry)))
})

test('the default font style matches the shipped Marker Slab lettering phrase', async () => {
  // The recipe was authored to default to an EXISTING lettering style rather
  // than to invent a new one, so this pins the two together: if the shipped
  // lettering phrase is ever rewritten, this fails and the recipe gets updated
  // with it instead of silently drifting.
  const lettering = await json(join(process.cwd(),
    'content-packs/paid/lettering/explainer/content/marker-slab.json'))
  assert.equal(lettering.name, 'Marker Slab')
  const recipe = await json(join(ROOT, 'thumbnail/labelled-caricature-trio/content/thumbnail-recipe.json'))
  for (const fragment of ['fat chisel-tip marker letterforms', 'single confident strokes',
    'blunt square stroke ends', 'slightly uneven thickness', 'heavy and immediate']) {
    assert.ok(lettering.phrase.includes(fragment), `the shipped lettering phrase still says "${fragment}"`)
  }
  assert.match(recipe.default_font_style, /blunt square stroke ends, slightly uneven thickness, heavy and immediate/)
})

test('the metadata formula fixes two title shapes and a fifteen-to-twenty-two-minute runtime', async () => {
  const doc = await json(join(ROOT,
    'metadata-formula/every-type-explained-titles/content/every-type-explained-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  // The two patterns the owner specified, verbatim.
  assert.match(doc.title_plan.guidance, /Every <Species> Type Explained in <N> Minutes/)
  assert.match(doc.title_plan.guidance, /Every Continent's <Superlative> Animal Explained in <N> Minutes/)
  // The number in the title is the real runtime, which is the promise the whole
  // shape rests on.
  assert.match(doc.title_plan.guidance, /never round it up/i)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  assert.match(runtime.instruction, /fifteen to twenty-two minutes/)
  assert.match(runtime.instruction, /not a rounded promise/)
  // The honest half of a completeness claim: what is still argued.
  const settled = doc.description_plan.sections.find(section => section.id === 'settled')
  assert.ok(settled, 'the formula separates settled claims from open ones')
  assert.match(settled.instruction, /still argued/i)
  assert.match(settled.instruction, /Never present an open question as settled/i)
  // The optional correction note emits nothing when the story context is silent.
  const correction = doc.description_plan.sections.find(section => section.id === 'correction')
  assert.ok(correction, 'the formula carries the optional correction note')
  assert.match(correction.instruction, /only when/i)
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  assert.ok(doc.tone.constraints.some(entry => /No hook, no cliffhanger/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never rounded up for effect/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never linger on an animal's suffering/i.test(entry)))
  // A built-in formula shares this id namespace, so a pack must never take one.
  const builtinDirectory = join(process.cwd(), 'electron', 'server', 'metadata-formulas')
  const builtinIds = await Promise.all(
    (await readdir(builtinDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => (await json(join(builtinDirectory, name))).id),
  )
  assert.ok(!builtinIds.includes(doc.id), `${doc.id} shadows a built-in`)
})

test('every declared preview exists, meets the contract, and is accounted for by the provenance record', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  const declared = new Set()
  for (const p of PACKS) {
    for (const name of p.docs) {
      const doc = await json(join(ROOT, p.seg, p.slug, 'content', name))
      for (const asset of doc.preview_assets ?? []) declared.add(`${p.seg}/${p.slug}/${asset}`)
    }
  }
  assert.deepEqual([...declared].sort(), Object.keys(PREVIEW_CONTRACT).sort())

  for (const [rel, [width, height]] of Object.entries(PREVIEW_CONTRACT)) {
    assert.ok(provenance.includes(rel.split('/').pop()), `provenance must name ${rel}`)
    assert.ok(provenance.includes(`${width}x${height}`), `provenance must state ${width}x${height}`)
    const path = join(ROOT, rel)
    assert.ok(await exists(path), `${rel} is declared by a pack and must be committed`)
    const buf = await readFile(path)
    assert.ok(buf.byteLength > 20 * 1024, `${rel} must exceed the 20 KB floor`)
    const meta = await sharp(buf).metadata()
    assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height },
      { format: 'webp', width, height }, `${rel} must decode to the declared contract`)
    const digest = createHash('sha256').update(buf).digest('hex')
    assert.ok(provenance.includes(digest), `provenance must record the digest of ${rel}`)
    assert.ok(provenance.includes(`${buf.byteLength}`), `provenance must record the byte count of ${rel}`)
  }
})

test('the provenance record states under what authorisation these were rendered, how, and what to refuse', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'cartoon-animal-explainer-previews-1',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The rejected first return of the fourth recipe preview, and the re-render
  // that replaced it. Without this a later reader sees only the committed file
  // and repeats the flag drift the next time the flags variant is re-run.
  for (const evidence of [
    'cartoon-animal-explainer-previews-1-retry4',
    'real national flag',
    'The rejected first return, kept as history',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The acceptance rules this collection needs: original subjects, correct
  // anatomy, calm animals, spelled labels, and no people anywhere.
  assert.match(provenance, /Original subjects only/)
  assert.match(provenance, /must be rejected rather than committed/)
  assert.match(provenance, /no bare skin appears in any prompt/)
  assert.match(provenance, /anatomy is wrong for the species/)
  assert.match(provenance, /spelled exactly as written/)
  // One run id, and its body stays inside the seven-prompt ceiling.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
  assert.ok(prompts.length <= 7, 'a single run id carries at most seven prompts')
  const bodies = provenance.match(/^> .+$/gm) ?? []
  assert.equal(bodies.length, prompts.length, 'every prompt has exactly one body')
  assert.ok(Buffer.byteLength(JSON.stringify(bodies)) < 16 * 1024, 'the request body stays under the 16 KiB cap')
})

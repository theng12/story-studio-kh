/**
 * The Lost Voyage collection — eight standalone packs authored 2026-09-08 for a
 * maritime sleep-history channel system. One reservation batch (revision 153),
 * one receipt, eight lifecycle promotions (revisions 154-161).
 *
 * Six of the eight declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and no owner authorisation
 * was given for this pass. Nothing was fabricated and nothing was stubbed, so
 * this file pins the honest state instead: every declared preview path is named
 * by the collection's PREVIEW-PROVENANCE.md, and any preview byte that HAS
 * landed must meet the contract. The day the previews are rendered, the
 * assertions below start checking them without being edited.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/lost-voyage')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:c276fd92692600fc764b44eafb43b501bbf6c7c17af47d339e3bff34e0a1b318'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'maritime-oil-painting', docs: ['visual-style.json'] },
  { kind: 'visual-style', seg: 'style', slug: 'foggy-harbour-realism', docs: ['visual-style.json'] },
  { kind: 'lettering-style', seg: 'lettering', slug: 'victorian-engraved-small-caps', docs: ['victorian-engraved-small-caps.json'], multi: true },
  { kind: 'lettering-style', seg: 'lettering', slug: 'antique-wood-type-poster-serif', docs: ['antique-wood-type-poster-serif.json'], multi: true },
  { kind: 'lettering-style', seg: 'lettering', slug: 'weathered-brush-stamp', docs: ['weathered-brush-stamp.json'], multi: true },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'maritime-title-left-subject-right', docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'lost-voyages', docs: ['topic-pack.json'] },
  { kind: 'metadata-formula', seg: 'metadata-formula', slug: 'history-for-sleep-titles', docs: ['history-for-sleep-titles.json'], multi: true },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  // Three per visual style since 2026-09-08: hero, quiet wide scene with no
  // figure, hardest case. Hero stays first in the pack's `preview_assets`.
  'style/maritime-oil-painting/assets/maritime-oil-painting.webp': [1672, 941],
  'style/maritime-oil-painting/assets/maritime-oil-painting-2.webp': [1672, 941],
  'style/maritime-oil-painting/assets/maritime-oil-painting-3.webp': [1672, 941],
  'style/foggy-harbour-realism/assets/foggy-harbour-realism.webp': [1672, 941],
  'style/foggy-harbour-realism/assets/foggy-harbour-realism-2.webp': [1672, 941],
  'style/foggy-harbour-realism/assets/foggy-harbour-realism-3.webp': [1672, 941],
  'lettering/victorian-engraved-small-caps/assets/victorian-engraved-small-caps.webp': [1024, 576],
  'lettering/antique-wood-type-poster-serif/assets/antique-wood-type-poster-serif.webp': [1024, 576],
  'lettering/weathered-brush-stamp/assets/weathered-brush-stamp.webp': [1024, 576],
  'thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-1.webp': [1672, 941],
  'thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-2.webp': [1672, 941],
  'thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-3.webp': [1672, 941],
  'thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-4.webp': [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Lost Voyage pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/lost-voyage/${p.seg}/${p.slug}`)
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

// Each style ships three previews since 2026-09-08 — hero, quiet wide scene
// with no figure, hardest case — and the hero stays first so a gallery that
// shows one image shows the signature shot.
test('the two visual styles are one cover look and one low-stimulation scene look', async () => {
  const cover = await json(join(ROOT, 'style/maritime-oil-painting/content/visual-style.json'))
  assert.equal(cover.name, 'Maritime Oil Painting')
  assert.deepEqual(cover.preview_assets, ['assets/maritime-oil-painting.webp', 'assets/maritime-oil-painting-2.webp', 'assets/maritime-oil-painting-3.webp'])
  assert.ok(cover.compatible_formula_ids.includes(FORMULA_ID))
  // The pale open sky is what the thumbnail recipe's title column sits on; a
  // style bible that stopped promising it would silently break the recipe.
  assert.match(cover.style_bible, /negative space/i)
  assert.match(cover.style_bible, /brushwork/i)
  assert.match(cover.negative_prompt, /photograph/i)
  assert.match(cover.negative_prompt, /modern vessels/i)

  const scene = await json(join(ROOT, 'style/foggy-harbour-realism/content/visual-style.json'))
  assert.equal(scene.name, 'Foggy Harbour Realism')
  assert.deepEqual(scene.preview_assets, ['assets/foggy-harbour-realism.webp', 'assets/foggy-harbour-realism-2.webp', 'assets/foggy-harbour-realism-3.webp'])
  assert.ok(scene.compatible_formula_ids.includes(FORMULA_ID))
  // Low stimulation is the whole product for in-video sleep scenes.
  assert.match(scene.style_bible, /low stimulation/i)
  assert.match(scene.style_bible, /one warm source/i)
  for (const rejected of ['bright sunshine', 'close-up faces', 'crowds', 'action']) {
    assert.ok(scene.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
  assert.notEqual(cover.style_bible, scene.style_bible)
})

test('the three lettering styles ship a phrase, an axis, and a swatch each', async () => {
  const expected = [
    ['victorian-engraved-small-caps', 'font', /small capitals/i],
    ['antique-wood-type-poster-serif', 'font', /wood-type/i],
    ['weathered-brush-stamp', 'text', /dry-brush/i],
  ]
  for (const [slug, axis, phraseShape] of expected) {
    const doc = await json(join(ROOT, 'lettering', slug, 'content', `${slug}.json`))
    assert.equal(doc.axis, axis)
    assert.match(doc.phrase, phraseShape)
    assert.ok(doc.phrase.length <= 600, `${slug} phrase fits the schema bound`)
    assert.deepEqual(doc.preview_assets, [`assets/${slug}.webp`])
  }
})

test('the thumbnail recipe puts a short hook left and one subject right', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/maritime-title-left-subject-right/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.equal(recipe.default_text_position, 'bottom-left')
  assert.equal(recipe.preview_assets.length, 4)
  assert.ok(recipe.compatible_formula_ids.includes(FORMULA_ID))
  // The recipe references the Victorian small-caps letterform by its own phrase,
  // so a reader who owns neither pack still knows what the title looks like.
  const lettering = await json(join(ROOT, 'lettering/victorian-engraved-small-caps/content/victorian-engraved-small-caps.json'))
  assert.equal(recipe.default_font_style, lettering.phrase)
  // Both subject variants live in one recipe; the schema carries one composition.
  assert.match(recipe.composition_guidance, /Variant A/)
  assert.match(recipe.composition_guidance, /Variant B/)
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/lost-voyages/content/topic-pack.json'))
  assert.deepEqual(doc.compatible_formula_ids, [FORMULA_ID])
  assert.equal(doc.subjects.length, 50)
  assert.equal(doc.max_siblings_per_subject, 20)
  assert.equal(doc.coverage_profiles.length, 50)
  assert.deepEqual(doc.coverage_profiles.map(p => p.subject), doc.subjects)
  const pairs = new Set(); const full = new Set()
  let tuples = 0
  for (const profile of doc.coverage_profiles) {
    assert.equal(profile.tuples.length, 20, `${profile.subject} declares twenty slots`)
    assert.equal(new Set(profile.tuples.map(t => t.episode_object)).size, 20, `${profile.subject} objects unique`)
    assert.equal(new Set(profile.tuples.map(t => t.mechanism)).size, 20, `${profile.subject} mechanisms unique`)
    for (const t of profile.tuples) {
      tuples += 1
      pairs.add(`${t.episode_object}|${t.mechanism}`)
      full.add(JSON.stringify(t))
    }
  }
  assert.equal(tuples, 1000)
  assert.equal(pairs.size, 1000, 'object|mechanism pairs unique across the pack')
  assert.equal(full.size, 1000, 'complete tuples unique across the pack')
  // The sleep contract: no hooks, no dwelling on suffering, no named people.
  for (const shape of [/hook/i, /suffering|drowning/i, /named individuals/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  assert.match(doc.prompt_context, /drifting toward sleep/i)
})

test('the metadata formula fixes two title shapes and a hookless tone', async () => {
  const doc = await json(join(ROOT, 'metadata-formula/history-for-sleep-titles/content/history-for-sleep-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  assert.match(doc.title_plan.guidance, /What It Was Like to/)
  assert.match(doc.title_plan.guidance, /History for Sleep/)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  assert.match(runtime.instruction, /hundred to one hundred and forty minutes/)
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  assert.ok(doc.tone.constraints.some(entry => /no hook/i.test(entry)))
  // A built-in formula shares this id namespace, so a pack must never take one.
  const builtinDirectory = join(process.cwd(), 'electron', 'server', 'metadata-formulas')
  const builtinIds = await Promise.all(
    (await readdir(builtinDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => (await json(join(builtinDirectory, name))).id),
  )
  assert.ok(!builtinIds.includes(doc.id), `${doc.id} shadows a built-in`)
})

test('every declared preview is named by the provenance record, and any that exists meets the contract', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  // Collect what the documents actually declare, so a new preview added to a
  // document cannot escape this check by not being listed above.
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
    if (!await exists(path)) continue
    const buf = await readFile(path)
    assert.ok(buf.byteLength > 20 * 1024, `${rel} must exceed the 20 KB floor`)
    const meta = await sharp(buf).metadata()
    assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height },
      { format: 'webp', width, height }, `${rel} must decode to the declared contract`)
    // A landed preview must carry its own byte evidence, not an empty row.
    const digest = createHash('sha256').update(buf).digest('hex')
    assert.ok(provenance.includes(digest), `provenance must record the digest of ${rel}`)
    assert.ok(provenance.includes(`${buf.byteLength}`), `provenance must record the byte count of ${rel}`)
  }
})

test('the provenance record states why nothing was generated and how to generate it', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'lost-voyage-previews-1',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // One prompt per declared preview, prepared so the render is one step.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
})

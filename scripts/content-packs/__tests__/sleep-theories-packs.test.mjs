/**
 * The Sleep Theories collection — three standalone packs authored 2026-09-08
 * for a mystery channel that is still a SLEEP channel: the thumbnail is loud so
 * the episode gets opened, and the episode itself is even, unhurried and built
 * strictly as "the case, and then the claims". One reservation batch (revision
 * 187), one receipt, three lifecycle promotions (revisions 191-193).
 *
 * Two of the three declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and no owner authorisation
 * was given for this pass. Nothing was fabricated and nothing was stubbed, so
 * this file pins the honest state instead: every declared preview path is named
 * by the collection's PREVIEW-PROVENANCE.md, and any preview byte that HAS
 * landed must meet the contract.
 *
 * The three-preview rule for Visual Styles, set by the owner on 2026-09-08 and
 * applied to Royal History first, is asserted here too, so a later edit cannot
 * quietly drop this collection back to one.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/sleep-theories')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:518be23c26cdafcff37523241d765233e5bc217a88a466e921b427cb6eca0fd0'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'
const RECIPE_SLUG = 'series-banner-investigator-mystery-object'

const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'comic-pulp-mystery', docs: ['visual-style.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: RECIPE_SLUG, docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'mysteries-and-cover-ups', docs: ['topic-pack.json'] },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/comic-pulp-mystery/assets/comic-pulp-mystery-hero.webp': [1672, 941],
  'style/comic-pulp-mystery/assets/comic-pulp-mystery-scene.webp': [1672, 941],
  'style/comic-pulp-mystery/assets/comic-pulp-mystery-face.webp': [1672, 941],
  [`thumbnail/${RECIPE_SLUG}/assets/${RECIPE_SLUG}-1.webp`]: [1672, 941],
  [`thumbnail/${RECIPE_SLUG}/assets/${RECIPE_SLUG}-2.webp`]: [1672, 941],
  [`thumbnail/${RECIPE_SLUG}/assets/${RECIPE_SLUG}-3.webp`]: [1672, 941],
  [`thumbnail/${RECIPE_SLUG}/assets/${RECIPE_SLUG}-4.webp`]: [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Sleep Theories pack is an authored, receipt-bound standalone source', async () => {
  const registry = await json(REGISTRY)
  for (const p of PACKS) {
    const packId = `com.storystudio.pack.${p.seg}.${p.slug}`
    const itemId = `com.storystudio.${p.seg}.${p.slug}`
    const record = registry.records.find(r => r.pack_id === packId && r.version === '1.0.0')
    assert.ok(record, `${packId} must be registered`)
    assert.equal(record.receipt_ref, RECEIPT)
    assert.equal(record.status, 'authored')
    assert.equal(record.kind, p.kind)
    assert.equal(record.item_id, itemId)
    assert.equal(record.item_ids, undefined)
    assert.equal(record.source_path, `content-packs/sleep-theories/${p.seg}/${p.slug}`)
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

test('the visual style is drawn, hard-edged, single-source and wet', async () => {
  const style = await json(join(ROOT, 'style/comic-pulp-mystery/content/visual-style.json'))
  assert.equal(style.name, 'Comic Pulp Mystery')
  assert.ok(style.compatible_formula_ids.includes(FORMULA_ID))
  // The five things the recipe sits on. A bible that stopped promising any of
  // them would silently break the cover this collection exists to make.
  assert.match(style.style_bible, /heavy black outline/i)
  assert.match(style.style_bible, /flat cel shading only/i)
  assert.match(style.style_bible, /one thing in the frame is glowing/i)
  assert.match(style.style_bible, /only true light source/i)
  assert.match(style.style_bible, /rain falls as long straight streaks/i)
  assert.match(style.style_bible, /lightning/i)
  // Teal and orange is the whole palette contract, and it is what makes the
  // banner and the tag readable at card size.
  assert.match(style.style_bible, /cold teal/i)
  assert.match(style.style_bible, /hot orange/i)
  for (const rejected of ['photoreal', 'pastel palette', 'flat explainer vector', 'daylight', 'readable lettering']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the visual style declares three previews — hero, empty scene, and hardest case', async () => {
  const doc = await json(join(ROOT, 'style/comic-pulp-mystery/content/visual-style.json'))
  assert.deepEqual(doc.preview_assets, [
    'assets/comic-pulp-mystery-hero.webp',
    'assets/comic-pulp-mystery-scene.webp',
    'assets/comic-pulp-mystery-face.webp',
  ], 'the style declares the three-preview set the owner asked for')
})

test('the recipe fixes a banner, an investigator and one tagged object', async () => {
  const recipe = await json(join(ROOT, `thumbnail/${RECIPE_SLUG}/content/thumbnail-recipe.json`))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.equal(recipe.default_text_position, 'top', 'the banner runs across the top')
  assert.equal(recipe.preview_assets.length, 4)
  assert.ok(recipe.compatible_formula_ids.includes(FORMULA_ID))
  // The three fixed places, stated in the guidance AND as hard rules, because
  // the recurrence of the frame is the entire product.
  assert.match(recipe.composition_guidance, /The banner\./)
  assert.match(recipe.composition_guidance, /The investigator\./)
  assert.match(recipe.composition_guidance, /The object\./)
  assert.ok(recipe.composition_rules.some(rule => /full-width band across the very top/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /right third only/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /left third and is the only light source/i.test(rule)))
  // The investigator recurs by DESCRIPTION, not by a reference image: the app
  // has no image-to-image path here and the recipe must not imply one.
  assert.ok(recipe.composition_rules.some(rule => /from the written description each time rather than from a reference image/i.test(rule)))
  assert.match(recipe.composition_guidance, /trench coat with the collar turned up/i)
  // Exactly one tag, and nothing else in the frame.
  assert.ok(recipe.composition_rules.some(rule => /Exactly one small yellow tag label/i.test(rule)))
  assert.ok(recipe.required_elements.some(entry => /full-width banner across the top/i.test(entry)))
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
  // A mystery channel is not a shock channel: gore is refused by name, and so
  // is anything that would make a real person or agency identifiable.
  assert.ok(recipe.avoid_elements.some(entry => /gore/i.test(entry)))
  assert.ok(recipe.avoid_elements.some(entry => /recognisable individual/i.test(entry)))
  // The banner is the only wordmark-shaped thing allowed anywhere.
  assert.ok(recipe.avoid_elements.some(entry => /beyond the banner itself/i.test(entry)))
  assert.match(recipe.headline_guidance, /series name for this episode/i)
  assert.match(recipe.headline_guidance, /Never a question mark/i)
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/mysteries-and-cover-ups/content/topic-pack.json'))
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
})

test('the topic pack separates the case from the claims, in prose and in rules', async () => {
  const doc = await json(join(ROOT, 'topic/mysteries-and-cover-ups/content/topic-pack.json'))
  // The one promise this pack is sold on. If it leaves the prompt context the
  // pack becomes a conspiracy generator, which is precisely what it is not.
  assert.match(doc.prompt_context, /the case, and then the claims/i)
  assert.match(doc.prompt_context, /Never state a claim as fact/i)
  assert.match(doc.prompt_context, /give the answer plainly and early/i)
  // It is still a sleep pack.
  assert.match(doc.prompt_context, /no hook, no question to the listener, no promise, no cliffhanger/i)
  assert.match(doc.prompt_context, /Invent nothing/i)
  // The Royal History exclusions model, plus the two this subject forces: no
  // living private individual, and no suspect named in an open matter.
  for (const shape of [/No claim is ever stated as fact/i, /invented quotations/i,
    /No living private individual/i, /No suspect is named in an unresolved matter/i,
    /No hooks, cliffhangers/i, /No modern political analogy/i, /self-contained/i,
    /No verdict passed on a person/i, /without checking whether it has since been explained/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  // An absent record is an absence, not a proof — the one epistemic rule that
  // keeps this pack honest across all fifty subjects.
  assert.ok(doc.evidence_expectations.some(entry => /an absence, never a proof/i.test(entry)))
  assert.ok(doc.compatibility_rules.some(rule => /promises a revelation/i.test(rule)))
})

test('no topic line is shared with any other authored collection', async () => {
  const FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']
  const linesOf = doc => new Set(FIELDS.flatMap(field => doc[field] ?? []))
  const mine = linesOf(await json(join(ROOT, 'topic/mysteries-and-cover-ups/content/topic-pack.json')))
  assert.ok(mine.size > 3000, 'the pack contributes its own authored lines')
  for (const [collection, slug] of [
    ['royal-history', 'rulers-and-dynasties'],
    ['lost-voyage', 'lost-voyages'],
    ['golden-epic', 'empires-and-civilisations-entire'],
    ['midnight-archives', 'the-real-story-is-worse'],
    ['timeless-dreams', 'legends-across-every-civilisation'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    const shared = [...mine].filter(line => other.has(line))
    assert.deepEqual(shared, [], `no line may be shared with ${collection}`)
  }
})

test('every declared preview is named by the provenance record, and any that exists meets the contract', async () => {
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
    if (!await exists(path)) continue
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

test('the provenance record states why nothing was generated and how to generate it', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'sleep-theories-previews-1',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
})

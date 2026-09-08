/**
 * The Gory Cartoon History collection — four standalone packs authored
 * 2026-09-08 for an obscure-history list channel that runs at two speeds: a
 * nine-to-fourteen-minute listicle, and a two-to-three-hour compilation built
 * from the same self-contained entries. One reservation batch (revision 220),
 * one receipt, four lifecycle promotions (revisions 223-226).
 *
 * Two of the four declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and no owner authorisation
 * was given for this pass. Nothing was fabricated and nothing was stubbed, so
 * this file pins the honest state instead: every declared preview path is named
 * by the collection's PREVIEW-PROVENANCE.md, and any preview byte that HAS
 * landed must meet the contract. The day the previews are rendered, the
 * assertions below start checking them without being edited.
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

const ROOT = join(process.cwd(), 'content-packs/gory-cartoon-history')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:b5fc5512341b93a9acd2859d2e69dccb599c626e5d138b71d8c21b7f680e5c14'
const LISTICLE_FORMULA = 'com.storystudio.formula.counted-explainer'
const ROLE_FORMULA = 'com.storystudio.formula.pov-your-life-as'
const SLEEP_FORMULA = 'com.storystudio.formula.sleep-history-compilation'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'bold-gory-cartoon', docs: ['visual-style.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'banner-triptych', docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'obscure-history-horrors', docs: ['topic-pack.json'] },
  {
    kind: 'metadata-formula',
    seg: 'metadata-formula',
    slug: 'obscure-history-listicle-titles',
    docs: ['obscure-history-listicle-titles.json'],
    multi: true,
  },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/bold-gory-cartoon/assets/bold-gory-cartoon-hero.webp': [1672, 941],
  'style/bold-gory-cartoon/assets/bold-gory-cartoon-scene.webp': [1672, 941],
  'style/bold-gory-cartoon/assets/bold-gory-cartoon-face.webp': [1672, 941],
  'thumbnail/banner-triptych/assets/banner-triptych-1.webp': [1672, 941],
  'thumbnail/banner-triptych/assets/banner-triptych-2.webp': [1672, 941],
  'thumbnail/banner-triptych/assets/banner-triptych-3.webp': [1672, 941],
  'thumbnail/banner-triptych/assets/banner-triptych-4.webp': [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Gory Cartoon History pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/gory-cartoon-history/${p.seg}/${p.slug}`)
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

test('the visual style is outline-first, flat, hard-shadowed and funny rather than horrible', async () => {
  const style = await json(join(ROOT, 'style/bold-gory-cartoon/content/visual-style.json'))
  assert.equal(style.name, 'Bold Gory Cartoon')
  assert.deepEqual(style.compatible_formula_ids, [LISTICLE_FORMULA, ROLE_FORMULA])
  // The five traits the recipe sits on. A bible that stopped promising any of
  // them would silently break the three-panel frame this collection is for.
  assert.match(style.style_bible, /thick black outline of even, confident weight/i)
  assert.match(style.style_bible, /flat saturated colour, one hue per surface/i)
  assert.match(style.style_bible, /a single hard cel shadow per object/i)
  assert.match(style.style_bible, /exactly one subject per panel/i)
  assert.match(style.style_bible, /plain flat field of a single colour/i)
  // Expression is the product. So is the promise that the gore is a prop.
  assert.match(style.style_bible, /this look lives on expression/i)
  assert.match(style.style_bible, /cartoon props, not wounds/i)
  assert.match(style.style_bible, /Nothing in this style hurts/i)
  for (const rejected of ['photoreal', 'soft painterly', 'pastel palette', 'chibi', 'realistic gore',
    'readable lettering', 'smooth gradient shading']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the visual style declares three previews — hero, empty scene, and hardest case', async () => {
  const doc = await json(join(ROOT, 'style/bold-gory-cartoon/content/visual-style.json'))
  assert.deepEqual(doc.preview_assets, [
    'assets/bold-gory-cartoon-hero.webp',
    'assets/bold-gory-cartoon-scene.webp',
    'assets/bold-gory-cartoon-face.webp',
  ], 'the style declares the three-preview set the owner asked for')
})

test('the recipe fixes a white banner over three equal panels, with a timeline variant', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/banner-triptych/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'annotated-collage')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.equal(recipe.default_text_position, 'top', 'the banner runs across the top')
  assert.equal(recipe.preview_assets.length, 4)
  assert.deepEqual(recipe.compatible_formula_ids, [LISTICLE_FORMULA, ROLE_FORMULA])
  // The two fixed parts, stated in the guidance AND as hard rules, because the
  // recurrence of the frame is the entire product.
  assert.match(recipe.composition_guidance, /The banner\./)
  assert.match(recipe.composition_guidance, /The triptych\./)
  assert.match(recipe.composition_guidance, /The variant\./)
  assert.ok(recipe.composition_rules.some(rule => /filled solid white and cut with a thick dark outline/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /three vertical panels of exactly equal width/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /exactly one subject on a plain flat backdrop/i.test(rule)))
  // Co-equal panels: this recipe has no hero and no centre anchor, which is the
  // one thing an "annotated-collage" layout could otherwise be read as implying.
  assert.ok(recipe.composition_rules.some(rule => /no panel is larger, brighter, closer or more central/i.test(rule)))
  assert.ok(recipe.avoid_elements.some(entry => /A hero panel, a centre anchor/i.test(entry)))
  // The Timeline Bar variant, exactly as the owner specified it: red bar, three
  // markers, an ancient date, a middle era, and the present.
  assert.ok(recipe.composition_rules.some(rule =>
    /straight red horizontal bar runs the full width beneath the panels/i.test(rule)
    && /an ancient date, a middle era, and the present/i.test(rule)))
  assert.match(recipe.headline_guidance, /two or three words in capitals, and no more/i)
  assert.match(recipe.headline_guidance, /an ancient date, a middle era, and the present/i)
  assert.match(recipe.headline_guidance, /no question mark, no exclamation, no countdown numeral/i)
  // The default font style is the shipped Bold Outline Pop lettering shape,
  // named in prose because a dotted identifier is not permitted in pack text.
  assert.match(recipe.default_font_style, /extra-heavy geometric sans-serif capitals wearing a thick contrasting outline/i)
  assert.match(recipe.default_font_style, /Bold Outline Pop/)
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
  // A grim-history channel is not a shock channel.
  assert.ok(recipe.avoid_elements.some(entry => /Realistic injury/i.test(entry)))
  assert.ok(recipe.avoid_elements.some(entry => /recognisable living individual/i.test(entry)))
})

test('the default font style matches the shipped Bold Outline Pop lettering phrase', async () => {
  // The recipe was authored to default to an EXISTING lettering style rather
  // than to invent a new one, so this pins the two together: if the shipped
  // lettering phrase is ever rewritten, this fails and the recipe gets updated
  // with it instead of silently drifting.
  const lettering = await json(join(process.cwd(),
    'content-packs/paid/lettering/explainer/content/bold-outline-pop.json'))
  assert.equal(lettering.name, 'Bold Outline Pop')
  const recipe = await json(join(ROOT, 'thumbnail/banner-triptych/content/thumbnail-recipe.json'))
  for (const fragment of ['extra-heavy geometric sans-serif letterforms', 'thick contrasting outline',
    'closed compact counters', 'tight even spacing', 'maximum weight and clarity']) {
    assert.ok(lettering.phrase.includes(fragment), `the shipped lettering phrase still says "${fragment}"`)
  }
  assert.match(recipe.default_font_style, /closed compact counters, tight even spacing, maximum weight and clarity/)
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/obscure-history-horrors/content/topic-pack.json'))
  assert.deepEqual(doc.compatible_formula_ids, [LISTICLE_FORMULA, ROLE_FORMULA, SLEEP_FORMULA])
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

test('the topic pack is grim without being cruel, and works at both runtimes', async () => {
  const doc = await json(join(ROOT, 'topic/obscure-history-horrors/content/topic-pack.json'))
  // The promise the pack is sold on: every entry has to survive being read in
  // ninety seconds and being read for an hour.
  assert.match(doc.prompt_context, /Every entry must work at both of this pack's two speeds/i)
  assert.match(doc.prompt_context, /never on tension, atmosphere or a raised voice/i)
  // The tone rule that keeps a grim subject sellable.
  assert.match(doc.prompt_context, /told without relish/i)
  assert.match(doc.prompt_context, /no entry is written to\nmake a listener wince|no entry is written to make a listener wince/i)
  assert.match(doc.prompt_context, /the belief is the subject/i)
  assert.match(doc.prompt_context, /give the\ncorrection plainly and early|give the correction plainly and early/i)
  assert.match(doc.prompt_context, /Invent nothing/i)
  for (const shape of [/No dwelling on suffering/i, /invented quotations/i,
    /No living private individual/i, /No third-party characters/i,
    /No hooks, cliffhangers/i, /No modern political analogy/i, /self-contained/i,
    /No entry describes a folkloric creature as though it were established fact/i,
    /No entry is left at the myth/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  assert.ok(doc.evidence_expectations.some(entry => /not as a claim about the world|not as a claim/i.test(entry))
    || doc.evidence_expectations.some(entry => /a belief with a documented distribution/i.test(entry)))
  assert.ok(doc.compatibility_rules.some(rule => /promises a worst entry/i.test(rule)))
  // The two runtimes are declared as an axis, not left implied.
  const modes = doc.idea_axes.find(axis => axis.id === 'runtime-mode')
  assert.ok(modes, 'the pack declares its two runtime modes')
  assert.equal(modes.values.length, 2)
  assert.ok(modes.values.some(v => /short list mode/i.test(v)))
  assert.ok(modes.values.some(v => /sleep compilation mode/i.test(v)))
})

test('the metadata formula fixes three title shapes and both runtime modes', async () => {
  const doc = await json(join(ROOT,
    'metadata-formula/obscure-history-listicle-titles/content/obscure-history-listicle-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  // The three patterns the owner specified, verbatim.
  assert.match(doc.title_plan.guidance, /<Adjective> <Things> You've Never Heard Of/)
  assert.match(doc.title_plan.guidance, /The <Superlative> <Things> In History/)
  assert.match(doc.title_plan.guidance, /Your Life \(And Death\) as <Role>/)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  // Both runtimes, expressed as modes rather than as one range.
  assert.match(runtime.instruction, /nine to fourteen minutes/)
  assert.match(runtime.instruction, /one hundred and twenty to one hundred and eighty minutes/)
  assert.match(runtime.instruction, /which of the two modes this episode is in/)
  const listening = doc.description_plan.sections.find(section => section.id === 'listening')
  assert.match(listening.instruction, /In short list mode/)
  assert.match(listening.instruction, /In sleep compilation mode/)
  // The optional podcast note emits nothing when the story context is silent.
  const repost = doc.description_plan.sections.find(section => section.id === 'repost')
  assert.ok(repost, 'the formula carries the optional repost note')
  assert.match(repost.instruction, /only when/i)
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  assert.ok(doc.tone.constraints.some(entry => /No hook, no cliffhanger/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never name a living person/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never dwell on suffering/i.test(entry)))
  // A built-in formula shares this id namespace, so a pack must never take one.
  const builtinDirectory = join(process.cwd(), 'electron', 'server', 'metadata-formulas')
  const builtinIds = await Promise.all(
    (await readdir(builtinDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => (await json(join(builtinDirectory, name))).id),
  )
  assert.ok(!builtinIds.includes(doc.id), `${doc.id} shadows a built-in`)
})

test('no topic line is shared with any other authored collection', async () => {
  const FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']
  const linesOf = doc => new Set(FIELDS.flatMap(field => doc[field] ?? []))
  const mine = linesOf(await json(join(ROOT, 'topic/obscure-history-horrors/content/topic-pack.json')))
  assert.ok(mine.size > 4000, 'the pack contributes its own authored lines')
  for (const [collection, slug] of [
    ['baroque-myth', 'gods-heroes-and-epics'],
    ['royal-history', 'rulers-and-dynasties'],
    ['lost-voyage', 'lost-voyages'],
    ['golden-epic', 'empires-and-civilisations-entire'],
    ['midnight-archives', 'the-real-story-is-worse'],
    ['timeless-dreams', 'legends-across-every-civilisation'],
    ['sleep-theories', 'mysteries-and-cover-ups'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    const shared = [...mine].filter(line => other.has(line))
    assert.deepEqual(shared, [], `no line may be shared with ${collection}`)
  }
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
    const digest = createHash('sha256').update(buf).digest('hex')
    assert.ok(provenance.includes(digest), `provenance must record the digest of ${rel}`)
    assert.ok(provenance.includes(`${buf.byteLength}`), `provenance must record the byte count of ${rel}`)
  }
})

test('the provenance record states why nothing was generated, how to generate it, and what to refuse', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'gory-cartoon-history-previews-1',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The acceptance rules this collection needs: original subjects, spelled
  // text, and gore that is a prop rather than an injury.
  assert.match(provenance, /Original subjects only/)
  assert.match(provenance, /must be rejected rather than committed/)
  assert.match(provenance, /reads as an injury rather than as a joke/)
  assert.match(provenance, /spelled exactly as written/)
  // One run id, and its body stays inside the seven-prompt ceiling.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
  assert.ok(prompts.length <= 7, 'a single run id carries at most seven prompts')
  const bodies = provenance.match(/^> .+$/gm) ?? []
  assert.equal(bodies.length, prompts.length, 'every prompt has exactly one body')
  assert.ok(Buffer.byteLength(JSON.stringify(bodies)) < 16 * 1024, 'the request body stays under the 16 KiB cap')
})

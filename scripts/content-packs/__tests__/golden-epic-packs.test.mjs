/**
 * The Golden Epic collection — five standalone packs authored 2026-09-08 for a
 * sleep-history channel that tells the ENTIRE story of one civilisation or one
 * life in a single two-to-three-and-a-half-hour sitting. One reservation batch
 * (revision 171), one receipt, five lifecycle promotions (revisions 172-176).
 *
 * Three of the five declare preview assets that DO NOT EXIST YET: this control
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

const ROOT = join(process.cwd(), 'content-packs/golden-epic')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:4fbb5e51237a152e732888baf06ecaafefd195cfbd844e37c393a73650b2ea39'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'golden-epic-poster', docs: ['visual-style.json'] },
  { kind: 'lettering-style', seg: 'lettering', slug: 'bevelled-gold-cinematic-serif', docs: ['bevelled-gold-cinematic-serif.json'], multi: true },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'regalia-portrait-title-quadrant', docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'empires-and-civilisations-entire', docs: ['topic-pack.json'] },
  { kind: 'metadata-formula', seg: 'metadata-formula', slug: 'entire-story-titles', docs: ['entire-story-titles.json'], multi: true },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/golden-epic-poster/assets/golden-epic-poster-hero.webp': [1672, 941],
  'style/golden-epic-poster/assets/golden-epic-poster-scene.webp': [1672, 941],
  'style/golden-epic-poster/assets/golden-epic-poster-face.webp': [1672, 941],
  'lettering/bevelled-gold-cinematic-serif/assets/bevelled-gold-cinematic-serif.webp': [1024, 576],
  'thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-1.webp': [1672, 941],
  'thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-2.webp': [1672, 941],
  'thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-3.webp': [1672, 941],
  'thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-4.webp': [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Golden Epic pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/golden-epic/${p.seg}/${p.slug}`)
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

test('the visual style is one poster look: regalia figure, whole civilisation, sunset gold', async () => {
  const style = await json(join(ROOT, 'style/golden-epic-poster/content/visual-style.json'))
  assert.equal(style.name, 'Golden Epic Poster')
  assert.ok(style.compatible_formula_ids.includes(FORMULA_ID))
  // The four things the thumbnail recipe's title quadrant and side split sit on.
  // A style bible that stopped promising them would silently break the recipe.
  assert.match(style.style_bible, /three-quarter length/i)
  assert.match(style.style_bible, /whole civilisation/i)
  assert.match(style.style_bible, /sunset/i)
  assert.match(style.style_bible, /volumetric haze/i)
  assert.match(style.style_bible, /gold, amber, bronze and deep crimson/i)
  // "Everything sharp" is the detail contract; depth comes from haze, not blur.
  assert.match(style.style_bible, /sharp/i)
  assert.match(style.style_bible, /rather than by softening or by blur/i)
  // The quiet opposite quadrant is what the title lands on.
  assert.match(style.style_bible, /opposite upper quadrant/i)
  for (const rejected of ['flat colour', 'cartoon', 'photograph', 'muted grey palette', 'modern objects']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
  // A poster style that allowed readable lettering would fight the recipe,
  // which draws the title itself.
  assert.match(style.negative_prompt, /readable lettering/i)
})

test('the visual style declares three previews — hero, empty scene, and hardest case', async () => {
  const doc = await json(join(ROOT, 'style/golden-epic-poster/content/visual-style.json'))
  assert.deepEqual(doc.preview_assets, [
    'assets/golden-epic-poster-hero.webp',
    'assets/golden-epic-poster-scene.webp',
    'assets/golden-epic-poster-face.webp',
  ], 'the style declares the three-preview set the owner asked for')
})

test('the lettering style ships a phrase, an axis, and one swatch', async () => {
  const doc = await json(join(ROOT, 'lettering/bevelled-gold-cinematic-serif/content/bevelled-gold-cinematic-serif.json'))
  assert.equal(doc.axis, 'font')
  assert.match(doc.phrase, /bevelled metallic gold serif capitals/i)
  assert.ok(doc.phrase.length <= 600, 'the phrase fits the schema bound')
  // The tagline rule IS the product here, because the image model draws both
  // lines; a phrase that dropped it would leave the recipe with no second line.
  assert.match(doc.phrase, /chrome edge/i)
  assert.match(doc.phrase, /small capitals/i)
  assert.match(doc.phrase, /two thin gold rules/i)
  // One to four swatches is the schema bound; this collection ships one.
  assert.deepEqual(doc.preview_assets, ['assets/bevelled-gold-cinematic-serif.webp'])
})

test('the thumbnail recipe alternates the portrait side and titles the opposite quadrant', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/regalia-portrait-title-quadrant/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.equal(recipe.default_text_position, 'top')
  assert.equal(recipe.preview_assets.length, 4)
  assert.ok(recipe.compatible_formula_ids.includes(FORMULA_ID))
  // The recipe references the Bevelled Gold letterform by its own phrase, so a
  // reader who owns neither pack still knows what the title looks like.
  const lettering = await json(join(ROOT, 'lettering/bevelled-gold-cinematic-serif/content/bevelled-gold-cinematic-serif.json'))
  assert.equal(recipe.default_font_style, lettering.phrase)
  // Alternation is the whole point: a channel row of these must not read as one
  // repeated image, and it is stated in the guidance AND in a hard rule.
  assert.match(recipe.composition_guidance, /alternate it left and right/i)
  assert.ok(recipe.composition_rules.some(rule => /alternates left and right/i.test(rule)))
  // Subject name plus tagline, exactly two lines, everywhere the recipe says it.
  assert.ok(recipe.composition_rules.some(rule => /exactly two lines/i.test(rule)))
  assert.match(recipe.headline_guidance, /two lines/i)
  assert.match(recipe.headline_guidance, /tagline/i)
  assert.ok(recipe.avoid_elements.some(entry => /third line of copy/i.test(entry)))
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/empires-and-civilisations-entire/content/topic-pack.json'))
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
  // Named subjects are the product here, so the exclusions follow the Royal
  // History model: police fabrication and living people rather than forbid
  // names, and refuse the two things a whole-arc history is most tempted by —
  // a verdict on a civilisation, and a destiny that explains its collapse.
  for (const shape of [/invented quotations/i, /living memory/i, /no verdict/i, /modern political analogy/i, /destined to rise or doomed to fall/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  // The format promise: one sitting, whole arc, never split.
  assert.ok(doc.exclusions.some(entry => /never split the arc/i.test(entry)))
  // The three promises the channel is built on: the whole arc in one sitting,
  // a sleep register, and no invention.
  assert.match(doc.prompt_context, /entire story/i)
  assert.match(doc.prompt_context, /drifting toward sleep/i)
  assert.match(doc.prompt_context, /invent nobody/i)
})

test('the metadata formula fixes the ENTIRE-story title shape and a hookless tone', async () => {
  const doc = await json(join(ROOT, 'metadata-formula/entire-story-titles/content/entire-story-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  assert.match(doc.title_plan.guidance, /Fall Asleep to the ENTIRE Story of <Subject> — <Tagline>/)
  // The three tagline styles the owner specified.
  assert.match(doc.title_plan.guidance, /the years the arc spans/i)
  assert.match(doc.title_plan.guidance, /The Empire That/)
  assert.match(doc.title_plan.guidance, /The Conqueror Who/)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  assert.match(runtime.instruction, /one hundred and twenty to two hundred and ten minutes/)
  // The podcast repost note is optional by construction: it emits nothing when
  // the story context does not say the episode was reposted as audio.
  const repost = doc.description_plan.sections.find(section => section.id === 'repost')
  assert.ok(repost, 'the formula carries the optional repost note')
  assert.match(repost.instruction, /only when/i)
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  assert.ok(doc.tone.constraints.some(entry => /no hook/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never name a living person/i.test(entry)))
  // The whole-arc promise has to survive into the write-up, not just the title.
  assert.ok(doc.tone.constraints.some(entry => /never split the story/i.test(entry)))
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
    'golden-epic-previews-1',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // Eight prompts, one per declared preview, prepared so the render is one step.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
})

/**
 * 1.0.1 of the Entire Story Titles formula, authored 2026-09-08 alongside the
 * Gory Cartoon History and Baroque Myth collections. Its own reservation batch
 * (revision 226), its own receipt, one lifecycle promotion (revision 234).
 *
 * The version exists for exactly one reason: some entire-story episodes run to
 * seven hours, and 1.0.0's write-up told the narrator to target a hundred and
 * twenty to two hundred and ten minutes. The runtime guidance is widened to a
 * hundred and twenty to four hundred and twenty, and the one description line
 * that repeated the old span is widened with it so the two cannot disagree.
 * Everything else is byte-identical, and the test below is what keeps it so.
 */
test('the widened Entire Story Titles version is registered as a sibling of 1.0.0', async () => {
  const registry = await json(REGISTRY)
  const packId = 'com.storystudio.pack.metadata-formula.entire-story-titles'
  const itemId = 'com.storystudio.metadata-formula.entire-story-titles'
  const base = registry.records.find(r => r.pack_id === packId && r.version === '1.0.0')
  const next = registry.records.find(r => r.pack_id === packId && r.version === '1.0.1')
  assert.ok(next, '1.0.1 must be registered')
  assert.equal(next.receipt_ref, 'authoring:44d6de9234c80a0b3243cf36074305faa1278f5f4ab1db25d59d169fcdc01b22')
  assert.equal(next.status, 'authored')
  assert.equal(next.kind, 'metadata-formula')
  assert.deepEqual(next.item_ids, [itemId])
  assert.equal(next.source_path, 'content-packs/golden-epic/metadata-formula/entire-story-titles-v1.0.1')
  assert.deepEqual(next.dependencies, [])
  // A new version keeps the lineage: same item set, same family, same SKU.
  assert.deepEqual(next.stocking_proposal, base.stocking_proposal)

  const manifest = await json(join(ROOT, 'metadata-formula/entire-story-titles-v1.0.1/pack.json'))
  assert.equal(manifest.version, '1.0.1')
  assert.equal(manifest.pack_id, packId)
  assert.equal(manifest.key_id, '{{KEY_ID}}')
  assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
  assert.match(manifest.changelog, /four hundred and twenty minutes/)
})

test('1.0.1 widens the runtime guidance to seven hours and changes nothing else', async () => {
  const before = await json(join(ROOT, 'metadata-formula/entire-story-titles/content/entire-story-titles.json'))
  const after = await json(join(ROOT, 'metadata-formula/entire-story-titles-v1.0.1/content/entire-story-titles.json'))

  // The widening itself.
  const beforeRuntime = before.description_plan.sections.find(s => s.id === 'runtime')
  const afterRuntime = after.description_plan.sections.find(s => s.id === 'runtime')
  assert.match(beforeRuntime.instruction, /one hundred and twenty to two hundred and ten minutes/)
  assert.match(afterRuntime.instruction, /one hundred and twenty to four hundred and twenty minutes/)
  assert.doesNotMatch(afterRuntime.instruction, /two hundred and ten/)
  // The description repeated the old span; it is widened with it, because a
  // formula that promises three and a half hours and instructs seven is broken.
  assert.match(before.description, /two to three and a half hours/)
  assert.match(after.description, /two hours to seven/)
  assert.doesNotMatch(after.description, /three and a half hours/)

  // Everything else is identical, field for field.
  assert.deepEqual(
    { ...after, description: null, description_plan: null },
    { ...before, description: null, description_plan: null },
    '1.0.1 changes only the description and the description plan',
  )
  const strip = plan => ({ ...plan, sections: plan.sections.map(s => s.id === 'runtime' ? { ...s, instruction: null } : s) })
  assert.deepEqual(strip(after.description_plan), strip(before.description_plan),
    'inside the description plan, only the runtime instruction changed')
})

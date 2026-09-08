/**
 * The Royal History collection — eight standalone packs authored 2026-09-08 for a
 * royal-biography sleep-history channel system. One reservation batch (revision 162),
 * one receipt, eight lifecycle promotions (revisions 163-170).
 *
 * Six of the eight declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and no owner authorisation
 * was given for this pass. Nothing was fabricated and nothing was stubbed, so
 * this file pins the honest state instead: every declared preview path is named
 * by the collection's PREVIEW-PROVENANCE.md, and any preview byte that HAS
 * landed must meet the contract. The day the previews are rendered, the
 * assertions below start checking them without being edited.
 *
 * New with this collection, by the owner's rule of 2026-09-08: a Visual Style
 * declares THREE previews — hero, a quiet wide scene with no figure, and the
 * hardest case the style can be asked for — rather than the single preview
 * every earlier collection shipped. The count is asserted below so a later
 * edit cannot quietly drop back to one.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/royal-history')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:6331568506a93d6ab6ec41e1639f99fc2eb6b5873c450163ac7888654f1475cc'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'dark-regal-portrait', docs: ['visual-style.json'] },
  { kind: 'visual-style', seg: 'style', slug: 'academic-classical-oil', docs: ['visual-style.json'] },
  { kind: 'lettering-style', seg: 'lettering', slug: 'roman-two-tone-capitals', docs: ['roman-two-tone-capitals.json'], multi: true },
  { kind: 'lettering-style', seg: 'lettering', slug: 'condensed-regal-serif', docs: ['condensed-regal-serif.json'], multi: true },
  { kind: 'lettering-style', seg: 'lettering', slug: 'heavy-grotesque-hook', docs: ['heavy-grotesque-hook.json'], multi: true },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'two-tone-hook-portrait-right', docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'rulers-and-dynasties', docs: ['topic-pack.json'] },
  { kind: 'metadata-formula', seg: 'metadata-formula', slug: 'documentary-for-sleep-titles', docs: ['documentary-for-sleep-titles.json'], multi: true },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/dark-regal-portrait/assets/dark-regal-portrait-hero.webp': [1672, 941],
  'style/dark-regal-portrait/assets/dark-regal-portrait-scene.webp': [1672, 941],
  'style/dark-regal-portrait/assets/dark-regal-portrait-face.webp': [1672, 941],
  'style/academic-classical-oil/assets/academic-classical-oil-hero.webp': [1672, 941],
  'style/academic-classical-oil/assets/academic-classical-oil-scene.webp': [1672, 941],
  'style/academic-classical-oil/assets/academic-classical-oil-face.webp': [1672, 941],
  'lettering/roman-two-tone-capitals/assets/roman-two-tone-capitals.webp': [1024, 576],
  'lettering/condensed-regal-serif/assets/condensed-regal-serif.webp': [1024, 576],
  'lettering/heavy-grotesque-hook/assets/heavy-grotesque-hook.webp': [1024, 576],
  'thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-1.webp': [1672, 941],
  'thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-2.webp': [1672, 941],
  'thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-3.webp': [1672, 941],
  'thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-4.webp': [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Royal History pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/royal-history/${p.seg}/${p.slug}`)
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

test('the two visual styles are one cover look and one low-stimulation scene look', async () => {
  const cover = await json(join(ROOT, 'style/dark-regal-portrait/content/visual-style.json'))
  assert.equal(cover.name, 'Dark Regal Portrait')
  assert.ok(cover.compatible_formula_ids.includes(FORMULA_ID))
  // The unlit ground and the off-centre head are what the thumbnail recipe's
  // hook column sits on; a style bible that stopped promising them would
  // silently break the recipe.
  assert.match(cover.style_bible, /single warm source/i)
  assert.match(cover.style_bible, /gold rim/i)
  assert.match(cover.style_bible, /off-centre/i)
  assert.match(cover.style_bible, /chest height/i)
  assert.match(cover.negative_prompt, /bright daylight/i)
  assert.match(cover.negative_prompt, /flat vector/i)
  assert.match(cover.negative_prompt, /anime/i)

  const scene = await json(join(ROOT, 'style/academic-classical-oil/content/visual-style.json'))
  assert.equal(scene.name, 'Academic Classical Oil')
  assert.ok(scene.compatible_formula_ids.includes(FORMULA_ID))
  // Low stimulation is the whole product for in-video sleep scenes.
  assert.match(scene.style_bible, /low stimulation/i)
  assert.match(scene.style_bible, /marble/i)
  assert.match(scene.style_bible, /golden-hour|late in the day/i)
  for (const rejected of ['action', 'gore', 'modern objects', 'saturated neon', 'close-up faces']) {
    assert.ok(scene.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
  assert.notEqual(cover.style_bible, scene.style_bible)
})

test('each visual style declares three previews — hero, empty scene, and hardest case', async () => {
  for (const slug of ['dark-regal-portrait', 'academic-classical-oil']) {
    const doc = await json(join(ROOT, 'style', slug, 'content/visual-style.json'))
    assert.deepEqual(doc.preview_assets, [
      `assets/${slug}-hero.webp`,
      `assets/${slug}-scene.webp`,
      `assets/${slug}-face.webp`,
    ], `${slug} declares the three-preview set the owner asked for`)
  }
})

test('the three lettering styles ship a phrase, an axis, and a swatch each', async () => {
  const expected = [
    ['roman-two-tone-capitals', 'font', /inscriptional capitals/i],
    ['condensed-regal-serif', 'font', /condensed serif capitals/i],
    ['heavy-grotesque-hook', 'font', /grotesque capitals/i],
  ]
  for (const [slug, axis, phraseShape] of expected) {
    const doc = await json(join(ROOT, 'lettering', slug, 'content', `${slug}.json`))
    assert.equal(doc.axis, axis)
    assert.match(doc.phrase, phraseShape)
    assert.ok(doc.phrase.length <= 600, `${slug} phrase fits the schema bound`)
    // One to four swatches is the schema bound; this collection ships one each.
    assert.deepEqual(doc.preview_assets, [`assets/${slug}.webp`])
  }
  // The two-tone letterforms each carry their colour split in the phrase itself,
  // because that split IS the product and the image model draws the letters.
  const roman = await json(join(ROOT, 'lettering/roman-two-tone-capitals/content/roman-two-tone-capitals.json'))
  assert.match(roman.phrase, /ink black/i)
  assert.match(roman.phrase, /oxide red/i)
  const regal = await json(join(ROOT, 'lettering/condensed-regal-serif/content/condensed-regal-serif.json'))
  assert.match(regal.phrase, /bone white/i)
  assert.match(regal.phrase, /aged gold/i)
})

test('the thumbnail recipe puts a two-word hook bottom-left and one portrait right', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/two-tone-hook-portrait-right/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.equal(recipe.default_text_position, 'bottom-left')
  assert.equal(recipe.preview_assets.length, 4)
  assert.ok(recipe.compatible_formula_ids.includes(FORMULA_ID))
  // The recipe references the Condensed Regal Serif letterform by its own phrase,
  // so a reader who owns neither pack still knows what the hook looks like.
  const lettering = await json(join(ROOT, 'lettering/condensed-regal-serif/content/condensed-regal-serif.json'))
  assert.equal(recipe.default_font_style, lettering.phrase)
  // Both variants live in one recipe; the schema carries one composition.
  assert.match(recipe.composition_guidance, /Variant A/)
  assert.match(recipe.composition_guidance, /Variant B/)
  // The hook is two words and two colours, everywhere the recipe states it.
  assert.ok(recipe.composition_rules.some(rule => /two words/i.test(rule)))
  assert.match(recipe.headline_guidance, /exactly two words/i)
  assert.ok(recipe.avoid_elements.some(entry => /longer than two words/i.test(entry)))
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/rulers-and-dynasties/content/topic-pack.json'))
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
  // The sleep contract, and the one thing that separates this pack from the
  // maritime one: names ARE the product here, so the exclusions have to police
  // fabrication and living people instead of forbidding names outright.
  for (const shape of [/hook/i, /invented quotations/i, /living people/i, /modern political analogy/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  assert.match(doc.prompt_context, /drifting toward sleep/i)
  assert.match(doc.prompt_context, /invent nobody/i)
})

test('the metadata formula fixes one three-part title shape and a hookless tone', async () => {
  const doc = await json(join(ROOT, 'metadata-formula/documentary-for-sleep-titles/content/documentary-for-sleep-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  assert.match(doc.title_plan.guidance, /<Name> \| <Epithet> Documentary \| <Era> History/)
  assert.match(doc.title_plan.guidance, /era tag rotates/i)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  assert.match(runtime.instruction, /sixty to one hundred and thirty minutes/)
  // The podcast repost note is optional by construction: it emits nothing when
  // the story context does not say the episode was reposted as audio.
  const repost = doc.description_plan.sections.find(section => section.id === 'repost')
  assert.ok(repost, 'the formula carries the optional repost note')
  assert.match(repost.instruction, /only when/i)
  assert.match(repost.instruction, /emit nothing at all/i)
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  assert.ok(doc.tone.constraints.some(entry => /no hook/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never name a living person/i.test(entry)))
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
    'royal-history-previews-1',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // Thirteen prompts, one per declared preview, prepared so the render is one step.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
})

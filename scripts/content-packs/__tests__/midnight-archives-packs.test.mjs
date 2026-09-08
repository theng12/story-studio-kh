/**
 * The Midnight Archives collection — eight standalone packs authored 2026-09-08
 * for a dark-history channel that is deliberately NOT a sleep channel: every
 * episode opens by contradicting what a viewer already believes, runs 35-95
 * minutes, and settles the contradiction inside itself. One reservation batch
 * (revision 177), one receipt, eight lifecycle promotions (revisions 178-185).
 *
 * Six of the eight declare preview assets. They did not exist when this file
 * was first written — this control Mac does not perform production image
 * generation, and no owner authorisation had been given — so nothing was
 * fabricated and nothing was stubbed. The authorisation arrived on 2026-09-08
 * and all thirteen were rendered by two Image Pool jobs, `bae07584` (prompts
 * 1-7) and `3eb8e9eb` (prompts 8-13), split because a single request exceeded
 * a body cap since fixed. All thirteen are now present, so the assertions below
 * require every declared preview to exist, to decode to its contract, and to
 * carry its own digest and byte count in PREVIEW-PROVENANCE.md. A preview that
 * goes missing now fails the suite instead of being skipped.
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

const ROOT = join(process.cwd(), 'content-packs/midnight-archives')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:bb7efb1511b882c7e01a8056c912ddf099fc4f1bbdaf0fa61dc7dea9889cf389'
const FORMULA_ID = 'com.storystudio.formula.history-explained'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'gothic-candlelight-portrait', docs: ['visual-style.json'] },
  { kind: 'visual-style', seg: 'style', slug: 'inked-crosshatch-storybook', docs: ['visual-style.json'] },
  { kind: 'lettering-style', seg: 'lettering', slug: 'red-glow-serif-capitals', docs: ['red-glow-serif-capitals.json'], multi: true },
  { kind: 'lettering-style', seg: 'lettering', slug: 'distressed-pale-serif', docs: ['distressed-pale-serif.json'], multi: true },
  { kind: 'lettering-style', seg: 'lettering', slug: 'dripping-paint-finish', docs: ['dripping-paint-finish.json'], multi: true },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'hook-left-frightened-face-right', docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'the-real-story-is-worse', docs: ['topic-pack.json'] },
  { kind: 'metadata-formula', seg: 'metadata-formula', slug: 'contrarian-reveal-titles', docs: ['contrarian-reveal-titles.json'], multi: true },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/gothic-candlelight-portrait/assets/gothic-candlelight-portrait-hero.webp': [1672, 941],
  'style/gothic-candlelight-portrait/assets/gothic-candlelight-portrait-scene.webp': [1672, 941],
  'style/gothic-candlelight-portrait/assets/gothic-candlelight-portrait-face.webp': [1672, 941],
  'style/inked-crosshatch-storybook/assets/inked-crosshatch-storybook-hero.webp': [1672, 941],
  'style/inked-crosshatch-storybook/assets/inked-crosshatch-storybook-scene.webp': [1672, 941],
  'style/inked-crosshatch-storybook/assets/inked-crosshatch-storybook-face.webp': [1672, 941],
  'lettering/red-glow-serif-capitals/assets/red-glow-serif-capitals.webp': [1024, 576],
  'lettering/distressed-pale-serif/assets/distressed-pale-serif.webp': [1024, 576],
  'lettering/dripping-paint-finish/assets/dripping-paint-finish.webp': [1024, 576],
  'thumbnail/hook-left-frightened-face-right/assets/hook-left-frightened-face-right-1.webp': [1672, 941],
  'thumbnail/hook-left-frightened-face-right/assets/hook-left-frightened-face-right-2.webp': [1672, 941],
  'thumbnail/hook-left-frightened-face-right/assets/hook-left-frightened-face-right-3.webp': [1672, 941],
  'thumbnail/hook-left-frightened-face-right/assets/hook-left-frightened-face-right-4.webp': [1672, 941],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Midnight Archives pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/midnight-archives/${p.seg}/${p.slug}`)
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

test('the cover style is one close face, one flame, amber on teal, over ink', async () => {
  const style = await json(join(ROOT, 'style/gothic-candlelight-portrait/content/visual-style.json'))
  assert.equal(style.name, 'Gothic Candlelight Portrait')
  assert.ok(style.compatible_formula_ids.includes(FORMULA_ID))
  // The five things the recipe's variant A sits on. A style bible that stopped
  // promising any of them would silently break the hook cover.
  assert.match(style.style_bible, /one face and one face only/i)
  assert.match(style.style_bible, /extreme state rather than at rest/i)
  assert.match(style.style_bible, /exactly one source/i)
  assert.match(style.style_bible, /cold teal/i)
  assert.match(style.style_bible, /ink texture/i)
  // The unlit opposite half is what the hook lands on.
  assert.match(style.style_bible, /unlit ground/i)
  for (const rejected of ['daylight', 'calm expression', 'photograph', 'neon', 'readable lettering']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the scene style is line-first, hatched, single-source, and cheap-model tolerant', async () => {
  const style = await json(join(ROOT, 'style/inked-crosshatch-storybook/content/visual-style.json'))
  assert.equal(style.name, 'Inked Crosshatch Storybook')
  assert.ok(style.compatible_formula_ids.includes(FORMULA_ID))
  assert.match(style.style_bible, /cross-hatch/i)
  assert.match(style.style_bible, /engraved graphic novel/i)
  assert.match(style.style_bible, /dark teal/i)
  assert.match(style.style_bible, /amber/i)
  assert.match(style.style_bible, /one source inside the scene/i)
  // The whole point of shipping a second style: it has to survive a cheaper
  // image model. If that promise leaves the bible, the pack loses its reason.
  assert.match(style.style_bible, /lower-fidelity/i)
  assert.match(style.style_bible, /line-first/i)
  for (const rejected of ['photoreal', 'soft airbrush', 'saturated colour', 'readable lettering']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('both visual styles declare three previews — hero, empty scene, and hardest case', async () => {
  for (const slug of ['gothic-candlelight-portrait', 'inked-crosshatch-storybook']) {
    const doc = await json(join(ROOT, `style/${slug}/content/visual-style.json`))
    assert.deepEqual(doc.preview_assets, [
      `assets/${slug}-hero.webp`,
      `assets/${slug}-scene.webp`,
      `assets/${slug}-face.webp`,
    ], `${slug} declares the three-preview set the owner asked for`)
  }
})

test('the three lettering styles ship a phrase, an axis, and one swatch each', async () => {
  const expected = [
    ['red-glow-serif-capitals', 'font', [/serif capitals/i, /deep blood red/i, /red glow/i, /distressed/i]],
    ['distressed-pale-serif', 'font', [/serif capitals/i, /blue-white/i, /distressed/i, /faintest cool glow/i]],
    ['dripping-paint-finish', 'text', [/wet paint/i, /single flat colour/i, /leaving the baseline/i]],
  ]
  for (const [slug, axis, shapes] of expected) {
    const doc = await json(join(ROOT, `lettering/${slug}/content/${slug}.json`))
    assert.equal(doc.axis, axis, `${slug} joins the ${axis} picker`)
    assert.ok(doc.phrase.length <= 600, `${slug} phrase fits the schema bound`)
    for (const shape of shapes) assert.match(doc.phrase, shape, `${slug} phrase must state ${shape}`)
    // One to four swatches is the schema bound; this collection ships one each.
    assert.deepEqual(doc.preview_assets, [`assets/${slug}.webp`])
  }
})

test('the recipe ships two variants, a three-to-five-word hook, and no furniture', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/hook-left-frightened-face-right/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  // `curiosity-hook` is the schema's name for the contrarian-hook slot; the
  // contrarian part is spelled out in the guidance, which is where it belongs.
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.match(recipe.headline_guidance, /contrarian hook of three to five words/i)
  assert.match(recipe.headline_guidance, /contradicts what the viewer already believes/i)
  assert.equal(recipe.preview_assets.length, 4)
  assert.ok(recipe.compatible_formula_ids.includes(FORMULA_ID))
  // The recipe quotes the Red-Glow letterform by its own phrase, so a reader
  // who owns neither pack still knows what the hook looks like.
  const lettering = await json(join(ROOT, 'lettering/red-glow-serif-capitals/content/red-glow-serif-capitals.json'))
  assert.equal(recipe.default_font_style, lettering.phrase)
  // Variant A and variant B, stated in the guidance AND in a hard rule.
  assert.match(recipe.composition_guidance, /Variant A, the hook cover/)
  assert.match(recipe.composition_guidance, /Variant B, the scene cover/)
  assert.ok(recipe.composition_rules.some(rule => /Exactly one variant per image/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /three to five words/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /alternates between the top and the bottom/i.test(rule)))
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
  // This is a hook channel, not a shock channel: gore is refused by name.
  assert.ok(recipe.avoid_elements.some(entry => /gore/i.test(entry)))
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/the-real-story-is-worse/content/topic-pack.json'))
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
  // names. Three are this format's own — a hook channel must pay its hooks,
  // must not call something a fraud it cannot attribute, and must not reach
  // for gore now that its subject matter finally allows it to.
  for (const shape of [/invented quotations/i, /living memory/i, /No verdict/i, /modern political analogy/i,
    /No gratuitous gore/i, /Pay every hook/i, /unless the episode can say who made it/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  // The three promises this channel is built on: contradiction first, awake
  // rather than asleep, and no invention.
  assert.match(doc.prompt_context, /shows what the record actually says/i)
  assert.match(doc.prompt_context, /not a sleep channel/i)
  assert.match(doc.prompt_context, /invent nobody/i)
})

test('no topic line is shared with the other named-subject collections', async () => {
  const FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']
  const linesOf = doc => new Set(FIELDS.flatMap(field => doc[field] ?? []))
  const mine = linesOf(await json(join(ROOT, 'topic/the-real-story-is-worse/content/topic-pack.json')))
  assert.ok(mine.size > 3000, 'the pack contributes its own authored lines')
  for (const [collection, slug] of [
    ['royal-history', 'rulers-and-dynasties'],
    ['lost-voyage', 'lost-voyages'],
    ['golden-epic', 'empires-and-civilisations-entire'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    const shared = [...mine].filter(line => other.has(line))
    assert.deepEqual(shared, [], `no line may be shared with ${collection}`)
  }
})

test('the metadata formula fixes three contrarian title shapes and a 35-95 minute runtime', async () => {
  const doc = await json(join(ROOT, 'metadata-formula/contrarian-reveal-titles/content/contrarian-reveal-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  // The three patterns the owner specified, verbatim.
  assert.match(doc.title_plan.guidance, /<Subject> Was Never <Familiar Claim> \| The Real Story Is Worse/)
  assert.match(doc.title_plan.guidance, /The Real <Subject> Was Not <Familiar Claim>/)
  assert.match(doc.title_plan.guidance, /They <Did This> Then <Erased It>/)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  assert.match(runtime.instruction, /thirty-five and ninety-five minutes/)
  // The series label is a shipped feature, not a stray phrase in a paragraph.
  const series = doc.description_plan.sections.find(section => section.id === 'series')
  assert.ok(series, 'the formula carries the series note')
  assert.equal(series.header.text, 'The Was Never series')
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  // Hook-forward is the tone, and the hook has to be paid — both stated.
  assert.ok(doc.tone.constraints.some(entry => /Lead with the contradiction/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /Pay the hook/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /Never name a living person/i.test(entry)))
  // A built-in formula shares this id namespace, so a pack must never take one.
  const builtinDirectory = join(process.cwd(), 'electron', 'server', 'metadata-formulas')
  const builtinIds = await Promise.all(
    (await readdir(builtinDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => (await json(join(builtinDirectory, name))).id),
  )
  assert.ok(!builtinIds.includes(doc.id), `${doc.id} shadows a built-in`)
})

test('every declared preview exists, meets the contract, and carries its byte evidence in the provenance record', async () => {
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
    assert.ok(await exists(path), `${rel} must exist: all thirteen previews landed on 2026-09-08`)
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

test('the provenance record states why the render was held, how it was run, and which two jobs ran it', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'midnight-archives-previews-1',
    'midnight-archives-previews-1b',
    'gpt-image-2',
    'bae07584',
    '3eb8e9eb',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // Thirteen prompts, one per declared preview, prepared so the render is one step.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
})

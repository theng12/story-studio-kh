/**
 * The Backyard Naturalist collection — five standalone packs authored
 * 2026-09-09 for a calm nature channel about the creatures and plants that live
 * around an ordinary house. One reservation batch (revision 268), one receipt,
 * five lifecycle promotions (revisions 273-277).
 *
 * Two of the five declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and the owner authorisation
 * of 2026-09-08 named that day's run ids rather than this pass. Nothing was
 * fabricated and nothing was stubbed, so this file pins the honest state
 * instead: every declared preview path is named by the collection's
 * PREVIEW-PROVENANCE.md, and any preview byte that HAS landed must meet the
 * contract.
 *
 * The two Topic Packs are the bulk of the collection and are held to the house
 * standard — fifty subjects, twenty slots each, a thousand complete tuples with
 * no line repeated inside a pack, between the two packs, or against any other
 * authored collection.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/backyard-naturalist')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:ba18b05fa0d75b1140ae48eacb398d3aa71357d9369e29e0834d7d0b170d8c27'
const SLEEP_FORMULA = 'com.storystudio.formula.sleep-history-compilation'
const WILDLIFE_FORMULA = 'com.storystudio.formula.natural-world-explained'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'naturalist-sketchbook', docs: ['visual-style.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'sketch-and-marker-note', docs: ['thumbnail-recipe.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'backyard-creatures', docs: ['topic-pack.json'] },
  { kind: 'topic-pack', seg: 'topic', slug: 'backyard-plants', docs: ['topic-pack.json'] },
  {
    kind: 'metadata-formula',
    seg: 'metadata-formula',
    slug: 'backyard-sleep-titles',
    docs: ['backyard-sleep-titles.json'],
    multi: true,
  },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/naturalist-sketchbook/assets/naturalist-sketchbook-hero.webp': [1672, 941],
  'style/naturalist-sketchbook/assets/naturalist-sketchbook-scene.webp': [1672, 941],
  'style/naturalist-sketchbook/assets/naturalist-sketchbook-face.webp': [1672, 941],
  'thumbnail/sketch-and-marker-note/assets/sketch-and-marker-note-1.webp': [1672, 941],
  'thumbnail/sketch-and-marker-note/assets/sketch-and-marker-note-2.webp': [1672, 941],
  'thumbnail/sketch-and-marker-note/assets/sketch-and-marker-note-3.webp': [1672, 941],
  'thumbnail/sketch-and-marker-note/assets/sketch-and-marker-note-4.webp': [1672, 941],
}

const TOPIC_FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }
const linesOf = doc => new Set(TOPIC_FIELDS.flatMap(field => doc[field] ?? []))

test('every Backyard Naturalist pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/backyard-naturalist/${p.seg}/${p.slug}`)
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

test('the visual style is cross-hatched, high-key, accurate, and one specimen at a time', async () => {
  const style = await json(join(ROOT, 'style/naturalist-sketchbook/content/visual-style.json'))
  assert.equal(style.name, 'Naturalist Sketchbook')
  assert.deepEqual(style.compatible_formula_ids, [SLEEP_FORMULA, WILDLIFE_FORMULA])
  // The six traits the recipe sits on. Losing any one turns this into an
  // ordinary ink illustration, which is what the negative prompt refuses.
  assert.match(style.style_bible, /Shading is built entirely from fine cross-hatching/i)
  assert.match(style.style_bible, /one light warm wash/i)
  assert.match(style.style_bible, /bright cream paper/i)
  assert.match(style.style_bible, /exactly one creature or one plant per page/i)
  assert.match(style.style_bible, /Anatomy is scientifically accurate/i)
  assert.match(style.style_bible, /at least half the frame carries nothing at all/i)
  // High-key is the load-bearing instruction: this look fails the moment it is
  // allowed to reach for a lamp or a dark ground.
  assert.match(style.style_bible, /This look is high-key throughout/i)
  assert.match(style.style_bible, /no dim room, no lamplight, no candle, no dusk, no vignette and no dark ground/i)
  // The comic touch is bounded rather than open-ended.
  assert.match(style.style_bible, /never more than once per page/i)
  assert.match(style.style_bible, /it never distorts the creature's anatomy/i)
  for (const rejected of ['dim lighting', 'lamplight', 'heavy ink wash', 'photoreal', 'distorted anatomy', 'text']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the visual style declares three previews — hero, empty page, and hardest case', async () => {
  const doc = await json(join(ROOT, 'style/naturalist-sketchbook/content/visual-style.json'))
  assert.deepEqual(doc.preview_assets, [
    'assets/naturalist-sketchbook-hero.webp',
    'assets/naturalist-sketchbook-scene.webp',
    'assets/naturalist-sketchbook-face.webp',
  ], 'the style declares the three-preview set the owner asked for')
})

test('the recipe fixes a left subject, a right marker note, and one arrow between them', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/sketch-and-marker-note/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'curiosity-hook')
  assert.equal(recipe.default_text_position, 'center', 'the note sits at the subject\'s own height')
  assert.equal(recipe.preview_assets.length, 4)
  assert.deepEqual(recipe.compatible_formula_ids, [SLEEP_FORMULA, WILDLIFE_FORMULA])
  // The three fixed parts, stated in the guidance AND as hard rules, because
  // the recurrence of the frame is the entire product.
  assert.match(recipe.composition_guidance, /The page\./)
  assert.match(recipe.composition_guidance, /The subject\./)
  assert.match(recipe.composition_guidance, /The note\./)
  assert.match(recipe.composition_guidance, /The arrow\./)
  assert.ok(recipe.composition_rules.some(rule => /one sheet of bright cream paper across the whole frame/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /Exactly one subject is drawn, in the left half/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /two, three or four words in total/i.test(rule)))
  // The arrow is the recipe's one annotation, and it is bounded hard.
  assert.ok(recipe.composition_rules.some(rule =>
    /Exactly one hand-drawn arrow/i.test(rule) && /without touching or overlapping it/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /no second arrow, dotted trail, double head, circle, bracket or ring/i.test(rule)))
  // The empty third of the page is a rule, not a hope.
  assert.ok(recipe.composition_rules.some(rule => /At least a third of the frame is left as empty cream paper/i.test(rule)))
  assert.match(recipe.headline_guidance, /Write the note as two to four words and no more/i)
  assert.match(recipe.headline_guidance, /It is a note, not a headline/i)
  assert.match(recipe.headline_guidance, /never use a word about killing, danger or disgust/i)
  // The default font style is the shipped Marker Slab lettering shape, named in
  // prose because a dotted identifier is not permitted in pack text.
  assert.match(recipe.default_font_style, /fat chisel-tip marker letterforms/i)
  assert.match(recipe.default_font_style, /Marker Slab/)
  for (const forbidden of ['wordmark', 'badge', 'border']) {
    assert.ok(recipe.avoid_elements.some(entry => entry.toLowerCase().includes(forbidden)),
      `the recipe must refuse a ${forbidden}`)
  }
  // A channel asking viewers to like its subjects does not show them dead.
  assert.ok(recipe.avoid_elements.some(entry => /dead, pinned, squashed, injured or bleeding/i.test(entry)))
  assert.ok(recipe.avoid_elements.some(entry => /bare skin/i.test(entry)))
})

test('the recipe defaults to the shipped Marker Slab lettering phrase', async () => {
  // Both recipes in this batch default to an EXISTING lettering style rather
  // than inventing one, so this pins the two together: if the shipped lettering
  // phrase is ever rewritten, this fails and the recipe gets updated with it
  // instead of silently drifting.
  const lettering = await json(join(process.cwd(),
    'content-packs/paid/lettering/explainer/content/marker-slab.json'))
  assert.equal(lettering.name, 'Marker Slab')
  const recipe = await json(join(ROOT, 'thumbnail/sketch-and-marker-note/content/thumbnail-recipe.json'))
  for (const fragment of ['fat chisel-tip marker letterforms', 'single confident strokes',
    'blunt square stroke ends', 'slightly uneven thickness', 'heavy and immediate']) {
    assert.ok(lettering.phrase.includes(fragment), `the shipped lettering phrase still says "${fragment}"`)
  }
  assert.match(recipe.default_font_style, /blunt square stroke ends, slightly uneven thickness, heavy and immediate/)
})

for (const slug of ['backyard-creatures', 'backyard-plants']) {
  test(`the ${slug} pack sells 1,000 authored assignments at the house standard`, async () => {
    const doc = await json(join(ROOT, `topic/${slug}/content/topic-pack.json`))
    assert.deepEqual(doc.compatible_formula_ids, [SLEEP_FORMULA, WILDLIFE_FORMULA])
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
    // The flat arrays are the profiles flattened in order; a drifting pair
    // would silently give the planner lines no chapter can be built from.
    for (const [array, key] of [['episode_objects', 'episode_object'], ['time_place_scopes', 'time_place_scope'],
      ['mechanisms', 'mechanism'], ['evidence_lenses', 'evidence_lens']]) {
      assert.deepEqual(doc[array], doc.coverage_profiles.flatMap(p => p.tuples.map(t => t[key])),
        `${array} must be the coverage profiles flattened in order`)
      assert.equal(new Set(doc[array]).size, 1000, `${array} carries a thousand distinct authored lines`)
    }
    assert.ok(linesOf(doc).size > 4000, 'the pack contributes its own authored lines')
  })
}

test('both topic packs refuse to tell anyone to kill anything, and refuse to give advice', async () => {
  for (const slug of ['backyard-creatures', 'backyard-plants']) {
    const doc = await json(join(ROOT, `topic/${slug}/content/topic-pack.json`))
    // The promise the collection is sold on, and the two lines that keep it
    // from becoming either a pest-control channel or an unqualified adviser.
    assert.ok(doc.exclusions.some(entry => /No entry recommends killing, poisoning, trapping/i.test(entry)),
      `${slug} must refuse to recommend killing`)
    assert.ok(doc.exclusions.some(entry => /No medical, veterinary or pesticide advice/i.test(entry)),
      `${slug} must refuse to give advice`)
    assert.ok(doc.exclusions.some(entry => /vermin, filth, a plague, an enemy/i.test(entry)))
    assert.ok(doc.exclusions.some(entry => /No living private individual is named/i.test(entry)))
    assert.ok(doc.exclusions.some(entry => /No hooks, cliffhangers, teasers/i.test(entry)))
    assert.ok(doc.exclusions.some(entry => /written for someone falling asleep/i.test(entry)))
    // Honesty about the problem is what keeps the defence credible.
    assert.match(doc.prompt_context, /concede it fully and early/i)
    assert.match(doc.prompt_context, /A pack that only defends its subjects is not worth listening to/i)
    assert.match(doc.prompt_context, /This is a sleep compilation before it is anything else/i)
    assert.match(doc.prompt_context, /lost nothing they were promised/i)
    assert.ok(doc.evidence_expectations.some(entry => /describe source types rather than citing any specific title/i.test(entry)))
    assert.ok(doc.compatibility_rules.some(rule => /Do not pair with a formula that promises a reveal/i.test(rule)))
    // Both runtimes are declared as axes rather than left implied.
    const lens = doc.idea_axes.find(axis => axis.id === 'chapter-lens')
    const shape = doc.idea_axes.find(axis => axis.id === 'chapter-shape')
    assert.ok(lens && shape, `${slug} declares both idea axes`)
    assert.equal(lens.values.length, 8)
    assert.equal(shape.values.length, 5)
  }
})

test('the creature pack states risk honestly and the plant pack states hazard honestly', async () => {
  const creatures = await json(join(ROOT, 'topic/backyard-creatures/content/topic-pack.json'))
  assert.match(creatures.prompt_context, /Risk is stated once and honestly/i)
  assert.match(creatures.prompt_context, /give the real frequency and the real severity/i)
  assert.ok(creatures.exclusions.some(entry => /without the actual frequency behind it/i.test(entry)))

  const plants = await json(join(ROOT, 'topic/backyard-plants/content/topic-pack.json'))
  assert.match(plants.prompt_context, /Safety is stated once and exactly/i)
  assert.match(plants.prompt_context, /confused with a dangerous relative/i)
  assert.ok(plants.exclusions.some(entry => /No entry tells a listener that a plant is safe to eat/i.test(entry)))
  assert.ok(plants.exclusions.some(entry => /No entry names a herbicide, pesticide, fungicide/i.test(entry)))
})

test('the metadata formula fixes two title shapes and a ninety-to-one-hundred-and-thirty-minute runtime', async () => {
  const doc = await json(join(ROOT, 'metadata-formula/backyard-sleep-titles/content/backyard-sleep-titles.json'))
  assert.equal(doc.title_plan.mode, 'paraphrase')
  // The two patterns the owner specified, verbatim, punctuation included.
  assert.match(doc.title_plan.guidance, /The Secret Life of Your Backyard: <Subject> \| Sleep Nature/)
  assert.match(doc.title_plan.guidance, /Why You Should Never Kill <Creature> \(told slowly\)/)
  const sectionIds = doc.description_plan.sections.map(section => section.id)
  assert.equal(new Set(sectionIds).size, sectionIds.length, 'section ids are unique')
  assert.ok(sectionIds.includes('runtime'), 'the write-up states the runtime')
  const runtime = doc.description_plan.sections.find(section => section.id === 'runtime')
  assert.match(runtime.instruction, /ninety to one hundred and thirty minutes/)
  assert.match(runtime.instruction, /nothing is held back for a second part/)
  // The listening note is what makes it a sleep write-up rather than a summary.
  const listening = doc.description_plan.sections.find(section => section.id === 'listening')
  assert.match(listening.instruction, /no music sting, no scare, no raised voice/)
  assert.match(listening.instruction, /falls asleep in the first chapter has missed nothing/)
  // The optional "what to do instead" note emits nothing when it does not apply,
  // and never becomes advice when it does.
  const instead = doc.description_plan.sections.find(section => section.id === 'instead')
  assert.ok(instead, 'the formula carries the optional note on what to do instead')
  assert.match(instead.instruction, /only when/i)
  assert.match(instead.instruction, /Give no medical advice, name no product/)
  for (const section of doc.description_plan.sections) {
    if (section.header.render) assert.ok(section.header.text, `${section.id} declares its header text`)
    else assert.ok(!section.header.text, `${section.id} carries no header text it will never print`)
  }
  assert.ok(doc.tone.constraints.some(entry => /No hook, no cliffhanger/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /never recommend killing it/i.test(entry)))
  assert.ok(doc.tone.constraints.some(entry => /Give no medical, veterinary or pesticide advice/i.test(entry)))
  // A built-in formula shares this id namespace, so a pack must never take one.
  const builtinDirectory = join(process.cwd(), 'electron', 'server', 'metadata-formulas')
  const builtinIds = await Promise.all(
    (await readdir(builtinDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => (await json(join(builtinDirectory, name))).id),
  )
  assert.ok(!builtinIds.includes(doc.id), `${doc.id} shadows a built-in`)
})

test('no topic line is shared between the two packs or with any other authored collection', async () => {
  const creatures = linesOf(await json(join(ROOT, 'topic/backyard-creatures/content/topic-pack.json')))
  const plants = linesOf(await json(join(ROOT, 'topic/backyard-plants/content/topic-pack.json')))
  assert.deepEqual([...creatures].filter(line => plants.has(line)), [],
    'the two packs in this collection share no line')
  for (const [collection, slug] of [
    ['baroque-myth', 'gods-heroes-and-epics'],
    ['royal-history', 'rulers-and-dynasties'],
    ['lost-voyage', 'lost-voyages'],
    ['golden-epic', 'empires-and-civilisations-entire'],
    ['midnight-archives', 'the-real-story-is-worse'],
    ['timeless-dreams', 'legends-across-every-civilisation'],
    ['sleep-theories', 'mysteries-and-cover-ups'],
    ['gory-cartoon-history', 'obscure-history-horrors'],
    ['sleep-history', 'food-histories'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    for (const [name, mine] of [['backyard-creatures', creatures], ['backyard-plants', plants]]) {
      assert.deepEqual([...mine].filter(line => other.has(line)), [],
        `${name} may share no line with ${collection}`)
    }
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

test('the provenance record states why nothing was generated, how to generate it, and what to refuse', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'backyard-naturalist-previews-1',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The acceptance rules this collection needs: original subjects, correct
  // anatomy, living subjects, a bright page, and no people anywhere.
  assert.match(provenance, /Original subjects only/)
  assert.match(provenance, /must be rejected rather than committed/)
  assert.match(provenance, /no bare skin appears in any prompt/)
  assert.match(provenance, /Anatomy is the product here/)
  assert.match(provenance, /dim, lamplit, vignetted or set against a dark ground/)
  assert.match(provenance, /spelled exactly as written/)
  // One run id, and its body stays inside the seven-prompt ceiling.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
  assert.ok(prompts.length <= 7, 'a single run id carries at most seven prompts')
  const bodies = provenance.match(/^> .+$/gm) ?? []
  assert.equal(bodies.length, prompts.length, 'every prompt has exactly one body')
  assert.ok(Buffer.byteLength(JSON.stringify(bodies)) < 16 * 1024, 'the request body stays under the 16 KiB cap')
})

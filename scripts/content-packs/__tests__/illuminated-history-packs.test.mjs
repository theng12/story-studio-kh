/**
 * The Illuminated History collection — eight standalone packs authored
 * 2026-09-09 for a long-form history channel that tells one turning point or
 * one era entire, at sleep length. One reservation batch (registry revision
 * 278), one receipt, eight lifecycle promotions (revisions 279-286).
 *
 * Seven of the eight declare preview assets that DO NOT EXIST YET: this control
 * Mac does not perform production image generation, and the owner authorisation
 * of 2026-09-08 named that day's run ids rather than this pass. Nothing was
 * fabricated and nothing was stubbed, so this file pins the honest state
 * instead: every declared preview path is named by the collection's
 * PREVIEW-PROVENANCE.md, and any preview byte that HAS landed must meet the
 * contract.
 *
 * The three-preview rule for Visual Styles, the four-preview rule for Thumbnail
 * Recipes and the one-swatch rule for Lettering Styles, all set by the owner on
 * 2026-09-08, are asserted here so a later edit cannot quietly drop this
 * collection below them.
 *
 * The Topic Pack is the bulk of the collection and is held to the house
 * standard — fifty subjects, twenty slots each, a thousand complete tuples with
 * no line repeated inside the pack or against any other authored collection.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/illuminated-history')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:8c0987243c2527ee9b83e1eeb4d8d76a2ac4d6ec34044ec961ee293de83517d7'
const SLEEP_FORMULA = 'com.storystudio.formula.sleep-history-compilation'
const HISTORY_FORMULA = 'com.storystudio.formula.history-explained'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'visual-style', seg: 'style', slug: 'illuminated-frame-painting', docs: ['visual-style.json'] },
  { kind: 'visual-style', seg: 'style', slug: 'dark-sepia-documentary-scene', docs: ['visual-style.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'framed-subject-with-dates', docs: ['thumbnail-recipe.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'medallion-portrait', docs: ['thumbnail-recipe.json'] },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'numbered-series-card', docs: ['thumbnail-recipe.json'] },
  {
    kind: 'lettering-style',
    seg: 'lettering',
    slug: 'cream-condensed-serif-with-tagline',
    docs: ['cream-condensed-serif-with-tagline.json'],
    multi: true,
  },
  {
    kind: 'lettering-style',
    seg: 'lettering',
    slug: 'red-grunge-capitals',
    docs: ['red-grunge-capitals.json'],
    multi: true,
  },
  { kind: 'topic-pack', seg: 'topic', slug: 'turning-points-and-eras', docs: ['topic-pack.json'] },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'style/illuminated-frame-painting/assets/illuminated-frame-painting-hero.webp': [1672, 941],
  'style/illuminated-frame-painting/assets/illuminated-frame-painting-scene.webp': [1672, 941],
  'style/illuminated-frame-painting/assets/illuminated-frame-painting-face.webp': [1672, 941],
  'style/dark-sepia-documentary-scene/assets/dark-sepia-documentary-scene-hero.webp': [1672, 941],
  'style/dark-sepia-documentary-scene/assets/dark-sepia-documentary-scene-scene.webp': [1672, 941],
  'style/dark-sepia-documentary-scene/assets/dark-sepia-documentary-scene-hardest.webp': [1672, 941],
  'lettering/cream-condensed-serif-with-tagline/assets/cream-condensed-serif-with-tagline.webp': [1024, 576],
  'lettering/red-grunge-capitals/assets/red-grunge-capitals.webp': [1024, 576],
  'thumbnail/framed-subject-with-dates/assets/framed-subject-with-dates-1.webp': [1672, 941],
  'thumbnail/framed-subject-with-dates/assets/framed-subject-with-dates-2.webp': [1672, 941],
  'thumbnail/framed-subject-with-dates/assets/framed-subject-with-dates-3.webp': [1672, 941],
  'thumbnail/framed-subject-with-dates/assets/framed-subject-with-dates-4.webp': [1672, 941],
  'thumbnail/medallion-portrait/assets/medallion-portrait-1.webp': [1672, 941],
  'thumbnail/medallion-portrait/assets/medallion-portrait-2.webp': [1672, 941],
  'thumbnail/medallion-portrait/assets/medallion-portrait-3.webp': [1672, 941],
  'thumbnail/medallion-portrait/assets/medallion-portrait-4.webp': [1672, 941],
  'thumbnail/numbered-series-card/assets/numbered-series-card-1.webp': [1672, 941],
  'thumbnail/numbered-series-card/assets/numbered-series-card-2.webp': [1672, 941],
  'thumbnail/numbered-series-card/assets/numbered-series-card-3.webp': [1672, 941],
  'thumbnail/numbered-series-card/assets/numbered-series-card-4.webp': [1672, 941],
}

const TOPIC_FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }
const linesOf = doc => new Set(TOPIC_FIELDS.flatMap(field => doc[field] ?? []))

test('every Illuminated History pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/illuminated-history/${p.seg}/${p.slug}`)
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

test('the framed style is a picture inside a gold border, and never a border drawn on a picture', async () => {
  const style = await json(join(ROOT, 'style/illuminated-frame-painting/content/visual-style.json'))
  assert.equal(style.name, 'Illuminated Frame Painting')
  assert.deepEqual(style.compatible_formula_ids, [SLEEP_FORMULA, HISTORY_FORMULA])
  // The traits that make this a framed object rather than a decorated picture.
  assert.match(style.style_bible, /ornate gold filigree band runs the whole way round/i)
  assert.match(style.style_bible, /heavier gilt ornament at each of the four corners/i)
  assert.match(style.style_bible, /burnished metal leaf and not yellow paint/i)
  assert.match(style.style_bible, /border never overlaps the picture and the picture never spills over the border/i)
  assert.match(style.style_bible, /Deep and jewelled inside the frame/i)
  assert.match(style.style_bible, /craquelure/i)
  // No writing anywhere: the reference is to a page's ornament, not its script.
  assert.match(style.style_bible, /never to its writing/i)
  // Fully clothed figures, stated in the contract as well as in the prompts.
  assert.match(style.style_bible, /There is no nudity anywhere in this look/i)
  for (const rejected of ['flat vector', 'photograph', 'neon', 'modern objects', 'printed text']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the sepia style is one warm light, small distant figures, and no readable face', async () => {
  const style = await json(join(ROOT, 'style/dark-sepia-documentary-scene/content/visual-style.json'))
  assert.equal(style.name, 'Dark Sepia Documentary Scene')
  assert.deepEqual(style.compatible_formula_ids, [SLEEP_FORMULA, HISTORY_FORMULA])
  assert.match(style.style_bible, /Sepia and slate, and almost nothing else/i)
  assert.match(style.style_bible, /Exactly one warm source/i)
  assert.match(style.style_bible, /There is no fill, no rim light from behind, no second lamp/i)
  assert.match(style.style_bible, /the mist does the work of distance/i)
  assert.match(style.style_bible, /no face is ever legible/i)
  assert.match(style.style_bible, /there is no nudity anywhere in this look/i)
  for (const rejected of ['bright daylight', 'saturated colour', 'cartoon', 'close-up face', 'text']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('both visual styles declare three previews — hero, empty scene, and hardest case', async () => {
  const framed = await json(join(ROOT, 'style/illuminated-frame-painting/content/visual-style.json'))
  assert.deepEqual(framed.preview_assets, [
    'assets/illuminated-frame-painting-hero.webp',
    'assets/illuminated-frame-painting-scene.webp',
    'assets/illuminated-frame-painting-face.webp',
  ])
  const sepia = await json(join(ROOT, 'style/dark-sepia-documentary-scene/content/visual-style.json'))
  assert.deepEqual(sepia.preview_assets, [
    'assets/dark-sepia-documentary-scene-hero.webp',
    'assets/dark-sepia-documentary-scene-scene.webp',
    // NOT `-face`: this style refuses a readable face by name, so its hardest
    // case is a crowded interior lit by one hearth. Naming the file `-face`
    // would promise a preview the contract forbids.
    'assets/dark-sepia-documentary-scene-hardest.webp',
  ])
})

test('all three recipes are episode-title cards with four previews and no wordmark', async () => {
  for (const slug of ['framed-subject-with-dates', 'medallion-portrait', 'numbered-series-card']) {
    const recipe = await json(join(ROOT, `thumbnail/${slug}/content/thumbnail-recipe.json`))
    assert.equal(recipe.layout, 'hero')
    assert.equal(recipe.aspect_ratio, '16:9')
    assert.equal(recipe.title_mode, 'ai')
    assert.equal(recipe.headline_mode, 'episode-title', `${slug} carries the episode title, not a hook`)
    assert.equal(recipe.preview_assets.length, 4, `${slug} shows the fixed frame against four subjects`)
    assert.deepEqual(recipe.compatible_formula_ids, [SLEEP_FORMULA, HISTORY_FORMULA])
    assert.ok(recipe.avoid_elements.some(entry => /wordmark/i.test(entry)), `${slug} must refuse a wordmark`)
    assert.ok(recipe.avoid_elements.some(entry => /question mark/i.test(entry)), `${slug} must refuse a question mark`)
    assert.ok(recipe.avoid_elements.some(entry => /living person/i.test(entry)), `${slug} must refuse a living person`)
    assert.ok(recipe.avoid_elements.some(entry => /Post-render typography compositing/i.test(entry)))
    assert.match(recipe.headline_guidance, /Never a question/i)
  }
})

test('the framed recipe keeps the type off the frame and prints a real span of years', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/framed-subject-with-dates/content/thumbnail-recipe.json'))
  assert.equal(recipe.default_text_position, 'center')
  assert.match(recipe.composition_guidance, /The frame\./)
  assert.match(recipe.composition_guidance, /The title block\./)
  assert.match(recipe.composition_guidance, /The ground\./)
  assert.ok(recipe.composition_rules.some(rule => /Exactly one ornate gold frame appears/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /exactly three lines/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /two numbers and an en dash and nothing else/i.test(rule)))
  // The type never lands on the painting: that is the whole discipline of the card.
  assert.ok(recipe.composition_rules.some(rule => /No line of type ever crosses the frame/i.test(rule)))
  assert.ok(recipe.avoid_elements.some(entry => /Any line of type crossing the frame/i.test(entry)))
  // Honest dates: the narrower attested span rather than an invented precision.
  assert.match(recipe.headline_guidance, /rather than a rounded century/i)
  assert.match(recipe.headline_guidance, /choose the narrower of the two attested spans/i)
})

test('the medallion recipe is struck metal in strict profile, never a painted face', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/medallion-portrait/content/thumbnail-recipe.json'))
  assert.ok(recipe.composition_rules.some(rule => /struck metal in one colour/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /never painted, coloured or enamelled/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /strict profile facing left/i.test(rule)))
  // The cast shadow is what makes it an object rather than a drawn circle.
  assert.ok(recipe.composition_rules.some(rule => /reads as an object in front of a picture/i.test(rule)))
  // Exactly one face on the card, and it is on the coin.
  assert.ok(recipe.composition_rules.some(rule => /the medallion carries the only face on the card/i.test(rule)))
  assert.ok(recipe.avoid_elements.some(entry => /real currency/i.test(entry)))
  // No date line here — the years belong to the other two recipes.
  assert.match(recipe.headline_guidance, /Do not put years in this block/i)
})

test('the series card fixes a title band with parenthesised years and a wordless map', async () => {
  const recipe = await json(join(ROOT, 'thumbnail/numbered-series-card/content/thumbnail-recipe.json'))
  assert.equal(recipe.default_text_position, 'top')
  assert.ok(recipe.composition_rules.some(rule => /title band holding all the type/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /ordinary parentheses/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /no legible place name, no cartouche and no lettering of any kind/i.test(rule)))
  assert.ok(recipe.composition_rules.some(rule => /soft seam of shadow, cloth, sheet edge or mist/i.test(rule)))
  assert.ok(recipe.avoid_elements.some(entry => /Any word, place name, cartouche or legend printed on the map/i.test(entry)))
  assert.ok(recipe.avoid_elements.some(entry => /hard ruled line/i.test(entry)))
  // The series promise: parallel wording down the shelf, number inside the title.
  assert.match(recipe.headline_guidance, /never as a separate badge, bug or corner mark/i)
  assert.match(recipe.headline_guidance, /Keep the wording of every card in a series parallel/i)
})

test('both lettering styles are font-axis, one swatch each, and inside the phrase limit', async () => {
  const cream = await json(join(ROOT,
    'lettering/cream-condensed-serif-with-tagline/content/cream-condensed-serif-with-tagline.json'))
  assert.equal(cream.name, 'Cream Condensed Serif with Tagline')
  assert.equal(cream.axis, 'font')
  assert.deepEqual(cream.preview_assets, ['assets/cream-condensed-serif-with-tagline.webp'])
  assert.match(cream.phrase, /tall narrow condensed serif capitals/i)
  assert.match(cream.phrase, /hard dark drop shadow/i)
  assert.match(cream.phrase, /small capitals/i)

  const red = await json(join(ROOT, 'lettering/red-grunge-capitals/content/red-grunge-capitals.json'))
  assert.equal(red.name, 'Red Grunge Capitals')
  assert.equal(red.axis, 'font')
  assert.deepEqual(red.preview_assets, ['assets/red-grunge-capitals.webp'])
  assert.match(red.phrase, /deep oxide red/i)
  assert.match(red.phrase, /edges broken and ragged/i)
  assert.match(red.phrase, /spatter/i)

  // `phrase` is capped at 600 characters by the signed schema. Both sit under
  // it today; a rewrite that overran would fail the build rather than here, so
  // this is the early warning.
  for (const doc of [cream, red]) {
    assert.ok(doc.phrase.length <= 600, `${doc.name} phrase must stay inside the 600-character limit`)
  }
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/turning-points-and-eras/content/topic-pack.json'))
  assert.equal(doc.name, 'Turning Points and Eras')
  assert.deepEqual(doc.compatible_formula_ids, [SLEEP_FORMULA])
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
  for (const [array, key] of [['episode_objects', 'episode_object'], ['time_place_scopes', 'time_place_scope'],
    ['mechanisms', 'mechanism'], ['evidence_lenses', 'evidence_lens']]) {
    assert.deepEqual(doc[array], doc.coverage_profiles.flatMap(p => p.tuples.map(t => t[key])),
      `${array} must be the coverage profiles flattened in order`)
    assert.equal(new Set(doc[array]).size, 1000, `${array} carries a thousand distinct authored lines`)
  }
  assert.ok(linesOf(doc).size > 4000, 'the pack contributes its own authored lines')
  // Both runtimes are declared as axes rather than left implied.
  const lens = doc.idea_axes.find(axis => axis.id === 'chapter-lens')
  const shape = doc.idea_axes.find(axis => axis.id === 'chapter-shape')
  assert.ok(lens && shape, 'the pack declares both idea axes')
  assert.equal(lens.values.length, 8)
  assert.equal(shape.values.length, 5)
})

test('the topic pack passes no verdicts, invents no quotations, and draws no modern parallels', async () => {
  const doc = await json(join(ROOT, 'topic/turning-points-and-eras/content/topic-pack.json'))
  // The four exclusions the owner carried over from Royal History, verbatim in
  // substance: no invented quotes, nobody within living memory, no verdicts, no
  // modern political analogy.
  assert.ok(doc.exclusions.some(entry => /No invented quotations/i.test(entry)))
  assert.ok(doc.exclusions.some(entry => /nobody within living memory/i.test(entry)))
  assert.ok(doc.exclusions.some(entry => /No verdict passed on any person or party/i.test(entry)))
  assert.ok(doc.exclusions.some(entry => /No modern political analogy/i.test(entry)))
  assert.ok(doc.exclusions.some(entry => /No hooks, cliffhangers, countdowns/i.test(entry)))
  assert.ok(doc.exclusions.some(entry => /No dwelling on torture, execution, massacre/i.test(entry)))
  // Several of these subjects are famous through retellings the archives do not
  // support, so the pack has to say what it will do about that.
  assert.ok(doc.exclusions.some(entry => /where a familiar version comes from a later invention/i.test(entry)))
  assert.ok(doc.exclusions.some(entry => /No mockery of anybody who held a belief/i.test(entry)))
  assert.match(doc.prompt_context, /No verdict is passed on anybody in these stories/i)
  assert.match(doc.prompt_context, /how much of the familiar story rests on later invention/i)
  assert.match(doc.prompt_context, /This is a sleep compilation before it is anything else/i)
  assert.match(doc.prompt_context, /Invent nothing/)
  assert.ok(doc.evidence_expectations.some(entry => /describe record types rather than citing any specific title/i.test(entry)))
  assert.ok(doc.evidence_expectations.some(entry => /when the famous number has no surviving basis at all/i.test(entry)))
  assert.ok(doc.compatibility_rules.some(rule => /Draw the twenty slots of a subject in order/i.test(rule)))
  assert.ok(doc.compatibility_rules.some(rule => /Do not pair with any formula that opens on a hook/i.test(rule)))
})

test('no topic line is shared with any other authored collection', async () => {
  const mine = linesOf(await json(join(ROOT, 'topic/turning-points-and-eras/content/topic-pack.json')))
  for (const [collection, slug] of [
    ['royal-history', 'rulers-and-dynasties'],
    ['golden-epic', 'empires-and-civilisations-entire'],
    ['baroque-myth', 'gods-heroes-and-epics'],
    ['lost-voyage', 'lost-voyages'],
    ['midnight-archives', 'the-real-story-is-worse'],
    ['timeless-dreams', 'legends-across-every-civilisation'],
    ['sleep-theories', 'mysteries-and-cover-ups'],
    ['gory-cartoon-history', 'obscure-history-horrors'],
    ['sleep-history', 'food-histories'],
    ['sleep-history', 'everyday-object-histories'],
    ['backyard-naturalist', 'backyard-creatures'],
    ['backyard-naturalist', 'backyard-plants'],
    ['free-starters', 'historical-wars-treaties-world-order-v1.0.2'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    assert.deepEqual([...mine].filter(line => other.has(line)), [],
      `turning-points-and-eras may share no line with ${collection}/${slug}`)
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
    'illuminated-history-previews-1',
    'illuminated-history-previews-2',
    'illuminated-history-previews-3',
    'illuminated-history-previews-4',
    'gpt-image-2',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The acceptance rules this collection needs. The packs let an episode name a
  // real historical figure; the PREVIEWS must not, and this pins that split.
  assert.match(provenance, /Original subjects only/)
  assert.match(provenance, /must be rejected rather than committed/)
  assert.match(provenance, /no preview in this collection depicts, names or dates any real person/i)
  assert.match(provenance, /No nudity and no bare skin beyond faces and hands appears in any prompt/)
  assert.match(provenance, /No blood, no wound, no execution/)
  assert.match(provenance, /spelled exactly as written/)
  assert.match(provenance, /the map must carry no lettering at all/)
  // Four run ids, none of them over the seven-prompt ceiling, and each run's
  // body inside the 16 KiB cap that blocked the Midnight Archives batch.
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
  const bodies = provenance.match(/^> .+$/gm) ?? []
  assert.equal(bodies.length, prompts.length, 'every prompt has exactly one body')
  const runs = [bodies.slice(0, 7), bodies.slice(7, 12), bodies.slice(12, 16), bodies.slice(16, 20)]
  for (const [index, run] of runs.entries()) {
    assert.ok(run.length > 0 && run.length <= 7, `run ${index + 1} carries at most seven prompts`)
    assert.ok(Buffer.byteLength(JSON.stringify(run)) < 16 * 1024,
      `run ${index + 1} stays under the 16 KiB request cap`)
  }
  assert.equal(runs.reduce((total, run) => total + run.length, 0), bodies.length)
})

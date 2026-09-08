/**
 * The Timeless Dreams collection — two standalone packs authored 2026-09-08 for
 * a calm sleep compilation that walks ONE mythical being around the world: each
 * chapter is a single culture's version of it, and the comparison is left for
 * the listener to notice rather than announced. One reservation batch (revision
 * 186), one receipt, two lifecycle promotions (revisions 189-190).
 *
 * The lettering pack declares one preview. It did not exist when this file was
 * first written — this control Mac does not perform production image
 * generation, and no owner authorisation had been given — so nothing was
 * fabricated and nothing was stubbed. The authorisation arrived on 2026-09-08
 * and the swatch was rendered by Image Pool job `5f541ae9`. It is now present,
 * so the assertions below require it to exist, to decode to its contract, and
 * to carry its own digest and byte count in PREVIEW-PROVENANCE.md. A preview
 * that goes missing now fails the suite instead of being skipped.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/timeless-dreams')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:f6542ed393e3498de1d862ba66945c22f8c5359975b487e5a3ba6fbffdaca90d'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'

/** `multi` kinds are sold as an item SET, so the registry records `item_ids`. */
const PACKS = [
  { kind: 'topic-pack', seg: 'topic', slug: 'legends-across-every-civilisation', docs: ['topic-pack.json'] },
  { kind: 'lettering-style', seg: 'lettering', slug: 'ornate-fantasy-metal-serif', docs: ['ornate-fantasy-metal-serif.json'], multi: true },
]

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = {
  'lettering/ornate-fantasy-metal-serif/assets/ornate-fantasy-metal-serif.webp': [1024, 576],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Timeless Dreams pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/timeless-dreams/${p.seg}/${p.slug}`)
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

test('the lettering style ships a phrase, the font axis, and one swatch', async () => {
  const doc = await json(join(ROOT, 'lettering/ornate-fantasy-metal-serif/content/ornate-fantasy-metal-serif.json'))
  assert.equal(doc.name, 'Ornate Fantasy Metal Serif')
  assert.equal(doc.axis, 'font', 'it joins the letterform picker, not the treatment picker')
  assert.ok(doc.phrase.length <= 600, 'phrase fits the schema bound')
  // The five things the owner asked for, each stated in the phrase the prompt
  // builder injects verbatim. Losing any one of them changes the product.
  for (const shape of [/ornate serif capitals/i, /engraved metal/i, /gold and dark bronze/i,
    /scale-like grain/i, /curling flourishes/i, /letter-spaced small capitals/i, /thin horizontal rules/i]) {
    assert.match(doc.phrase, shape, `the phrase must state ${shape}`)
  }
  // A title face has to stay a title face: no effects the caption engine would
  // then have to fight.
  for (const shape of [/no drop shadow/i, /no outer glow/i, /no gradient wash/i]) {
    assert.match(doc.phrase, shape, `the phrase must refuse ${shape}`)
  }
  // One to four swatches is the schema bound; this collection ships one.
  assert.deepEqual(doc.preview_assets, ['assets/ornate-fantasy-metal-serif.webp'])
})

test('the topic pack sells 1,000 authored assignments at the house standard', async () => {
  const doc = await json(join(ROOT, 'topic/legends-across-every-civilisation/content/topic-pack.json'))
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

test('the topic pack is a sleep pack, and says so where it matters', async () => {
  const doc = await json(join(ROOT, 'topic/legends-across-every-civilisation/content/topic-pack.json'))
  // The three promises this compilation is built on: one being toured across
  // cultures, no hook of any kind, and nothing invented.
  assert.match(doc.prompt_context, /walks the same being around the world/i)
  assert.match(doc.prompt_context, /no hook, no question, no promise, no countdown, no cliffhanger/i)
  assert.match(doc.prompt_context, /Invent nothing/i)
  // Living traditions are the exposure this subject actually carries, so the
  // exclusions name restricted knowledge and refuse a verdict on belief. The
  // sleep-channel exclusions from Royal History carry over alongside them.
  for (const shape of [/restricted or initiated knowledge/i, /living religion/i, /No hooks, cliffhangers/i,
    /invented quotations/i, /No modern political analogy/i, /No living people are named/i,
    /self-contained/i, /No moralising/i]) {
    assert.ok(doc.exclusions.some(entry => shape.test(entry)), `exclusions must cover ${shape}`)
  }
  // A pack that says "no hooks" must not then be pairable with a hook formula.
  assert.ok(doc.compatibility_rules.some(rule => /opens on a hook/i.test(rule)))
})

test('no topic line is shared with any other authored collection', async () => {
  const FIELDS = ['subjects', 'episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']
  const linesOf = doc => new Set(FIELDS.flatMap(field => doc[field] ?? []))
  const mine = linesOf(await json(join(ROOT, 'topic/legends-across-every-civilisation/content/topic-pack.json')))
  assert.ok(mine.size > 3000, 'the pack contributes its own authored lines')
  for (const [collection, slug] of [
    ['royal-history', 'rulers-and-dynasties'],
    ['lost-voyage', 'lost-voyages'],
    ['golden-epic', 'empires-and-civilisations-entire'],
    ['midnight-archives', 'the-real-story-is-worse'],
    ['sleep-theories', 'mysteries-and-cover-ups'],
  ]) {
    const other = linesOf(await json(join(process.cwd(),
      `content-packs/${collection}/topic/${slug}/content/topic-pack.json`)))
    const shared = [...mine].filter(line => other.has(line))
    assert.deepEqual(shared, [], `no line may be shared with ${collection}`)
  }
})

test('every declared preview exists, meets the contract, and carries its byte evidence in the provenance record', async () => {
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
    assert.ok(await exists(path), `${rel} must exist: the swatch landed on 2026-09-08`)
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

test('the provenance record states why the render was held, how it was run, and which job ran it', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'timeless-dreams-previews-1',
    'gpt-image-2',
    '5f541ae9',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
})

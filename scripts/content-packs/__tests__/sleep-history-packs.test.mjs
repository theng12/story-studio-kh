import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

// Six standalone packs authored 2026-09-06 for the sleep-history compilation
// channel system. One reservation batch (revision 143), one receipt.
const ROOT = join(process.cwd(), 'content-packs/sleep-history')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const RECEIPT = 'authoring:6a7d2a107dacc5f4f3ba37f76913e0dcc7861459094d7eb7af7ebf0fcbb9a473'
const FORMULA_ID = 'com.storystudio.formula.sleep-history-compilation'

const PACKS = [
  { kind: 'series-formula', seg: 'formula', slug: 'sleep-history-compilation', doc: 'series-formula.json' },
  { kind: 'topic-pack', seg: 'topic', slug: 'food-histories', doc: 'topic-pack.json' },
  { kind: 'topic-pack', seg: 'topic', slug: 'drinks-and-spices-histories', doc: 'topic-pack.json' },
  { kind: 'topic-pack', seg: 'topic', slug: 'everyday-object-histories', doc: 'topic-pack.json' },
  { kind: 'visual-style', seg: 'style', slug: 'old-master-still-life', doc: 'visual-style.json' },
  { kind: 'thumbnail-recipe', seg: 'thumbnail', slug: 'period-portrait-serif-title', doc: 'thumbnail-recipe.json' },
]

const PREVIEWS = {
  'style/old-master-still-life/assets/old-master-still-life.webp': ['458a51449b2d0dda867e78bea53dfca6683472d80e866c9f274c5a62f2d2a970', 1451920],
  'thumbnail/period-portrait-serif-title/assets/period-portrait-serif-title-1.webp': ['667facc6fb129cbfa0059e7d943949052c79940d6c29454a5108abf25f0e905c', 1375338],
  'thumbnail/period-portrait-serif-title/assets/period-portrait-serif-title-2.webp': ['bd9ab6c143229d271bb5d54de5271b8e0ca8d65436d9ae2cd5f9d644991c896a', 1438258],
  'thumbnail/period-portrait-serif-title/assets/period-portrait-serif-title-3.webp': ['525e202c2607b575b920c2e4a6c8c9ae500da718e05081b5a1ba2c65c1b8847a', 1414078],
  'thumbnail/period-portrait-serif-title/assets/period-portrait-serif-title-4.webp': ['83b3afe278ce385416465bffe6522b85d51568637c3d141a1234c845cc283e79', 1433404],
  'thumbnail/period-portrait-serif-title/assets/period-portrait-serif-title-5.webp': ['66dbb3b2bdec42859554cd23f97405d082690e99e852c56854f3a88365330589', 1566560],
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }

test('every sleep-history pack is an authored, receipt-bound standalone source', async () => {
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
    assert.equal(record.source_path, `content-packs/sleep-history/${p.seg}/${p.slug}`)
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.bundle_id, undefined, 'no Channel Kit membership')
    const manifest = await json(join(ROOT, p.seg, p.slug, 'pack.json'))
    assert.deepEqual(manifest, {
      pack_format: 1, pack_id: packId, publisher_id: 'com.storystudio', key_id: '{{KEY_ID}}', version: '1.0.0',
      min_app_version: '{{MIN_APP_VERSION}}', lifecycle: 'active',
      entitlement: { sku: `com.storystudio.sku.${p.seg}.${p.slug}`, family: `com.storystudio.family.${p.seg}.${p.slug}` },
      dependencies: [],
    })
    assert.deepEqual(await readdir(join(ROOT, p.seg, p.slug, 'content')), [p.doc])
    const doc = await json(join(ROOT, p.seg, p.slug, 'content', p.doc))
    assert.equal(doc.kind, p.kind)
    assert.equal(doc.id, itemId)
    for (const [keyPath, value] of meaningfulStrings(doc)) {
      const mark = markIn(value)
      assert.equal(mark, undefined, `${packId} ${keyPath} carries a third-party mark`)
    }
  }
})

test('the formula is a long, calm, independent-chapter compilation', async () => {
  const doc = await json(join(ROOT, 'formula/sleep-history-compilation/content/series-formula.json'))
  const s = doc.script_structure
  assert.equal(s.chapters_independent, true)
  assert.deepEqual(s.chapter_count_range, [10, 20])
  assert.deepEqual(s.length_minutes_range, [90, 180])
  assert.equal(s.default_length_minutes, 150)
  assert.equal(s.default_words_per_minute, 120)
  assert.deepEqual(s.visual_pacing_profile, { opening_duration_sec: 600, opening: { min_sec: 8, max_sec: 15 }, settled: { min_sec: 40, max_sec: 60 } })
  assert.deepEqual(doc.compatible_topic_pack_ids.sort(), [
    'com.storystudio.topic.drinks-and-spices-histories', 'com.storystudio.topic.everyday-object-histories', 'com.storystudio.topic.food-histories',
  ])
  assert.ok(doc.recommended_visual_style_ids.includes('com.storystudio.style.old-master-still-life'))
  assert.equal(doc.default_thumbnail_recipe_id, 'com.storystudio.thumbnail.period-portrait-serif-title')
  assert.equal(doc.opening_profile.id, 'sleep-landing')
  for (const banned of ['cliffhanger', 'countdown']) assert.ok(doc.narrative_quality_contract.forbidden_patterns.includes(banned))
})

test('each topic pack sells 1,000 authored assignments at the house standard', async () => {
  for (const slug of ['food-histories', 'drinks-and-spices-histories', 'everyday-object-histories']) {
    const doc = await json(join(ROOT, 'topic', slug, 'content/topic-pack.json'))
    assert.deepEqual(doc.compatible_formula_ids, [FORMULA_ID])
    assert.equal(doc.subjects.length, 50, `${slug} subjects`)
    assert.equal(doc.max_siblings_per_subject, 20)
    assert.equal(doc.coverage_profiles.length, 50, `${slug} profiles`)
    assert.deepEqual(doc.coverage_profiles.map(p => p.subject), doc.subjects)
    const pairs = new Set(); const full = new Set()
    let tuples = 0
    for (const profile of doc.coverage_profiles) {
      assert.equal(profile.tuples.length, 20, `${slug}/${profile.subject} declares twenty slots`)
      const objects = new Set(profile.tuples.map(t => t.episode_object))
      const mechanisms = new Set(profile.tuples.map(t => t.mechanism))
      assert.equal(objects.size, 20, `${slug}/${profile.subject} objects unique`)
      assert.equal(mechanisms.size, 20, `${slug}/${profile.subject} mechanisms unique`)
      for (const t of profile.tuples) {
        tuples += 1
        pairs.add(`${t.episode_object}|${t.mechanism}`)
        full.add(JSON.stringify(t))
      }
    }
    assert.equal(tuples, 1000, `${slug} sells 1,000 assignments`)
    assert.equal(pairs.size, 1000, `${slug} object|mechanism pairs unique across the pack`)
    assert.equal(full.size, 1000, `${slug} complete tuples unique across the pack`)
  }
})

test('the visual style and thumbnail recipe are object-led and title-exact', async () => {
  const style = await json(join(ROOT, 'style/old-master-still-life/content/visual-style.json'))
  assert.equal(style.name, 'Old Master Still Life')
  assert.deepEqual(style.preview_assets, ['assets/old-master-still-life.webp'])
  assert.ok(style.style_bible.includes('still life'))
  assert.ok(style.negative_prompt.includes('readable text'))
  const recipe = await json(join(ROOT, 'thumbnail/period-portrait-serif-title/content/thumbnail-recipe.json'))
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.preview_assets.length, 5)
  assert.ok(recipe.compatible_formula_ids.includes(FORMULA_ID))
})

test('every preview decodes as 1672x941 WebP with the recorded digest and provenance', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const [rel, [sha, bytes]] of Object.entries(PREVIEWS)) {
    const buf = await readFile(join(ROOT, rel))
    assert.equal(buf.byteLength, bytes, `${rel} bytes`)
    assert.ok(buf.byteLength > 20 * 1024)
    assert.equal(createHash('sha256').update(buf).digest('hex'), sha, `${rel} digest`)
    const meta = await sharp(buf).metadata()
    assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height }, { format: 'webp', width: 1672, height: 941 })
    assert.ok(provenance.includes(sha), `provenance records ${rel}`)
    assert.ok(provenance.includes(`${bytes} bytes`))
  }
  for (const evidence of ['gpt-image-2', 'reference_images: []', '1672x941 WebP decode passed', 'job `4aad010e`', '1280×720']) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
})

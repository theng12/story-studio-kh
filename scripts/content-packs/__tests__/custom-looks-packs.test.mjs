/**
 * The Custom Looks collection — fifteen Visual Styles adopted on 2026-10-25 from
 * the owner's own channel art styles.
 *
 * WHERE THEY CAME FROM. The owner's channels carried 34 distinct hand-written
 * style presets. A triage against the 43 styles already in the Store adopted
 * fifteen of them as standalone styles and mapped the rest onto styles the Store
 * already sells (that mapping is app-side, see
 * electron/server/content-packs/style-aliases.ts). The owner accepted the triage
 * in full and then asked for all fifteen rather than nine, with the condition
 * that each be made visibly distinct from its nearest neighbour in the Store.
 *
 * WHAT THIS FILE PINS, and why each one is worth a test rather than a review:
 *
 *   1. The exact three-preview contract (owner, 2026-10-25: no more and no
 *      fewer), hero first, each a 1672x941 WebP over 20 KB that fully decodes
 *      and whose bytes are distinct from its siblings. A style that ships the
 *      same picture twice is not three previews.
 *   2. Every declared preview's digest and byte count appears in
 *      PREVIEW-PROVENANCE.md, so the row cannot drift from the file.
 *   3. Six of the fifteen render close to something already on the shelf. Those
 *      six carry a REQUIRED contrast phrase in their bible — the sentence that
 *      says, in rendering language, how they differ from their neighbour. If
 *      someone softens that sentence away, this fails, because the distinctness
 *      was the owner's condition for shipping them at all.
 *   4. No two bibles describe the same picture, judged on the style-defining
 *      sentences with the shared content-independence close excluded.
 *   5. A style never contradicts itself: its own name must not appear in its own
 *      negative prompt, and every negative prompt must exclude photography.
 *   6. No third-party mark anywhere in the docs, and no Formula compatibility
 *      claimed: these were authored against no Series Formula.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = join(process.cwd(), 'content-packs/custom-looks')
const STYLE_ROOT = join(ROOT, 'style')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const PROVENANCE = join(ROOT, 'PREVIEW-PROVENANCE.md')
const VERSION = '1.0.0'
/**
 * The reservation batch these fifteen identities came from.
 *
 * Re-chained 2026-10-27 onto `release/1.4.361` (which had already reserved the
 * five Sleep Formula successors at revision 332), so the same identities were
 * reserved once more at 332 → 333. The receipt embeds `expected_revision`, so
 * it moved; the pack ids, versions and sources did not.
 */
const RESERVATION_RECEIPT = 'authoring:85da73f8062c23ff136e937dd298ab93db64bfa19e8242e945761c786e3b6aed'

/**
 * One row per style. `contrast` is a phrase the bible must contain: for the six
 * neighbours it is the explicit distinction, for the rest it is the medium.
 */
const STYLES = [
  {
    slug: 'carved-woodcut-print',
    name: 'Carved Woodcut Print',
    category: 'Illustration',
    contrast: ['gouge', 'hand-pulled'],
  },
  {
    slug: 'lush-painterly-scenery',
    name: 'Lush Painterly Scenery',
    category: 'Illustration',
    contrast: ['painted animation background'],
  },
  {
    slug: 'dark-moody-painterly',
    name: 'Dark Moody Painterly',
    category: 'Illustration',
    contrast: ['low-key'],
  },
  {
    slug: 'vintage-copperplate-engraving',
    name: 'Vintage Copperplate Engraving',
    category: 'Illustration',
    contrast: ['intaglio'],
  },
  {
    slug: 'warm-cosy-interior-illustration',
    name: 'Warm Cosy Interior Illustration',
    category: 'Illustration',
    contrast: ['lamplight'],
  },
  {
    slug: 'storybook-stick-figure-cartoon',
    name: 'Storybook Stick-Figure Cartoon',
    category: 'Illustration',
    contrast: ['stick'],
  },
  {
    slug: 'muted-isometric-infographic',
    name: 'Muted Isometric Infographic',
    category: 'Explainer',
    contrast: ['axonometric'],
  },
  {
    slug: 'dark-folk-horror-gouache',
    name: 'Dark Folk-Horror Gouache',
    category: 'Illustration',
    contrast: ['gouache'],
  },
  {
    slug: 'stained-glass-panel-illustration',
    name: 'Stained-Glass Panel Illustration',
    category: 'Illustration',
    contrast: ['lead came'],
  },
  // The six that render closest to an existing Store style. Their required
  // phrases are the explicit contrast the owner made a condition of shipping.
  {
    slug: 'clean-editorial-illustration',
    name: 'Clean Editorial Illustration',
    category: 'Editorial',
    neighbour: 'Flat Vector Explainer',
    contrast: ['grain', 'explainer diagram'],
  },
  {
    slug: 'museum-diorama',
    name: 'Museum Diorama',
    category: 'Realistic',
    neighbour: 'Studio Catalog Realism',
    contrast: ['diorama', 'neutral sweep'],
  },
  {
    slug: 'cosy-night-pixel-art',
    name: 'Cosy Night Pixel Art',
    category: 'Digital',
    neighbour: 'Pixel Art Story',
    contrast: ['pixel', 'game interface'],
  },
  {
    slug: 'matte-gouache-storybook',
    name: 'Matte Gouache Storybook',
    category: 'Illustration',
    neighbour: 'Watercolor Storybook',
    contrast: ['transparent washes', 'no colour bleeding'],
  },
  {
    slug: 'naturalist-watercolour-plate',
    name: 'Naturalist Watercolour Plate',
    category: 'Illustration',
    neighbour: 'Naturalist Sketchbook',
    contrast: ['fills the frame edge to edge', 'no border, no margin'],
  },
  {
    slug: 'painterly-prehistoric-life',
    name: 'Painterly Prehistoric Life',
    category: 'Illustration',
    neighbour: 'Paleo Documentary Tableau',
    contrast: ['ochre', 'early humans'],
  },
]

// 2026-11-06 text patches: same identity and previews in a later version
// directory, prose-only edits. They are archived source inventory, not shipped
// receipts and not additional styles; the fifteen adopted styles stay as listed.
const TEXT_PATCH_DIRECTORIES = [
  'cosy-night-pixel-art-v1.0.1',
  'dark-folk-horror-gouache-v1.0.1',
  'painterly-prehistoric-life-v1.0.1',
  'warm-cosy-interior-illustration-v1.0.2',
]

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/** The style-defining sentences, without the shared content-independence close. */
function definingText(bible) {
  return bible
    .split(/(?<=\.)\s+/)
    .filter(sentence => !/^content-independent/i.test(sentence.trim()))
    .join(' ')
    .toLowerCase()
}

test('the collection is exactly the fifteen adopted styles plus their archived text patches', async () => {
  const dirs = (await readdir(STYLE_ROOT, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  assert.deepEqual(dirs, [...STYLES.map(style => style.slug), ...TEXT_PATCH_DIRECTORIES].sort())
})

test('a text patch keeps its identity and previews, changing only its prose', async () => {
  for (const patchDir of TEXT_PATCH_DIRECTORIES) {
    const baseSlug = patchDir.replace(/-v\d+\.\d+\.\d+$/, '')
    const baseDir = join(STYLE_ROOT, baseSlug)
    const patch = await readJson(join(STYLE_ROOT, patchDir, 'pack.json'))
    const base = await readJson(join(baseDir, 'pack.json'))
    assert.equal(patch.pack_id, base.pack_id, `${patchDir} must keep the same pack identity`)
    assert.ok(patch.version > base.version, `${patchDir} must be a later version`)

    // Same previews, same bytes: a patch may not change what is drawn.
    const assetNames = await readdir(join(baseDir, 'assets'))
    assert.deepEqual(await readdir(join(STYLE_ROOT, patchDir, 'assets')), assetNames)
    for (const name of assetNames) {
      assert.deepEqual(
        await readFile(join(STYLE_ROOT, patchDir, 'assets', name)),
        await readFile(join(baseDir, 'assets', name)),
        `${patchDir}/${name} must be byte-identical to ${baseSlug}`,
      )
    }

    const patchDoc = await readJson(join(STYLE_ROOT, patchDir, 'content', 'visual-style.json'))
    const baseDoc = await readJson(join(baseDir, 'content', 'visual-style.json'))
    assert.notEqual(patchDoc.style_bible, baseDoc.style_bible, `${patchDir} must genuinely change its prose`)
  }
})

test('every pack declares its reserved identity, entitlement and manifest contract', async () => {
  for (const style of STYLES) {
    const packId = `com.storystudio.pack.style.${style.slug}`
    const itemId = `com.storystudio.style.${style.slug}`
    const dir = join(STYLE_ROOT, style.slug)
    assert.deepEqual((await readdir(dir)).sort(), ['assets', 'content', 'pack.json'])
    assert.deepEqual((await readdir(join(dir, 'content'))).sort(), ['visual-style.json'])

    const manifest = await readJson(join(dir, 'pack.json'))
    assert.equal(manifest.pack_format, 1)
    assert.equal(manifest.pack_id, packId)
    assert.equal(manifest.publisher_id, 'com.storystudio')
    assert.equal(manifest.version, VERSION)
    assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(manifest.lifecycle, 'active')
    assert.ok(manifest.changelog.length > 0, `${packId} says what its first release ships`)
    assert.deepEqual(manifest.entitlement, {
      sku: `com.storystudio.sku.style.${style.slug}`,
      family: `com.storystudio.family.style.${style.slug}`,
    })
    assert.deepEqual(manifest.dependencies, [])
    assert.equal(manifest.bundles, undefined, 'a creative component declares no bundle')

    const doc = await readJson(join(dir, 'content', 'visual-style.json'))
    assert.equal(doc.kind, 'visual-style')
    assert.equal(doc.schema_version, 1)
    assert.equal(doc.id, itemId)
    assert.equal(doc.name, style.name)
    assert.equal(doc.category, style.category)
    assert.ok(doc.description.length > 80, `${packId} has a store description`)
    assert.ok(doc.description.length <= 2000, `${packId} description fits the field`)
    // Searchable: every style carries real tags, and the ones a customer would
    // type for this look are among them.
    assert.ok(doc.tags.length >= 3, `${packId} carries at least three search tags`)
    assert.ok(doc.tags.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 60))
    assert.equal(new Set(doc.tags).size, doc.tags.length, `${packId} tags are unique`)
    assert.deepEqual(doc.compatible_formula_ids, [],
      `${packId} was authored against no Series Formula and must claim none`)
    // Render-ready prose, not a placeholder.
    assert.ok(doc.style_bible.split(/\s+/).length >= 150, `${packId} style_bible is a full contract`)
    assert.ok(doc.negative_prompt.length >= 200, `${packId} negative_prompt is usable`)
  }
})

test('the style bibles say what distinguishes them, including from the six nearest neighbours', async () => {
  for (const style of STYLES) {
    const doc = await readJson(join(STYLE_ROOT, style.slug, 'content', 'visual-style.json'))
    const bible = doc.style_bible.toLowerCase()
    for (const phrase of style.contrast) {
      assert.ok(bible.includes(phrase.toLowerCase()),
        `${style.slug} must keep the phrase "${phrase}" — it is how this style stays distinct`
        + (style.neighbour ? ` from ${style.neighbour}` : ''))
    }
  }
})

test('no two of the fifteen describe the same picture', async () => {
  const seen = new Map()
  for (const style of STYLES) {
    const doc = await readJson(join(STYLE_ROOT, style.slug, 'content', 'visual-style.json'))
    const text = definingText(doc.style_bible)
    const collision = seen.get(text)
    assert.equal(collision, undefined,
      `${style.slug} describes the same picture as ${collision}`)
    seen.set(text, style.slug)
  }
})

test('a style never contradicts itself in its own negative prompt', async () => {
  for (const style of STYLES) {
    const doc = await readJson(join(STYLE_ROOT, style.slug, 'content', 'visual-style.json'))
    const negative = doc.negative_prompt.toLowerCase()
    assert.ok(negative.includes('photoreal'),
      `${style.slug} must exclude photography, or its medium is not defended`)
    assert.ok(!negative.includes(doc.name.toLowerCase()),
      `${style.slug} forbids its own name`)
  }
})

test('every style carries exactly three verified previews, hero first, and they are distinct pictures', async () => {
  for (const style of STYLES) {
    const slug = style.slug
    const dir = join(STYLE_ROOT, slug)
    const doc = await readJson(join(dir, 'content', 'visual-style.json'))

    // Owner, 2026-10-25: exactly three, no more and no fewer; the hero is the
    // card image, so the order is a customer-visible fact rather than a list.
    assert.deepEqual(doc.preview_assets, [
      `assets/${slug}.webp`,
      `assets/${slug}-scene.webp`,
      `assets/${slug}-hardest.webp`,
    ])
    assert.deepEqual((await readdir(join(dir, 'assets'))).sort(),
      [`${slug}-hardest.webp`, `${slug}-scene.webp`, `${slug}.webp`])

    const digests = []
    for (const preview of doc.preview_assets) {
      const bytes = await readFile(join(dir, preview))
      assert.ok(bytes.length > 20 * 1024, `${slug}/${preview} is under the 20 KB floor`)
      const meta = await sharp(bytes, { failOn: 'error' }).metadata()
      assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height },
        { format: 'webp', width: 1672, height: 941 }, `${slug}/${preview} is not a 1672x941 WebP`)
      // Full decode, not just a header read: a truncated file still reports
      // its declared dimensions.
      await sharp(bytes, { failOn: 'error' }).raw().toBuffer()
      digests.push(sha256(bytes))
    }
    assert.equal(new Set(digests).size, 3, `${slug} ships the same picture twice`)
  }
})

test('every preview carries its own digest and byte count in PREVIEW-PROVENANCE.md', async () => {
  const brief = await readFile(PROVENANCE, 'utf8')
  for (const style of STYLES) {
    for (const suffix of ['', '-scene', '-hardest']) {
      const path = join(STYLE_ROOT, style.slug, 'assets', `${style.slug}${suffix}.webp`)
      const bytes = await readFile(path)
      for (const evidence of [sha256(bytes), String(bytes.length), '1672x941']) {
        assert.ok(brief.includes(evidence),
          `${style.slug}${suffix} provenance must record ${evidence}`)
      }
    }
  }
})

test('all fifteen are authored registry records under this reservation', async () => {
  const registry = await readJson(REGISTRY)
  for (const style of STYLES) {
    const record = registry.records.find(candidate =>
      candidate.pack_id === `com.storystudio.pack.style.${style.slug}`
      && candidate.version === VERSION)
    assert.ok(record, `${style.slug} ${VERSION} must have a registry record`)
    assert.equal(record.item_id, `com.storystudio.style.${style.slug}`)
    assert.equal(record.kind, 'visual-style')
    assert.equal(record.status, 'authored')
    assert.equal(record.source_path, `content-packs/custom-looks/style/${style.slug}`)
    assert.equal(record.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(record.min_app_version_status, 'release-bound')
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.receipt_ref, RESERVATION_RECEIPT,
      `${style.slug} must trace to the batch that reserved it`)
  }
})

test('no third-party mark is carried into the store', async () => {
  for (const style of STYLES) {
    const doc = await readJson(join(STYLE_ROOT, style.slug, 'content', 'visual-style.json'))
    for (const [keyPath, value] of meaningfulStrings(doc)) {
      assert.equal(markIn(value), undefined, `${style.slug} ${keyPath} carries a third-party mark`)
    }
  }
})

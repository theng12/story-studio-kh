/**
 * The Standalone Looks collection — four Visual Styles that belong to NO
 * channel: two authored 2026-09-08, a third added 2026-09-09 and a fourth added
 * 2026-10-29. All four declare `compatible_formula_ids: []`, exactly as
 * the shipped Production Looks and Storytelling Looks styles do, because a look
 * sold on its own must not claim a Series Formula it was never authored
 * against. Three reservation batches (revisions 188, 267 and 352), three
 * receipts, four lifecycle promotions (revisions 194-195, 272 and 353).
 *
 * Both declare preview assets. They did not exist when this file was first
 * written — this control Mac does not perform production image generation, and
 * no owner authorisation had been given — so nothing was fabricated and nothing
 * was stubbed. The authorisation arrived on 2026-09-08 and all six were
 * rendered by two Image Pool jobs, `c55d3e01` (five of the six) and `da15eecf`
 * (the sixth, resubmitted alone after a provider submission failure on that one
 * item). All six are now present, so the assertions below require each of those
 * six to exist, to decode to its contract, and to carry its own digest and byte
 * count in PREVIEW-PROVENANCE.md. A preview that goes missing now fails the
 * suite instead of being skipped.
 *
 * The third look, Flat Colour Stick Scenes, was rendered on 2026-09-09 under a
 * second owner authorisation, through the same `gpt-image-2` lane, under the
 * run id `standalone-looks-previews-2`. All three of its previews landed on the
 * first submission and are committed, so its assertions are no longer
 * conditional either: all nine previews of the first three looks in this
 * collection must now exist, decode to contract, and carry their digests in
 * PREVIEW-PROVENANCE.md.
 *
 * The fourth look, Webtoon Martial Arts, was authored and rendered on
 * 2026-10-29 on this Mac's own Studio Hub (the owner's single local exception
 * for drawing art-style pack previews), on Qwen Image 2.1 turbo, one job in
 * flight at a time. It is the same contract as its siblings — three distinct
 * 1672x941 WebPs in provenance — and it names its own preview files rather than
 * the `-hero`/`-scene`/`-face` spelling the first three use; those names are as
 * authored, not a rule of the collection, so the contract below is read from a
 * per-look file list rather than rebuilt from the slug.
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

const ROOT = join(process.cwd(), 'content-packs/standalone-looks')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const FIRST_PASS_RECEIPT = 'authoring:ada3557c18e5d2448acef9340b5472a0e6eee39da2de7f3b70c3f2121931713f'
const SECOND_PASS_RECEIPT = 'authoring:ebd1b5e09ab64e5b5f921bd6a8630358bcb69c8efb2fbcbf5739418e740c0754'
/** Authored, rendered and registered on 2026-10-29 on this Mac's own Studio Hub. */
const HUB_PASS_RECEIPT = 'authoring:dd8b9f217d28cea898f4eeaad442d3007dc6ca2bcc88448c9ecf61a423913577'
/** Rendered on 2026-09-08; their previews must be on disk. */
const RENDERED_SLUGS = ['inked-fable-cartoon', 'scratchy-editorial-poster']
/** Authored 2026-09-09; rendered 2026-09-09 under `standalone-looks-previews-2`. */
const PENDING_SLUGS = ['flat-colour-stick-scenes']
/** Authored 2026-10-29; rendered 2026-10-29 on this Mac's own Studio Hub. */
const HUB_SLUGS = ['webtoon-martial-arts']
const SLUGS = [...RENDERED_SLUGS, ...PENDING_SLUGS, ...HUB_SLUGS]
const RECEIPTS = Object.fromEntries([
  ...RENDERED_SLUGS.map(slug => [slug, FIRST_PASS_RECEIPT]),
  ...PENDING_SLUGS.map(slug => [slug, SECOND_PASS_RECEIPT]),
  ...HUB_SLUGS.map(slug => [slug, HUB_PASS_RECEIPT]),
])

const PACKS = SLUGS.map(slug => ({ kind: 'visual-style', seg: 'style', slug, docs: ['visual-style.json'] }))

/**
 * Each look's three preview files, in the owner's order: the hero (the card
 * image, `preview_assets[0]`), a quiet wide scene with no figure, and the
 * hardest legal case for the style.
 */
const PREVIEW_FILES = {
  'inked-fable-cartoon': ['hero', 'scene', 'face'].map(kind => `inked-fable-cartoon-${kind}.webp`),
  'scratchy-editorial-poster': ['hero', 'scene', 'face'].map(kind => `scratchy-editorial-poster-${kind}.webp`),
  'flat-colour-stick-scenes': ['hero', 'scene', 'face'].map(kind => `flat-colour-stick-scenes-${kind}.webp`),
  'webtoon-martial-arts': [
    'webtoon-martial-arts.webp',
    'webtoon-martial-arts-scene.webp',
    'webtoon-martial-arts-hardest.webp',
  ],
}

const previewsOf = slugs => Object.fromEntries(slugs.flatMap(slug =>
  PREVIEW_FILES[slug].map(name => [`style/${slug}/assets/${name}`, [1672, 941]])))

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = previewsOf(SLUGS)
const RENDERED_PREVIEWS = previewsOf(RENDERED_SLUGS)
const PENDING_PREVIEWS = previewsOf(PENDING_SLUGS)
const HUB_PREVIEWS = previewsOf(HUB_SLUGS)

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Standalone Looks pack is an authored, receipt-bound standalone source', async () => {
  const registry = await json(REGISTRY)
  for (const p of PACKS) {
    const packId = `com.storystudio.pack.${p.seg}.${p.slug}`
    const itemId = `com.storystudio.${p.seg}.${p.slug}`
    const record = registry.records.find(r => r.pack_id === packId && r.version === '1.0.0')
    assert.ok(record, `${packId} must be registered`)
    assert.equal(record.receipt_ref, RECEIPTS[p.slug])
    assert.equal(record.status, 'authored')
    assert.equal(record.kind, p.kind)
    assert.equal(record.item_id, itemId)
    assert.equal(record.item_ids, undefined)
    assert.equal(record.source_path, `content-packs/standalone-looks/${p.seg}/${p.slug}`)
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

test('every look is sold with no channel attached', async () => {
  for (const slug of SLUGS) {
    const doc = await json(join(ROOT, `style/${slug}/content/visual-style.json`))
    assert.deepEqual(doc.compatible_formula_ids, [],
      `${slug} must claim no Series Formula it was not authored against`)
  }
})

test('all four looks declare three previews — hero, empty scene, and hardest case', async () => {
  for (const slug of SLUGS) {
    const doc = await json(join(ROOT, `style/${slug}/content/visual-style.json`))
    assert.deepEqual(doc.preview_assets, PREVIEW_FILES[slug].map(name => `assets/${name}`),
      `${slug} declares the three-preview set the owner asked for`)
  }
})

test('the fable look is ink-first, one warm key, and menace in the eyes', async () => {
  const style = await json(join(ROOT, 'style/inked-fable-cartoon/content/visual-style.json'))
  assert.equal(style.name, 'Inked Fable Cartoon')
  // The six things that make this look itself. Losing any one changes it into
  // an ordinary cartoon, which is what its negative prompt spends its length
  // refusing.
  assert.match(style.style_bible, /thick, confident black ink outline of visibly variable weight/i)
  assert.match(style.style_bible, /cel shading over them in two soft-edged steps/i)
  assert.match(style.style_bible, /exactly one warm key/i)
  assert.match(style.style_bible, /anthropomorphic animals built for bulk/i)
  assert.match(style.style_bible, /glowing white in the shadow of the brow/i)
  assert.match(style.style_bible, /never a level eye-line camera/i)
  // The crowd rule is what gives the look its signature composition.
  assert.match(style.style_bible, /exactly one figure is lifted out of it/i)
  for (const rejected of ['flat explainer colour', 'chibi', 'photoreal', 'neon', 'clean vector lines', 'readable lettering']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

test('the poster look is two inks on white, and its lettering is texture only', async () => {
  const style = await json(join(ROOT, 'style/scratchy-editorial-poster/content/visual-style.json'))
  assert.equal(style.name, 'Scratchy Editorial Poster')
  assert.match(style.style_bible, /scratchy pen and marker work/i)
  assert.match(style.style_bible, /half-dry brush/i)
  assert.match(style.style_bible, /nothing is finished at the edges/i)
  assert.match(style.style_bible, /stark white paper/i)
  assert.match(style.style_bible, /strictly limited to two inks/i)
  assert.match(style.style_bible, /cropped tight and centred/i)
  assert.match(style.style_bible, /mock body-copy columns/i)
  // The load-bearing instruction: the huge capitals are ornament, and the real
  // title comes from the caption system afterwards. A model that reads them as
  // language will spell something, and a spelled word in a Visual Style preview
  // is a defect.
  assert.match(style.style_bible, /no complete word is ever visible/i)
  assert.match(style.style_bible, /Treat them as ornament, not language/i)
  assert.match(style.style_bible, /the real title is set by the caption system afterwards/i)
  for (const rejected of ['smooth digital rendering', 'photoreal', 'gradients', 'dark background',
    'clean vector lines', 'recognisable character', 'logo']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

/** Decode one preview and hold it to its contract and its provenance row. */
async function assertPreview(rel, [width, height], provenance) {
  const buf = await readFile(join(ROOT, rel))
  assert.ok(buf.byteLength > 20 * 1024, `${rel} must exceed the 20 KB floor`)
  const meta = await sharp(buf).metadata()
  assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height },
    { format: 'webp', width, height }, `${rel} must decode to the declared contract`)
  const digest = createHash('sha256').update(buf).digest('hex')
  assert.ok(provenance.includes(digest), `provenance must record the digest of ${rel}`)
  assert.ok(provenance.includes(`${buf.byteLength}`), `provenance must record the byte count of ${rel}`)
}

test('every declared preview is named by the provenance record at its contract size', async () => {
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
  }
})

test('the six previews rendered on 2026-09-08 are still present and still accounted for', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const [rel, size] of Object.entries(RENDERED_PREVIEWS)) {
    assert.ok(await exists(join(ROOT, rel)), `${rel} must exist: all six previews landed on 2026-09-08`)
    await assertPreview(rel, size, provenance)
  }
})

test('the third look\'s three previews landed on 2026-09-09 and are accounted for', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const [rel, size] of Object.entries(PENDING_PREVIEWS)) {
    assert.ok(await exists(join(ROOT, rel)),
      `${rel} is declared by the third look and must be committed`)
    await assertPreview(rel, size, provenance)
  }
})

test('the fourth look\'s three previews were rendered on 2026-10-29 and are accounted for', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const [rel, size] of Object.entries(HUB_PREVIEWS)) {
    assert.ok(await exists(join(ROOT, rel)),
      `${rel} is declared by the fourth look and must be committed`)
    await assertPreview(rel, size, provenance)
  }
})

test('the provenance record states why the render was held, how it was run, which jobs ran it, and that the subjects are original', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'standalone-looks-previews-1',
    'standalone-looks-previews-1b',
    'standalone-looks-previews-2',
    'gpt-image-2',
    'c55d3e01',
    'da15eecf',
  ]) {
    assert.ok(provenance.includes(evidence), `provenance must record ${evidence}`)
  }
  // The poster look renders lettering as texture, so the acceptance rule has to
  // say what makes a returned image unusable: a readable word, or a subject a
  // viewer could recognise.
  assert.match(provenance, /Original subjects only/)
  assert.match(provenance, /spell no word in any language/)
  assert.match(provenance, /must be rejected rather than committed/)
  const prompts = provenance.match(/^## Prompt \d+ — /gm) ?? []
  assert.equal(prompts.length, Object.keys(PREVIEW_CONTRACT).length)
  const bodies = provenance.match(/^> .+$/gm) ?? []
  assert.equal(bodies.length, prompts.length, 'every prompt has exactly one body')
  // The second pass is its own run id with its own three-prompt body, which is
  // what keeps it from overwriting the first pass's six files.
  assert.ok(Buffer.byteLength(JSON.stringify(bodies.slice(
    RENDERED_SLUGS.length * 3, (RENDERED_SLUGS.length + PENDING_SLUGS.length) * 3))) < 16 * 1024,
  'the second-pass request body stays under the 16 KiB cap')
})

test('the stick-figure look is rough-lined, unshaded, fully furnished, and deadpan', async () => {
  const style = await json(join(ROOT, 'style/flat-colour-stick-scenes/content/visual-style.json'))
  assert.equal(style.name, 'Flat Colour Stick Scenes')
  // The six things that make this look itself, and separate it from the two
  // shipped stick-figure explainer styles, which both work on a blank ground.
  assert.match(style.style_bible, /round tan head, two big white eyes/i)
  assert.match(style.style_bible, /edges are visibly rough and slightly pixel-stepped/i)
  assert.match(style.style_bible, /one flat colour with no shading of any kind/i)
  assert.match(style.style_bible, /never leaves a figure on a blank ground/i)
  assert.match(style.style_bible, /Every frame is a complete coloured place/i)
  assert.match(style.style_bible, /exactly one clear idea per frame/i)
  // The diagram grammar is the signature: the explaining marks are objects in
  // the world, not an overlay on top of it.
  assert.match(style.style_bible, /objects in the scene rather than an overlay/i)
  assert.match(style.style_bible, /prohibition circle stands in the world as a sign on a post/i)
  // Lettering is permitted, but only as scene furniture — never as a headline.
  assert.match(style.style_bible, /Any lettering in this style is scene detail/i)
  assert.match(style.style_bible, /never a caption laid over the image/i)
  // Deadpan is a contract term here, not a mood word.
  assert.match(style.style_bible, /gentle and deadpan/i)
  assert.match(style.style_bible, /never mug, never wink/i)
  for (const rejected of ['shading', 'gradients', 'painterly texture', 'realistic anatomy',
    'clean vector polish', 'photograph']) {
    assert.ok(style.negative_prompt.includes(rejected), `negative prompt must reject ${rejected}`)
  }
})

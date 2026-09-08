/**
 * The Standalone Looks collection — two Visual Styles authored 2026-09-08 that
 * belong to NO channel. Both declare `compatible_formula_ids: []`, exactly as
 * the shipped Production Looks and Storytelling Looks styles do, because a look
 * sold on its own must not claim a Series Formula it was never authored
 * against. One reservation batch (revision 188), one receipt, two lifecycle
 * promotions (revisions 194-195).
 *
 * Both declare preview assets that DO NOT EXIST YET: this control Mac does not
 * perform production image generation, and no owner authorisation was given for
 * this pass. Nothing was fabricated and nothing was stubbed, so this file pins
 * the honest state instead: every declared preview path is named by the
 * collection's PREVIEW-PROVENANCE.md, and any preview byte that HAS landed must
 * meet the contract.
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
const RECEIPT = 'authoring:ada3557c18e5d2448acef9340b5472a0e6eee39da2de7f3b70c3f2121931713f'
const SLUGS = ['inked-fable-cartoon', 'scratchy-editorial-poster']

const PACKS = SLUGS.map(slug => ({ kind: 'visual-style', seg: 'style', slug, docs: ['visual-style.json'] }))

/** Preview path (collection-relative) → required dimensions. */
const PREVIEW_CONTRACT = Object.fromEntries(SLUGS.flatMap(slug =>
  ['hero', 'scene', 'face'].map(kind => [`style/${slug}/assets/${slug}-${kind}.webp`, [1672, 941]])))

async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function exists(path) { return stat(path).then(() => true, () => false) }

test('every Standalone Looks pack is an authored, receipt-bound standalone source', async () => {
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

test('both looks are sold with no channel attached', async () => {
  for (const slug of SLUGS) {
    const doc = await json(join(ROOT, `style/${slug}/content/visual-style.json`))
    assert.deepEqual(doc.compatible_formula_ids, [],
      `${slug} must claim no Series Formula it was not authored against`)
  }
})

test('both looks declare three previews — hero, empty scene, and hardest case', async () => {
  for (const slug of SLUGS) {
    const doc = await json(join(ROOT, `style/${slug}/content/visual-style.json`))
    assert.deepEqual(doc.preview_assets, [
      `assets/${slug}-hero.webp`,
      `assets/${slug}-scene.webp`,
      `assets/${slug}-face.webp`,
    ], `${slug} declares the three-preview set the owner asked for`)
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

test('the provenance record states why nothing was generated, how to generate it, and that the subjects are original', async () => {
  const provenance = await readFile(join(ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    'image-pool/generate',
    'reference_images: []',
    'does not perform production image generation',
    'standalone-looks-previews-1',
    'gpt-image-2',
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
})

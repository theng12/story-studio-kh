/**
 * The 2026-09-08 style preview backfill.
 *
 * WHAT IT WAS. Every Visual Style that shipped before 2026-09-08 carried
 * exactly one preview, its hero. The owner's rule that day was three: the hero,
 * a quiet wide scene with no figure in it, and the hardest case the style can
 * legally be asked for. Twenty-three Styles across eight collections were
 * brought up to it by rendering forty-six new previews and bumping each pack
 * into a new `<slug>-v<version>` sibling directory.
 *
 * WHY THIS FILE EXISTS RATHER THAN TWENTY-THREE EDITS. Each collection already
 * has a test that pins its own packs, and every one of them was written against
 * the generation that shipped at the time. Adding the successor to each in its
 * own idiom would have spread one rule across eight files and left the rule
 * itself written down nowhere. The per-collection tests keep doing what they
 * did — they still pin the older directories, byte for byte — and this file
 * carries the one thing that is true of all twenty-three at once.
 *
 * WHAT IT CATCHES THAT THE OTHERS CANNOT. A bump is a directory copy, and a
 * copy is exactly the operation that quietly re-encodes an image or drops a
 * file. So the hero of every successor is compared byte for byte against the
 * hero of the version it succeeded, not merely re-measured; six of those heroes
 * are owner-approved migrations whose approval does not survive a re-encode.
 * The two new previews are then held to the same contract the render brief set:
 * 1672x941 WebP, above the 20 KB floor, declared hero-first, and present on
 * disk under `assets/` rather than only in the document.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const ROOT = new URL('../../../', import.meta.url)
const REGISTRY = new URL('content-packs/authoring-registry.json', ROOT)
const BRIEF = new URL('content-packs/PREVIEW-BACKFILL-2026-09-08.md', ROOT)

/**
 * Collection, slug, the directory the pack shipped from before the backfill,
 * and the version it moved to. `previous` is the directory whose hero bytes the
 * successor must reproduce exactly — for three of these it is itself already a
 * versioned successor, which is why it is written out rather than derived.
 */
const BACKFILLED = [
  ['free-starters', 'cinematic-photoreal', 'cinematic-photoreal', '1.0.1'],
  ['free-starters', 'flat-vector-explainer', 'flat-vector-explainer', '1.0.1'],
  ['free-starters', 'hand-drawn-editorial-diagram', 'hand-drawn-editorial-diagram', '1.0.1'],
  ['free-starters', 'minimal-stick-figure-explainer', 'minimal-stick-figure-explainer-v1.0.1', '1.0.2'],
  ['free-starters', 'paleo-documentary-tableau', 'paleo-documentary-tableau', '1.0.1'],
  ['free-starters', 'prehistoric-stick-cartoon', 'prehistoric-stick-cartoon-v1.0.1', '1.0.2'],
  ['free-starters', 'sepia-ink-wash', 'sepia-ink-wash', '1.0.1'],
  ['free-starters', 'watercolor-storybook', 'watercolor-storybook', '1.0.1'],
  ['free-starters', 'waxy-outline-cartoon', 'waxy-outline-cartoon', '1.0.1'],
  ['legacy-thumbnail-restoration', 'dreamlike-luminous-sleep-illustration', 'dreamlike-luminous-sleep-illustration', '1.0.1'],
  ['legacy-thumbnail-restoration', 'hand-drawn-hardship-cartoon', 'hand-drawn-hardship-cartoon', '1.0.1'],
  ['legacy-thumbnail-restoration', 'impasto-psychological-animals', 'impasto-psychological-animals', '1.0.1'],
  ['paid/archival-ledger', 'archival-documentary-reconstruction', 'archival-documentary-reconstruction', '1.0.1'],
  ['production-looks', 'anime-cel', 'anime-cel', '1.0.1'],
  ['production-looks', 'hand-drawn-cartoon-explainer', 'hand-drawn-cartoon-explainer', '1.0.1'],
  ['production-looks', 'pixel-art-story', 'pixel-art-story', '1.0.1'],
  ['production-looks', 'retro-paint-fantasy', 'retro-paint-fantasy', '1.0.1'],
  ['production-looks', 'studio-catalog-realism', 'studio-catalog-realism', '1.0.1'],
  ['production-looks', 'whiteboard-doodle-explainer', 'whiteboard-doodle-explainer', '1.0.1'],
  ['psychology-editorial', 'pastel-surreal-psychological-collage', 'pastel-surreal-psychological-collage-v1.0.1', '1.0.2'],
  ['sleep-history', 'old-master-still-life', 'old-master-still-life', '1.0.1'],
  ['storytelling-looks', 'chinese-ink-wash-storytelling', 'chinese-ink-wash-storytelling', '1.0.1'],
  ['symbolic-psychology-studio', 'oil-painting-classical', 'oil-painting-classical', '1.0.1'],
  // 2026-10-24 preview backfill: two more styles get their second and third previews.
  ['illustrated-history', 'bold-illustrated-history', 'bold-illustrated-history', '1.0.1'],
  ['poetry-looks', 'quiet-anime-poetry', 'quiet-anime-poetry', '1.0.1'],
].map(([collection, slug, previous, version]) => ({
  collection,
  slug,
  version,
  previousPath: `content-packs/${collection}/style/${previous}`,
  sourcePath: `content-packs/${collection}/style/${slug}-v${version}`,
}))

/**
 * The Archival Ledger style was listed twice in the catalogue index when this
 * backfill ran — once under the retired source monolith and once under its live
 * `paid/` pack. The registry validator refuses any source path under the
 * monolith by name, so the backfill registered it from `paid/` and left the
 * monolith alone. The monolith itself was deleted on 2026-09-08, but the guard
 * stays: "we picked the right one of two identical-looking directories" is the
 * kind of decision that is invisible six months later.
 */
const RETIRED_SOURCE_ROOT = 'content-packs/archival-ledger'

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const inRepo = relative => join(process.cwd(), relative)

test('the backfill covers twenty-five styles and none of them is registered from the retired monolith', () => {
  assert.equal(BACKFILLED.length, 25)
  assert.equal(new Set(BACKFILLED.map(row => row.slug)).size, 25)
  for (const row of BACKFILLED) {
    assert.ok(
      !row.sourcePath.startsWith(RETIRED_SOURCE_ROOT),
      `${row.slug} must not be registered from the retired source monolith`,
    )
  }
})

test('every backfilled successor declares three previews and carries them on disk at contract size', async t => {
  for (const row of BACKFILLED) {
    await t.test(`${row.collection}/${row.slug}@${row.version}`, async () => {
      const sourceRoot = inRepo(row.sourcePath)
      assert.deepEqual((await readdir(sourceRoot)).sort(), ['assets', 'content', 'pack.json'])
      assert.deepEqual((await readdir(join(sourceRoot, 'content'))).sort(), ['visual-style.json'])

      const manifest = await readJson(join(sourceRoot, 'pack.json'))
      assert.equal(manifest.pack_format, 1)
      assert.equal(manifest.pack_id, `com.storystudio.pack.style.${row.slug}`)
      assert.equal(manifest.publisher_id, 'com.storystudio')
      assert.equal(manifest.version, row.version)
      assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
      assert.equal(manifest.lifecycle, 'active')
      assert.ok(manifest.changelog, 'a successor must say what the bump changed')
      assert.equal(manifest.entitlement.sku, `com.storystudio.sku.style.${row.slug}`)
      assert.equal(manifest.entitlement.family, `com.storystudio.family.style.${row.slug}`)

      const style = await readJson(join(sourceRoot, 'content', 'visual-style.json'))
      assert.equal(style.kind, 'visual-style')
      assert.equal(style.id, `com.storystudio.style.${row.slug}`)
      // Hero first: the Content Store shows preview_assets[0] as the card image,
      // so the order is a customer-visible fact, not a list.
      assert.deepEqual(style.preview_assets, [
        `assets/${row.slug}.webp`,
        `assets/${row.slug}-scene.webp`,
        `assets/${row.slug}-face.webp`,
      ])
      assert.deepEqual(
        (await readdir(join(sourceRoot, 'assets'))).sort(),
        [`${row.slug}-face.webp`, `${row.slug}-scene.webp`, `${row.slug}.webp`],
      )

      for (const preview of style.preview_assets) {
        const bytes = await readFile(join(sourceRoot, preview))
        assert.ok(bytes.length > 20 * 1024, `${row.sourcePath}/${preview} is under the 20 KB floor`)
        assert.deepEqual(
          await sharp(bytes).metadata().then(({ format, width, height }) => ({ format, width, height })),
          { format: 'webp', width: 1672, height: 941 },
          `${row.sourcePath}/${preview} is not a 1672x941 WebP`,
        )
      }
    })
  }
})

test('a bump copies the hero across unchanged rather than re-encoding it', async t => {
  for (const row of BACKFILLED) {
    await t.test(`${row.slug}@${row.version}`, async () => {
      // The predecessor's hero is whatever it declared: a published pack is never renamed to fit.
      const beforeStyle = await readJson(inRepo(join(row.previousPath, 'content', 'visual-style.json')))
      const afterStyle = await readJson(inRepo(join(row.sourcePath, 'content', 'visual-style.json')))
      const before = await readFile(inRepo(join(row.previousPath, beforeStyle.preview_assets[0])))
      const after = await readFile(inRepo(join(row.sourcePath, 'assets', `${row.slug}.webp`)))
      assert.equal(sha256(after), sha256(before), `${row.slug} hero changed across the bump`)
      assert.equal(after.length, before.length)

      // The prose is art direction the customer reads. A preview bump does not
      // touch it, so any drift here is an unintended edit riding along.
      for (const field of ['name', 'description', 'category', 'style_bible', 'negative_prompt']) {
        assert.deepEqual(afterStyle[field], beforeStyle[field], `${row.slug} ${field} changed in a preview-only bump`)
      }
      assert.deepEqual(afterStyle.tags, beforeStyle.tags)
      assert.deepEqual(afterStyle.compatible_formula_ids, beforeStyle.compatible_formula_ids)
    })
  }
})

test('every backfilled successor is an authored registry record at its new source path', async () => {
  const registry = await readJson(REGISTRY)
  assert.ok(registry.revision >= 196, `registry revision ${registry.revision} predates the preview backfill`)

  for (const row of BACKFILLED) {
    const record = registry.records.find(candidate =>
      candidate.pack_id === `com.storystudio.pack.style.${row.slug}` && candidate.version === row.version)
    assert.ok(record, `${row.slug} ${row.version} must have a registry record`)
    assert.equal(record.item_id, `com.storystudio.style.${row.slug}`)
    assert.equal(record.publisher_id, 'com.storystudio')
    assert.equal(record.kind, 'visual-style')
    assert.equal(record.status, 'authored')
    assert.equal(record.source_path, row.sourcePath)
    assert.equal(record.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(record.min_app_version_status, 'release-bound')
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.stocking_proposal.family.id, `com.storystudio.family.style.${row.slug}`)
    assert.equal(record.stocking_proposal.sku.id, `com.storystudio.sku.style.${row.slug}`)
    assert.match(record.receipt_ref, /^authoring:[a-f0-9]{64}$/)

    // The record the pack succeeded stays exactly as it was. A bump adds a
    // record; it never edits the one already sold.
    const predecessor = registry.records.find(candidate =>
      candidate.pack_id === record.pack_id && candidate.source_path === row.previousPath)
    assert.ok(predecessor, `${row.slug} must keep its pre-backfill record`)
    assert.notEqual(predecessor.version, row.version)
  }
})

test('every rendered preview is accounted for in the 2026-09-08 backfill provenance record', async () => {
  const brief = await readFile(BRIEF, 'utf8')

  // Only the original 23 styles are documented in the 2026-09-08 brief.
  // The two 2026-10-24 additions have their own provenance tracking.
  const originalBackfilled = BACKFILLED.slice(0, 23)
  for (const row of originalBackfilled) {
    for (const variant of ['scene', 'face']) {
      const assetPath = `${row.sourcePath}/assets/${row.slug}-${variant}.webp`
      const bytes = await readFile(inRepo(assetPath))
      const digest = sha256(bytes)
      for (const evidence of [assetPath, digest, String(bytes.length), '1672x941']) {
        assert.ok(brief.includes(evidence), `${row.slug} ${variant} provenance must record ${evidence}`)
      }
    }
  }
})

/**
 * The 2026-10-24 three-preview rule, enforced across the whole shelf.
 *
 * WHAT THIS CATCHES THAT THE PER-PACK TESTS CANNOT. Each collection's own test
 * pins its packs at the generation that shipped, so a new pack authored
 * tomorrow with only a hero would pass its own collection's test and be
 * invisible here. The owner's rule is a shelf-wide invariant: every LIVE
 * visual style must carry at least three distinct verified previews, hero
 * first. This test walks every authored visual-style record, picks the
 * highest-version source directory for each pack_id, and holds it to the
 * contract. Historical predecessor directories (the ones a successor
 * replaced) are excluded by the same highest-version rule the catalogue
 * index uses.
 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

test('every live visual style on the shelf carries at least three distinct verified previews, hero first', async () => {
  const registry = await readJson(REGISTRY)
  const byPackId = new Map()
  for (const record of registry.records) {
    if (record.kind !== 'visual-style') continue
    if (record.status !== 'authored') continue
    const existing = byPackId.get(record.pack_id)
    if (!existing || compareSemver(record.version, existing.version) > 0) {
      byPackId.set(record.pack_id, record)
    }
  }

  assert.ok(byPackId.size >= 25, `expected at least 25 live visual styles, found ${byPackId.size}`)

  for (const [packId, record] of byPackId) {
    const slug = packId.replace('com.storystudio.pack.style.', '')
    const style = await readJson(inRepo(join(record.source_path, 'content', 'visual-style.json')))
    assert.equal(style.id, `com.storystudio.style.${slug}`, `${packId} item id must match its pack`)
    assert.ok(Array.isArray(style.preview_assets) && style.preview_assets.length >= 3,
      `${packId}@${record.version} must declare at least three preview_assets (owner rule 2026-09-08, reinforced 2026-10-24)`)

    const seen = new Set()
    for (const preview of style.preview_assets) {
      assert.ok(preview.startsWith('assets/') && preview.endsWith('.webp'),
        `${packId}@${record.version} preview ${preview} must be a WebP under assets/`)
      assert.ok(!seen.has(preview), `${packId}@${record.version} repeats preview ${preview}`)
      seen.add(preview)

      const bytes = await readFile(inRepo(join(record.source_path, preview)))
      assert.ok(bytes.length > 20 * 1024,
        `${packId}@${record.version} ${preview} is under the 20 KB floor (${bytes.length} bytes)`)
      const meta = await sharp(bytes).metadata().then(({ format, width, height }) => ({ format, width, height }))
      assert.deepEqual(meta, { format: 'webp', width: 1672, height: 941 },
        `${packId}@${record.version} ${preview} is not a 1672x941 WebP`)
    }

    // Hash-distinct: a style that ships the same bytes twice is not three
    // previews, it is one preview declared three times.
    const digests = await Promise.all(style.preview_assets.map(async preview =>
      sha256(await readFile(inRepo(join(record.source_path, preview))))))
    assert.equal(new Set(digests).size, digests.length,
      `${packId}@${record.version} previews are not hash-distinct`)
  }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { MARKS } from './forbidden-marks.mjs'

const ROOT = new URL('../../../content-packs/production-looks/', import.meta.url)
const REGISTRY = new URL('../../../content-packs/authoring-registry.json', import.meta.url)
// Re-minted on 2026-08-28 when the paint-fantasy pack's identifiers were
// renamed off a third-party mark. The receipt hashes pack_id, item_id and
// source_path, so the rename necessarily produced a new one.
const RECEIPT = 'authoring:6e66133618b8aa71b6650ac93603060cb3f3756e0af8f5fe9199a5fd38944fdf'

const STYLES = {
  'retro-paint-fantasy': {
    name: 'Retro Paint Fantasy',
    description: 'Deliberately rough fantasy art with thick outlines, flat fills, and goofy old-web energy.',
    category: 'Digital',
    tags: ['retro', 'fantasy', 'rough', 'flat color', 'old web'],
    style_bible: 'crude 90s paint-program fantasy art, retro internet animation aesthetic, medieval fantasy atmosphere, thick black outlines, rough hand-drawn lines, flat colors, limited color palette, simple shading, intentionally low-detail rendering, expressive faces, minimal textures, clean digital fill areas, dramatic perspective, wide-angle framing, dynamic off-center composition',
    negative_prompt: 'photorealism, realistic anatomy, cinematic realism, ultra detailed rendering, 3D render, smooth skin, glossy realism, centered composition',
    sha256: '5dced4a83086703f8b49ce8edff43b137126a0c237a8636c35ef6b4d5b3afbc8',
    bytes: 226050,
  },
  'pixel-art-story': {
    name: 'Pixel Art Story',
    description: 'Readable retro RPG pixel art with strong silhouettes and playful adventure framing.',
    category: 'Digital',
    tags: ['pixel', 'retro', 'rpg', 'game', 'fantasy'],
    style_bible: '16-bit pixel art fantasy, retro RPG aesthetic, pixel-defined edges, restricted retro palette, clean sprite-like forms, readable silhouettes, tileable background logic, playful scene staging, side-scrolling adventure energy, simple dramatic lighting translated into pixel clusters',
    negative_prompt: 'photorealism, painterly brushwork, smooth gradients, ultra detailed rendering, 3D render, soft airbrush shading, realistic skin texture, centered static composition',
    sha256: 'f81fd10b04dabff766f993fe6dfecd80611c5e3d61545abc131431650307adf5',
    bytes: 191300,
  },
  'anime-cel': {
    name: 'Anime Cel',
    description: 'Modern anime cel-shading — clean lineart, flat cel light, expressive and vivid.',
    category: 'Digital',
    tags: ['anime', 'cel shading', 'line art', 'vivid', 'character'],
    style_bible: 'modern anime cel-shaded illustration, clean confident lineart, flat cel shading with crisp shadow shapes, vivid but harmonious palette, expressive faces, soft rim light, detailed painted backgrounds, dynamic composition, key-visual quality, subtle gradient skies',
    negative_prompt: 'photorealism, 3D render, western cartoon, muddy colours, sketchy unfinished lines, heavy film grain, realistic skin pores, text, watermark',
    sha256: 'd5c5336ef911b14dec00deee80b112a0d25f70a6e5106cb755f6dc42173f8e18',
    bytes: 270804,
  },
  'studio-catalog-realism': {
    name: 'Studio Catalog Realism',
    description: 'Crisp tabletop realism with neutral surfaces, honest materials, soft studio light, and carefully staged miniature scenes.',
    category: 'Realistic',
    tags: ['studio', 'catalog', 'diorama', 'product', 'miniature'],
    style_bible: 'clean studio catalog photography, carefully staged physical miniature diorama aesthetic, neutral charcoal textured sweep, soft large-source overhead lighting, natural soft-edged shadows, accurate restrained color, crisp tactile materials, centered product-documentation composition, high depth of field, minimal styling, subtle commercial polish, honest documentary clarity, full subject visible with generous breathing room',
    negative_prompt: 'logos, packaging, labels, barcodes, typography, watermark, dramatic cinematic lighting, fantasy digital painting, clutter, glossy CGI, floating objects, extreme shallow depth of field, harsh reflections, oversaturated colors',
    sha256: '60e7b00efb4b6c80e691c6241edcb8a19659a7b069842fd3fb36b11af6a1171e',
    bytes: 239570,
  },
  'whiteboard-doodle-explainer': {
    name: 'Whiteboard Doodle Explainer',
    description: 'Hand-drawn whiteboard doodles — stick figures, big expressive faces, one idea per frame.',
    category: 'Explainer',
    tags: ['whiteboard', 'doodle', 'stick figure', 'marker', 'educational'],
    style_bible: 'simple hand-drawn whiteboard-doodle illustration, thick black marker outlines, smooth rounded shapes, clean vector-like lines, minimal detail, high readability at small sizes, looks quickly sketched on a whiteboard, stick-figure humans with circle heads and simple line bodies, highly expressive faces with big eyes and raised eyebrows showing clear emotion, everyday objects simplified into symbolic icons that can be anthropomorphised with faces and personality for visual metaphor, pure white background, one main idea per image, a large central character or object, generous empty space, no realistic perspective or complex environment, arrows and circles and lines to direct attention, simple icons as visual shortcuts, mostly black-and-white line art with limited flat colour accents reserved for important elements only (blue for important or science or earth, yellow for energy or success or discovery, red for danger or problem, green for nature or growth), no realistic lighting, no cinematic shadows, optional big bold uppercase handwritten marker lettering at the top with only a few words',
    negative_prompt: 'photorealism, 3D render, painterly brushwork, cinematic lighting, realistic shading, gradients, film grain, busy cluttered background, detailed environment, soft airbrush, colour photograph, realistic anatomy',
    sha256: 'e4ed319d2d1a59b2dabea6d94c114fcdd11e808e80bccd7617e203ae41354dcb',
    bytes: 158216,
  },
  'hand-drawn-cartoon-explainer': {
    name: 'Hand-Drawn Cartoon Explainer',
    description: 'Casual explainer-video cartoons with rounded mascots, slightly imperfect ink lines, flat muted colors, and familiar everyday props.',
    category: 'Explainer',
    tags: ['hand drawn', 'cartoon', 'mascot', 'educational', 'flat color', 'online video'],
    style_bible: 'simple hand-drawn 2D cartoon explainer, casual educational online-video animation aesthetic, clean but slightly uneven thick black outlines, flat solid color fills, muted friendly palette of medium blue, teal, sage green, warm yellow, tan, cream, and grey, round-headed simplified characters with oversized outlined circular eyes, dot pupils, bold eyebrows, and small expressive mouths, black line limbs, rounded plain colored torsos, recognizable everyday props, playful anthropomorphic objects and visual metaphors, simple white or pale cream backgrounds, lightly detailed interiors, one clear visual idea or action per frame, readable medium-wide composition, generous breathing room, minimal shading, soft flat visual treatment, slightly wobbly human-drawn contours rather than geometric vector perfection',
    negative_prompt: 'photorealism, 3D render, anime, painterly brushwork, glossy polished vector art, perfectly geometric shapes, cinematic lighting, gradients, complex textures, realistic skin, dense clutter, dramatic depth of field, tiny details, illegible writing, random letters, captions, speech bubbles, watermark',
    sha256: 'ad03fb926514316328776c89684f25e8ee34f0635cfff8d8e9c378d077445b16',
    bytes: 78230,
  },
}

const slugs = Object.keys(STYLES).sort()
/**
 * The 2026-09-08 style preview backfill gave each of the six a 1.0.1 successor
 * carrying the owner's three previews rather than one. The bump is a new
 * sibling directory, so this file now describes two generations: the 1.0.0
 * trees below, frozen exactly as they were, and the `-v1.0.1` trees checked in
 * `SUCCESSOR_VERSION`'s own test. Both are pinned, because the migrated hero
 * bytes have to survive the copy unchanged and the assertion that proves it is
 * worth nothing if it only ever looks at the directory nobody edits.
 */
const SUCCESSOR_VERSION = '1.0.1'
const successorDirectories = slugs.map(slug => `${slug}-v${SUCCESSOR_VERSION}`)
// 2026-11-06 text patches: archived source inventory with the same identity and
// previews, not shipped receipts. Each patches the 1.0.1 successor it follows,
// because the 1.0.0 tree predates the three-preview backfill.
const TEXT_PATCH_DIRECTORIES = [
  { directory: 'pixel-art-story-v1.0.2', predecessor: 'pixel-art-story-v1.0.1' },
  { directory: 'retro-paint-fantasy-v1.0.2', predecessor: 'retro-paint-fantasy-v1.0.1' },
]
const parseJson = async path => JSON.parse(await readFile(path, 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('production looks contain exactly the six receipt-authorized source trees, their successors and archived text patches', async () => {
  const styleRoot = new URL('style/', ROOT)
  const entries = await readdir(styleRoot, { withFileTypes: true })
  assert.deepEqual(
    entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
    [...slugs, ...successorDirectories, ...TEXT_PATCH_DIRECTORIES.map(patch => patch.directory)].sort(),
  )

  // A text patch changes prose only: same identity, same preview bytes, and it
  // is archived source, never a receipt for something that shipped.
  for (const { directory: patchDir, predecessor } of TEXT_PATCH_DIRECTORIES) {
    const baseRoot = new URL(`style/${predecessor}/`, ROOT)
    const patchRoot = new URL(`style/${patchDir}/`, ROOT)
    const patch = await parseJson(new URL('pack.json', patchRoot))
    const base = await parseJson(new URL('pack.json', baseRoot))
    assert.equal(patch.pack_id, base.pack_id, `${patchDir} must keep the same pack identity`)
    assert.ok(patch.version > base.version, `${patchDir} must be a later version`)

    const assetNames = await readdir(new URL('assets/', baseRoot))
    assert.deepEqual(await readdir(new URL('assets/', patchRoot)), assetNames)
    for (const name of assetNames) {
      assert.deepEqual(
        await readFile(new URL(`assets/${name}`, patchRoot)),
        await readFile(new URL(`assets/${name}`, baseRoot)),
        `${patchDir}/${name} must be byte-identical to ${predecessor}`,
      )
    }

    const patchDoc = await parseJson(new URL('content/visual-style.json', patchRoot))
    const baseDoc = await parseJson(new URL('content/visual-style.json', baseRoot))
    assert.notEqual(patchDoc.style_bible, baseDoc.style_bible, `${patchDir} must genuinely change its prose`)
  }

  const registry = await parseJson(REGISTRY)
  assert.ok(registry.revision >= 43, `registry revision ${registry.revision} predates the production-looks reservation`)
  const receiptRecords = registry.records.filter(record => record.receipt_ref === RECEIPT)
  assert.equal(receiptRecords.length, 6)

  for (const slug of slugs) {
    const expected = STYLES[slug]
    const sourceRoot = new URL(`style/${slug}/`, ROOT)
    const record = receiptRecords.find(candidate => candidate.source_path.endsWith(`/${slug}`))
    assert.ok(record, `${slug} must have a receipt record`)
    assert.equal(record.receipt_ref, RECEIPT)
    assert.equal(record.pack_id, `com.storystudio.pack.style.${slug}`)
    assert.equal(record.item_id, `com.storystudio.style.${slug}`)
    assert.equal(record.version, '1.0.0')
    assert.equal(record.publisher_id, 'com.storystudio')
    assert.equal(record.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(record.min_app_version_status, 'release-bound')
    assert.equal(record.kind, 'visual-style')
    assert.equal(record.status, 'authored')
    assert.equal(record.source_path, `content-packs/production-looks/style/${slug}`)
    assert.deepEqual(record.dependencies, [])
    assert.equal(record.stocking_proposal.family.id, `com.storystudio.family.style.${slug}`)
    assert.equal(record.stocking_proposal.sku.id, `com.storystudio.sku.style.${slug}`)
    assert.deepEqual((await readdir(sourceRoot)).sort(), ['assets', 'content', 'pack.json'])
    assert.deepEqual(await readdir(new URL('assets/', sourceRoot)), [`${slug}.webp`])
    assert.deepEqual(await readdir(new URL('content/', sourceRoot)), ['visual-style.json'])
    const manifest = await parseJson(new URL('pack.json', sourceRoot))
    assert.deepEqual(manifest, {
      pack_format: 1,
      pack_id: record.pack_id,
      publisher_id: record.publisher_id,
      key_id: '{{KEY_ID}}',
      version: record.version,
      min_app_version: record.min_app_version,
      lifecycle: 'active',
      entitlement: {
        sku: record.stocking_proposal.sku.id,
        family: record.stocking_proposal.family.id,
      },
    })

    const style = await parseJson(new URL('content/visual-style.json', sourceRoot))
    assert.deepEqual(style, {
      kind: 'visual-style',
      schema_version: 1,
      id: record.item_id,
      name: expected.name,
      description: expected.description,
      category: expected.category,
      tags: expected.tags,
      style_bible: expected.style_bible,
      negative_prompt: expected.negative_prompt,
      preview_assets: [`assets/${slug}.webp`],
      compatible_formula_ids: [],
    })

    const manifestText = await readFile(new URL('pack.json', sourceRoot), 'utf8')
    const styleText = await readFile(new URL('content/visual-style.json', sourceRoot), 'utf8')
    assert.doesNotMatch(manifestText, /builtin-/)
    assert.doesNotMatch(styleText, /builtin-/)
  }
})

test('production look previews preserve approved bytes and complete provenance evidence', async () => {
  const provenance = await readFile(new URL('PREVIEW-PROVENANCE.md', ROOT), 'utf8')

  for (const slug of slugs) {
    const expected = STYLES[slug]
    const assetPath = `content-packs/production-looks/style/${slug}/assets/${slug}.webp`
    const destinationBytes = await readFile(join(process.cwd(), assetPath))

    assert.equal(destinationBytes.length, expected.bytes)
    assert.ok(destinationBytes.length > 20 * 1024)
    assert.equal(sha256(destinationBytes), expected.sha256)
    assert.deepEqual(
      await sharp(destinationBytes).metadata().then(({ format, width, height }) => ({ format, width, height })),
      { format: 'webp', width: 1672, height: 941 },
    )

    for (const evidence of [`com.storystudio.style.${slug}`, assetPath, expected.sha256, String(expected.bytes), '1672x941', 'WebP decode passed']) {
      assert.ok(provenance.includes(evidence), `${slug} provenance must record ${evidence}`)
    }
  }
})

/**
 * The 1.0.1 successors from the 2026-09-08 preview backfill.
 *
 * WHAT THIS HAS TO CATCH. The hero bytes in these six are owner-approved
 * migrations, and the bump copied them into a new directory. A copy is exactly
 * the operation that silently re-encodes, so the hero digest is asserted again
 * here against the same constant the 1.0.0 test uses — if the two ever diverge,
 * the migration approval no longer covers what ships. The other half is that
 * the successor actually gained the two previews it was bumped for, at the
 * contract size, above the floor, and declared hero-first.
 */
test('every production look successor carries three previews and an unchanged migrated hero', async () => {
  const registry = await parseJson(REGISTRY)

  for (const slug of slugs) {
    const expected = STYLES[slug]
    const directory = `${slug}-v${SUCCESSOR_VERSION}`
    const sourceRoot = new URL(`style/${directory}/`, ROOT)
    const sourcePath = `content-packs/production-looks/style/${directory}`

    assert.deepEqual((await readdir(sourceRoot)).sort(), ['assets', 'content', 'pack.json'])
    assert.deepEqual(
      (await readdir(new URL('assets/', sourceRoot))).sort(),
      [`${slug}-face.webp`, `${slug}-scene.webp`, `${slug}.webp`],
    )

    const manifest = await parseJson(new URL('pack.json', sourceRoot))
    assert.equal(manifest.pack_id, `com.storystudio.pack.style.${slug}`)
    assert.equal(manifest.version, SUCCESSOR_VERSION)
    assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
    assert.equal(manifest.lifecycle, 'active')
    assert.ok(manifest.changelog, `${slug} successor must say what the bump changed`)

    const style = await parseJson(new URL('content/visual-style.json', sourceRoot))
    assert.equal(style.id, `com.storystudio.style.${slug}`)
    assert.equal(style.style_bible, expected.style_bible)
    assert.equal(style.negative_prompt, expected.negative_prompt)
    assert.deepEqual(style.preview_assets, [
      `assets/${slug}.webp`,
      `assets/${slug}-scene.webp`,
      `assets/${slug}-face.webp`,
    ])

    // The hero is the approved migration. A bump may not re-encode it.
    const hero = await readFile(join(process.cwd(), sourcePath, 'assets', `${slug}.webp`))
    assert.equal(hero.length, expected.bytes)
    assert.equal(sha256(hero), expected.sha256)

    for (const preview of style.preview_assets) {
      const bytes = await readFile(join(process.cwd(), sourcePath, preview))
      assert.ok(bytes.length > 20 * 1024, `${sourcePath}/${preview} is under the 20 KB floor`)
      assert.deepEqual(
        await sharp(bytes).metadata().then(({ format, width, height }) => ({ format, width, height })),
        { format: 'webp', width: 1672, height: 941 },
      )
    }

    const record = registry.records.find(candidate =>
      candidate.pack_id === manifest.pack_id && candidate.version === SUCCESSOR_VERSION)
    assert.ok(record, `${slug} ${SUCCESSOR_VERSION} must have a registry record`)
    assert.equal(record.item_id, style.id)
    assert.equal(record.kind, 'visual-style')
    assert.equal(record.status, 'authored')
    assert.equal(record.source_path, sourcePath)
    assert.equal(record.min_app_version_status, 'release-bound')
  }
})

/**
 * These six are sold. A third-party product mark in the text a customer reads
 * or searches is a commercial exposure, not a wording preference.
 *
 * The owner ruled twice on 2026-08-28: rename the paint-fantasy product away
 * from the Microsoft mark, and scrub `YouTube` from the cartoon explainer's
 * description, tags and style bible. Both marks had reached customer-visible
 * text once already, so this pins their absence rather than trusting review to
 * catch a reintroduction.
 *
 * Scope is deliberately the six PRE-STOCK Production Looks. Already-published
 * packs are not swept here: changing those means new versions and
 * republication, which is a different decision with a different cost.
 */
// MARKS is imported from ./forbidden-marks.mjs rather than declared here, so that
// widening the list widens this guard and the published-pack scrub guard together
// instead of only whichever one happened to be in hand. Both surfaces hoisted the
// same literal on the same day; the shared module is where the two agreed to meet.

test('no sold Production Look carries a third-party product mark in customer-visible text', async () => {
  // Both generations. A successor is the surface a buyer actually acquires, so
  // sweeping only the 1.0.0 tree would leave the shipped text unguarded.
  for (const directory of [...slugs, ...successorDirectories]) {
    const slug = directory
    const style = await parseJson(new URL(`style/${directory}/content/visual-style.json`, ROOT))

    // Everything the customer can read or search.
    const surfaces = [
      ['name', style.name], ['description', style.description], ['tags', style.tags.join(' ')],
      ['style_bible', style.style_bible], ['negative_prompt', style.negative_prompt],
    ]

    for (const [field, text] of surfaces) {
      for (const mark of MARKS) {
        assert.ok(!mark.test(text), `${slug} ${field} names a third-party product mark (${mark}): ${text}`)
      }
    }
  }
})

/**
 * The same ruling, one surface further out.
 *
 * A built-in Formula's `visualStyleHint` is art direction the customer reads
 * and edits in the format-override editor. On 2026-08-28 `ancient-humans.json`
 * still asked for "hand-drawn MS Paint storybook frames" — the exact mark the
 * six Production Looks had just been scrubbed of, sitting outside every list
 * that scrub worked from. Rewritten to "hand-drawn 90s paint-program storybook
 * frames", the wording the renamed product's own style bible already uses.
 *
 * This test still checks `visualStyleHint` ALONE, but no longer because the
 * other hints are allowed to name the platform. When it was written,
 * `metadataTitleStyleHint` and the thumbnail guidance were left naming YouTube
 * on the theory that a reference to where the episode is published is
 * functional rather than borrowed art direction — and, decisively, they were
 * pinned to published pack bytes and could not be touched.
 *
 * The owner's 2026-08-28 ruling went the other way on the wording: the thirteen
 * mark-scrub successors say "episode title" and "in a video feed", and on
 * 2026-08-29 they were published and the live copy moved with them. Every one
 * of those hints is now clean, and `published-mark-scrub.test.mjs` enforces it
 * across every built-in document with no exception list.
 *
 * What stays platform-named is the app's real integration surface — upload, the
 * finalizer, OAuth, playlists, category lookup. Naming the service you upload
 * to is not the exposure the ruling was about.
 */
test('no built-in Formula asks for a third-party product by name in its art direction', async () => {
  const NICHES = new URL('../../../electron/server/niches/', import.meta.url)
  const files = (await readdir(NICHES)).filter(name => name.endsWith('.json')).sort()

  assert.ok(files.length >= 20, `expected the built-in Formula catalog, saw ${files.length} files`)

  for (const file of files) {
    const hint = (await parseJson(new URL(file, NICHES))).visualStyleHint
    if (typeof hint !== 'string') continue
    for (const mark of MARKS) {
      assert.ok(!mark.test(hint), `${file} visualStyleHint names a third-party product mark (${mark}): ${hint}`)
    }
  }
})

/**
 * The same rule, applied to identifiers rather than prose.
 *
 * WHY THIS EXISTS SEPARATELY. On 2026-08-25 this pack's display name was
 * changed to Retro Paint Fantasy and its identifiers were deliberately left
 * alone, to preserve the receipt chain. That reasoning assumed an id is
 * internal. It is not: `pack_id` is printed on the permanent Installed tab of
 * the Content Store, it names the `.sspack` file a buyer downloads, it becomes
 * a directory under the customer's Application Support tree, and it is a key
 * inside the `project.json` in their own project folder. An id also freezes
 * permanently at first sale, where prose can still be edited. So the id is the
 * HARDER surface to fix, not the softer one, and it is guarded here.
 *
 * Separators differ from prose — an identifier writes `ms-paint`, not
 * `MS Paint` — so the prose patterns are rewritten to treat `-`, `_`, `.` and
 * whitespace alike. `\b` cannot survive that rewrite, because `_` is a word
 * character and would make `ms_paint_fantasy` slip through, so the ends become
 * explicit alphanumeric lookarounds. The mark list itself is shared with the
 * prose test above so the two can never drift apart.
 */
test('no sold Production Look carries a third-party product mark in any identifier', async () => {
  const IDENTIFIER_MARKS = MARKS.map(mark => {
    assert.match(mark.source, /^\\b.*\\b$/,
      `mark ${mark} is not word-bounded at both ends, so it cannot be rewritten for identifiers`)
    const body = mark.source.slice(2, -2).replaceAll('\\s*', '[\\s._-]*')
    return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i')
  })
  const registry = await parseJson(REGISTRY)
  const records = registry.records.filter(record => record.receipt_ref === RECEIPT)
  assert.equal(records.length, 6)

  // Both generations again, for the same reason, and because the backfill
  // introduced two new asset filenames per pack that nothing else pins.
  for (const directory of [...slugs, ...successorDirectories]) {
    const slug = directory
    const sourceRoot = new URL(`style/${directory}/`, ROOT)
    const manifest = await parseJson(new URL('pack.json', sourceRoot))
    const style = await parseJson(new URL('content/visual-style.json', sourceRoot))
    const record = registry.records.find(candidate =>
      candidate.pack_id === manifest.pack_id && candidate.version === manifest.version)
    assert.ok(record, `${slug} must have a registry record to check`)

    // Every name a customer can see, be handed as a file, or find on disk.
    const identifiers = [
      ['directory name', slug],
      ['manifest pack_id', manifest.pack_id],
      ['manifest sku', manifest.entitlement.sku],
      ['manifest family', manifest.entitlement.family],
      ['item id', style.id],
      ...style.preview_assets.map((asset, index) => [`preview_assets[${index}]`, asset]),
      ...(await readdir(new URL('assets/', sourceRoot))).map(name => [`asset filename ${name}`, name]),
      ['registry pack_id', record.pack_id],
      ['registry item_id', record.item_id],
      ['registry source_path', record.source_path],
      ['registry family', record.stocking_proposal.family.id],
      ['registry sku', record.stocking_proposal.sku.id],
    ]

    for (const [field, value] of identifiers) {
      for (const mark of IDENTIFIER_MARKS) {
        assert.ok(!mark.test(value), `${slug} ${field} carries a third-party product mark (${mark}): ${value}`)
      }
    }
  }
})

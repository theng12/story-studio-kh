import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../content-packs/production-looks/', import.meta.url)
const REGISTRY = new URL('../../../content-packs/authoring-registry.json', import.meta.url)
const LEGACY_SOURCE = new URL('../../../frontend/composables/useBuiltInStyles.ts', import.meta.url)
const unregister = register()
const { BUILT_IN_STYLES } = await import(LEGACY_SOURCE)
unregister()
// Re-minted on 2026-08-28 when the paint-fantasy pack's identifiers were
// renamed off a third-party mark. The receipt hashes pack_id, item_id and
// source_path, so the rename necessarily produced a new one.
const RECEIPT = 'authoring:6e66133618b8aa71b6650ac93603060cb3f3756e0af8f5fe9199a5fd38944fdf'

const STYLES = {
  'retro-paint-fantasy': {
    // The product slug was renamed off a third-party mark before this pack was
    // ever stocked. The legacy built-in it was productised from keeps the old
    // slug — existing projects pin `builtin-ms-paint-fantasy` in their
    // `active_style_preset_id`, and the shipped swatch is named for it — so
    // only the rows that reach back to that legacy record use `legacy`.
    legacy: 'ms-paint-fantasy',
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
// The slug the legacy built-in record and its shipped swatch are named for.
// Identical to the product slug for five of the six.
const legacySlug = slug => STYLES[slug].legacy ?? slug
const parseJson = async path => JSON.parse(await readFile(path, 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('production looks contain exactly the six receipt-authorized source trees', async () => {
  const styleRoot = new URL('style/', ROOT)
  const entries = await readdir(styleRoot, { withFileTypes: true })
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(), slugs)

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
    // Parity is checked against the evaluated legacy record, not against the
    // source text. A quoting or formatting change in useBuiltInStyles.ts must
    // not be able to pass or fail this on its own.
    const legacy = BUILT_IN_STYLES.find(candidate => candidate.id === `builtin-${legacySlug(slug)}`)
    assert.ok(legacy, `${slug} must still have a legacy built-in record to be a faithful productisation of`)
    assert.deepEqual({
      name: expected.name,
      blurb: expected.description,
      category: expected.category,
      tags: expected.tags,
      data: { style_bible: expected.style_bible, negative_prompt: expected.negative_prompt },
    }, {
      name: legacy.name,
      blurb: legacy.blurb,
      category: legacy.category,
      tags: legacy.tags,
      data: legacy.data,
    }, `${slug} must retain its legacy renderer contract`)

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
    const sourcePath = `frontend/public/builtin-style-previews/${legacySlug(slug)}.webp`
    const destinationPath = `content-packs/production-looks/style/${slug}/assets/${slug}.webp`
    const sourceBytes = await readFile(join(process.cwd(), sourcePath))
    const destinationBytes = await readFile(join(process.cwd(), destinationPath))

    assert.equal(destinationBytes.length, expected.bytes)
    assert.ok(destinationBytes.length > 20 * 1024)
    assert.equal(sha256(sourceBytes), expected.sha256)
    assert.equal(sha256(destinationBytes), expected.sha256)
    assert.deepEqual(destinationBytes, sourceBytes)
    assert.deepEqual(
      await sharp(destinationBytes).metadata().then(({ format, width, height }) => ({ format, width, height })),
      { format: 'webp', width: 1672, height: 941 },
    )

    for (const evidence of [sourcePath, destinationPath, `builtin-${legacySlug(slug)}`, expected.sha256, String(expected.bytes), '1672x941', 'WebP decode passed', 'byte-identical']) {
      assert.ok(provenance.includes(evidence), `${slug} provenance must record ${evidence}`)
    }
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
 * Scope is deliberately the six PRE-STOCK Production Looks and the legacy
 * records they were productised from. Already-published packs are not swept
 * here: changing those means new versions and republication, which is a
 * different decision with a different cost.
 */
// Word-boundary matched so ordinary words are never caught by accident.
const MARKS = [/\bMS\s*Paint\b/i, /\bMicrosoft\b/i, /\bYouTube\b/i, /\bPhotoshop\b/i, /\bIllustrator\b/i, /\bTikTok\b/i, /\bInstagram\b/i]

test('no sold Production Look carries a third-party product mark in customer-visible text', async () => {
  for (const slug of slugs) {
    const style = await parseJson(new URL(`style/${slug}/content/visual-style.json`, ROOT))
    const legacy = BUILT_IN_STYLES.find(candidate => candidate.id === `builtin-${legacySlug(slug)}`)

    // Everything the customer can read or search, from both surfaces.
    const surfaces = [
      ['name', style.name], ['description', style.description], ['tags', style.tags.join(' ')],
      ['style_bible', style.style_bible], ['negative_prompt', style.negative_prompt],
      ['legacy name', legacy.name], ['legacy blurb', legacy.blurb], ['legacy tags', legacy.tags.join(' ')],
      ['legacy style_bible', legacy.data.style_bible], ['legacy negative_prompt', legacy.data.negative_prompt],
    ]

    for (const [field, text] of surfaces) {
      for (const mark of MARKS) {
        assert.ok(!mark.test(text), `${slug} ${field} names a third-party product mark (${mark}): ${text}`)
      }
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

  for (const slug of slugs) {
    const sourceRoot = new URL(`style/${slug}/`, ROOT)
    const manifest = await parseJson(new URL('pack.json', sourceRoot))
    const style = await parseJson(new URL('content/visual-style.json', sourceRoot))
    const record = records.find(candidate => candidate.pack_id === manifest.pack_id)
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

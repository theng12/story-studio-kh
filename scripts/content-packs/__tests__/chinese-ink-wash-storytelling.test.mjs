import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

const SOURCE = join(process.cwd(), 'content-packs/storytelling-looks/style/chinese-ink-wash-storytelling')
const PREVIEW = join(SOURCE, 'assets/chinese-ink-wash-storytelling.webp')
const REGISTRY = join(process.cwd(), 'content-packs/authoring-registry.json')
const PACK_ID = 'com.storystudio.pack.style.chinese-ink-wash-storytelling'
const ITEM_ID = 'com.storystudio.style.chinese-ink-wash-storytelling'
const RECEIPT = 'authoring:544cc9ae4d80604d5a14b8683f3accb25c11d5386a63751947276d4ef4cc8353'
const PREVIEW_SHA256 = 'b31459ec20c7e59c4907a04106b8c87b3f5e3cf8e39d91c4b2f94ed99a26e6e4'
const STYLE_BIBLE = 'Monochrome Chinese ink-wash narrative on warm ivory rice/xuan paper; variable-pressure calligraphic contours, diluted pooled ink, wet blooms, dry-brush texture, soft feathered edges, and restrained hatching. Use near-black anchors, active negative space, and mist-layered depth around one subject or a small grouping. Favor asymmetrical spacious narrative framing, selective detail, and contemplative literati stillness; keep the style content-independent with no fixed character, prop, era, location, or composition.'
const NEGATIVE_PROMPT = 'sepia or foxed expedition-journal styling, lamplight, edge vignette, colored watercolor, storybook, pastel, gouache, oil paint, photorealism, CGI, vector, cartoon, anime, infographic, readable text or calligraphy, seals, chops, signatures, logos, watermarks, UI, interface bars, borders, letterbox, pillarbox, copied reference composition'

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('Chinese Ink-Wash Storytelling is a standalone, preview-gated visual-style source contract', async () => {
  const manifest = await json(join(SOURCE, 'pack.json'))
  const style = await json(join(SOURCE, 'content/visual-style.json'))
  const registry = await json(REGISTRY)
  const record = registry.records.find(candidate => candidate.pack_id === PACK_ID && candidate.version === '1.0.0')

  assert.ok(record, 'registry must contain the exact pack version')
  assert.equal(record.receipt_ref, RECEIPT)
  assert.equal(record.status, 'authored')
  assert.equal(record.item_id, ITEM_ID)
  assert.equal(record.source_path, 'content-packs/storytelling-looks/style/chinese-ink-wash-storytelling')
  assert.deepEqual(record.dependencies, [])
  assert.equal(record.stocking_proposal.family.id, 'com.storystudio.family.style.chinese-ink-wash-storytelling')
  assert.equal(record.stocking_proposal.sku.id, 'com.storystudio.sku.style.chinese-ink-wash-storytelling')

  assert.deepEqual(manifest, {
    pack_format: 1,
    pack_id: PACK_ID,
    publisher_id: 'com.storystudio',
    key_id: '{{KEY_ID}}',
    version: '1.0.0',
    min_app_version: '{{MIN_APP_VERSION}}',
    lifecycle: 'active',
    entitlement: {
      sku: 'com.storystudio.sku.style.chinese-ink-wash-storytelling',
      family: 'com.storystudio.family.style.chinese-ink-wash-storytelling',
    },
  })
  assert.deepEqual(style, {
    kind: 'visual-style',
    schema_version: 1,
    id: ITEM_ID,
    name: 'Chinese Ink-Wash Storytelling',
    description: 'Monochrome brush-and-wash storytelling with calligraphic contours, wet blooms, dry-brush texture, and spacious rice-paper compositions.',
    category: 'Illustration',
    tags: ['chinese ink painting', 'ink wash', 'brush painting', 'monochrome', 'rice paper', 'calligraphic', 'literati'],
    style_bible: STYLE_BIBLE,
    negative_prompt: NEGATIVE_PROMPT,
    preview_assets: ['assets/chinese-ink-wash-storytelling.webp'],
    compatible_formula_ids: [],
  })
  for (const previewOnlySubject of [
    'hand-and-coin',
    'bowed robed figure',
    'temple-gate traveler',
    'vessel arrangement',
    'mountain arrangement',
    'scroll-and-brush',
  ]) {
    assert.equal(style.negative_prompt.includes(previewOnlySubject), false,
      `runtime negative prompt must not suppress valid customer subject matter: ${previewOnlySubject}`)
  }
  assert.deepEqual(await readdir(join(SOURCE, 'content')), ['visual-style.json'])

  const previewExists = await access(PREVIEW).then(() => true).catch(() => false)
  assert.equal(previewExists, true, `missing verified preview: ${PREVIEW}`)
  const metadata = await sharp(PREVIEW).metadata()
  assert.deepEqual({ format: metadata.format, width: metadata.width, height: metadata.height }, {
    format: 'webp',
    width: 1672,
    height: 941,
  })
  const previewBytes = await readFile(PREVIEW)
  assert.ok(previewBytes.byteLength > 20 * 1024, 'preview must exceed 20 KB')
  assert.equal(createHash('sha256').update(previewBytes).digest('hex'), PREVIEW_SHA256)

  const provenance = await readFile(join(process.cwd(), 'content-packs/storytelling-looks/PREVIEW-PROVENANCE.md'), 'utf8')
  for (const evidence of [
    ITEM_ID,
    'assets/chinese-ink-wash-storytelling.webp',
    PREVIEW_SHA256,
    '315978 bytes',
    '1672x941',
    'WebP decode passed',
    'GPT built-in image generation',
    'reference_images: []',
  ]) {
    assert.ok(provenance.includes(evidence), `preview provenance must record ${evidence}`)
  }
})

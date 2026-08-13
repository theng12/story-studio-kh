import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  ContentPackBundleSchema,
  ContentPackDocumentSchema,
  ContentPackManifestSchema,
  parseContentPackDocument,
  parseContentPackManifest,
} from '../content-packs/schemas.js'

const SHA256 = 'a'.repeat(64)

const manifest = {
  pack_format: 1,
  pack_id: 'com.storystudio.bundle.hidden-mechanics',
  publisher_id: 'com.storystudio',
  key_id: 'com.storystudio.key.primary',
  version: '1.2.3',
  min_app_version: '1.0.832',
  lifecycle: 'active',
  entitlement: {
    sku: 'com.storystudio.sku.hidden-mechanics',
    family: 'com.storystudio.family.hidden-mechanics',
  },
  items: [
    {
      id: 'com.storystudio.formula.hidden-mechanics-history',
      kind: 'series-formula',
      schema_version: 1,
      path: 'content/formula.json',
    },
    {
      id: 'com.storystudio.topic.historical-finance',
      kind: 'topic-pack',
      schema_version: 1,
      path: 'content/topic-pack.json',
    },
    {
      id: 'com.storystudio.style.archival-documentary',
      kind: 'visual-style',
      schema_version: 1,
      path: 'content/visual-style.json',
    },
    {
      id: 'com.storystudio.thumbnail.archival-map',
      kind: 'thumbnail-recipe',
      schema_version: 1,
      path: 'content/thumbnail-recipe.json',
    },
  ],
  bundles: [{
    id: 'com.storystudio.bundle.hidden-mechanics',
    kind: 'channel-kit',
    name: 'Hidden Mechanics of History',
    component_ids: [
      'com.storystudio.formula.hidden-mechanics-history',
      'com.storystudio.topic.historical-finance',
      'com.storystudio.style.archival-documentary',
      'com.storystudio.thumbnail.archival-map',
    ],
  }],
  files: [
    { path: 'content/formula.json', sha256: SHA256, bytes: 100, mime: 'application/json' },
    { path: 'content/topic-pack.json', sha256: SHA256, bytes: 100, mime: 'application/json' },
    { path: 'content/visual-style.json', sha256: SHA256, bytes: 100, mime: 'application/json' },
    { path: 'content/thumbnail-recipe.json', sha256: SHA256, bytes: 100, mime: 'application/json' },
    { path: 'assets/style-preview.webp', sha256: SHA256, bytes: 100, mime: 'image/webp' },
  ],
} as const

const documents = {
  'series-formula': {
    kind: 'series-formula', schema_version: 1,
    id: 'com.storystudio.formula.hidden-mechanics-history',
    name: 'Hidden Mechanics of History', description: 'Explains historical systems.',
    channel_promise: 'Reveal the systems behind historical events.',
    audience: 'Curious history viewers.',
    narrative_rules: ['Open with the mechanism.', 'Explain causality clearly.'],
    title_rules: ['Name the historical system.'],
    script_structure: ['Hook', 'Mechanism', 'Consequences'],
    compatible_topic_pack_ids: ['com.storystudio.topic.historical-finance'],
    recommended_visual_style_ids: ['com.storystudio.style.archival-documentary'],
    recommended_thumbnail_recipe_ids: ['com.storystudio.thumbnail.archival-map'],
  },
  'topic-pack': {
    kind: 'topic-pack', schema_version: 1,
    id: 'com.storystudio.topic.historical-finance',
    name: 'Historical Finance', description: 'Institutions and money in history.',
    compatible_formula_ids: ['com.storystudio.formula.hidden-mechanics-history'],
    subjects: ['Roman tax farming'], episode_objects: ['Publicani contracts'],
    time_place_scopes: ['Roman Republic, Mediterranean'], mechanisms: ['Revenue extraction'],
    evidence_lenses: ['Administrative records'], exclusions: ['Modern personal finance'],
    max_siblings_per_subject: 4, prompt_context: 'Use concrete institutions and evidence.',
  },
  'visual-style': {
    kind: 'visual-style', schema_version: 1,
    id: 'com.storystudio.style.archival-documentary',
    name: 'Archival Documentary', description: 'Measured archival texture.', category: 'documentary',
    tags: ['archival', 'historical'], style_bible: 'Aged archive film with restrained contrast.',
    negative_prompt: 'No text in image.', preview_assets: ['assets/style-preview.webp'],
    compatible_formula_ids: ['com.storystudio.formula.hidden-mechanics-history'],
  },
  'thumbnail-recipe': {
    kind: 'thumbnail-recipe', schema_version: 1,
    id: 'com.storystudio.thumbnail.archival-map',
    name: 'Archival Map', description: 'Hero map with a single focal subject.',
    layout: 'hero', composition_guidance: 'Use a map as the supporting visual.',
    required_elements: ['one focal historical object'], avoid_elements: ['tiny unreadable labels'],
    headline_mode: 'title', headline_rules: ['Keep the title concise.'],
    text_style: 'bold historical documentary', preview_assets: ['assets/style-preview.webp'],
    compatible_formula_ids: ['com.storystudio.formula.hidden-mechanics-history'],
  },
} as const

function assertRejected(value: unknown, matcher?: RegExp): void {
  if (matcher) assert.throws(() => parseContentPackManifest(value), matcher)
  else assert.throws(() => parseContentPackManifest(value))
}

describe('Content Pack v1 contracts', () => {
  test('accepts a strict manifest with all four initial content item kinds', () => {
    const parsed = parseContentPackManifest(manifest)
    assert.equal(parsed.pack_id, manifest.pack_id)
    assert.deepEqual(parsed.items.map(item => item.kind), [
      'series-formula', 'topic-pack', 'visual-style', 'thumbnail-recipe',
    ])
    assert.equal(ContentPackManifestSchema.parse(manifest).version, '1.2.3')
  })

  test('accepts one strict document of every initial content kind', () => {
    for (const [kind, document] of Object.entries(documents)) {
      const parsed = parseContentPackDocument(kind as keyof typeof documents, document)
      assert.equal(parsed.kind, kind)
      assert.equal(ContentPackDocumentSchema.parse(document).id, document.id)
    }
  })

  test('treats a channel kit as a manifest bundle reference rather than a content document', () => {
    assert.equal(ContentPackBundleSchema.parse(manifest.bundles[0]).kind, 'channel-kit')
    assert.throws(() => ContentPackDocumentSchema.parse({ ...manifest.bundles[0], schema_version: 1 }), /kind/i)
  })

  test('rejects unknown fields anywhere in the manifest or a content document', () => {
    assertRejected({ ...manifest, untrusted: true }, /unrecognized key/i)
    assert.throws(() => ContentPackDocumentSchema.parse({ ...documents['visual-style'], untrusted: true }), /unrecognized key/i)
  })

  test('rejects non-namespaced IDs and IDs outside the publisher namespace', () => {
    assertRejected({ ...manifest, pack_id: 'hidden-mechanics' }, /qualified/i)
    assertRejected({
      ...manifest,
      items: [{ ...manifest.items[0], id: 'com.someoneelse.formula.hidden-mechanics-history' }, ...manifest.items.slice(1)],
    }, /publisher namespace/i)
  })

  test('rejects prerelease, ranged, and malformed semantic versions', () => {
    for (const version of ['1.2', '^1.2.3', '>=1.2.3', '1.2.3-beta', 'v1.2.3']) {
      assertRejected({ ...manifest, version }, /semantic version/i)
    }
  })

  test('rejects range dependencies and item paths that are not declared files', () => {
    assertRejected({
      ...manifest,
      dependencies: [{ pack_id: 'com.storystudio.topic.historical-finance', version: '^1.0.0' }],
    }, /semantic version/i)
    assertRejected({
      ...manifest,
      items: [{ ...manifest.items[0], path: 'content/not-declared.json' }, ...manifest.items.slice(1)],
    }, /declared file/i)
  })

  test('rejects unsupported MIME types and executable-looking file extensions', () => {
    assertRejected({
      ...manifest,
      files: [...manifest.files.slice(0, 4), { ...manifest.files[4], path: 'assets/preview.svg', mime: 'image/svg+xml' }],
    }, /MIME|extension/i)
    assertRejected({
      ...manifest,
      files: [{ ...manifest.files[0], path: 'content/formula.js' }, ...manifest.files.slice(1)],
    }, /MIME|extension/i)
  })

  test('rejects URLs and provider or model identifiers in documents', () => {
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['visual-style'], style_bible: 'Use https://example.test/style.json',
    }), /URL/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['visual-style'], provider_id: 'provider-x',
    }), /unrecognized key/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['visual-style'], model_id: 'model-x',
    }), /unrecognized key/i)
  })
})

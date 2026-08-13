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
  changelog: 'Adds the first archival documentary channel kit.',
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
    components: [
      { pack_id: 'com.storystudio.bundle.hidden-mechanics', version: '1.2.3', item_id: 'com.storystudio.formula.hidden-mechanics-history', kind: 'series-formula' },
      { pack_id: 'com.storystudio.bundle.hidden-mechanics', version: '1.2.3', item_id: 'com.storystudio.topic.historical-finance', kind: 'topic-pack' },
      { pack_id: 'com.storystudio.bundle.hidden-mechanics', version: '1.2.3', item_id: 'com.storystudio.style.archival-documentary', kind: 'visual-style' },
      { pack_id: 'com.storystudio.bundle.hidden-mechanics', version: '1.2.3', item_id: 'com.storystudio.thumbnail.archival-map', kind: 'thumbnail-recipe' },
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
    formula_family: 'Evidence and systems', tagline: 'The forces beneath the familiar story.',
    perspective_policy: 'Third-person evidence-led documentary narration.',
    narrative_quality_contract: {
      opening_policy: 'Open on an actual outcome or dated decision.',
      forbidden_patterns: ['Invented quotations', 'False certainty'],
      required_habits: ['Separate evidence, inference, and interpretation.'],
      closing_policy: 'State the best-supported account and uncertainty.',
    },
    opening_profile: { id: 'documentary-outcome', label: 'Documentary outcome', description: 'Begin with the dated outcome.' },
    metadata_profile: {
      id: 'history-youtube', label: 'History YouTube', description: 'Evidence-led publishing copy.',
      description_section_ids: ['hook', 'sources'], title_mode: 'use_idea_title',
      description_max_chars: 3000, title_max_length: 100, tag_count: 12,
    },
    production_kit: {
      id: 'hidden-mechanics-kit', label: 'Hidden Mechanics Kit', description: 'Coherent history production primitives.',
      recommended_visual_style_id: 'com.storystudio.style.archival-documentary',
      episode_profiles: [{ id: 'default', label: 'Default', description: 'Evidence-led documentary.', idea_axis_value: 'default', narrator_style_id: 'historical-investigator' }],
    },
    narrative_rules: ['Open with the mechanism.', 'Explain causality clearly.'],
    title_rules: ['Name the historical system.'],
    script_structure: {
      default_chapter_count: 9, chapter_count_range: [9, 9], default_length_minutes: 36,
      length_minutes_range: [30, 45], duration_presets: [30, 36, 45], default_words_per_minute: 140,
      chapters_independent: true, pacing_arc: ['Outcome', 'Mechanism'], additional_rules: ['Distinguish evidence from inference.'],
    },
    compatible_topic_pack_ids: ['com.storystudio.topic.historical-finance'],
    default_topic_pack_ids: ['com.storystudio.topic.historical-finance'],
    recommended_visual_style_ids: ['com.storystudio.style.archival-documentary'],
    recommended_thumbnail_recipe_ids: ['com.storystudio.thumbnail.archival-map'],
    idea_axes: [{ id: 'causal-mechanism', label: 'Causal mechanism', values: ['state capacity', 'fiscal pressure'] }],
    vocabulary: { mood: ['measured'], theme: ['causation'], genre: ['history documentary'], keyword: ['history explained'] },
    audience_hint: 'Viewers seeking evidence-led explanations.',
    idea_system_prompt_role: 'Generate original historical-causality documentary ideas.',
    idea_guidance_text: 'Honor every assigned causal dimension.',
    script_context: 'Name dates, places, actors, institutions, and source types when supported.',
    script_system_prompt_role: 'Write a meticulous history documentary.',
    script_closing_hint: 'Return to the outcome and remaining uncertainty.',
    narrator_styles: [{ id: 'historical-investigator', label: 'Historical investigator', description: 'Measured and evidence-forward.' }],
    default_narrator_style_id: 'historical-investigator',
    title_shape_rules: ['Name one specific outcome.'], title_length_range: [6, 16],
    logline_shape_rules: ['Name the outcome and mechanism.'], logline_sentence_range: [1, 2],
    theme_shape_rules: ['Cover outcome, mechanism, and institution.'], theme_count_range: [2, 4],
    structural_variety: 'vary-all', default_thumbnail_recipe_id: 'com.storystudio.thumbnail.archival-map',
    metadata_title_style_hint: 'Specific evidence-led history title.',
    metadata_title_hook_rules: ['Name the outcome early.'], metadata_tags_hook_rules: ['Use only covered entities.'],
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
    category: 'History', tags: ['archival', 'map'], aspect_ratio: '16:9',
    layout: 'hero', title_mode: 'ai', composition_guidance: 'Use a map as the supporting visual.',
    required_elements: ['one focal historical object'], avoid_elements: ['tiny unreadable labels'],
    headline_mode: 'episode-title', headline_guidance: 'Keep the title concise.',
    default_text_style: 'bold historical documentary', default_font_style: 'bold', default_text_position: 'bottom',
    headline_formats: ['WHY {SUBJECT} CHANGED THE OUTCOME'], visual_style_guidance: 'Restrained archival documentary.',
    preview_assets: ['assets/style-preview.webp'],
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

  test('accepts a rich Hidden Mechanics-shaped Formula without discarding approved editorial fields', () => {
    const parsed = parseContentPackDocument('series-formula', documents['series-formula'])
    assert.equal(parsed.kind, 'series-formula')
    assert.equal(parsed.script_structure.default_length_minutes, 36)
    assert.equal(parsed.narrative_quality_contract?.forbidden_patterns[0], 'Invented quotations')
    assert.equal(parsed.production_kit?.episode_profiles?.[0]?.narrator_style_id, 'historical-investigator')
    assert.equal(parsed.idea_axes?.[0]?.id, 'causal-mechanism')
  })

  test('treats a channel kit as a manifest bundle reference rather than a content document', () => {
    assert.equal(ContentPackBundleSchema.parse(manifest.bundles[0]).kind, 'channel-kit')
    assert.throws(() => ContentPackDocumentSchema.parse({ ...manifest.bundles[0], schema_version: 1 }), /kind/i)
  })

  test('requires an exact Formula and Topic Pack component reference in each Channel Kit', () => {
    const styleOnly = {
      ...manifest.bundles[0],
      components: [manifest.bundles[0].components[2]],
    }
    assert.throws(() => ContentPackBundleSchema.parse(styleOnly), /Formula|Topic Pack/i)
    const duplicate = {
      ...manifest.bundles[0],
      components: [manifest.bundles[0].components[0], manifest.bundles[0].components[0], manifest.bundles[0].components[1]],
    }
    assert.throws(() => ContentPackBundleSchema.parse(duplicate), /unique/i)
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

  test('rejects URI schemes, protocol-relative references, and model-routing directives in active text', () => {
    for (const unsafeText of [
      'javascript:alert(1)', 'data:text/plain,hello', 'file:///secret', 'ftp://example.test/file', '//example.test/file',
      'provider_id: route-here', 'provider: route-here', 'model_id: route-here',
    ]) {
      assert.throws(() => ContentPackDocumentSchema.parse({
        ...documents['visual-style'], style_bible: unsafeText,
      }), /URI|routing/i)
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
    }), /URI/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['visual-style'], provider_id: 'provider-x',
    }), /unrecognized key/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['visual-style'], model_id: 'model-x',
    }), /unrecognized key/i)
  })

  test('requires deterministic manifest identities and lifecycle declarations', () => {
    assertRejected({
      ...manifest,
      items: [manifest.items[0], manifest.items[0], ...manifest.items.slice(1)],
    }, /unique/i)
    assertRejected({
      ...manifest,
      files: [manifest.files[0], manifest.files[0], ...manifest.files.slice(1)],
    }, /unique/i)
    assertRejected({
      ...manifest,
      items: [{ ...manifest.items[0], path: manifest.items[1].path }, ...manifest.items.slice(1)],
    }, /unique/i)
    assertRejected({
      ...manifest,
      bundles: [manifest.bundles[0], manifest.bundles[0]],
    }, /unique/i)
    assertRejected({
      ...manifest,
      entitlement: { ...manifest.entitlement, sku: 'com.someoneelse.sku.hidden-mechanics' },
    }, /publisher namespace/i)
    assertRejected({
      ...manifest,
      bundles: [{ ...manifest.bundles[0], id: 'com.someoneelse.bundle.hidden-mechanics' }],
    }, /publisher namespace/i)
    assertRejected({ ...manifest, lifecycle: 'replaced' }, /successor/i)
    assertRejected({ ...manifest, successor_pack_id: manifest.pack_id }, /successor/i)
    assertRejected({
      ...manifest,
      publisher_id: 'com.storystudio-',
    }, /qualified/i)
  })

  test('rejects a same-pack Channel Kit reference that does not name a declared document', () => {
    assertRejected({
      ...manifest,
      bundles: [{
        ...manifest.bundles[0],
        components: [
          { ...manifest.bundles[0].components[0], item_id: 'com.storystudio.formula.not-declared' },
          manifest.bundles[0].components[1],
        ],
      }],
    }, /declared document/i)
  })

  test('requires an exact version on an independently versioned Channel Kit component', () => {
    assert.throws(() => ContentPackBundleSchema.parse({
      ...manifest.bundles[0],
      components: [
        { ...manifest.bundles[0].components[0], version: '^1.2.3' },
        manifest.bundles[0].components[1],
      ],
    }), /semantic version/i)
  })
})

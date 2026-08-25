import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import {
  ContentPackBundleSchema,
  ContentPackDocumentSchema,
  ContentPackManifestSchema,
  isBundleOnlyCoordinationManifest,
  parseContentPackDocument,
  parseContentPackManifest,
} from '../content-packs/schemas.js'
import { METADATA_SECTION_IDS } from '../lib/metadata-sections.js'

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

const bundleOnlyManifest = {
  ...manifest,
  pack_id: 'com.storystudio.bundle.free-starter',
  version: '1.0.0',
  entitlement: {
    sku: 'com.storystudio.sku.free-starter',
    family: 'com.storystudio.family.free-starter',
  },
  items: [],
  files: [],
  dependencies: [
    { pack_id: 'com.storystudio.formula.free-starter', version: '1.0.0' },
    { pack_id: 'com.storystudio.topic.free-starter', version: '1.0.0' },
    { pack_id: 'com.storystudio.style.free-starter', version: '1.0.0' },
    { pack_id: 'com.storystudio.thumbnail.free-starter', version: '1.0.0' },
  ],
  bundles: [{
    id: 'com.storystudio.bundle.free-starter',
    kind: 'channel-kit',
    name: 'Free Starter Channel Kit',
    components: [
      { pack_id: 'com.storystudio.formula.free-starter', version: '1.0.0', item_id: 'com.storystudio.formula.free-starter', kind: 'series-formula' },
      { pack_id: 'com.storystudio.topic.free-starter', version: '1.0.0', item_id: 'com.storystudio.topic.free-starter', kind: 'topic-pack' },
      { pack_id: 'com.storystudio.style.free-starter', version: '1.0.0', item_id: 'com.storystudio.style.free-starter', kind: 'visual-style' },
      { pack_id: 'com.storystudio.thumbnail.free-starter', version: '1.0.0', item_id: 'com.storystudio.thumbnail.free-starter', kind: 'thumbnail-recipe' },
    ],
  }],
} as const

const multiStyleBundleOnlyManifest = {
  ...bundleOnlyManifest,
  dependencies: [
    ...bundleOnlyManifest.dependencies.slice(0, 2),
    bundleOnlyManifest.dependencies[3],
    bundleOnlyManifest.dependencies[2],
    { pack_id: 'com.storystudio.style.free-starter-impasto', version: '1.0.0' },
    { pack_id: 'com.storystudio.style.free-starter-oil', version: '1.0.0' },
  ],
  bundles: [{
    ...bundleOnlyManifest.bundles[0],
    components: [
      ...bundleOnlyManifest.bundles[0].components.slice(0, 2),
      bundleOnlyManifest.bundles[0].components[3],
      bundleOnlyManifest.bundles[0].components[2],
      { pack_id: 'com.storystudio.style.free-starter-impasto', version: '1.0.0', item_id: 'com.storystudio.style.free-starter-impasto', kind: 'visual-style' },
      { pack_id: 'com.storystudio.style.free-starter-oil', version: '1.0.0', item_id: 'com.storystudio.style.free-starter-oil', kind: 'visual-style' },
    ],
  }],
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
    idea_axes: [
      { id: 'episode-profile', label: 'Episode profile', values: ['default'] },
      { id: 'causal-mechanism', label: 'Causal mechanism', values: ['state capacity', 'fiscal pressure'] },
    ],
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

  test('accepts only one empty coordination bundle with a complete external closure', () => {
    const parsed = parseContentPackManifest(bundleOnlyManifest)
    assert.equal(parsed.items.length, 0)
    assert.equal(parsed.files.length, 0)
    assert.equal(isBundleOnlyCoordinationManifest(parsed), true)
    assert.deepEqual(new Set(parsed.bundles[0]!.components.map(row => row.kind)),
      new Set(['series-formula', 'topic-pack', 'visual-style', 'thumbnail-recipe']))
  })

  test('accepts one-or-more ordered Styles in a bundle-only coordination manifest', () => {
    const parsed = parseContentPackManifest(multiStyleBundleOnlyManifest)
    const counts = parsed.bundles[0]!.components.reduce<Record<string, number>>(
      (result, component) => ({ ...result, [component.kind]: (result[component.kind] ?? 0) + 1 }),
      {},
    )
    assert.deepEqual(counts, {
      'series-formula': 1,
      'topic-pack': 1,
      'thumbnail-recipe': 1,
      'visual-style': 3,
    })
    assert.deepEqual(
      parsed.bundles[0]!.components.map(component => component.kind),
      ['series-formula', 'topic-pack', 'thumbnail-recipe', 'visual-style', 'visual-style', 'visual-style'],
    )
    assert.deepEqual(
      parsed.bundles[0]!.components.filter(component => component.kind === 'visual-style').map(component => component.item_id),
      [
        'com.storystudio.style.free-starter',
        'com.storystudio.style.free-starter-impasto',
        'com.storystudio.style.free-starter-oil',
      ],
    )
  })

  test('requires bundle-only dependencies to equal the ordered one-component-per-dependency owner sequence', () => {
    assertRejected({
      ...multiStyleBundleOnlyManifest,
      dependencies: [
        multiStyleBundleOnlyManifest.dependencies[1],
        multiStyleBundleOnlyManifest.dependencies[0],
        ...multiStyleBundleOnlyManifest.dependencies.slice(2),
      ],
    }, /order|sequence|component/i)

    const shared = multiStyleBundleOnlyManifest.dependencies[0]
    assertRejected({
      ...multiStyleBundleOnlyManifest,
      dependencies: [shared],
      bundles: [{
        ...multiStyleBundleOnlyManifest.bundles[0],
        components: multiStyleBundleOnlyManifest.bundles[0].components.map(component => ({
          ...component,
          pack_id: shared.pack_id,
          version: shared.version,
        })),
      }],
    }, /cardinality|one component|dependency/i)
  })

  test('keeps empty items or files invalid outside the one bundle-only coordination shape', () => {
    assertRejected({ ...manifest, items: [] }, /items|empty|content/i)
    assertRejected({ ...manifest, files: [] }, /files|empty|content/i)
    assertRejected({ ...bundleOnlyManifest, bundles: [] }, /bundle/i)
    assertRejected({ ...bundleOnlyManifest, bundles: [bundleOnlyManifest.bundles[0], bundleOnlyManifest.bundles[0]] }, /one|bundle/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{
        ...bundleOnlyManifest.bundles[0],
        components: [{ ...bundleOnlyManifest.bundles[0].components[0], pack_id: bundleOnlyManifest.pack_id }, ...bundleOnlyManifest.bundles[0].components.slice(1)],
      }],
    }, /external|same-pack/i)
  })

  test('requires the coordination bundle to contain one external Formula, one or more Topic Packs, one or more Styles, and one Recipe with exact used dependencies', () => {
    const fiveTopicBundleOnlyManifest = {
      ...bundleOnlyManifest,
      dependencies: [
        bundleOnlyManifest.dependencies[0],
        bundleOnlyManifest.dependencies[1],
        { pack_id: 'com.storystudio.topic.free-starter-second', version: '1.0.0' },
        { pack_id: 'com.storystudio.topic.free-starter-third', version: '1.0.0' },
        { pack_id: 'com.storystudio.topic.free-starter-fourth', version: '1.0.0' },
        { pack_id: 'com.storystudio.topic.free-starter-fifth', version: '1.0.0' },
        bundleOnlyManifest.dependencies[2],
        bundleOnlyManifest.dependencies[3],
      ],
      bundles: [{
        ...bundleOnlyManifest.bundles[0],
        components: [
          bundleOnlyManifest.bundles[0].components[0],
          bundleOnlyManifest.bundles[0].components[1],
          { pack_id: 'com.storystudio.topic.free-starter-second', version: '1.0.0', item_id: 'com.storystudio.topic.free-starter-second', kind: 'topic-pack' },
          { pack_id: 'com.storystudio.topic.free-starter-third', version: '1.0.0', item_id: 'com.storystudio.topic.free-starter-third', kind: 'topic-pack' },
          { pack_id: 'com.storystudio.topic.free-starter-fourth', version: '1.0.0', item_id: 'com.storystudio.topic.free-starter-fourth', kind: 'topic-pack' },
          { pack_id: 'com.storystudio.topic.free-starter-fifth', version: '1.0.0', item_id: 'com.storystudio.topic.free-starter-fifth', kind: 'topic-pack' },
          bundleOnlyManifest.bundles[0].components[2],
          bundleOnlyManifest.bundles[0].components[3],
        ],
      }],
    }

    assert.equal(parseContentPackManifest(fiveTopicBundleOnlyManifest).bundles[0]!.components.length, 8,
      'bundle-only coordination must admit all five independent Topic Packs')
    assertRejected({
      ...bundleOnlyManifest,
      dependencies: bundleOnlyManifest.dependencies.slice(1),
    }, /dependency/i)
    assertRejected({
      ...bundleOnlyManifest,
      dependencies: [...bundleOnlyManifest.dependencies, { pack_id: 'com.storystudio.unused.free-starter', version: '1.0.0' }],
    }, /unused|dependenc/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{ ...bundleOnlyManifest.bundles[0], components: bundleOnlyManifest.bundles[0].components.slice(0, 3) }],
    }, /Style|Recipe|component/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{ ...bundleOnlyManifest.bundles[0], components: bundleOnlyManifest.bundles[0].components.slice(1) }],
    }, /Formula|component/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{ ...bundleOnlyManifest.bundles[0], components: bundleOnlyManifest.bundles[0].components.filter(component => component.kind !== 'topic-pack') }],
    }, /Topic|component/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{
        ...bundleOnlyManifest.bundles[0],
        components: [
          ...bundleOnlyManifest.bundles[0].components.slice(0, 3),
          { ...bundleOnlyManifest.bundles[0].components[2], item_id: 'com.storystudio.style.second-free-starter' },
        ],
      }],
    }, /Formula|exactly|unique|kind/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{
        ...bundleOnlyManifest.bundles[0],
        components: bundleOnlyManifest.bundles[0].components.filter(component => component.kind !== 'visual-style'),
      }],
    }, /Style|component/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{
        ...bundleOnlyManifest.bundles[0],
        components: [
          ...bundleOnlyManifest.bundles[0].components,
          { ...bundleOnlyManifest.bundles[0].components[3], item_id: 'com.storystudio.thumbnail.second-free-starter' },
        ],
      }],
    }, /Recipe|exactly|unique|kind/i)
    assertRejected({
      ...bundleOnlyManifest,
      bundles: [{
        ...bundleOnlyManifest.bundles[0],
        components: [
          ...bundleOnlyManifest.bundles[0].components.slice(0, 3),
          { ...bundleOnlyManifest.bundles[0].components[3], item_id: bundleOnlyManifest.bundles[0].components[2].item_id },
        ],
      }],
    }, /unique/i)
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
    assert.equal(parsed.idea_axes?.[1]?.id, 'causal-mechanism')
  })

  test('derives Formula metadata section IDs from the app-owned metadata registry', () => {
    assert.ok(METADATA_SECTION_IDS.includes('hook'))
    assert.ok(METADATA_SECTION_IDS.includes('sources'))
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['series-formula'],
      metadata_profile: {
        ...documents['series-formula'].metadata_profile,
        description_section_ids: ['hook', 'pack-invented-section'],
      },
    }), /invalid_enum_value|Invalid enum value/i)
  })

  test('requires Formula defaults and declared internal references to be coherent', () => {
    const invalidFormulas = [
      {
        ...documents['series-formula'],
        script_structure: { ...documents['series-formula'].script_structure, default_chapter_count: 8 },
      },
      {
        ...documents['series-formula'],
        script_structure: { ...documents['series-formula'].script_structure, default_length_minutes: 46 },
      },
      {
        ...documents['series-formula'],
        script_structure: { ...documents['series-formula'].script_structure, duration_presets: [30, 60] },
      },
      {
        ...documents['series-formula'],
        default_topic_pack_ids: ['com.storystudio.topic.not-compatible'],
      },
      {
        ...documents['series-formula'],
        default_narrator_style_id: 'missing-narrator-style',
      },
      {
        ...documents['series-formula'],
        production_kit: {
          ...documents['series-formula'].production_kit,
          episode_profiles: [{ ...documents['series-formula'].production_kit.episode_profiles[0], narrator_style_id: 'missing-narrator-style' }],
        },
      },
      {
        ...documents['series-formula'],
        default_thumbnail_recipe_id: 'com.storystudio.thumbnail.not-recommended',
      },
      {
        ...documents['series-formula'],
        production_kit: { ...documents['series-formula'].production_kit, recommended_visual_style_id: 'com.storystudio.style.not-recommended' },
      },
    ]
    for (const formula of invalidFormulas) {
      assert.throws(() => ContentPackDocumentSchema.parse(formula), /default|range|duration|topic|narrator|thumbnail|visual/i)
    }
  })

  test('requires Formula axes, narrator styles, and episode profiles to form one unambiguous profile map', () => {
    const formula = documents['series-formula']
    const profile = formula.production_kit.episode_profiles[0]
    const episodeAxis = formula.idea_axes[0]
    const causalAxis = formula.idea_axes[1]
    const invalidFormulas = [
      { ...formula, idea_axes: [episodeAxis, { ...episodeAxis, label: 'Duplicate episode profile' }, causalAxis] },
      { ...formula, idea_axes: [{ ...episodeAxis, values: ['default', 'default'] }, causalAxis] },
      { ...formula, narrator_styles: [formula.narrator_styles[0], { ...formula.narrator_styles[0], label: 'Duplicate narrator' }] },
      {
        ...formula,
        production_kit: {
          ...formula.production_kit,
          episode_profiles: [profile, { ...profile, id: 'alternate', idea_axis_value: 'default' }],
        },
      },
      {
        ...formula,
        production_kit: {
          ...formula.production_kit,
          episode_profiles: [profile, { ...profile, id: 'default', idea_axis_value: 'alternate' }],
        },
        idea_axes: [{ ...episodeAxis, values: ['default', 'alternate'] }, causalAxis],
      },
      { ...formula, idea_axes: [causalAxis] },
      {
        ...formula,
        production_kit: {
          ...formula.production_kit,
          episode_profiles: [{ ...profile, idea_axis_value: 'not-declared' }],
        },
      },
    ]
    for (const invalid of invalidFormulas) {
      assert.throws(() => ContentPackDocumentSchema.parse(invalid), /unique|episode-profile|episode profile|declared/i)
    }

    assert.equal(ContentPackDocumentSchema.parse({
      ...formula,
      idea_axes: [causalAxis],
      production_kit: { ...formula.production_kit, episode_profiles: undefined },
    }).kind, 'series-formula')
  })

  test('accepts projections of Deep Time visual pacing and Prayer metadata-recency declarations', async () => {
    const [deepTime, prayer] = await Promise.all([
      readFile(new URL('../niches/deep-time-documentary.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../niches/prayer.json', import.meta.url), 'utf8').then(JSON.parse),
    ])
    const deepTimeProjection = {
      ...documents['series-formula'],
      id: 'com.storystudio.formula.deep-time-documentary', name: deepTime.name, description: deepTime.description,
      formula_family: deepTime.formulaFamily, example_topics: deepTime.exampleTopics,
      script_structure: {
        ...documents['series-formula'].script_structure,
        visual_pacing_profile: deepTime.scriptStructure.visualPacingProfile,
        motion_profile_id: deepTime.scriptStructure.motionProfile.id,
      },
      evidence_expectations: ['separate observation, inference, debate, and speculation'],
      creative_profiles: ['balanced'],
    }
    const prayerProjection = {
      ...documents['series-formula'],
      id: 'com.storystudio.formula.prayer', name: prayer.name, description: prayer.description,
      metadata_description: {
        voice_guidance: prayer.metadataDescription.voiceGuidance,
        description_shape_rules: prayer.metadataDescription.descriptionShapeRules,
        cta_shape: prayer.metadataDescription.ctaShape,
        closing_benediction: prayer.metadataDescription.closingBenediction,
      },
      recency_avoidance: {
        strategy_id: 'scripture-references',
        label: prayer.recencyAvoidance.label,
        default_lookback: prayer.recencyAvoidance.defaultLookback,
        scopes: prayer.recencyAvoidance.scopes,
      },
    }
    const parsedDeepTime = parseContentPackDocument('series-formula', deepTimeProjection)
    const parsedPrayer = parseContentPackDocument('series-formula', prayerProjection)
    if (parsedDeepTime.kind !== 'series-formula' || parsedPrayer.kind !== 'series-formula') assert.fail('expected Formula documents')
    assert.equal(parsedDeepTime.script_structure.motion_profile_id, 'ambient-documentary')
    assert.equal(parsedPrayer.recency_avoidance?.scopes?.[1], 'metadata')
  })

  test('accepts a Topic Pack projection with current diversity axes and declarative evidence compatibility', async () => {
    const source = JSON.parse(await readFile(new URL('../topic-packs/historical-money-debt-financial-institutions.json', import.meta.url), 'utf8'))
    const projection = {
      ...documents['topic-pack'],
      name: source.name, description: source.description, subjects: source.subjects,
      idea_axes: source.ideaAxes.map((axis: { id: string, label: string, values: string[] }) => ({
        id: axis.id, label: axis.label, values: axis.values,
      })),
      evidence_expectations: ['distinguish policy, institution, and ordinary people'],
      compatibility_rules: ['Use only with historical-causality Formulas.'],
    }
    const parsed = parseContentPackDocument('topic-pack', projection)
    if (parsed.kind !== 'topic-pack') assert.fail('expected Topic Pack document')
    assert.equal(parsed.idea_axes?.[0]?.id, 'financial-mechanism')
  })

  test('requires coherent per-subject Topic coverage profiles to partition subjects and use declared tuple values', () => {
    const topic = {
      ...documents['topic-pack'],
      subjects: ['Ledger', 'Harbor'], episode_objects: ['a ledger', 'a cargo manifest'],
      time_place_scopes: ['a tax office', 'a port'], mechanisms: ['record keeping', 'cargo scheduling'],
      evidence_lenses: ['administrative record', 'shipping record'],
      coverage_profiles: [
        { subject: 'Ledger', tuples: [
          { episode_object: 'a ledger', time_place_scope: 'a tax office', mechanism: 'record keeping', evidence_lens: 'administrative record' },
          { episode_object: 'a cargo manifest', time_place_scope: 'a port', mechanism: 'cargo scheduling', evidence_lens: 'shipping record' },
        ] },
        { subject: 'Harbor', tuples: [
          { episode_object: 'a cargo manifest', time_place_scope: 'a port', mechanism: 'cargo scheduling', evidence_lens: 'shipping record' },
          { episode_object: 'a ledger', time_place_scope: 'a tax office', mechanism: 'record keeping', evidence_lens: 'administrative record' },
        ] },
      ],
    }
    assert.equal(parseContentPackDocument('topic-pack', topic).kind, 'topic-pack')
    assert.throws(() => parseContentPackDocument('topic-pack', {
      ...topic, coverage_profiles: [{ ...topic.coverage_profiles[0], subject: 'Unknown' }],
    }), /coverage profile subject|exactly one/i)
    assert.throws(() => parseContentPackDocument('topic-pack', {
      ...topic, coverage_profiles: [{ ...topic.coverage_profiles[0], tuples: [{ ...topic.coverage_profiles[0].tuples[0], episode_object: 'an invented object' }] }],
    }), /coverage profile episode_object/i)
    assert.throws(() => parseContentPackDocument('topic-pack', {
      ...topic, coverage_profiles: [topic.coverage_profiles[0], { ...topic.coverage_profiles[0], subject: 'Ledger' }],
    }), /exactly one/i)
    assert.throws(() => parseContentPackDocument('topic-pack', {
      ...topic, coverage_profiles: [{ ...topic.coverage_profiles[0], tuples: [topic.coverage_profiles[0].tuples[0], { ...topic.coverage_profiles[0].tuples[1], mechanism: 'record keeping' }] }],
    }), /must each change episode object and mechanism/i)
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
      '(//example.test/file)', 'browse www.example.test now', 'see example.test/style for details',
      'provider_id: route-here', 'provider: route-here', 'model_id: route-here', 'engine_id: route-here', 'model: route-here', 'model=route-here',
      'use provider route-here model route-model', 'route via provider route-here',
    ]) {
      assert.throws(() => ContentPackDocumentSchema.parse({
        ...documents['visual-style'], style_bible: unsafeText,
      }), /URI|routing/i)
    }
  })

  test('rejects private-key blocks and credential or account assignments without banning ordinary prose', () => {
    for (const unsafeText of [
      '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----',
      'api_key: "sk-live-abc123456789"',
      'api key is sk-live-abc123456789',
      'secret = "do-not-package-me"',
      'token: "opaque-token-value"',
      'access_token = "opaque-token-value"',
      'bearer = "opaque-token-value"',
      'account_id: "acct_123"',
      'customer_id = "cus_123"',
      'authorization: bearer sk-live-abc123456789',
      'access token is 0123456789abcdef0123456789abcdef',
    ]) {
      assert.throws(() => ContentPackDocumentSchema.parse({
        ...documents['visual-style'], style_bible: unsafeText,
      }), /credential|private key|secret/i)
    }
    for (const ordinaryText of [
      'A historian may discuss a customer ID policy, an account identifier, a secret ballot, or a token of respect without embedding credentials.',
      'The secret revealed ledger changed the course of the negotiation.',
      'A bearer royal message crossed the frontier at dawn.',
      'A token Roman tessera marked a citizen’s entitlement.',
      'The access token is never shown in the documentary.',
      'A customer ID historical card identifies a museum drawer, not an account.',
    ]) {
      assert.equal(ContentPackDocumentSchema.parse({
        ...documents['visual-style'], style_bible: ordinaryText,
      }).kind, 'visual-style')
    }
  })

  test('allows ordinary non-routing use of the word provider', () => {
    assert.equal(ContentPackDocumentSchema.parse({
      ...documents['visual-style'], style_bible: 'A healthcare provider and a liquidity provider appear only as ordinary documentary subjects.',
    }).kind, 'visual-style')
  })

  test('rejects raw pack-supplied regexes, motion mixes, unregistered motion IDs, and Formula style fields', () => {
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['series-formula'],
      recency_avoidance: { strategy_id: 'scripture-references', label: 'scripture references', extract_patterns: ['.*'] },
    }), /unrecognized key/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['series-formula'],
      script_structure: { ...documents['series-formula'].script_structure, motion_profile: { id: 'ambient-documentary' } },
    }), /unrecognized key/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['series-formula'],
      script_structure: { ...documents['series-formula'].script_structure, motion_profile_id: 'unregistered-motion' },
    }), /invalid_enum_value/i)
    assert.throws(() => ContentPackDocumentSchema.parse({
      ...documents['series-formula'], visual_style_hint: 'Formula-owned art direction is forbidden.',
    }), /unrecognized key/i)
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

  test('rejects dependency ambiguity, self-dependencies, and unsafe manifest path segments', () => {
    assertRejected({
      ...manifest,
      dependencies: [
        { pack_id: 'com.storystudio.topic.historical-finance', version: '1.0.0' },
        { pack_id: 'com.storystudio.topic.historical-finance', version: '2.0.0' },
      ],
    }, /dependency.*unique|dependency.*one version/i)
    assertRejected({
      ...manifest,
      dependencies: [{ pack_id: manifest.pack_id, version: '1.2.3' }],
    }, /self|itself/i)
    for (const path of ['content/./formula.json', 'content//formula.json', 'assets/preview/../style.webp']) {
      assertRejected({
        ...manifest,
        files: [{ ...manifest.files[0], path }, ...manifest.files.slice(1)],
      }, /relative|path/i)
    }
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

  test('requires every external Channel Kit component to have one exact manifest dependency', () => {
    const externalComponent = {
      pack_id: 'com.partner.pack.history-assets', version: '2.0.0', item_id: 'com.partner.style.history-assets', kind: 'visual-style',
    } as const
    assertRejected({
      ...manifest,
      bundles: [{ ...manifest.bundles[0], components: [manifest.bundles[0].components[0], manifest.bundles[0].components[1], externalComponent] }],
    }, /dependency/i)
    assert.equal(parseContentPackManifest({
      ...manifest,
      dependencies: [{ pack_id: externalComponent.pack_id, version: externalComponent.version }],
      bundles: [{ ...manifest.bundles[0], components: [manifest.bundles[0].components[0], manifest.bundles[0].components[1], externalComponent] }],
    }).dependencies?.length, 1)
  })

  test('rejects duplicate dependency pairs and Channel Kit item IDs even when versions differ', () => {
    assertRejected({
      ...manifest,
      dependencies: [
        { pack_id: 'com.partner.pack.history-assets', version: '2.0.0' },
        { pack_id: 'com.partner.pack.history-assets', version: '2.0.0' },
      ],
    }, /unique/i)
    assert.throws(() => ContentPackBundleSchema.parse({
      ...manifest.bundles[0],
      components: [
        manifest.bundles[0].components[0],
        manifest.bundles[0].components[1],
        { ...manifest.bundles[0].components[1], version: '2.0.0' },
      ],
    }), /unique/i)
  })

  test('rejects a same-pack Channel Kit component that claims a different version', () => {
    assertRejected({
      ...manifest,
      bundles: [{
        ...manifest.bundles[0],
        components: [{ ...manifest.bundles[0].components[0], version: '9.9.9' }, manifest.bundles[0].components[1]],
      }],
    }, /exact current pack version/i)
  })
})

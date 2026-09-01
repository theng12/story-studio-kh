import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildContentPack } from '../lib.mjs'

const SOURCE_DIRECTORY = new URL('../../../content-packs/archival-ledger/', import.meta.url)
const PUBLISHER_README = new URL('../README.md', import.meta.url)
const HMH_FORMULA = new URL('../../../electron/server/niches/hidden-mechanics-history.json', import.meta.url)
const HMH_STYLE = new URL('../../../content-packs/paid/archival-ledger/style/archival-documentary-reconstruction/content/visual-style.json', import.meta.url)
const HMH_RECIPE = new URL('../../../electron/server/thumbnail-templates/archival-map-investigation.json', import.meta.url)
const HMH_TOPICS = [
  'historical-states-revolutions-collapse',
  'historical-money-debt-financial-institutions',
  'historical-empires-trade-extraction',
  'historical-wars-treaties-world-order',
  'historical-infrastructure-commodities-corporate-power',
].map(id => new URL(`../../../electron/server/topic-packs/${id}.json`, import.meta.url))

const PACK_ID = 'com.storystudio.pack.archival-ledger'
const VERSION = '1.0.0'
const FORMULA_ID = 'com.storystudio.formula.archival-ledger'
const STYLE_ID = 'com.storystudio.style.archival-documentary-reconstruction'
const RECIPE_ID = 'com.storystudio.thumbnail.archival-map-investigation'
const TOPIC_IDS = [
  'com.storystudio.topic.archival-ledger.states-revolutions-collapse',
  'com.storystudio.topic.archival-ledger.money-debt-financial-institutions',
  'com.storystudio.topic.archival-ledger.empires-trade-extraction',
  'com.storystudio.topic.archival-ledger.wars-treaties-world-order',
  'com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power',
]

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

async function sourceDocuments() {
  const names = [
    'series-formula.json',
    'topic-states-revolutions-collapse.json',
    'topic-money-debt-financial-institutions.json',
    'topic-empires-trade-extraction.json',
    'topic-wars-treaties-world-order.json',
    'topic-infrastructure-commodities-corporate-power.json',
    'visual-style.json',
    'thumbnail-recipe.json',
  ]
  return Promise.all(names.map(async name => [name, await readJson(new URL(`content/${name}`, SOURCE_DIRECTORY))]))
}

function promptFacts(formula) {
  return {
    idea_system_prompt_role: formula.ideaSystemPromptRole,
    idea_guidance_text: formula.ideaGuidanceText,
    script_context: formula.scriptContext,
    script_system_prompt_role: formula.scriptSystemPromptRole,
  }
}

test('Archival Ledger source is a self-contained, price-free 500+ archival history system', async () => {
  const manifest = await readJson(new URL('pack.json', SOURCE_DIRECTORY))
  const documents = Object.fromEntries(await sourceDocuments())
  const serialized = canonicalJson({ manifest, documents })
  const formula = documents['series-formula.json']
  const topics = TOPIC_IDS.map((_, index) => documents[[
    'topic-states-revolutions-collapse.json',
    'topic-money-debt-financial-institutions.json',
    'topic-empires-trade-extraction.json',
    'topic-wars-treaties-world-order.json',
    'topic-infrastructure-commodities-corporate-power.json',
  ][index]])

  assert.equal(manifest.pack_id, PACK_ID)
  assert.equal(manifest.version, VERSION)
  assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}')
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.price, undefined)
  assert.doesNotMatch(serialized, /"(?:price|credits|showcase|youtube|video)"\s*:/i)
  assert.doesNotMatch(serialized, /https?:\/\//i)
  assert.equal(formula.name, 'Archival Ledger')
  assert.equal(formula.tagline, 'Debt → Power')
  assert.deepEqual(formula.youtube_tags_hint, ["history documentary", "history explained", "historical causes", "political economy history", "world history", "financial history", "empires and revolutions"])
  assert.deepEqual(formula.default_topic_pack_ids, TOPIC_IDS)
  assert.equal(formula.production_kit.recommended_visual_style_id, STYLE_ID)
  assert.deepEqual(formula.recommended_thumbnail_recipe_ids, [RECIPE_ID])
  assert.equal(formula.default_thumbnail_recipe_id, RECIPE_ID)
  assert.equal(topics.length, 5)
  assert.equal(topics.reduce((total, topic) => total + topic.subjects.length, 0), 125)
  assert.equal(new Set(topics.flatMap(topic => topic.subjects.map(subject => subject.toLowerCase()))).size, 125)
  assert.ok(topics.every(topic => topic.max_siblings_per_subject === 4))
  assert.ok(topics.every(topic => topic.compatible_formula_ids.includes(FORMULA_ID)))
  assert.equal(documents['visual-style.json'].id, STYLE_ID)
  assert.equal(documents['thumbnail-recipe.json'].id, RECIPE_ID)
})

test('Archival Ledger preserves the effective HMH prompt, topic, style, and thumbnail behavior', async () => {
  const legacyFormula = await readJson(HMH_FORMULA)
  const legacyTopics = await Promise.all(HMH_TOPICS.map(readJson))
  const legacyRecipe = await readJson(HMH_RECIPE)
  const documents = Object.fromEntries(await sourceDocuments())
  const sourceFormula = documents['series-formula.json']
  const sourceTopics = [
    documents['topic-states-revolutions-collapse.json'],
    documents['topic-money-debt-financial-institutions.json'],
    documents['topic-empires-trade-extraction.json'],
    documents['topic-wars-treaties-world-order.json'],
    documents['topic-infrastructure-commodities-corporate-power.json'],
  ]

  assert.equal(sha256(canonicalJson({
    idea_system_prompt_role: sourceFormula.idea_system_prompt_role,
    idea_guidance_text: sourceFormula.idea_guidance_text,
    script_context: sourceFormula.script_context,
    script_system_prompt_role: sourceFormula.script_system_prompt_role,
  })), sha256(canonicalJson(promptFacts(legacyFormula))))
  assert.deepEqual(sourceFormula.youtube_tags_hint, legacyFormula.youtubeTagsHint)
  assert.deepEqual(sourceFormula.script_structure, {
    default_chapter_count: legacyFormula.scriptStructure.defaultChapterCount,
    chapter_count_range: legacyFormula.scriptStructure.chapterCountRange,
    default_length_minutes: legacyFormula.scriptStructure.defaultLengthMinutes,
    length_minutes_range: legacyFormula.scriptStructure.lengthMinutesRange,
    duration_presets: legacyFormula.scriptStructure.durationPresets,
    default_words_per_minute: legacyFormula.scriptStructure.defaultWordsPerMinute,
    chapters_independent: legacyFormula.scriptStructure.chaptersIndependent,
    pacing_arc: legacyFormula.scriptStructure.pacingArc,
    additional_rules: legacyFormula.scriptStructure.additionalRules,
  })
  for (const [index, topic] of sourceTopics.entries()) {
    assert.deepEqual(topic.subjects, legacyTopics[index].subjects.map(subject =>
      index === 4 && subject === 'the Suez Canal' ? 'the Erie Canal' : subject,
    ))
    assert.deepEqual(topic.idea_axes, legacyTopics[index].ideaAxes)
    assert.equal(topic.prompt_context, legacyTopics[index].promptContext)
  }
  assert.equal(documents['thumbnail-recipe.json'].layout, legacyRecipe.recipe.layout)
  assert.equal(documents['thumbnail-recipe.json'].title_mode, legacyRecipe.recipe.titleMode)
  assert.deepEqual(documents['thumbnail-recipe.json'].required_elements, legacyRecipe.recipe.requiredElements)
  assert.deepEqual(documents['thumbnail-recipe.json'].avoid_elements, legacyRecipe.recipe.avoid)
  assert.deepEqual(documents['thumbnail-recipe.json'].headline_formats, legacyRecipe.recipe.headlineFormats)
  assert.deepEqual(documents['thumbnail-recipe.json'].composition_rules, legacyRecipe.recipe.compositionRules)
  const styleSource = await readJson(HMH_STYLE)
  assert.equal(documents['visual-style.json'].style_bible, styleSource.style_bible)
  assert.equal(documents['visual-style.json'].negative_prompt, styleSource.negative_prompt)
})

test('the retired Archival Ledger monolith cannot be built, signed, or documented as stock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'archival-ledger-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { privateKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'ephemeral-private.pem')
  const firstPath = join(root, 'archival-ledger-first.sspack')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))

  await assert.rejects(
    buildContentPack({ sourceDirectory: SOURCE_DIRECTORY.pathname, privateKeyPath, outputPath: firstPath }),
    /source-only.*cannot be built, signed, or stocked/i,
  )
  const documentation = await readFile(PUBLISHER_README, 'utf8')
  assert.match(documentation, /content-packs\/archival-ledger[^\n]*source-only/i)
  assert.match(documentation, /never sign or stock/i)
  assert.doesNotMatch(documentation, /content-pack:build -- \.\/content-packs\/archival-ledger\s*\\/)
  assert.match(documentation, /content-packs\/paid\/archival-ledger\/formula\/archival-ledger/i)
  assert.match(documentation, /content-packs\/paid\/archival-ledger\/kit\/archival-ledger/i)
})

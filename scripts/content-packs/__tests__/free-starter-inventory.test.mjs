import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const PROVENANCE = new URL('../../../content-packs/free-starters/ASSET-PROVENANCE.md', import.meta.url)

const registry = {
  formulas: [
    ['natural-world-explained', 'animals'],
    ['ancient-humans', 'ancient-humans'],
    ['deep-time-documentary', 'deep-time-documentary'],
    ['economics-of', 'business-economics'],
    ['human-behavior-explained', 'psychology'],
    ['history-explained', 'history-narration'],
    ['pov-your-life-as', 'pov-life'],
    ['guided-mindfulness', 'mindfulness'],
    ['practical-motivation', 'motivation'],
    ['sleep-story', 'sleep'],
  ].map(([slug, sourceId]) => ({
    id: `com.storystudio.formula.${slug}`,
    packId: `com.storystudio.pack.formula.${slug}`,
    sourcePath: `electron/server/niches/${sourceId}.json`,
  })),
  topics: [
    ['natural-world-animals', true],
    ['ancient-humans-survival', true],
    ['deep-time-earth-systems', true],
    ['economics-businesses', true],
    ['human-behavior-social-dynamics', true],
    ['historical-wars-treaties-world-order', true],
    ['pov-historical-occupations', true],
    ['everyday-calm', false],
    ['habits-momentum', false],
    ['night-journeys', false],
  ].map(([slug, migrated]) => ({
    id: `com.storystudio.topic.${slug}`,
    packId: `com.storystudio.pack.topic.${slug}`,
    sourcePath: migrated ? `electron/server/topic-packs/${slug}.json` : null,
  })),
  styles: [
    ['waxy-outline-cartoon', 'waxy-outline-cartoon'],
    ['prehistoric-stick-cartoon', 'prehistoric-stick-cartoon'],
    ['paleo-documentary-tableau', 'paleo-documentary-tableau'],
    ['hand-drawn-editorial-diagram', 'hand-drawn-editorial-diagram'],
    ['minimal-stick-figure-explainer', 'minimal-stick-figure-explainer'],
    ['sepia-ink-wash', 'sepia-ink-wash'],
    ['cinematic-photoreal', 'cinematic-photoreal'],
    ['watercolor-storybook', 'watercolor-storybook'],
    ['flat-vector-explainer', 'flat-vector-explainer'],
  ].map(([slug, preview]) => ({
    id: `com.storystudio.style.${slug}`,
    packId: `com.storystudio.pack.style.${slug}`,
    sourceId: `builtin-${slug}`,
    sourcePath: 'frontend/composables/useBuiltInStyles.ts',
    previewPath: `frontend/public/builtin-style-previews/${preview}.webp`,
  })),
  recipes: [
    ['curiosity-question-cartoon', true],
    ['prehistoric-discovery', false],
    ['documentary-label-tableau', true],
    ['annotated-business-board', true],
    ['centered-hero-headline', true],
    ['portrait-block-right', true],
    ['dreamscape-story-window', false],
  ].map(([slug, migrated]) => ({
    id: `com.storystudio.thumbnail.${slug}`,
    packId: `com.storystudio.pack.thumbnail.${slug}`,
    sourceId: slug,
    sourcePath: migrated ? `electron/server/thumbnail-templates/${slug}.json` : null,
  })),
  kits: [
    ['wild-worlds', 'natural-world-explained', 'natural-world-animals', 'waxy-outline-cartoon', 'curiosity-question-cartoon'],
    ['first-humans', 'ancient-humans', 'ancient-humans-survival', 'prehistoric-stick-cartoon', 'prehistoric-discovery'],
    ['deep-time', 'deep-time-documentary', 'deep-time-earth-systems', 'paleo-documentary-tableau', 'documentary-label-tableau'],
    ['business-explained', 'economics-of', 'economics-businesses', 'hand-drawn-editorial-diagram', 'annotated-business-board'],
    ['human-behavior', 'human-behavior-explained', 'human-behavior-social-dynamics', 'minimal-stick-figure-explainer', 'centered-hero-headline'],
    ['history-explained', 'history-explained', 'historical-wars-treaties-world-order', 'sepia-ink-wash', 'documentary-label-tableau'],
    ['a-life-as', 'pov-your-life-as', 'pov-historical-occupations', 'cinematic-photoreal', 'portrait-block-right'],
    ['calm-mind', 'guided-mindfulness', 'everyday-calm', 'watercolor-storybook', 'centered-hero-headline'],
    ['build-momentum', 'practical-motivation', 'habits-momentum', 'flat-vector-explainer', 'annotated-business-board'],
    ['sleep-journeys', 'sleep-story', 'night-journeys', 'watercolor-storybook', 'dreamscape-story-window'],
  ].map(([slug, formula, topic, style, recipe]) => ({
    id: `com.storystudio.bundle.${slug}`,
    packId: `com.storystudio.pack.kit.${slug}`,
    formulaPackId: `com.storystudio.pack.formula.${formula}`,
    topicPackId: `com.storystudio.pack.topic.${topic}`,
    stylePackId: `com.storystudio.pack.style.${style}`,
    recipePackId: `com.storystudio.pack.thumbnail.${recipe}`,
  })),
}

const recipePreviewPaths = [
  'frontend/public/thumbnail-recipe-previews/curiosity-question-cartoon-poison-or-cure.webp',
  'frontend/public/thumbnail-recipe-previews/curiosity-question-cartoon-too-smart.webp',
  'frontend/public/thumbnail-recipe-previews/curiosity-question-cartoon-silent-killer.webp',
  'frontend/public/thumbnail-recipe-previews/documentary-label-tableau-sleep.webp',
  'frontend/public/thumbnail-recipe-previews/documentary-label-tableau-giants.webp',
  'frontend/public/thumbnail-recipe-previews/documentary-label-tableau-rift.webp',
  'frontend/public/thumbnail-recipe-previews/annotated-business-board-coffee.webp',
  'frontend/public/thumbnail-recipe-previews/annotated-business-board-workshop.webp',
  'frontend/public/thumbnail-recipe-previews/annotated-business-board-hotel.webp',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sourceExists(relativePath) {
  await access(new URL(relativePath, ROOT))
}

function readProvenance(markdown) {
  const match = markdown.match(/<!-- free-starter-preview-provenance\n([\s\S]*?)\n-->/)
  assert.ok(match, 'ASSET-PROVENANCE.md must contain the machine-readable preview registry')
  return JSON.parse(match[1])
}

test('free Starter Channel Kit registry freezes approved identities, source mappings, and preview provenance', async () => {
  assert.equal(registry.formulas.length, 10)
  assert.equal(registry.topics.length, 10)
  assert.equal(registry.styles.length, 9)
  assert.equal(registry.recipes.length, 7)
  assert.equal(registry.kits.length, 10)
  assert.equal(new Set(registry.styles.map(row => row.packId)).size, 9)
  assert.equal(new Set(registry.recipes.map(row => row.packId)).size, 7)

  await Promise.all([
    ...registry.formulas.map(row => sourceExists(row.sourcePath)),
    ...registry.topics.filter(row => row.sourcePath).map(row => sourceExists(row.sourcePath)),
    ...registry.styles.map(row => sourceExists(row.sourcePath)),
    ...registry.recipes.filter(row => row.sourcePath).map(row => sourceExists(row.sourcePath)),
  ])

  const records = readProvenance(await readFile(PROVENANCE, 'utf8'))
  assert.ok(Array.isArray(records))
  assert.deepEqual(new Set(records.map(row => row.provenance)), new Set([
    'migrated-approved-built-in',
    'owner-supplied-original',
  ]))

  const expectedExistingPaths = [
    ...registry.styles.map(row => row.previewPath),
    ...recipePreviewPaths,
  ]
  for (const sourcePath of expectedExistingPaths) {
    const record = records.find(row => row.sourcePath === sourcePath)
    assert.ok(record, `missing provenance record for ${sourcePath}`)
    assert.equal(record.provenance, 'migrated-approved-built-in')
    assert.match(record.sha256, /^[a-f0-9]{64}$/)
    assert.equal(sha256(await readFile(new URL(sourcePath, ROOT))), record.sha256)
  }

  for (const sourceId of ['prehistoric-discovery', 'dreamscape-story-window']) {
    const record = records.find(row => row.id === sourceId)
    assert.deepEqual(record, {
      id: sourceId,
      provenance: 'owner-supplied-original',
      status: 'blocked-missing-owner-original',
      sourcePath: null,
      sha256: null,
    })
  }
})

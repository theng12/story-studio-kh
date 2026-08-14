import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../', import.meta.url)
const PROVENANCE = new URL('../../../content-packs/free-starters/ASSET-PROVENANCE.md', import.meta.url)
const unregisterTsx = register()
const { BUILT_IN_STYLES } = await import(new URL('../../../frontend/composables/useBuiltInStyles.ts', import.meta.url))
unregisterTsx()

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
  ].map(([slug]) => ({
    id: `com.storystudio.style.${slug}`,
    packId: `com.storystudio.pack.style.${slug}`,
    sourceId: `builtin-${slug}`,
    sourcePath: 'frontend/composables/useBuiltInStyles.ts',
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

function sourcePathForPublicAsset(publicPath) {
  assert.match(publicPath, /^\/(builtin-style-previews|thumbnail-recipe-previews)\/[a-z0-9-]+\.webp$/)
  return `frontend/public${publicPath}`
}

function assertDeclaredPreview(records, ownerId, publicPath) {
  const sourcePath = sourcePathForPublicAsset(publicPath)
  const record = records.find(row => row.sourcePath === sourcePath)
  assert.ok(record, `missing provenance record for declared ${publicPath}`)
  assert.equal(record.ownerId, ownerId, `declared ${publicPath} must retain ${ownerId} provenance`)
  assert.equal(record.provenance, 'migrated-approved-built-in')
  assert.match(record.sha256, /^[a-f0-9]{64}$/)
  return record
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

  const styleDeclarations = registry.styles.map(row => {
    const style = BUILT_IN_STYLES.find(candidate => candidate.id === row.sourceId)
    assert.ok(style, `missing built-in Style declaration for ${row.sourceId}`)
    return { row, style }
  })
  const recipeDeclarations = await Promise.all(registry.recipes
    .filter(row => row.sourcePath)
    .map(async row => ({
      row,
      template: JSON.parse(await readFile(new URL(row.sourcePath, ROOT), 'utf8')),
    })))

  for (const { row, style } of styleDeclarations) {
    const record = assertDeclaredPreview(records, row.sourceId, style.preview_image)
    assert.equal(sha256(await readFile(new URL(record.sourcePath, ROOT))), record.sha256)
  }
  for (const { row, template } of recipeDeclarations) {
    const declaredPaths = template.previewImages || []
    const approvedRecords = records.filter(record => record.ownerId === row.sourceId && record.status === 'approved')
    assert.equal(declaredPaths.length, approvedRecords.length, `${row.sourceId} preview declarations must match its approved ledger records`)
    for (const publicPath of declaredPaths) {
      const record = assertDeclaredPreview(records, row.sourceId, publicPath)
      assert.equal(sha256(await readFile(new URL(record.sourcePath, ROOT))), record.sha256)
    }
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

test('declared preview redirects cannot cross a Style or Recipe provenance identity', async () => {
  const records = readProvenance(await readFile(PROVENANCE, 'utf8'))
  const style = BUILT_IN_STYLES.find(candidate => candidate.id === 'builtin-waxy-outline-cartoon')
  const redirectedStyle = BUILT_IN_STYLES.find(candidate => candidate.id === 'builtin-paleo-documentary-tableau')
  assert.ok(style)
  assert.ok(redirectedStyle)
  const redirectedStyleDeclaration = { ...style, preview_image: redirectedStyle.preview_image }
  assert.throws(
    () => assertDeclaredPreview(records, style.id, redirectedStyleDeclaration.preview_image),
    /must retain builtin-waxy-outline-cartoon provenance/,
  )

  const curiosity = JSON.parse(await readFile(new URL('electron/server/thumbnail-templates/curiosity-question-cartoon.json', ROOT), 'utf8'))
  const documentary = JSON.parse(await readFile(new URL('electron/server/thumbnail-templates/documentary-label-tableau.json', ROOT), 'utf8'))
  assert.ok(curiosity.previewImages?.[0])
  assert.ok(documentary.previewImages?.[0])
  const redirectedRecipeDeclaration = { ...curiosity, previewImages: [documentary.previewImages[0]] }
  assert.throws(
    () => assertDeclaredPreview(records, curiosity.id, redirectedRecipeDeclaration.previewImages[0]),
    /must retain curiosity-question-cartoon provenance/,
  )
})

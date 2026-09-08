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
    ['prehistoric-stick-cartoon', 'prehistoric-stick-cartoon-v1.0.1'],
    ['paleo-documentary-tableau', 'paleo-documentary-tableau'],
    ['hand-drawn-editorial-diagram', 'hand-drawn-editorial-diagram'],
    ['minimal-stick-figure-explainer', 'minimal-stick-figure-explainer-v1.0.1'],
    ['sepia-ink-wash', 'sepia-ink-wash'],
    ['cinematic-photoreal', 'cinematic-photoreal'],
    ['watercolor-storybook', 'watercolor-storybook'],
    ['flat-vector-explainer', 'flat-vector-explainer'],
  ].map(([slug, directory]) => ({
    id: `com.storystudio.style.${slug}`,
    packId: `com.storystudio.pack.style.${slug}`,
    sourcePath: `content-packs/free-starters/style/${directory}/content/visual-style.json`,
    assetPath: `content-packs/free-starters/style/${directory}/assets/${slug}.webp`,
  })),
  recipes: [
    ['curiosity-question-cartoon', true],
    ['prehistoric-discovery', false],
    ['documentary-label-tableau', true],
    ['annotated-business-board', true],
    ['centered-hero-headline', false],
    ['portrait-block-right', false],
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
  assert.match(publicPath, /^\/thumbnail-recipe-previews\/[a-z0-9-]+\.webp$/)
  return `frontend/public${publicPath}`
}

function assertDeclaredPreview(records, ownerId, publicPath) {
  const sourcePath = sourcePathForPublicAsset(publicPath)
  const record = records.find(row => row.sourcePath === sourcePath)
  assert.ok(record, `missing provenance record for declared ${publicPath}`)
  assert.equal(record.ownerId, ownerId, `declared ${publicPath} must retain ${ownerId} provenance`)
  assert.ok(['migrated-approved-built-in', 'publisher-created-tool-generated-original'].includes(record.provenance))
  assert.match(record.sha256, /^[a-f0-9]{64}$/)
  return record
}

function assertPackDeclaredPreview(records, ownerId, sourcePath) {
  const record = records.find(row => row.sourcePath === sourcePath)
  assert.ok(record, `missing provenance record for declared ${sourcePath}`)
  assert.equal(record.ownerId, ownerId, `declared ${sourcePath} must retain ${ownerId} provenance`)
  assert.equal(record.provenance, 'migrated-approved-built-in')
  assert.equal(record.status, 'approved')
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
    'publisher-created-tool-generated-original',
  ]))

  const styleDeclarations = await Promise.all(registry.styles.map(async row => ({
    row,
    style: JSON.parse(await readFile(new URL(row.sourcePath, ROOT), 'utf8')),
  })))
  const recipeDeclarations = await Promise.all(registry.recipes
    .filter(row => row.sourcePath)
    .map(async row => ({
      row,
      template: JSON.parse(await readFile(new URL(row.sourcePath, ROOT), 'utf8')),
    })))

  for (const { row, style } of styleDeclarations) {
    assert.equal(style.id, row.id)
    assert.deepEqual(style.preview_assets, [`assets/${row.id.replace('com.storystudio.style.', '')}.webp`])
    const record = assertPackDeclaredPreview(records, row.id, row.assetPath)
    assert.equal(sha256(await readFile(new URL(record.sourcePath, ROOT))), record.sha256)
  }
  for (const { row, template } of recipeDeclarations) {
    const declaredPaths = template.previewImages || []
    const approvedRecords = records.filter(record => record.ownerId === row.sourceId && record.status === 'approved' && record.sourcePath?.startsWith('frontend/public/'))
    assert.equal(declaredPaths.length, approvedRecords.length, `${row.sourceId} preview declarations must match its approved ledger records`)
    for (const publicPath of declaredPaths) {
      const record = assertDeclaredPreview(records, row.sourceId, publicPath)
      assert.equal(sha256(await readFile(new URL(record.sourcePath, ROOT))), record.sha256)
    }
  }

  for (const [sourceId, sourcePath, hash] of [
    ['prehistoric-discovery', 'content-packs/free-starters/thumbnail/prehistoric-discovery/assets/prehistoric-discovery.webp', '557f86602b5f96f8d92fc28f981c79eb1121d63b2f7ab1d8bff535e8524dfd14'],
    ['centered-hero-headline', 'content-packs/free-starters/thumbnail/centered-hero-headline/assets/centered-hero-headline.webp', '330334bf935e06fb8167a4ea8321d37a92f64b12a88e9564ccb9cf45f893d2ab'],
    ['portrait-block-right', 'content-packs/free-starters/thumbnail/portrait-block-right/assets/portrait-block-right.webp', 'd7f458e7e6a4025e8a52c22fab0827fcae32c3c2d576be1e32bf6da439ecc00f'],
    ['dreamscape-story-window', 'content-packs/free-starters/thumbnail/dreamscape-story-window/assets/dreamscape-story-window.webp', '1c2ea52dfd2677ce59178e308559c2ae7d97a3a7c2a4c6f6b73bdccf37a8d2ce'],
  ]) {
    const record = records.find(row => row.id === sourceId)
    assert.equal(record.id, sourceId)
    assert.equal(record.ownerId, sourceId)
    assert.equal(record.provenance, 'publisher-created-tool-generated-original')
    assert.equal(record.status, 'approved')
    assert.equal(record.sourcePath, sourcePath)
    assert.equal(record.sha256, hash)
    assert.equal(record.generation_tool, 'codex-built-in-imagegen')
    assert.match(record.source_path, /^<owner-home>\/\.codex\/generated_images\//)
    assert.match(record.source_prompt, /Original 16:9/)
    assert.equal(sha256(await readFile(new URL(sourcePath, ROOT))), hash)
  }
})

test('declared preview redirects cannot cross a Style or Recipe provenance identity', async () => {
  const records = readProvenance(await readFile(PROVENANCE, 'utf8'))
  const style = registry.styles.find(candidate => candidate.id === 'com.storystudio.style.waxy-outline-cartoon')
  const redirectedStyle = registry.styles.find(candidate => candidate.id === 'com.storystudio.style.paleo-documentary-tableau')
  assert.ok(style)
  assert.ok(redirectedStyle)
  assert.throws(
    () => assertPackDeclaredPreview(records, style.id, redirectedStyle.assetPath),
    /must retain com\.storystudio\.style\.waxy-outline-cartoon provenance/,
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

test('free Starter Channel Kit sources preserve 47 lineages and every versioned successor', async () => {
  const sourceRoots = ['formula', 'topic', 'style', 'thumbnail', 'kit']
  const packSources = []
  for (const root of sourceRoots) {
    const directory = new URL(`../../../content-packs/free-starters/${root}/`, import.meta.url)
    const entries = await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      const relative = `content-packs/free-starters/${root}/${entry.name}/pack.json`
      const source = JSON.parse(await readFile(new URL(`../../../${relative}`, import.meta.url), 'utf8'))
      packSources.push({ relative, source })
    }
  }
  assert.equal(new Set(packSources.map(row => row.source.pack_id)).size, 47)
  assert.equal(
    new Set(packSources.map(row => `${row.source.pack_id}@${row.source.version}`)).size,
    packSources.length,
    'two free-starter sources claim the same pack_id@version',
  )
  for (const { relative, source } of packSources) {
    assert.match(source.version, /^1\.0\.\d+$/, `${relative} must stay on the 1.0.x release line`)
    assert.match(source.entitlement.family, /^com\.storystudio\.family\./)
  }
  const historicalFormulas = packSources.filter(({ relative }) => /formula\/.+-v1\.0\.0\/pack\.json$/.test(relative))
  assert.deepEqual(historicalFormulas.map(({ relative }) => relative).sort(), [
    'content-packs/free-starters/formula/ancient-humans-v1.0.0/pack.json',
    'content-packs/free-starters/formula/pov-your-life-as-v1.0.0/pack.json',
  ])
  assert.ok(historicalFormulas.every(({ source }) => source.version === '1.0.0'))
  const successors = packSources.filter(({ relative }) => /-v1\.0\.1\/pack\.json$/.test(relative))
  assert.deepEqual(successors.map(({ relative }) => relative).sort(), [
    'content-packs/free-starters/formula/economics-of-v1.0.1/pack.json',
    'content-packs/free-starters/formula/guided-mindfulness-v1.0.1/pack.json',
    'content-packs/free-starters/formula/history-explained-v1.0.1/pack.json',
    'content-packs/free-starters/formula/human-behavior-explained-v1.0.1/pack.json',
    'content-packs/free-starters/formula/practical-motivation-v1.0.1/pack.json',
    'content-packs/free-starters/kit/a-life-as-v1.0.1/pack.json',
    'content-packs/free-starters/kit/build-momentum-v1.0.1/pack.json',
    'content-packs/free-starters/kit/business-explained-v1.0.1/pack.json',
    'content-packs/free-starters/kit/calm-mind-v1.0.1/pack.json',
    'content-packs/free-starters/kit/first-humans-v1.0.1/pack.json',
    'content-packs/free-starters/kit/history-explained-v1.0.1/pack.json',
    'content-packs/free-starters/kit/human-behavior-v1.0.1/pack.json',
    'content-packs/free-starters/kit/sleep-journeys-v1.0.1/pack.json',
    'content-packs/free-starters/style/cinematic-photoreal-v1.0.1/pack.json',
    'content-packs/free-starters/style/flat-vector-explainer-v1.0.1/pack.json',
    'content-packs/free-starters/style/hand-drawn-editorial-diagram-v1.0.1/pack.json',
    'content-packs/free-starters/style/minimal-stick-figure-explainer-v1.0.1/pack.json',
    'content-packs/free-starters/style/paleo-documentary-tableau-v1.0.1/pack.json',
    'content-packs/free-starters/style/prehistoric-stick-cartoon-v1.0.1/pack.json',
    'content-packs/free-starters/style/sepia-ink-wash-v1.0.1/pack.json',
    'content-packs/free-starters/style/watercolor-storybook-v1.0.1/pack.json',
    'content-packs/free-starters/style/waxy-outline-cartoon-v1.0.1/pack.json',
    'content-packs/free-starters/thumbnail/curiosity-question-cartoon-v1.0.1/pack.json',
    'content-packs/free-starters/thumbnail/documentary-label-tableau-v1.0.1/pack.json',
    'content-packs/free-starters/thumbnail/prehistoric-discovery-v1.0.1/pack.json',
    'content-packs/free-starters/topic/ancient-humans-survival-v1.0.1/pack.json',
    'content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1/pack.json',
    'content-packs/free-starters/topic/economics-businesses-v1.0.1/pack.json',
    'content-packs/free-starters/topic/everyday-calm-v1.0.1/pack.json',
    'content-packs/free-starters/topic/habits-momentum-v1.0.1/pack.json',
    'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1/pack.json',
    'content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1/pack.json',
    'content-packs/free-starters/topic/natural-world-animals-v1.0.1/pack.json',
    'content-packs/free-starters/topic/night-journeys-v1.0.1/pack.json',
    'content-packs/free-starters/topic/pov-historical-occupations-v1.0.1/pack.json',
  ])
  // The `-v1.0.1` list above cannot see a second successor, so the 1.0.2 roots were
  // going unpinned entirely. Five Formulas are the 2026-08-28 mark scrub: those
  // packs were already past 1.0.0, so their scrubbed successor is 1.0.2. History
  // Explained 1.0.2 is the separate free compatibility successor. The two Style
  // 1.0.2 roots are the 2026-09-08 preview backfill landing on the two Styles
  // that were already past 1.0.0 when it ran.
  const secondSuccessors = packSources.filter(({ relative }) => /-v1\.0\.2\/pack\.json$/.test(relative))
  assert.deepEqual(secondSuccessors.map(({ relative }) => relative).sort(), [
    'content-packs/free-starters/formula/ancient-humans-v1.0.2/pack.json',
    'content-packs/free-starters/formula/deep-time-documentary-v1.0.2/pack.json',
    'content-packs/free-starters/formula/history-explained-v1.0.2/pack.json',
    'content-packs/free-starters/formula/human-behavior-explained-v1.0.2/pack.json',
    'content-packs/free-starters/formula/natural-world-explained-v1.0.2/pack.json',
    'content-packs/free-starters/formula/pov-your-life-as-v1.0.2/pack.json',
    'content-packs/free-starters/kit/build-momentum-v1.0.2/pack.json',
    'content-packs/free-starters/kit/calm-mind-v1.0.2/pack.json',
    'content-packs/free-starters/kit/human-behavior-v1.0.2/pack.json',
    'content-packs/free-starters/kit/sleep-journeys-v1.0.2/pack.json',
    'content-packs/free-starters/style/minimal-stick-figure-explainer-v1.0.2/pack.json',
    'content-packs/free-starters/style/prehistoric-stick-cartoon-v1.0.2/pack.json',
    'content-packs/free-starters/topic/habits-momentum-v1.0.2/pack.json',
    'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.2/pack.json',
  ])
  assert.ok(secondSuccessors.every(({ source }) => source.version === '1.0.2'))
})

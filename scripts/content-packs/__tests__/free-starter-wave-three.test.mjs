import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { register } from 'tsx/esm/api'

const WAVE = new URL('../../../content-packs/free-starters/', import.meta.url)
const PROVENANCE = new URL('../../../content-packs/free-starters/ASSET-PROVENANCE.md', import.meta.url)
const BLOCKED_DREAMSCAPE_PREVIEW = new URL('../../../content-packs/free-starters/thumbnail/dreamscape-story-window/assets/dreamscape-story-window.webp', import.meta.url)
const DOCUMENT_NAME = { formula: 'series-formula', topic: 'topic-pack', style: 'visual-style', thumbnail: 'thumbnail-recipe' }
// Wave three shipped three Channel Kits. Owner ruling 2026-09-08 discontinued
// them and deleted every Kit source; these components are still authored and
// now sell one at a time.
const channels = {
  'calm-mind': ['guided-mindfulness', 'everyday-calm', 'watercolor-storybook', 'centered-hero-headline', 'Pause → Presence'],
  'build-momentum': ['practical-motivation', 'habits-momentum', 'flat-vector-explainer', 'annotated-business-board', 'Friction → Action'],
  'sleep-journeys': ['sleep-story', 'night-journeys', 'watercolor-storybook', 'dreamscape-story-window', 'Setting → Rest'],
}

const canonicalJson = value => JSON.stringify(value).toLowerCase()
const sourcePath = url => decodeURIComponent(url.pathname)
async function json(path) { return JSON.parse(await readFile(new URL(path, WAVE), 'utf8')) }
function provenanceRecords(markdown) {
  const match = markdown.match(/<!-- free-starter-preview-provenance\n([\s\S]*?)\n-->/)
  assert.ok(match, 'ASSET-PROVENANCE.md must contain the machine-readable preview registry')
  return JSON.parse(match[1])
}
async function assertApprovedPreview(record, { ownerId, assetPath, canonicalSourcePath }) {
  assert.equal(record.ownerId, ownerId)
  assert.equal(record.provenance, 'publisher-created-tool-generated-original')
  assert.equal(record.status, 'approved')
  assert.equal(record.sourcePath, canonicalSourcePath)
  assert.match(record.sha256, /^[a-f0-9]{64}$/)
  await access(assetPath)
  assert.equal(createHash('sha256').update(await readFile(assetPath)).digest('hex'), record.sha256)
  assert.deepEqual(await sharp(assetPath).metadata().then(({ format, width, height }) => ({ format, width, height })), { format: 'webp', width: 1672, height: 941 })
}

test('wave three binds the exact wellness identities, 15-subject Topics, and complete axes', async () => {
  const actualCounts = []
  for (const [, [formula, topic, style, recipe, promise]] of Object.entries(channels)) {
    const [formulaDoc, topicDoc, styleDoc, recipeDoc] = await Promise.all([
      json(`formula/${formula}/content/${DOCUMENT_NAME.formula}.json`),
      json(`topic/${topic}/content/${DOCUMENT_NAME.topic}.json`),
      json(`style/${style}/content/${DOCUMENT_NAME.style}.json`),
      json(`thumbnail/${recipe}/content/${DOCUMENT_NAME.thumbnail}.json`),
    ])
    actualCounts.push(topicDoc.subjects.length)
    assert.equal(formulaDoc.id, `com.storystudio.formula.${formula}`)
    assert.equal(formulaDoc.channel_promise, promise)
    assert.equal(topicDoc.id, `com.storystudio.topic.${topic}`)
    assert.equal(styleDoc.id, `com.storystudio.style.${style}`)
    assert.equal(recipeDoc.id, `com.storystudio.thumbnail.${recipe}`)
    assert.ok(recipeDoc.compatible_formula_ids.includes(formulaDoc.id), `${recipe} must declare compatibility with ${formula}`)
    assert.equal(topicDoc.subjects.length, 15)
    assert.equal(new Set(topicDoc.subjects.map(value => value.toLowerCase())).size, 15)
    for (const field of ['episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses', 'exclusions', 'compatibility_rules']) assert.ok(topicDoc[field]?.length, `${topic} needs ${field}`)
    for (const axis of ['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens']) assert.ok(topicDoc.idea_axes.some(row => row.id === axis), `${topic} needs ${axis}`)
    // Each component stands alone: no bundle, and no dependency on a coordinator.
    for (const [kind, slug] of [['formula', formula], ['topic', topic], ['style', style], ['thumbnail', recipe]]) {
      const manifest = await json(`${kind}/${slug}/pack.json`)
      assert.equal(manifest.bundles, undefined)
      assert.deepEqual(manifest.dependencies ?? [], [])
    }
  }
  assert.deepEqual(actualCounts, [15, 15, 15])
  assert.equal(channels['calm-mind'][3], 'centered-hero-headline')
  assert.equal(channels['build-momentum'][3], 'annotated-business-board')
  assert.equal(channels['sleep-journeys'][2], 'watercolor-storybook')
})

test('wellness and sleep sources reject medical, coercive, and high-arousal framing', async () => {
  const [everydayCalm, habitsMomentum, nightJourneys, sleepFormula] = await Promise.all([
    json('topic/everyday-calm/content/topic-pack.json'),
    json('topic/habits-momentum/content/topic-pack.json'),
    json('topic/night-journeys/content/topic-pack.json'),
    json('formula/sleep-story/content/series-formula.json'),
  ])
  assert.doesNotMatch(canonicalJson(everydayCalm), /diagnose|treat|cure|therapy/i)
  assert.doesNotMatch(canonicalJson(habitsMomentum), /crush|grind|shame|force|hustle/i)
  assert.doesNotMatch(canonicalJson(nightJourneys), /violence|peril|cliffhanger|jump scare|urgent/i)
  assert.match(sleepFormula.channel_promise, /low-arousal|rest/i)
  assert.match(canonicalJson(sleepFormula.script_structure), /no tension|no peril|no cliffhangers|no jump scares/)
})

test('offline assignments cover every new subject deterministically and safe source packages build with an ephemeral key', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'story-wave-three-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const unregister = register()
  const { contentPackDocumentToNiche, contentPackDocumentToTopicPack } = await import(new URL('../../../electron/server/content-packs/legacy-adapters.ts', import.meta.url))
  const { planIdeaAssignments } = await import(new URL('../../../electron/server/services/idea-campaign-planner.ts', import.meta.url))
  unregister()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(temporary, 'private.pem')
  const publicKeyPath = join(temporary, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')
  const approvedStyleCopies = {
    'style/watercolor-storybook/assets/watercolor-storybook.webp': '9c65c85f58f714941a9181b87ee6f5cecb4f21814272775d6c32282ed3ac1534',
    'style/flat-vector-explainer/assets/flat-vector-explainer.webp': '2c6cd5d6d9a90fb3f8e8557b6ac6477e1d74d0316cb34544afdc286f7ac55bce',
  }
  for (const [path, hash] of Object.entries(approvedStyleCopies)) {
    const preview = new URL(path, WAVE)
    assert.equal(createHash('sha256').update(await readFile(preview)).digest('hex'), hash)
    assert.deepEqual(await sharp(sourcePath(preview)).metadata().then(({ format, width, height }) => ({ format, width, height })), { format: 'webp', width: 1672, height: 941 })
  }

  for (const [channel, [formula, topic]] of Object.entries(channels)) {
    const [formulaDoc, topicDoc] = await Promise.all([
      json(`formula/${formula}/content/series-formula.json`),
      json(`topic/${topic}/content/topic-pack.json`),
    ])
    const niche = contentPackDocumentToNiche(formulaDoc)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(topicDoc)]
    const first = planIdeaAssignments({ niche, count: 15, seed: `wave-three-${channel}` }).slice(0, 15)
    const second = planIdeaAssignments({ niche, count: 15, seed: `wave-three-${channel}` }).slice(0, 15)
    assert.deepEqual(first, second)
    assert.equal(first.length, 15)
    assert.equal(new Set(first.map(item => item.fingerprint)).size, 15)
    for (const assignment of first) {
      assert.ok(assignment.dimensions.subject)
      assert.ok(assignment.dimensions['episode-object'])
      assert.ok(assignment.dimensions['time-place-scope'])
      assert.ok(assignment.dimensions.mechanism)
      assert.ok(assignment.dimensions['evidence-lens'])
    }
  }

  const safeSources = ['formula/guided-mindfulness', 'formula/practical-motivation', 'formula/sleep-story', 'topic/everyday-calm', 'topic/habits-momentum', 'topic/night-journeys', 'style/watercolor-storybook', 'style/flat-vector-explainer', 'thumbnail/centered-hero-headline', 'thumbnail/annotated-business-board', 'thumbnail/dreamscape-story-window']
  for (const source of safeSources) {
    const first = join(temporary, `${source.replace('/', '-')}-first.sspack`)
    const second = join(temporary, `${source.replace('/', '-')}-second.sspack`)
    await buildContentPack({ sourceDirectory: sourcePath(new URL(`${source}/`, WAVE)), privateKeyPath, outputPath: first, keyId: 'com.storystudio.key.test', minAppVersion: '1.0.0' })
    await buildContentPack({ sourceDirectory: sourcePath(new URL(`${source}/`, WAVE)), privateKeyPath, outputPath: second, keyId: 'com.storystudio.key.test', minAppVersion: '1.0.0' })
    assert.deepEqual(await readFile(first), await readFile(second))
    await validateContentPack({ archivePath: first, publicKeyPath, publisherId: 'com.storystudio', keyId: 'com.storystudio.key.test' })
  }
})

test('Dreamscape Story Window binds its approved publisher-created raster', async () => {
  const recipe = await json('thumbnail/dreamscape-story-window/content/thumbnail-recipe.json')
  assert.equal(recipe.id, 'com.storystudio.thumbnail.dreamscape-story-window')
  assert.deepEqual(recipe.preview_assets, [
    'assets/dreamscape-story-window.webp',
  ])
  const record = provenanceRecords(await readFile(PROVENANCE, 'utf8')).find(row => row.id === 'dreamscape-story-window')
  assert.ok(record, 'missing dreamscape-story-window provenance record')
  const ownerId = 'dreamscape-story-window'
  const canonicalSourcePath = 'content-packs/free-starters/thumbnail/dreamscape-story-window/assets/dreamscape-story-window.webp'
  const assetPath = sourcePath(BLOCKED_DREAMSCAPE_PREVIEW)
  try {
    await access(assetPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    assert.deepEqual(record, { id: ownerId, ownerId, provenance: 'publisher-created-tool-generated-original', status: 'blocked-missing-owner-original', sourcePath: null, sha256: null })
    assert.fail(`missing publisher-created Dreamscape Story Window raster: ${canonicalSourcePath}`)
  }
  await assertApprovedPreview(record, { ownerId, assetPath, canonicalSourcePath })
})

test('a present Dreamscape raster rejects a blocked provenance record', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'story-wave-three-blocked-preview-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const assetPath = join(temporary, 'dreamscape-story-window.webp')
  await writeFile(assetPath, await readFile(new URL('style/watercolor-storybook/assets/watercolor-storybook.webp', WAVE)))
  await assert.rejects(
    assertApprovedPreview({ id: 'dreamscape-story-window', ownerId: 'dreamscape-story-window', provenance: 'publisher-created-tool-generated-original', status: 'blocked-missing-owner-original', sourcePath: null, sha256: null }, {
      ownerId: 'dreamscape-story-window', assetPath,
      canonicalSourcePath: 'content-packs/free-starters/thumbnail/dreamscape-story-window/assets/dreamscape-story-window.webp',
    }),
    { name: 'AssertionError', message: /approved/ },
  )
})

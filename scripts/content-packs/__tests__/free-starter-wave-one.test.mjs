import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../', import.meta.url)
const WAVE = new URL('../../../content-packs/free-starters/', import.meta.url)
const BLOCKED_PREHISTORIC_PREVIEW = new URL('../../../content-packs/free-starters/thumbnail/prehistoric-discovery/assets/prehistoric-discovery.webp', import.meta.url)
const RELEASE = { keyId: 'com.storystudio.key.test', minAppVersion: '1.0.0' }

// Wave one shipped three Channel Kits, each coordinating one Formula, Topic,
// Style, and Recipe. Owner ruling 2026-09-08 discontinued Channel Kits and
// deleted every Kit source; the twelve components below are still authored,
// still built here, and now sold one at a time. The grouping survives only to
// say which Formula reads which Topic.
const channels = [
  ['wild-worlds', 'natural-world-explained', 'natural-world-animals', 'waxy-outline-cartoon', 'curiosity-question-cartoon'],
  ['first-humans', 'ancient-humans', 'ancient-humans-survival', 'prehistoric-stick-cartoon', 'prehistoric-discovery'],
  ['deep-time', 'deep-time-documentary', 'deep-time-earth-systems', 'paleo-documentary-tableau', 'documentary-label-tableau'],
].map(([slug, formula, topic, style, recipe]) => ({
  slug,
  components: [
    ['formula', formula, 'series-formula'],
    ['topic', topic, 'topic-pack'],
    ['style', style, 'visual-style'],
    ['thumbnail', recipe, 'thumbnail-recipe'],
  ].map(([kindSlug, componentSlug, kind]) => ({
    kindSlug, componentSlug, kind,
    packId: `com.storystudio.pack.${kindSlug}.${componentSlug}`,
    itemId: `com.storystudio.${kindSlug === 'thumbnail' ? 'thumbnail' : kindSlug}.${componentSlug}`,
  })),
}))

const topics = [
  ['natural-world-animals', 10],
  ['ancient-humans-survival', 20],
  ['deep-time-earth-systems', 30],
].map(([slug, subjectCount]) => ({ slug, subjectCount, path: new URL(`topic/${slug}/content/topic-pack.json`, WAVE) }))

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

async function sourceFor(kind, slug) {
  const root = new URL(`${kind}/${slug}/`, WAVE)
  const [manifest, document] = await Promise.all([
    readJson(new URL('pack.json', root)),
    readJson(new URL(`content/${kind === 'formula' ? 'series-formula' : kind === 'topic' ? 'topic-pack' : kind === 'style' ? 'visual-style' : 'thumbnail-recipe'}.json`, root)),
  ])
  return { root, manifest, document }
}

function sourceDirectory(url) {
  return decodeURIComponent(url.pathname)
}

test('wave one has the exact source identities, advertisements, and enriched topic dimensions', async () => {
  const sourceTopics = await Promise.all(topics.map(async row => ({ ...row, document: await readJson(row.path) })))
  assert.deepEqual(Object.fromEntries(sourceTopics.map(row => [row.document.id, row.document.subjects.length])), {
    'com.storystudio.topic.natural-world-animals': 10,
    'com.storystudio.topic.ancient-humans-survival': 20,
    'com.storystudio.topic.deep-time-earth-systems': 30,
  })
  for (const { document } of sourceTopics) {
    assert.ok(document.episode_objects.length > 0)
    assert.ok(document.time_place_scopes.length > 0)
    assert.ok(document.mechanisms.length > 0)
    assert.ok(document.evidence_lenses.length > 0)
    assert.ok(document.compatibility_rules.length > 0)
    assert.ok(document.idea_axes.some(axis => axis.id === 'episode-object'))
    assert.ok(document.idea_axes.some(axis => axis.id === 'time-place-scope'))
    assert.ok(document.idea_axes.some(axis => axis.id === 'mechanism'))
    assert.ok(document.idea_axes.some(axis => axis.id === 'evidence-lens'))
  }

  // Every component sells on its own now, so each one must be a standalone
  // source: its own creative document, and no bundle or dependency closure
  // pointing at a coordinator that no longer exists.
  for (const channel of channels) {
    for (const component of channel.components) {
      const { manifest, document } = await sourceFor(component.kindSlug, component.componentSlug)
      assert.equal(manifest.pack_id, component.packId)
      assert.match(manifest.version, /^1\.0\.\d+$/)
      assert.equal('items' in manifest, false)
      assert.equal('files' in manifest, false)
      assert.equal(manifest.bundles, undefined)
      assert.deepEqual(manifest.dependencies ?? [], [])
      assert.equal(document.id, component.itemId)
      assert.equal(document.kind, component.kind)
    }
  }
})

test('wave one Formula sources carry legacy loader decoration as authored schema fields', async () => {
  const expected = {
    'natural-world-explained': ['Living world', 'Natural World, Explained'],
    'ancient-humans': ['Evidence & systems', 'How Did Ancient Humans…?'],
    'deep-time-documentary': ['Evidence & systems', 'Deep Time Documentary'],
  }
  for (const [slug, [family, name]] of Object.entries(expected)) {
    const { document } = await sourceFor('formula', slug)
    assert.equal(document.formula_family, family)
    assert.equal(document.name, name)
    assert.ok(document.perspective_policy)
    assert.ok(document.narrative_quality_contract)
    assert.ok(document.metadata_profile)
  }
})

test('Natural World compatibility prose names every declared Formula', async () => {
  const topic = await readJson(new URL('topic/natural-world-animals/content/topic-pack.json', WAVE))
  assert.deepEqual(topic.compatible_formula_ids, [
    'com.storystudio.formula.natural-world-explained',
    'com.storystudio.formula.listicle-explainer',
  ])
  assert.match(topic.compatibility_rules.join(' '), /Natural World Formula.*Counted Explainer/i)
})

test('offline assignments cover each advertised Topic deterministically with meaningful fingerprints', async () => {
  const unregister = register()
  const { contentPackDocumentToNiche, contentPackDocumentToTopicPack } = await import(new URL('../../../electron/server/content-packs/legacy-adapters.ts', import.meta.url))
  const { planIdeaAssignments } = await import(new URL('../../../electron/server/services/idea-campaign-planner.ts', import.meta.url))
  unregister()

  for (const topic of topics) {
    const formulaSlug = channels.find(channel => channel.components.some(component => component.componentSlug === topic.slug))?.components[0].componentSlug
    const { document: formula } = await sourceFor('formula', formulaSlug)
    const sourceTopic = await readJson(topic.path)
    const niche = contentPackDocumentToNiche(formula)
    niche.activeTopicPacks = [contentPackDocumentToTopicPack(sourceTopic)]
    const first = planIdeaAssignments({ niche, count: topic.subjectCount, seed: `wave-one-${topic.slug}` }).slice(0, topic.subjectCount)
    const second = planIdeaAssignments({ niche, count: topic.subjectCount, seed: `wave-one-${topic.slug}` }).slice(0, topic.subjectCount)
    assert.deepEqual(first, second)
    assert.equal(first.length, topic.subjectCount)
    assert.equal(new Set(first.map(item => item.fingerprint)).size, topic.subjectCount)
    for (const assignment of first) {
      assert.ok(assignment.dimensions.subject)
      assert.ok(assignment.dimensions['episode-object'])
      assert.ok(assignment.dimensions['time-place-scope'])
      assert.ok(assignment.dimensions.mechanism)
      assert.ok(assignment.dimensions['evidence-lens'])
    }
  }
})

test('approved preview bytes are copied unchanged and all unblocked sources build reproducibly with an ephemeral key', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'story-wave-one-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(temporary, 'private.pem')
  const publicKeyPath = join(temporary, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')
  const approvedCopies = {
    'style/waxy-outline-cartoon/assets/waxy-outline-cartoon.webp': 'd3597964cecae335b8f9b18dd6f589b9891cf5e07a84bd1015ca10c5d0a94010',
    'style/prehistoric-stick-cartoon/assets/prehistoric-stick-cartoon.webp': '332f2620384aabf367f76380cd991a33f3abd44efc63abe3ea3a3e06bb68f096',
    'style/paleo-documentary-tableau/assets/paleo-documentary-tableau.webp': '5d2daa07445802fcd32d953ce79627d1d305d17a200c98de24be4c59bed68a64',
    'thumbnail/curiosity-question-cartoon/assets/poison-or-cure.webp': '7db7035bf150ff038dd66e09ee1b64bb5dd9c25e6a0e5bf5dd07693887a9d331',
    'thumbnail/curiosity-question-cartoon/assets/too-smart.webp': '63a39f11109f0ca2eb2c5f4281f29e24b9f9b6a417cb398c1832d356ed5a15a0',
    'thumbnail/curiosity-question-cartoon/assets/silent-killer.webp': '23104abd2f2b670b6f891f1dd4d3f024c82a7ad2ef4db22859461b4344bd5820',
    'thumbnail/documentary-label-tableau/assets/sleep.webp': '5e3a64298145f243dfea3a6687440962fc298d8b3290a8ff29bac3447b1cf491',
    'thumbnail/documentary-label-tableau/assets/giants.webp': '46ba43a45b2c14ac15364af2fab5ff50798f6335baee3beeadef7727aa51de27',
    'thumbnail/documentary-label-tableau/assets/rift.webp': 'a7ea66ddb743ccc93ed3536ecddca248fa9187d4fa9eeced0377970536a0e4a2',
  }
  for (const [relativePath, hash] of Object.entries(approvedCopies)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(relativePath, WAVE))).digest('hex'), hash)
  }
  const unblocked = channels.flatMap(channel => channel.components.map(component => [component.kindSlug, component.componentSlug]))
  for (const [kind, slug] of unblocked) {
    const source = sourceDirectory(new URL(`${kind}/${slug}/`, WAVE))
    const first = join(temporary, `${kind}-${slug}-first.sspack`)
    const second = join(temporary, `${kind}-${slug}-second.sspack`)
    await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: first, ...RELEASE })
    await buildContentPack({ sourceDirectory: source, privateKeyPath, outputPath: second, ...RELEASE })
    assert.deepEqual(await readFile(first), await readFile(second))
    await validateContentPack({ archivePath: first, publicKeyPath, publisherId: 'com.storystudio', keyId: RELEASE.keyId })
  }
})

test('First Humans binds its approved publisher-created Prehistoric Discovery raster', async () => {
  const { manifest, document } = await sourceFor('thumbnail', 'prehistoric-discovery')
  assert.equal(manifest.pack_id, 'com.storystudio.pack.thumbnail.prehistoric-discovery')
  assert.deepEqual(document.preview_assets, [
    'assets/prehistoric-discovery.webp',
  ])
  await access(BLOCKED_PREHISTORIC_PREVIEW)
  assert.deepEqual(await sharp(sourceDirectory(BLOCKED_PREHISTORIC_PREVIEW)).metadata().then(({ format, width, height }) => ({ format, width, height })), {
    format: 'webp', width: 1672, height: 941,
  })
})

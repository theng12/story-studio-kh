import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

const WAVE = new URL('../../../content-packs/free-starters/', import.meta.url)
const ROOT = new URL('../../../', import.meta.url)
const PROVENANCE = new URL('../../../content-packs/free-starters/ASSET-PROVENANCE.md', import.meta.url)
const kits = {
  'business-explained': ['economics-of', 'economics-businesses', 'hand-drawn-editorial-diagram', 'annotated-business-board', 'Cost → Constraint'],
  'human-behavior': ['human-behavior-explained', 'human-behavior-social-dynamics', 'minimal-stick-figure-explainer', 'centered-hero-headline', 'Signal → Choice'],
  'history-explained': ['history-explained', 'historical-wars-treaties-world-order', 'sepia-ink-wash', 'documentary-label-tableau', 'Event → Consequence'],
  'a-life-as': ['pov-your-life-as', 'pov-historical-occupations', 'cinematic-photoreal', 'portrait-block-right', 'Role → Reality'],
}

const subjectCounts = [40, 10, 25, 25]
const documentName = { formula: 'series-formula', topic: 'topic-pack', style: 'visual-style', thumbnail: 'thumbnail-recipe' }
async function json(path) { return JSON.parse(await readFile(new URL(path, WAVE), 'utf8')) }
const sourcePath = url => decodeURIComponent(url.pathname)
function provenanceRecords(markdown) {
  const match = markdown.match(/<!-- free-starter-preview-provenance\n([\s\S]*?)\n-->/)
  assert.ok(match, 'ASSET-PROVENANCE.md must contain the machine-readable preview registry')
  return JSON.parse(match[1])
}

test('wave two has exact source identities, enriched Topic dimensions, promises, and Kit closures', async () => {
  const actualCounts = []
  for (const [kit, [formula, topic, style, recipe, promise]] of Object.entries(kits)) {
    const [formulaDoc, topicDoc, styleDoc, recipeDoc, manifest] = await Promise.all([
      json(`formula/${formula}/content/${documentName.formula}.json`), json(`topic/${topic}/content/${documentName.topic}.json`),
      json(`style/${style}/content/${documentName.style}.json`), json(`thumbnail/${recipe}/content/${documentName.thumbnail}.json`), json(`kit/${kit}/pack.json`),
    ])
    actualCounts.push(topicDoc.subjects.length)
    assert.equal(formulaDoc.id, `com.storystudio.formula.${formula}`)
    assert.equal(formulaDoc.channel_promise, promise)
    assert.equal(topicDoc.id, `com.storystudio.topic.${topic}`)
    assert.equal(styleDoc.id, `com.storystudio.style.${style}`)
    assert.equal(recipeDoc.id, `com.storystudio.thumbnail.${recipe}`)
    for (const field of ['episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses', 'exclusions', 'compatibility_rules']) assert.ok(topicDoc[field]?.length, `${topic} needs ${field}`)
    for (const axis of ['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens']) assert.ok(topicDoc.idea_axes.some(row => row.id === axis), `${topic} needs ${axis}`)
    assert.deepEqual(manifest.dependencies.map(row => row.pack_id), [
      `com.storystudio.pack.formula.${formula}`, `com.storystudio.pack.topic.${topic}`,
      `com.storystudio.pack.style.${style}`, `com.storystudio.pack.thumbnail.${recipe}`,
    ])
  }
  assert.deepEqual(actualCounts, subjectCounts)
  assert.equal(kits['human-behavior'][3], 'centered-hero-headline')
  assert.equal(kits['history-explained'][3], 'documentary-label-tableau')
})

test('wars Topic remains compatible with both the new History Formula and Hidden Mechanics History', async () => {
  const wars = await json('topic/historical-wars-treaties-world-order/content/topic-pack.json')
  assert.ok(wars.compatible_formula_ids.includes('com.storystudio.formula.history-explained'))
  assert.ok(wars.compatible_formula_ids.includes('com.storystudio.formula.hidden-mechanics-history'))
  assert.match(wars.prompt_context, /diplomacy, political objectives, resources, alliances, logistics, and civilian consequences/)
})

test('approved wave two preview bytes remain unchanged and every unblocked source builds deterministically', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'story-wave-two-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(temporary, 'private.pem')
  const publicKeyPath = join(temporary, 'public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const approved = {
    'style/hand-drawn-editorial-diagram/assets/hand-drawn-editorial-diagram.webp': 'f77e53d89e1278f107b9f81483de4e422444b6c2221ea3fc248d7dd96e73b1fe',
    'style/minimal-stick-figure-explainer/assets/minimal-stick-figure-explainer.webp': '9a6c9d494566a2a6e053595004f973776bde9886beab135feb00ded7426d8a88',
    'style/sepia-ink-wash/assets/sepia-ink-wash.webp': 'eb45b547bd057a05579fc9d140158dcfa0309b5b96d87ce8cbf366053fa4a3ae',
    'style/cinematic-photoreal/assets/cinematic-photoreal.webp': '667b99a21264de8f6c2738b739df3ed77034a6cc3357458191a6a0cd569feeb0',
    'thumbnail/annotated-business-board/assets/coffee.webp': '7b0a222dcf0ca1d558d5ebfa28300ec9be201d8ddcbe70259c0fb05fc57da1e8',
    'thumbnail/annotated-business-board/assets/workshop.webp': 'ee08f477759b2dbc1ddc1df4a3560e3c030523858f23f396b67730c3b7240328',
    'thumbnail/annotated-business-board/assets/hotel.webp': '29064f0bd0b38e59883db2ee8f1c66f428c10a3afbca02ca488c9adaf758c2fe',
  }
  for (const [path, hash] of Object.entries(approved)) assert.equal(createHash('sha256').update(await readFile(new URL(path, WAVE))).digest('hex'), hash)
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')
  const unblocked = ['formula/economics-of', 'formula/human-behavior-explained', 'formula/history-explained', 'formula/pov-your-life-as', 'topic/economics-businesses', 'topic/human-behavior-social-dynamics', 'topic/historical-wars-treaties-world-order', 'topic/pov-historical-occupations', 'style/hand-drawn-editorial-diagram', 'style/minimal-stick-figure-explainer', 'style/sepia-ink-wash', 'style/cinematic-photoreal', 'thumbnail/annotated-business-board', 'kit/business-explained', 'kit/human-behavior', 'kit/history-explained', 'kit/a-life-as']
  for (const source of unblocked) {
    const first = join(temporary, `${source.replace('/', '-')}-first.sspack`)
    const second = join(temporary, `${source.replace('/', '-')}-second.sspack`)
    await buildContentPack({ sourceDirectory: sourcePath(new URL(`${source}/`, WAVE)), privateKeyPath, outputPath: first, keyId: 'com.storystudio.key.test', minAppVersion: '1.0.0' })
    await buildContentPack({ sourceDirectory: sourcePath(new URL(`${source}/`, WAVE)), privateKeyPath, outputPath: second, keyId: 'com.storystudio.key.test', minAppVersion: '1.0.0' })
    assert.deepEqual(await readFile(first), await readFile(second))
    await validateContentPack({ archivePath: first, publicKeyPath, publisherId: 'com.storystudio', keyId: 'com.storystudio.key.test' })
  }
})

test('BLOCKED: Centered Hero and Portrait Block bind a future raster to their exact owner provenance', async () => {
  const records = provenanceRecords(await readFile(PROVENANCE, 'utf8'))
  for (const [ownerId, preview] of [['centered-hero-headline', 'thumbnail/centered-hero-headline/assets/centered-hero-headline.webp'], ['portrait-block-right', 'thumbnail/portrait-block-right/assets/portrait-block-right.webp']]) {
    const record = records.find(row => row.id === ownerId)
    assert.ok(record, `missing ${ownerId} provenance record`)
    assert.equal(record.ownerId, ownerId)
    assert.equal(record.provenance, 'owner-supplied-original')
    const url = new URL(preview, WAVE)
    const canonicalSourcePath = `content-packs/free-starters/${preview}`
    if (record.status === 'blocked-missing-owner-original') {
      assert.equal(record.sourcePath, null)
      assert.equal(record.sha256, null)
      await access(url)
      continue
    }
    assert.equal(record.status, 'approved')
    assert.equal(record.sourcePath, canonicalSourcePath)
    assert.match(record.sha256, /^[a-f0-9]{64}$/)
    await access(url)
    assert.equal(createHash('sha256').update(await readFile(url)).digest('hex'), record.sha256)
    assert.deepEqual(await sharp(sourcePath(url)).metadata().then(({ format, width, height }) => ({ format, width, height })), { format: 'webp', width: 1672, height: 941 })
  }
})

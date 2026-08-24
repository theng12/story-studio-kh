import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const registryPath = join(repositoryRoot, 'content-packs', 'authoring-registry.json')
const stagingModule = new URL('../stage-handoff-artifacts.mjs', import.meta.url)
const waveId = 'thumbnail-recipe-expansion-ten'
const deliveryProfile = 'genstudio-store-receipt-v1'
const minAppVersion = '1.0.843'
const maxArchiveBytes = 52_428_800
const receiptRef = 'authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378'
const allowedSlugs = [
  'before-after-proof-panel',
  'two-option-criteria-split',
  'reaction-evidence-inset',
  'cutaway-exploded-object',
  'hero-payoff-companion',
  'iconic-result-closeup',
  'scale-journey',
  'numbered-lineup',
  'macro-mystery-detail',
  'hands-on-pov-moment',
]
const summaries = {
  'before-after-proof-panel': 'Matched before-and-after states show one subject changing across a truthful temporal seam.',
  'two-option-criteria-split': 'Two present-time alternatives receive equal visual weight for an honest criteria-based comparison.',
  'reaction-evidence-inset': 'A reaction subject directs attention to one original in-scene evidence detail.',
  'cutaway-exploded-object': 'One object opens into an ordered, readable view of its meaningful internal layers.',
  'hero-payoff-companion': 'A generic hero visibly interacts with a separate, tangible result object.',
  'iconic-result-closeup': 'One truthful finished outcome dominates the frame at a detail-revealing angle.',
  'scale-journey': 'Three related forms progress through continuous depth to communicate scale or magnitude.',
  'numbered-lineup': 'Three to five equal-status entries form a precise lineup with matching native numerals.',
  'macro-mystery-detail': 'An extreme close detail creates bounded curiosity while a small honest clue preserves context.',
  'hands-on-pov-moment': 'First-person or over-shoulder hands perform one clear, safe action in task context.',
}
const bindings = Object.fromEntries(allowedSlugs.map(slug => [slug, {
  pack_id: `com.storystudio.pack.thumbnail.${slug}`,
  item_id: `com.storystudio.thumbnail.${slug}`,
  version: '1.0.0',
  publisher_id: 'com.storystudio',
  kind: 'thumbnail-recipe',
  source_path: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/${slug}`,
  dependencies: [],
}]))
const requiredReviewNames = [
  'schema',
  'originality-provenance',
  'compatibility',
  'prompt-equivalence',
  'visual',
  'thumbnail',
  'safety',
  'copy',
  'commercial-boundary',
]
const forbiddenKey = /(credential|secret|private.?key|provider|model|route|price|credit|discount|commerce|product|release|account|wire)/i
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const absent = path => access(path).then(() => false, () => true)

function recursiveWalk(value, visit) {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value)) for (const [key, child] of Object.entries(value)) visit(key, child)
  for (const child of Object.values(value)) recursiveWalk(child, visit)
}

function reviewsFor(slug) {
  const base = `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/${slug}`
  return requiredReviewNames.map(review => ({
    review,
    status: 'passed',
    evidence: review === 'commercial-boundary'
      ? `${base}.spec.md and ${base}.quality.md`
      : `${base}.${['originality-provenance', 'visual', 'thumbnail', 'safety', 'copy'].includes(review) ? 'quality' : 'spec'}.md`,
  }))
}

function componentSummary(slug) {
  return { schema_version: 1, kind: 'thumbnail-recipe', summary: summaries[slug], slots: { 'thumbnail-recipe': 1 } }
}

async function archiveFacts(archivePath, slug) {
  const bytes = await readFile(archivePath)
  const zip = await JSZip.loadAsync(bytes)
  const files = Object.values(zip.files).filter(entry => !entry.dir)
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  const expectedNames = [
    'manifest.json',
    'content/thumbnail-recipe.json',
    ...[1, 2, 3].map(index => `assets/${slug}-${index}.webp`),
  ]
  assert.deepEqual(files.map(entry => entry.name).sort(), expectedNames.sort())
  for (const entry of files) {
    assert.equal(entry.unixPermissions & 0o170000, 0o100000, `${entry.name} is a regular file`)
    assert.equal(entry.unixPermissions & 0o111, 0, `${entry.name} is not executable`)
    assert.doesNotMatch(entry.name, /\.(?:sh|exe|bat|cmd|com|ps1)$/i)
  }
  const parsedJson = []
  for (const entry of files.filter(candidate => candidate.name.endsWith('.json'))) {
    parsedJson.push(JSON.parse(await entry.async('string')))
  }
  recursiveWalk(parsedJson, (key, value) => {
    assert.notEqual(key, 'component_summary')
    assert.doesNotMatch(key, forbiddenKey)
    if (typeof value === 'string') assert.doesNotMatch(value, /^https?:\/\//i)
  })
  return { bytes, zip, manifest }
}

async function buildTwice(slug, root) {
  const binding = bindings[slug]
  const sourceDirectory = join(repositoryRoot, binding.source_path)
  const first = join(root, `${slug}-first.sspack`)
  const second = join(root, `${slug}-second.sspack`)
  for (const outputPath of [first, second]) {
    await buildContentPack({ sourceDirectory, outputPath, deliveryProfile, minAppVersion })
    await validateContentPack({ archivePath: outputPath, deliveryProfile, includeManifest: true })
  }
  const [one, two] = await Promise.all([readFile(first), readFile(second)])
  assert.deepEqual(two, one, `${slug} must build byte-identically`)
  assert.equal(digest(two), digest(one))
  assert.ok(one.byteLength > 0 && one.byteLength <= maxArchiveBytes)
  const { zip, manifest } = await archiveFacts(first, slug)
  assert.equal(manifest.pack_id, binding.pack_id)
  assert.equal(manifest.publisher_id, binding.publisher_id)
  assert.equal(manifest.version, binding.version)
  assert.equal(manifest.min_app_version, minAppVersion)
  assert.equal(manifest.delivery_profile, deliveryProfile)
  assert.deepEqual(manifest.dependencies, [])
  assert.equal(manifest.items.length, 1)
  assert.deepEqual(manifest.items[0], { id: binding.item_id, kind: binding.kind, path: 'content/thumbnail-recipe.json', schema_version: 1 })
  assert.equal(Object.hasOwn(manifest, 'key_id'), false)
  assert.equal(zip.file('signature.ed25519'), null)
  for (let index = 1; index <= 3; index += 1) {
    const relativeAsset = `assets/${slug}-${index}.webp`
    assert.deepEqual(await zip.file(relativeAsset).async('nodebuffer'), await readFile(join(sourceDirectory, relativeAsset)))
  }
  return { slug, candidate_path: first, bytes: one.byteLength, sha256: digest(one) }
}

async function fixture(t, eligibleSlugs = allowedSlugs.slice(0, 2)) {
  const root = await mkdtemp(join(tmpdir(), 'story-thumbnail-ten-stage-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidateRoot = join(root, 'candidates')
  const artifactRoot = join(root, 'artifacts', 'thumbnail-ten')
  const receiverHandoffPath = join(root, 'receiver', 'receiver.json')
  await Promise.all([mkdir(candidateRoot), mkdir(dirname(artifactRoot)), mkdir(dirname(receiverHandoffPath))])
  const candidates = []
  for (const slug of eligibleSlugs) candidates.push(await buildTwice(slug, candidateRoot))
  const entries = candidates.map(candidate => ({
    ...candidate,
    ...bindings[candidate.slug],
    delivery_profile: deliveryProfile,
    min_app_version: minAppVersion,
    receipt_ref: receiptRef,
    reviews: reviewsFor(candidate.slug),
    component_summary: componentSummary(candidate.slug),
  }))
  const blockedEntries = allowedSlugs.filter(slug => !eligibleSlugs.includes(slug))
    .map(slug => ({ slug, blocker: `Review-clean authored candidate not selected in fixture: ${slug}` }))
  return { waveId, repositoryRoot, candidateRoot, artifactRoot, receiverHandoffPath, allowedSlugs: [...allowedSlugs], eligibleSlugs: [...eligibleSlugs], entries, blockedEntries }
}

test('all ten authored and review-clean recipes build twice as deterministic keyless candidates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'story-thumbnail-ten-build-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  for (const slug of allowedSlugs) {
    const binding = bindings[slug]
    const record = registry.records.find(candidate => candidate.pack_id === binding.pack_id)
    assert.equal(record.status, 'authored')
    assert.equal(record.receipt_ref, receiptRef)
    assert.deepEqual(record.dependencies, [])
    for (const suffix of ['spec', 'quality']) {
      const review = await readFile(join(repositoryRoot, `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/${slug}.${suffix}.md`), 'utf8')
      assert.match(review, /(?:^|\n)PASS\s*(?:\n|$)/)
      assert.doesNotMatch(review, /(?:Important|Critical).*OPEN/i)
    }
    await buildTwice(slug, root)
  }
})

test('the named ten-recipe wave stages an exact partial partition with Story identities and truthful status', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const input = await fixture(t)
  const result = await stageHandoffArtifacts(input)
  assert.equal(result.phase, 'complete')
  const ledger = JSON.parse(await readFile(result.ledgerPath, 'utf8'))
  const release = JSON.parse(await readFile(result.releaseHandoffPath, 'utf8'))
  const receiver = JSON.parse(await readFile(result.receiverHandoffPath, 'utf8'))
  assert.deepEqual(Object.keys(ledger).sort(), ['entries', 'schema_version'])
  assert.deepEqual(Object.keys(release).sort(), ['entries', 'schema_version'])
  assert.deepEqual(Object.keys(receiver).sort(), ['artifact_root', 'blocked_entries', 'explicitly_not_done', 'ledger_path', 'schema_version', 'status', 'successful_entries'])
  assert.equal(receiver.status, 'partial-ready-blocked')
  assert.deepEqual(receiver.blocked_entries, input.blockedEntries)
  assert.deepEqual(receiver.successful_entries, release.entries)
  for (const [index, entry] of release.entries.entries()) {
    const binding = bindings[entry.slug]
    assert.deepEqual(Object.keys(entry).sort(), [
      'absolute_path', 'bytes', 'component_summary', 'delivery_profile', 'dependencies', 'item_id', 'kind',
      'min_app_version', 'pack_id', 'publisher_id', 'receipt_ref', 'reviews', 'sha256', 'slug', 'source_path', 'version',
    ].sort())
    for (const field of ['pack_id', 'item_id', 'version', 'publisher_id', 'kind', 'source_path', 'dependencies']) assert.deepEqual(entry[field], binding[field])
    assert.deepEqual(entry.component_summary, componentSummary(entry.slug))
    assert.deepEqual(entry.reviews.map(review => review.review), requiredReviewNames)
    assert.deepEqual(await readFile(entry.absolute_path), await readFile(input.entries[index].candidate_path))
    await validateContentPack({ archivePath: entry.absolute_path, deliveryProfile })
  }
  assert.equal(JSON.stringify(ledger).includes('component_summary'), false)
})

test('the named ten-recipe wave derives ready status only from exact complete delivery', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const input = await fixture(t, allowedSlugs)
  const result = await stageHandoffArtifacts(input)
  const receiver = JSON.parse(await readFile(result.receiverHandoffPath, 'utf8'))
  assert.equal(receiver.status, 'ready-for-owner-stocking')
  assert.deepEqual(receiver.successful_entries.map(entry => entry.slug), allowedSlugs)
  assert.deepEqual(receiver.blocked_entries, [])
})

test('the named wave fails closed on malformed partitions, bindings, receipts, summaries, reviews, and destinations', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const cases = [
    ['duplicate allowed', base => ({ allowedSlugs: [...base.allowedSlugs, base.allowedSlugs[0]] }), /duplicate|exact/i],
    ['unknown allowed', base => ({ allowedSlugs: [...base.allowedSlugs.slice(0, -1), 'unknown-leaf'] }), /fixed|exact|slug/i],
    ['omitted blocked', base => ({ blockedEntries: base.blockedEntries.slice(1) }), /partition|blocked/i],
    ['overlap', base => ({ blockedEntries: [...base.blockedEntries, { slug: base.eligibleSlugs[0], blocker: 'overlap' }] }), /overlap|partition|blocked/i],
    ['wrong receipt', base => ({ entries: base.entries.map(entry => ({ ...entry, receipt_ref: `authoring:${'0'.repeat(64)}` })) }), /receipt/i],
    ['wrong binding', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, item_id: `${entry.item_id}.wrong` }) }), /binding|item_id/i],
    ['wrong profile', base => ({ entries: base.entries.map(entry => ({ ...entry, delivery_profile: 'other' })) }), /profile/i],
    ['wrong floor', base => ({ entries: base.entries.map(entry => ({ ...entry, min_app_version: '1.0.842' })) }), /min_app_version/i],
    ['wrong digest', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, sha256: '0'.repeat(64) }) }), /digest|SHA/i],
    ['wrong bytes', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, bytes: entry.bytes + 1 }) }), /byte/i],
    ['wrong summary', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, component_summary: { ...entry.component_summary, summary: 'wrong' } }) }), /summary/i],
    ['wrong summary slot', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, component_summary: { ...entry.component_summary, slots: { 'series-formula': 1 } } }) }), /summary|slot/i],
    ['incomplete review', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, reviews: entry.reviews.slice(1) }) }), /review/i],
    ['reordered reviews', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, reviews: entry.reviews.toReversed() }) }), /review/i],
    ['wrong review evidence', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, reviews: entry.reviews.map((review, reviewIndex) => reviewIndex ? review : { ...review, evidence: 'generic claim' }) }) }), /review|evidence/i],
    ['extra entry field', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, unexpected: true }) }), /entry|field/i],
    ['artifact inside repository', () => ({ artifactRoot: join(repositoryRoot, '.forbidden-thumbnail-ten') }), /repository/i],
  ]
  for (const [label, mutation, pattern] of cases) {
    const base = await fixture(t)
    await assert.rejects(stageHandoffArtifacts({ ...base, ...mutation(base) }), pattern, label)
    assert.equal(await absent(base.artifactRoot), true, label)
    assert.equal(await absent(base.receiverHandoffPath), true, label)
  }

  const existing = await fixture(t)
  await mkdir(existing.artifactRoot)
  await assert.rejects(stageHandoffArtifacts(existing), /already exists/i)

  const symlinked = await fixture(t)
  const realRoot = `${symlinked.candidateRoot}-real`
  await rm(symlinked.candidateRoot, { recursive: true })
  await mkdir(realRoot)
  await symlink(realRoot, symlinked.candidateRoot, 'dir')
  await assert.rejects(stageHandoffArtifacts(symlinked), /symlink/i)

  const mislabeled = await fixture(t)
  const [left, right] = mislabeled.entries
  await assert.rejects(stageHandoffArtifacts({
    ...mislabeled,
    entries: [
      { ...left, candidate_path: right.candidate_path, bytes: right.bytes, sha256: right.sha256 },
      { ...right, candidate_path: left.candidate_path, bytes: left.bytes, sha256: left.sha256 },
    ],
  }), /archive.*identity|binding|manifest/i)
})

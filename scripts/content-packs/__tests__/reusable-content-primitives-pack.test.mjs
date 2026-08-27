import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const registryPath = join(repositoryRoot, 'content-packs', 'authoring-registry.json')
const stagingModule = new URL('../stage-handoff-artifacts.mjs', import.meta.url)
const deliveryProfile = 'genstudio-store-receipt-v1'
const minAppVersion = '1.0.843'
const maxArchiveBytes = 52_428_800
const receiptRef = 'authoring:bd4d3d8938cee8b2191379c5912cbbc5d848daa36bf6f7ca28f870c1359a2728'
const waveLeaves = [
  ['question-ladder', 'formula/question-ladder'],
  ['audience-question-seeder', 'topic/audience-question-seeder'],
  ['before-after-timeline', 'formula/before-after-timeline'],
  ['object-hero-question', 'thumbnail/object-hero-question'],
  ['route-map-one-promise', 'thumbnail/route-map-one-promise'],
]
const allowedSlugs = waveLeaves.map(([slug]) => slug)
const textSlugs = allowedSlugs.slice(0, 3)
const summaries = {
  'question-ladder': { schema_version: 1, kind: 'series-formula', summary: 'A reusable evidence-aware answer ladder from concrete question to bounded conclusion.', slots: { 'series-formula': 1 } },
  'audience-question-seeder': { schema_version: 1, kind: 'topic-pack', summary: 'A duplicate-resistant audience-question domain pack with bounded evidence and actionability axes.', slots: { 'topic-pack': 1 } },
  'before-after-timeline': { schema_version: 1, kind: 'series-formula', summary: 'A reusable baseline-to-result timeline that keeps confounders and causal limits visible.', slots: { 'series-formula': 1 } },
  'object-hero-question': { schema_version: 1, kind: 'thumbnail-recipe', summary: 'A single-object thumbnail grammar with an exact AI-rendered episode-title question.', slots: { 'thumbnail-recipe': 1 } },
  'route-map-one-promise': { schema_version: 1, kind: 'thumbnail-recipe', summary: 'A symbolic route-and-promise thumbnail grammar with an exact AI-rendered episode title.', slots: { 'thumbnail-recipe': 1 } },
}
const waveBindings = {
  'question-ladder': { pack_id: 'com.storystudio.pack.formula.question-ladder', item_id: 'com.storystudio.formula.question-ladder', version: '1.0.0', source_path: 'content-packs/reusable-primitives/formula/question-ladder' },
  'audience-question-seeder': { pack_id: 'com.storystudio.pack.topic.audience-question-seeder', item_id: 'com.storystudio.topic.audience-question-seeder', version: '1.0.0', source_path: 'content-packs/reusable-primitives/topic/audience-question-seeder' },
  'before-after-timeline': { pack_id: 'com.storystudio.pack.formula.before-after-timeline', item_id: 'com.storystudio.formula.before-after-timeline', version: '1.0.0', source_path: 'content-packs/reusable-primitives/formula/before-after-timeline' },
  'object-hero-question': { pack_id: 'com.storystudio.pack.thumbnail.object-hero-question', item_id: 'com.storystudio.thumbnail.object-hero-question', version: '1.0.0', source_path: 'content-packs/reusable-primitives/thumbnail/object-hero-question' },
  'route-map-one-promise': { pack_id: 'com.storystudio.pack.thumbnail.route-map-one-promise', item_id: 'com.storystudio.thumbnail.route-map-one-promise', version: '1.0.0', source_path: 'content-packs/reusable-primitives/thumbnail/route-map-one-promise' },
}
const completeReviews = [
  'schema',
  'originality-provenance',
  'compatibility',
  'prompt-equivalence',
  'safety',
  'copy',
  'commercial-boundary',
].map(review => ({ review, status: 'passed' }))
const recipeReviews = [...completeReviews, 'visual', 'thumbnail'].map(review => typeof review === 'string'
  ? { review, status: 'passed' }
  : review)

const absent = path => access(path).then(() => false, () => true)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function hasRecursiveKey(value, key) {
  if (!value || typeof value !== 'object') return false
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true
  return Object.values(value).some(child => hasRecursiveKey(child, key))
}

async function archiveJson(archivePath) {
  const archive = await JSZip.loadAsync(await readFile(archivePath))
  const parsed = []
  for (const [name, entry] of Object.entries(archive.files)) {
    if (!entry.dir && name.endsWith('.json')) parsed.push(JSON.parse(await entry.async('string')))
  }
  return { archive, parsed }
}

async function buildTwice(slug, relativeSource, root) {
  const sourceDirectory = join(repositoryRoot, 'content-packs', 'reusable-primitives', relativeSource)
  const first = join(root, `${slug}-first.sspack`)
  const second = join(root, `${slug}-second.sspack`)
  for (const outputPath of [first, second]) {
    await buildContentPack({ sourceDirectory, outputPath, deliveryProfile, minAppVersion })
    await validateContentPack({ archivePath: outputPath, deliveryProfile })
  }
  const firstBytes = await readFile(first)
  const secondBytes = await readFile(second)
  assert.deepEqual(secondBytes, firstBytes, `${slug} delivery build must be byte-identical`)
  assert.equal(digest(secondBytes), digest(firstBytes))
  assert.ok(firstBytes.byteLength <= maxArchiveBytes)
  const { archive, parsed } = await archiveJson(first)
  const manifest = JSON.parse(await archive.file('manifest.json').async('string'))
  assert.equal(manifest.min_app_version, minAppVersion)
  assert.equal(manifest.delivery_profile, deliveryProfile)
  assert.deepEqual(manifest.dependencies ?? [], [])
  assert.equal(Object.hasOwn(manifest, 'key_id'), false)
  assert.equal(archive.file('signature.ed25519'), null)
  assert.equal(parsed.some(value => hasRecursiveKey(value, 'component_summary')), false)
  return { slug, candidate_path: first, sha256: digest(firstBytes), bytes: firstBytes.byteLength }
}

async function stageFixture(t, eligibleSlugs = textSlugs.slice(0, 2)) {
  const root = await mkdtemp(join(tmpdir(), 'story-wave-two-stage-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidateRoot = join(root, 'candidates')
  const artifactParent = join(root, 'artifacts')
  const receiverParent = join(root, 'handoffs')
  await Promise.all([mkdir(candidateRoot), mkdir(artifactParent), mkdir(receiverParent)])
  const built = []
  for (const slug of eligibleSlugs) {
    const relativeSource = waveLeaves.find(([candidate]) => candidate === slug)[1]
    built.push(await buildTwice(slug, relativeSource, candidateRoot))
  }
  const entries = built.map(candidate => ({
    ...candidate,
    ...waveBindings[candidate.slug],
    delivery_profile: deliveryProfile,
    min_app_version: minAppVersion,
    receipt_ref: receiptRef,
    reviews: structuredClone(waveBindings[candidate.slug].pack_id.includes('.thumbnail.') ? recipeReviews : completeReviews),
    component_summary: structuredClone(summaries[candidate.slug]),
  }))
  const blockedEntries = allowedSlugs
    .filter(slug => !eligibleSlugs.includes(slug))
    .map(slug => ({ slug, blocker: `BLOCKED: ${slug} is not in this explicit eligible set.` }))
  return {
    root,
    repositoryRoot,
    candidateRoot,
    artifactRoot: join(artifactParent, 'wave-two'),
    receiverHandoffPath: join(receiverParent, 'receiver.json'),
    allowedSlugs: [...allowedSlugs],
    eligibleSlugs: [...eligibleSlugs],
    entries,
    blockedEntries,
  }
}

async function successorFixture(t) {
  const fixture = await stageFixture(t, ['object-hero-question', 'route-map-one-promise'])
  const priorArtifactRoot = join(fixture.root, 'prior-three-leaf-delivery')
  await mkdir(priorArtifactRoot)
  const priorArtifactPhysical = await realpath(priorArtifactRoot)
  const priorEntries = []
  for (const slug of textSlugs) {
    const relativeSource = waveLeaves.find(([candidate]) => candidate === slug)[1]
    const candidate = await buildTwice(slug, relativeSource, priorArtifactRoot)
    const absolutePath = join(priorArtifactPhysical, `${slug}.sspack`)
    await rename(candidate.candidate_path, absolutePath)
    priorEntries.push({
      absolute_path: absolutePath,
      bytes: candidate.bytes,
      delivery_profile: deliveryProfile,
      min_app_version: minAppVersion,
      receipt_ref: receiptRef,
      reviews: structuredClone(completeReviews),
      sha256: candidate.sha256,
      slug,
    })
  }
  const priorLedgerPath = join(priorArtifactRoot, 'ledger.json')
  await writeFile(priorLedgerPath, `${JSON.stringify({ schema_version: 1, entries: priorEntries })}\n`, { flag: 'wx' })
  return {
    ...fixture,
    waveId: 'reusable-content-primitives-wave-two-recipe-completion',
    completion: {
      prior_artifact_root: priorArtifactRoot,
      prior_ledger_path: priorLedgerPath,
      prior_delivered_slugs: textSlugs,
    },
  }
}

function assertCandidateStatus(candidate) {
  const stagingStatuses = new Set(['complete', 'preflight-failed', 'failed-after-root', 'skipped-empty'])
  assert.ok(stagingStatuses.has(candidate.evidence.staging.status))
  const complete = candidate.evidence.staging.status === 'complete'
  if (!complete) assert.deepEqual(candidate.delivered_leaves, [])
  const isFullyValidated = complete
    && candidate.blocked_leaves.length === 0
    && [candidate.eligible_leaves, candidate.authored_leaves, candidate.delivered_leaves]
      .every(slugs => new Set(slugs).size === allowedSlugs.length
        && allowedSlugs.every(slug => slugs.includes(slug)))
  assert.equal(candidate.status, isFullyValidated ? 'candidate-validated' : 'blocked')
}

test('qualifies every present Wave 2 source independently and reserves only absent Recipe sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'story-wave-two-pack-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))

  for (const [index, [slug, relativeSource]] of waveLeaves.entries()) {
    const sourceDirectory = join(repositoryRoot, 'content-packs', 'reusable-primitives', relativeSource)
    const exists = !(await absent(sourceDirectory))
    if (index < 3) assert.equal(exists, true, `${slug} text source is required`)
    if (!exists) {
      assert.ok(index >= 3, 'only Recipe source roots may be absent')
      const record = registry.records.find(candidate => candidate.source_path.endsWith(relativeSource))
      assert.equal(record?.status, 'reserved')
      continue
    }
    await buildTwice(slug, relativeSource, root)
  }
})

test('stages an explicit partial set with exact final shapes and summary placement', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t)
  const result = await stageHandoffArtifacts(fixture)
  assert.equal(result.phase, 'complete')
  assert.deepEqual(result.archivePaths, fixture.eligibleSlugs.map(slug => join(fixture.artifactRoot, `${slug}.sspack`)))
  assert.ok(result.archivePaths.every(isAbsolute))

  const ledger = JSON.parse(await readFile(result.ledgerPath, 'utf8'))
  const releaseHandoff = JSON.parse(await readFile(result.releaseHandoffPath, 'utf8'))
  const receiver = JSON.parse(await readFile(result.receiverHandoffPath, 'utf8'))
  assert.deepEqual(Object.keys(ledger).sort(), ['entries', 'schema_version'])
  assert.deepEqual(Object.keys(releaseHandoff).sort(), ['entries', 'schema_version'])
  assert.deepEqual(Object.keys(receiver).sort(), ['artifact_root', 'blocked_entries', 'explicitly_not_done', 'ledger_path', 'schema_version', 'successful_entries'])
  assert.equal(ledger.schema_version, 1)
  assert.equal(releaseHandoff.schema_version, 1)
  assert.equal(receiver.schema_version, 1)
  assert.deepEqual(ledger.entries.map(entry => entry.slug), fixture.eligibleSlugs)
  assert.deepEqual(receiver.blocked_entries, fixture.blockedEntries)
  assert.deepEqual(releaseHandoff.entries, receiver.successful_entries)
  assert.equal(hasRecursiveKey(ledger, 'component_summary'), false)
  assert.equal(hasRecursiveKey(releaseHandoff, 'component_summary'), true)
  assert.equal(hasRecursiveKey(receiver.successful_entries, 'component_summary'), true)
  assert.equal(hasRecursiveKey(receiver.blocked_entries, 'component_summary'), false)

  for (const [index, entry] of ledger.entries.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ['absolute_path', 'bytes', 'delivery_profile', 'min_app_version', 'receipt_ref', 'reviews', 'sha256', 'slug'])
    assert.deepEqual(releaseHandoff.entries[index], { ...entry, component_summary: summaries[entry.slug] })
    const sourceBytes = await readFile(fixture.entries[index].candidate_path)
    const finalBytes = await readFile(entry.absolute_path)
    assert.deepEqual(finalBytes, sourceBytes)
    await validateContentPack({ archivePath: entry.absolute_path, deliveryProfile })
  }
})

test('stages only the two recipe archives while proving the prior three-leaf delivery and full-wave completion', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await successorFixture(t)
  const result = await stageHandoffArtifacts(fixture)
  assert.deepEqual(result.archivePaths, fixture.eligibleSlugs.map(slug => join(fixture.artifactRoot, `${slug}.sspack`)))
  const ledger = JSON.parse(await readFile(result.ledgerPath, 'utf8'))
  const release = JSON.parse(await readFile(result.releaseHandoffPath, 'utf8'))
  const receiver = JSON.parse(await readFile(result.receiverHandoffPath, 'utf8'))
  const prior = {
    artifact_root: await realpath(fixture.completion.prior_artifact_root),
    ledger_path: fixture.completion.prior_ledger_path,
    receipt_ref: receiptRef,
    delivered_leaves: textSlugs,
    validation: 'validated-existing-delivery',
  }
  assert.deepEqual(ledger.prior_validated_delivery, prior)
  assert.deepEqual(release.prior_validated_delivery, prior)
  assert.deepEqual(receiver.prior_validated_delivery, prior)
  assert.deepEqual(release.wave_completion, { all_leaves: allowedSlugs, status: 'complete' })
  assert.deepEqual(receiver.wave_completion, { all_leaves: allowedSlugs, status: 'complete' })
  assert.equal(receiver.stocking_request, 'draft-stocking-only')
  assert.equal(receiver.commercial_boundary, 'Component packs are draft and available through active Channel Kits; no standalone publication is authorized here.')
  assert.deepEqual(receiver.successful_entries.map(entry => entry.slug), fixture.eligibleSlugs)
  assert.equal(receiver.blocked_entries, undefined)
})

test('rejects malformed slug partitions before writing either destination', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const base = await stageFixture(t)
  const cases = [
    ['duplicate allowed', { allowedSlugs: [...base.allowedSlugs, base.allowedSlugs[0]] }],
    ['duplicate eligible', { eligibleSlugs: [...base.eligibleSlugs, base.eligibleSlugs[0]] }],
    ['duplicate entries', { entries: [...base.entries, base.entries[0]] }],
    ['duplicate blocked', { blockedEntries: [...base.blockedEntries, base.blockedEntries[0]] }],
    ['eligible outside allowed', { eligibleSlugs: [...base.eligibleSlugs, 'unknown'] }],
    ['entry omitted', { entries: base.entries.slice(1) }],
    ['entry outside eligible', { entries: [...base.entries, { ...base.entries[0], slug: base.blockedEntries[0].slug }] }],
    ['blocked outside allowed', { blockedEntries: [...base.blockedEntries, { slug: 'unknown', blocker: 'blocked' }] }],
    ['eligible blocked overlap', { blockedEntries: [...base.blockedEntries, { slug: base.eligibleSlugs[0], blocker: 'blocked' }] }],
    ['fixed slug omitted', { blockedEntries: base.blockedEntries.slice(1) }],
  ]
  for (const [label, changes] of cases) {
    await assert.rejects(stageHandoffArtifacts({ ...base, ...changes }), /slug|eligible|blocked|partition|duplicate/i, label)
    assert.equal(await absent(base.artifactRoot), true, label)
    assert.equal(await absent(base.receiverHandoffPath), true, label)
  }
})

test('rejects a self-consistent allowed set that omits a fixed Wave 2 slug', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t)
  const inventedAllowed = [
    'question-ladder',
    'audience-question-seeder',
    'object-hero-question',
    'route-map-one-promise',
    'invented-leaf',
  ]
  await assert.rejects(stageHandoffArtifacts({
    ...fixture,
    allowedSlugs: inventedAllowed,
    blockedEntries: inventedAllowed
      .filter(slug => !fixture.eligibleSlugs.includes(slug))
      .map(slug => ({ slug, blocker: `BLOCKED: ${slug}` })),
  }), /fixed.*wave|allowed.*exact|unknown.*slug/i)
})

test('rejects a syntactically valid receipt that is not the Wave 2 reservation', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t)
  await assert.rejects(stageHandoffArtifacts({
    ...fixture,
    entries: fixture.entries.map(entry => ({ ...entry, receipt_ref: `authoring:${'0'.repeat(64)}` })),
  }), /receipt.*wave|receipt.*exact|reservation/i)
})

test('rejects valid archives mislabeled as another fixed Wave 2 slug', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t)
  const [question, audience] = fixture.entries
  await assert.rejects(stageHandoffArtifacts({
    ...fixture,
    entries: [
      { ...question, candidate_path: audience.candidate_path, sha256: audience.sha256, bytes: audience.bytes },
      { ...audience, candidate_path: question.candidate_path, sha256: question.sha256, bytes: question.bytes },
    ],
  }), /archive.*identity|pack_id|mislabeled|slug.*archive/i)
})

test('fails closed on destination, containment, evidence, and review violations', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const malformed = [
    ['relative artifact destination', base => ({ artifactRoot: 'relative-artifacts' }), /absolute/i],
    ['relative receiver destination', base => ({ receiverHandoffPath: 'relative-receiver.json' }), /absolute/i],
    ['artifact inside repository', base => ({ artifactRoot: join(repositoryRoot, '.forbidden-stage-test') }), /repository/i],
    ['receiver inside repository', base => ({ receiverHandoffPath: join(repositoryRoot, '.forbidden-receiver-test.json') }), /repository/i],
    ['wrong digest', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, sha256: '0'.repeat(64) }) }), /digest|sha256/i],
    ['wrong byte count', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, bytes: entry.bytes + 1 }) }), /byte|size/i],
    ['wrong floor', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, min_app_version: '1.0.842' }) }), /min_app_version|floor/i],
    ['wrong profile', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, delivery_profile: 'other' }) }), /profile/i],
    ['incomplete reviews', base => ({ entries: base.entries.map((entry, index) => index ? entry : { ...entry, reviews: entry.reviews.slice(1) }) }), /review/i],
  ]
  for (const [label, mutate, error] of malformed) {
    const base = await stageFixture(t)
    await assert.rejects(stageHandoffArtifacts({ ...base, ...mutate(base) }), error, label)
    assert.equal(await absent(base.artifactRoot), true, label)
    assert.equal(await absent(base.receiverHandoffPath), true, label)
  }

  const existingArtifact = await stageFixture(t)
  await mkdir(existingArtifact.artifactRoot)
  await assert.rejects(stageHandoffArtifacts(existingArtifact), /already exists/i)

  const existingReceiver = await stageFixture(t)
  await writeFile(existingReceiver.receiverHandoffPath, '{}', { flag: 'wx' })
  await assert.rejects(stageHandoffArtifacts(existingReceiver), /already exists/i)

  const symlinkCandidate = await stageFixture(t)
  const realCandidate = `${symlinkCandidate.candidateRoot}-real`
  await realpath(symlinkCandidate.candidateRoot)
  await rm(symlinkCandidate.candidateRoot, { recursive: true })
  await mkdir(realCandidate)
  await symlink(realCandidate, symlinkCandidate.candidateRoot, 'dir')
  await assert.rejects(stageHandoffArtifacts(symlinkCandidate), /symlink/i)

  const symlinkDestination = await stageFixture(t)
  const artifactParent = dirname(symlinkDestination.artifactRoot)
  const realParent = `${artifactParent}-real`
  await rm(artifactParent, { recursive: true })
  await mkdir(realParent)
  await symlink(realParent, artifactParent, 'dir')
  await assert.rejects(stageHandoffArtifacts(symlinkDestination), /symlink/i)

  const escapingSource = await stageFixture(t)
  const outside = join(escapingSource.root, 'outside.sspack')
  await writeFile(outside, await readFile(escapingSource.entries[0].candidate_path))
  await rm(escapingSource.entries[0].candidate_path)
  await symlink(outside, escapingSource.entries[0].candidate_path)
  await assert.rejects(stageHandoffArtifacts(escapingSource), /symlink|candidate.?root|regular file|escapes/i)
})

test('detects a candidate mutation after evidence preflight and source open during staged copy', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t, ['question-ladder'])
  const source = fixture.entries[0].candidate_path
  let mutatedAfterOpen = false
  await assert.rejects(stageHandoffArtifacts(fixture, {
    async afterPhase(name, detail) {
      if (name !== 'source-opened' || detail.path !== source || !detail.destination.includes('.staging') || mutatedAfterOpen) return
      mutatedAfterOpen = true
      await appendFile(source, Buffer.from([1]))
    },
  }), error => error?.phase === 'failed-after-root' && /source changed while being copied/i.test(error.message))
  assert.equal(mutatedAfterOpen, true)
  assert.equal(await absent(fixture.receiverHandoffPath), true)
  const failure = JSON.parse(await readFile(join(fixture.artifactRoot, 'failure.json'), 'utf8'))
  assert.match(failure.error, /source changed while being copied/i)
})

test('records truthful failed-after-root cleanup before and after archive finalization', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  for (const [phase, shouldThrow] of [
    ['staged-and-validated', name => name === 'staged-and-validated'],
    ['archive-finalized', name => name === 'archive-finalized'],
  ]) {
    const fixture = await stageFixture(t)
    await assert.rejects(
      stageHandoffArtifacts(fixture, {
        afterPhase(name) {
          if (shouldThrow(name)) throw new Error(`controlled ${phase} failure`)
        },
      }),
      error => error?.phase === 'failed-after-root' && /controlled/.test(error.message),
    )
    assert.equal(await absent(fixture.artifactRoot), false)
    assert.equal(await absent(fixture.receiverHandoffPath), true)
    const failure = JSON.parse(await readFile(join(fixture.artifactRoot, 'failure.json'), 'utf8'))
    assert.equal(failure.phase, 'failed-after-root')
    assert.deepEqual(failure.cleanup_failures, [])
    assert.deepEqual(failure.remaining_paths, [join(fixture.artifactRoot, 'failure.json')])
    const names = (await import('node:fs/promises')).readdir(fixture.artifactRoot)
    assert.deepEqual(await names, ['failure.json'])
  }
})

test('never removes a competing final archive that wins the exclusive-create race', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t, ['question-ladder'])
  const sentinelPath = join(fixture.artifactRoot, 'question-ladder.sspack')
  const sentinel = Buffer.from('competing-owner-sentinel')
  await assert.rejects(stageHandoffArtifacts(fixture, {
    async afterPhase(name) {
      if (name === 'staged-and-validated') await writeFile(sentinelPath, sentinel, { flag: 'wx' })
    },
  }), error => error?.phase === 'failed-after-root' && /exist/i.test(error.message))
  assert.deepEqual(await readFile(sentinelPath), sentinel)
})

test('never removes a competing staged file that wins the exclusive-create race', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t, ['question-ladder'])
  const sentinel = Buffer.from('competing-staged-owner')
  let sentinelPath
  await assert.rejects(stageHandoffArtifacts(fixture, {
    async afterPhase(name, detail) {
      if (name !== 'source-opened' || !detail.destination.includes('.staging') || sentinelPath) return
      sentinelPath = detail.destination
      await writeFile(sentinelPath, sentinel, { flag: 'wx' })
    },
  }), error => error?.phase === 'failed-after-root' && /exist/i.test(error.message))
  assert.ok(sentinelPath)
  assert.deepEqual(await readFile(sentinelPath), sentinel)
  const failure = JSON.parse(await readFile(join(fixture.artifactRoot, 'failure.json'), 'utf8'))
  assert.ok(failure.cleanup_failures.some(entry => entry.path === dirname(sentinelPath) && /ENOTEMPTY|not empty/i.test(entry.error)))
  assert.ok(failure.remaining_paths.includes(sentinelPath))
})

test('rejects a receiver-parent symlink swap after archive finalization without redirecting success', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t, ['question-ladder'])
  const receiverParent = dirname(fixture.receiverHandoffPath)
  const originalParent = `${receiverParent}-original`
  const attackerParent = `${receiverParent}-attacker`
  let swapped = false
  await mkdir(attackerParent)
  await assert.rejects(stageHandoffArtifacts(fixture, {
    async afterPhase(name) {
      if (name !== 'archive-finalized' || swapped) return
      swapped = true
      await rename(receiverParent, originalParent)
      await symlink(attackerParent, receiverParent, 'dir')
    },
  }), error => error?.phase === 'failed-after-root' && /parent|ancestry|replaced|symlink/i.test(error.message))
  assert.equal(await absent(join(attackerParent, 'receiver.json')), true)
})

test('rejects an artifact-root symlink swap after ledger finalization without redirected handoffs', async (t) => {
  const { stageHandoffArtifacts } = await import(stagingModule)
  const fixture = await stageFixture(t, ['question-ladder'])
  const originalRoot = `${fixture.artifactRoot}-original`
  const attackerRoot = `${fixture.artifactRoot}-attacker`
  let swapped = false
  await mkdir(attackerRoot)
  await assert.rejects(stageHandoffArtifacts(fixture, {
    async afterPhase(name, detail) {
      if (name !== 'handoff-finalized' || !detail.path.endsWith('ledger.json') || swapped) return
      swapped = true
      await rename(fixture.artifactRoot, originalRoot)
      await symlink(attackerRoot, fixture.artifactRoot, 'dir')
    },
  }), error => error?.phase === 'failed-after-root' && /artifact root|ancestry|replaced|symlink/i.test(error.message))
  assert.equal(await absent(join(attackerRoot, 'release-handoff.json')), true)
  assert.equal(await absent(join(attackerRoot, 'failure.json')), true)
})

test('enforces truthful candidate partial-status semantics', () => {
  for (const status of ['preflight-failed', 'failed-after-root', 'skipped-empty']) {
    assertCandidateStatus({
      status: 'blocked',
      eligible_leaves: [...textSlugs],
      authored_leaves: [...textSlugs],
      delivered_leaves: [],
      blocked_leaves: allowedSlugs.map(slug => ({ slug, blocker: 'blocked' })),
      evidence: { staging: { status } },
    })
  }
  assertCandidateStatus({
    status: 'candidate-validated',
    eligible_leaves: [...allowedSlugs],
    authored_leaves: [...allowedSlugs],
    delivered_leaves: [...allowedSlugs],
    blocked_leaves: [],
    evidence: { staging: { status: 'complete' } },
  })
  assert.throws(() => assertCandidateStatus({
    status: 'candidate-validated',
    eligible_leaves: [...textSlugs],
    authored_leaves: [...textSlugs],
    delivered_leaves: [...textSlugs],
    blocked_leaves: [],
    evidence: { staging: { status: 'complete' } },
  }))
})

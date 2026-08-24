import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { contentPackDocumentToNiche, contentPackDocumentToTopicPack } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import { planIdeaAssignments } from '../services/idea-campaign-planner.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_PATH = path.join(ROOT, 'content-packs', 'authoring-registry.json')
const BASELINE_COMMIT = 'ddf8a42b475efec3e3556f95f21ae6a182752204'
const execFile = promisify(execFileCallback)

type TopicDocument = Extract<ContentPackDocument, { kind: 'topic-pack' }>
type FormulaDocument = Extract<ContentPackDocument, { kind: 'series-formula' }>

type RegistryRecord = {
  receipt_ref: string
  pack_id: string
  item_id: string
  version: string
  publisher_id: string
  min_app_version: string
  min_app_version_status: string
  kind: 'topic-pack'
  source_path: string
  status: 'reserved' | 'authored'
  dependencies: unknown[]
  stocking_proposal: {
    family: { id: string, status: string }
    sku: { id: string, status: string }
  }
}

type ReviewedRow = {
  slug: string
  class: 'profile' | 'independent'
  predecessorRoot: string
  successorRoot: string
  document: string
  packId: string
  itemId: string
  formulaRoot: string
  subjects: number
  siblings: number
  tupleAdditions: number
  reviewPath: string
  universalMatrixPath?: string
}

type TopicSource = {
  manifest: Record<string, unknown>
  document: TopicDocument
  manifestBytes: Buffer
  documentBytes: Buffer
}

type ExpectedIdentity = Omit<RegistryRecord, 'receipt_ref'>
type ReservationResult = { revision: number, receipt_ref: string }

const TOPIC_SUCCESSORS = [
  ['ancient-humans-survival', 'content-packs/free-starters/topic/ancient-humans-survival', 'com.storystudio.pack.topic.ancient-humans-survival'],
  ['deep-time-earth-systems', 'content-packs/free-starters/topic/deep-time-earth-systems', 'com.storystudio.pack.topic.deep-time-earth-systems'],
  ['economics-businesses', 'content-packs/free-starters/topic/economics-businesses', 'com.storystudio.pack.topic.economics-businesses'],
  ['everyday-calm', 'content-packs/free-starters/topic/everyday-calm', 'com.storystudio.pack.topic.everyday-calm'],
  ['habits-momentum', 'content-packs/free-starters/topic/habits-momentum', 'com.storystudio.pack.topic.habits-momentum'],
  ['historical-wars-treaties-world-order', 'content-packs/free-starters/topic/historical-wars-treaties-world-order', 'com.storystudio.pack.topic.historical-wars-treaties-world-order'],
  ['human-behavior-social-dynamics', 'content-packs/free-starters/topic/human-behavior-social-dynamics', 'com.storystudio.pack.topic.human-behavior-social-dynamics'],
  ['natural-world-animals', 'content-packs/free-starters/topic/natural-world-animals', 'com.storystudio.pack.topic.natural-world-animals'],
  ['night-journeys', 'content-packs/free-starters/topic/night-journeys', 'com.storystudio.pack.topic.night-journeys'],
  ['pov-historical-occupations', 'content-packs/free-starters/topic/pov-historical-occupations', 'com.storystudio.pack.topic.pov-historical-occupations'],
  ['audience-question-seeder', 'content-packs/reusable-primitives/topic/audience-question-seeder', 'com.storystudio.pack.topic.audience-question-seeder'],
  ['empires-trade-extraction', 'content-packs/paid/archival-ledger/topic/empires-trade-extraction', 'com.storystudio.pack.topic.archival-ledger.empires-trade-extraction'],
  ['infrastructure-commodities-corporate-power', 'content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power', 'com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power'],
  ['money-debt-financial-institutions', 'content-packs/paid/archival-ledger/topic/money-debt-financial-institutions', 'com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions'],
  ['states-revolutions-collapse', 'content-packs/paid/archival-ledger/topic/states-revolutions-collapse', 'com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse'],
  ['wars-treaties-world-order', 'content-packs/paid/archival-ledger/topic/wars-treaties-world-order', 'com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order'],
] as const

const REVIEWED_ROWS: ReviewedRow[] = [
  {
    slug: 'human-behavior-social-dynamics',
    class: 'profile',
    predecessorRoot: 'content-packs/free-starters/topic/human-behavior-social-dynamics',
    successorRoot: 'content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1',
    document: 'content/topic-pack.json',
    packId: 'com.storystudio.pack.topic.human-behavior-social-dynamics',
    itemId: 'com.storystudio.topic.human-behavior-social-dynamics',
    formulaRoot: 'content-packs/free-starters/formula/human-behavior-explained',
    subjects: 50,
    siblings: 20,
    tupleAdditions: 980,
    reviewPath: '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/human-behavior-social-dynamics-semantic-review.md',
  },
  {
    slug: 'natural-world-animals',
    class: 'profile',
    predecessorRoot: 'content-packs/free-starters/topic/natural-world-animals',
    successorRoot: 'content-packs/free-starters/topic/natural-world-animals-v1.0.1',
    document: 'content/topic-pack.json',
    packId: 'com.storystudio.pack.topic.natural-world-animals',
    itemId: 'com.storystudio.topic.natural-world-animals',
    formulaRoot: 'content-packs/free-starters/formula/natural-world-explained',
    subjects: 50,
    siblings: 20,
    tupleAdditions: 980,
    reviewPath: '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md',
  },
]

// Task 18 changes this to 'authored' only after all sixteen serialized transitions succeed.
const EXPECTED_RECEIPT_STATUS: RegistryRecord['status'] = 'reserved'

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function unique(values: string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} must not repeat values`)
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

async function readTopicSource(row: ReviewedRow): Promise<TopicSource> {
  const sourceRoot = path.join(ROOT, row.successorRoot)
  const [manifestBytes, documentBytes] = await Promise.all([
    readFile(path.join(sourceRoot, 'pack.json')),
    readFile(path.join(sourceRoot, row.document)),
  ])
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
  const document = parseContentPackDocument('topic-pack', JSON.parse(documentBytes.toString('utf8')))
  assert.equal(document.kind, 'topic-pack')
  return { manifest, document, manifestBytes, documentBytes }
}

async function baselineBytes(relativePath: string): Promise<Buffer> {
  const { stdout } = await execFile('git', ['show', `${BASELINE_COMMIT}:${relativePath}`], {
    cwd: ROOT,
    encoding: 'buffer',
  })
  return Buffer.from(stdout)
}

async function assertImmutablePredecessor(row: ReviewedRow): Promise<void> {
  for (const file of ['pack.json', row.document]) {
    const relativePath = path.posix.join(row.predecessorRoot, file)
    const [expected, actual] = await Promise.all([
      baselineBytes(relativePath),
      readFile(path.join(ROOT, relativePath)),
    ])
    assert.deepEqual(actual, expected, `${relativePath} must remain byte-identical to ${BASELINE_COMMIT}`)
  }
}

async function assertIdentity(row: ReviewedRow, source: TopicSource): Promise<void> {
  const [registry, result, expected] = await Promise.all([
    readJson<{ revision: number, records: RegistryRecord[] }>(REGISTRY_PATH),
    readJson<ReservationResult>(path.join(ROOT, '.superpowers', 'sdd', '2026-08-25-topic-pack-1000-repair', 'reservation-result.json')),
    readJson<ExpectedIdentity>(path.join(ROOT, '.superpowers', 'sdd', '2026-08-25-topic-pack-1000-repair', 'expected-identities', `${row.slug}.json`)),
  ])
  assert.ok(registry.revision >= result.revision, 'registry revision must not predate the reservation result')
  const matches = registry.records.filter(record => record.pack_id === row.packId && record.version === '1.0.1')
  assert.equal(matches.length, 1, `${row.packId}@1.0.1 must have one receipt-bound registry record`)
  const record = matches[0]!
  const { receipt_ref: receiptRef, status, ...issuedIdentity } = record
  const { status: _expectedStatus, ...expectedIssuedIdentity } = expected
  assert.equal(receiptRef, result.receipt_ref, `${row.slug} must retain the coordinator receipt`)
  assert.deepEqual(issuedIdentity, expectedIssuedIdentity, `${row.slug} must retain its receipt-issued identity`)
  assert.equal(status, EXPECTED_RECEIPT_STATUS, `${row.slug} must match the receipt batch lifecycle state`)
  assert.equal(source.manifest.pack_id, record.pack_id)
  assert.equal(source.manifest.publisher_id, record.publisher_id)
  assert.equal(source.manifest.version, record.version)
  assert.equal(source.manifest.min_app_version, record.min_app_version)
  assert.deepEqual(source.manifest.entitlement, {
    family: record.stocking_proposal.family.id,
    sku: record.stocking_proposal.sku.id,
  }, `${row.slug} manifest entitlement must retain its receipt-issued family and SKU`)
  assert.equal(source.document.id, record.item_id)
}

async function assertTupleAdditions(row: ReviewedRow, document: TopicDocument): Promise<void> {
  if (row.class === 'independent') {
    assert.equal(row.tupleAdditions, 0, `${row.slug} independent rows must not claim profile tuple additions`)
    return
  }
  const predecessor = parseContentPackDocument('topic-pack', await readJson<unknown>(
    path.join(ROOT, row.predecessorRoot, row.document),
  ))
  assert.equal(predecessor.kind, 'topic-pack')
  const predecessorTuples = predecessor.coverage_profiles?.reduce((total, profile) => total + profile.tuples.length, 0) || 0
  const successorTuples = document.coverage_profiles?.reduce((total, profile) => total + profile.tuples.length, 0) || 0
  assert.equal(successorTuples - predecessorTuples, row.tupleAdditions,
    `${row.slug} must add exactly ${row.tupleAdditions} profile tuples`)
}

function assertProfileShape(row: ReviewedRow, document: TopicDocument): void {
  assert.equal(document.subjects.length, row.subjects, `${row.slug} must declare ${row.subjects} subjects`)
  unique(document.subjects, `${row.slug} subjects`)
  assert.equal(document.max_siblings_per_subject, row.siblings, `${row.slug} must cap siblings at ${row.siblings}`)
  assert.equal(document.coverage_groups, undefined, `${row.slug} must stay profile-based`)
  assert.equal(document.coverage_profiles?.length, row.subjects, `${row.slug} must provide one profile per subject`)

  const tupleKeys: string[] = []
  const coreKeys: string[] = []
  for (const profile of document.coverage_profiles || []) {
    assert.ok(document.subjects.includes(profile.subject), `${row.slug} profile subject must be declared`)
    assert.equal(profile.tuples.length, row.siblings, `${row.slug}:${profile.subject} must have ${row.siblings} tuples`)
    unique(profile.tuples.map(tuple => tuple.episode_object), `${row.slug}:${profile.subject} episode objects`)
    unique(profile.tuples.map(tuple => tuple.mechanism), `${row.slug}:${profile.subject} mechanisms`)
    tupleKeys.push(...profile.tuples.map(tuple => [profile.subject, tuple.episode_object, tuple.time_place_scope, tuple.mechanism, tuple.evidence_lens].join('|')))
    coreKeys.push(...profile.tuples.map(tuple => [tuple.episode_object, tuple.mechanism].join('|')))
  }
  unique(tupleKeys, `${row.slug} complete tuples`)
  unique(coreKeys, `${row.slug} episode-object/mechanism pairs`)
}

function assertIndependentShape(row: ReviewedRow, document: TopicDocument): void {
  assert.equal(document.subjects.length, row.subjects, `${row.slug} must declare ${row.subjects} subjects`)
  unique(document.subjects, `${row.slug} subjects`)
  assert.equal(document.max_siblings_per_subject, row.siblings, `${row.slug} must cap siblings at ${row.siblings}`)
  assert.equal(document.coverage_profiles, undefined, `${row.slug} must stay independent-axis`)
  assert.equal(document.coverage_groups, undefined, `${row.slug} must stay independent-axis`)
  for (const [name, values] of Object.entries({
    episode_objects: document.episode_objects,
    time_place_scopes: document.time_place_scopes,
    mechanisms: document.mechanisms,
  })) {
    assert.ok(values.length >= row.siblings, `${row.slug} ${name} must offer at least ${row.siblings} values`)
    unique(values, `${row.slug} ${name}`)
  }
}

function assertPlannedAssignments(row: ReviewedRow, document: TopicDocument, assignments: ReturnType<typeof planIdeaAssignments>): void {
  const profiles = new Map((document.coverage_profiles || []).map(profile => [profile.subject, profile]))
  const declared = {
    subject: new Set(document.subjects),
    'episode-object': new Set(document.episode_objects),
    'time-place-scope': new Set(document.time_place_scopes),
    mechanism: new Set(document.mechanisms),
    'evidence-lens': new Set(document.evidence_lenses),
  }
  for (const assignment of assignments) {
    const dimensions = assignment.dimensions
    for (const dimension of ['subject', 'episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'] as const) {
      assert.ok(dimensions[dimension], `${row.slug} assignments must include ${dimension}`)
    }
    assert.ok(declared.subject.has(dimensions.subject!), `${row.slug} assignments must use declared subjects`)
    if (row.class === 'independent') {
      for (const dimension of ['episode-object', 'time-place-scope', 'mechanism', 'evidence-lens'] as const) {
        assert.ok(declared[dimension].has(dimensions[dimension]!), `${row.slug} assignments must use declared ${dimension} values`)
      }
      continue
    }
    const profile = profiles.get(dimensions.subject!)
    assert.ok(profile, `${row.slug} assignments must use a profiled subject`)
    assert.ok(profile.tuples.some(tuple => (
      tuple.episode_object === dimensions['episode-object']
      && tuple.time_place_scope === dimensions['time-place-scope']
      && tuple.mechanism === dimensions.mechanism
      && tuple.evidence_lens === dimensions['evidence-lens']
    )), `${row.slug} assignments must select an authored whole tuple, not independently zipped axis values`)
  }
}

async function assertPlannerCapacity(row: ReviewedRow, document: TopicDocument): Promise<void> {
  const formulaPath = path.join(ROOT, row.formulaRoot, 'content', 'series-formula.json')
  const formula = parseContentPackDocument('series-formula', await readJson<unknown>(formulaPath))
  assert.equal(formula.kind, 'series-formula')
  const niche = contentPackDocumentToNiche(formula as FormulaDocument)
  niche.activeTopicPacks = [contentPackDocumentToTopicPack(document)]

  const seed = `topic-pack-1000:${row.slug}`
  const full = planIdeaAssignments({ niche, count: 1_000, seed })
  const replay = planIdeaAssignments({ niche, count: 1_000, seed })
  assert.equal(full.length, 1_000, `${row.slug} must plan exactly 1,000 assignments`)
  assert.deepEqual(replay, full, `${row.slug} must replay deterministically with the same seed`)
  unique(full.map(assignment => assignment.fingerprint), `${row.slug} fingerprints`)
  unique(full.map(assignment => assignment.idea_key), `${row.slug} idea keys`)
  assertPlannedAssignments(row, document, full)

  const first = planIdeaAssignments({ niche, count: 500, seed }).slice(0, 500)
  const second = planIdeaAssignments({ niche, count: 500, seed, usedFingerprints: first.map(assignment => assignment.fingerprint) }).slice(0, 500)
  assert.equal(first.length, 500, `${row.slug} must provide the first 500 reservations`)
  assert.equal(second.length, 500, `${row.slug} must provide the second 500 reservations`)
  assert.equal(first.filter(assignment => second.some(next => next.fingerprint === assignment.fingerprint)).length, 0,
    `${row.slug} 500 + 500 reservations must not overlap`)
  const reserved = [...first, ...second]
  unique(reserved.map(assignment => assignment.fingerprint), `${row.slug} combined reservations`)
  assert.equal(reserved.length, 1_000, `${row.slug} must fill all 1,000 lifetime reservations`)
  assertPlannedAssignments(row, document, reserved)

  if (row.class === 'profile') {
    assert.throws(() => planIdeaAssignments({ niche, count: 1, seed, usedFingerprints: reserved.map(assignment => assignment.fingerprint) }),
      /cannot plan the requested campaign without repeating an episode object or mechanism/,
      `${row.slug} must fail closed after its 1,000 structural assignments are reserved`)
  } else {
    assert.deepEqual(
      planIdeaAssignments({ niche, count: 1, seed, usedFingerprints: reserved.map(assignment => assignment.fingerprint) }),
      [],
      `${row.slug} must return no assignment after its 1,000 structural assignments are reserved`,
    )
  }

  const structures = new Map<string, { episodeObjects: string[], mechanisms: string[] }>()
  for (const assignment of full) {
    const subject = assignment.dimensions.subject
    const episodeObject = assignment.dimensions['episode-object']
    const mechanism = assignment.dimensions.mechanism
    const values = structures.get(subject) || { episodeObjects: [], mechanisms: [] }
    values.episodeObjects.push(episodeObject!)
    values.mechanisms.push(mechanism!)
    structures.set(subject, values)
  }
  for (const [subject, values] of structures) {
    unique(values.episodeObjects, `${row.slug}:${subject} planned episode objects`)
    unique(values.mechanisms, `${row.slug}:${subject} planned mechanisms`)
  }
}

async function assertReviewArtifacts(row: ReviewedRow, source: TopicSource): Promise<void> {
  const review = await readFile(path.join(ROOT, row.reviewPath), 'utf8')
  assert.match(review, new RegExp(sha256(source.documentBytes)), `${row.slug} review must bind the successor document digest`)
  if (!row.universalMatrixPath) return
  const matrix = await readJson<{
    pack_id: string
    version: string
    source_document_sha256: string
    subjects: string[]
    material_axes: { episode_objects: string[], time_place_scopes: string[], mechanisms: string[] }
    verdicts: Array<{ subject: string, axis: string, verdict: string }>
  }>(path.join(ROOT, row.universalMatrixPath))
  assert.equal(matrix.pack_id, row.packId)
  assert.equal(matrix.version, '1.0.1')
  assert.equal(matrix.source_document_sha256, sha256(source.documentBytes))
  assert.deepEqual(matrix.subjects, source.document.subjects)
  assert.deepEqual(matrix.material_axes.episode_objects, source.document.episode_objects)
  assert.deepEqual(matrix.material_axes.time_place_scopes, source.document.time_place_scopes)
  assert.deepEqual(matrix.material_axes.mechanisms, source.document.mechanisms)
  assert.equal(matrix.verdicts.length, row.subjects * 3, `${row.slug} universal matrix must review every subject-axis pair`)
  assert.ok(matrix.verdicts.every(verdict => verdict.verdict === 'accepted'), `${row.slug} universal matrix must not retain rejected axes`)
}

async function assertRowCapacity(row: ReviewedRow): Promise<void> {
  const source = await readTopicSource(row)
  await assertImmutablePredecessor(row)
  await assertIdentity(row, source)
  if (row.class === 'profile') assertProfileShape(row, source.document)
  else assertIndependentShape(row, source.document)
  await assertTupleAdditions(row, source.document)
  await assertReviewArtifacts(row, source)
  await assertPlannerCapacity(row, source.document)
}

test('all sixteen Topic Pack 1.0.1 successor identities share one atomic receipt', async () => {
  const [registry, result, expectedIdentities] = await Promise.all([
    readJson<{ revision: number, records: RegistryRecord[] }>(REGISTRY_PATH),
    readJson<ReservationResult>(path.join(ROOT, '.superpowers', 'sdd', '2026-08-25-topic-pack-1000-repair', 'reservation-result.json')),
    Promise.all(TOPIC_SUCCESSORS.map(([slug]) => readJson<ExpectedIdentity>(
      path.join(ROOT, '.superpowers', 'sdd', '2026-08-25-topic-pack-1000-repair', 'expected-identities', `${slug}.json`),
    ))),
  ])
  assert.ok(registry.revision >= result.revision, 'registry revision must not predate the reservation result')
  const received = registry.records.filter(record => record.receipt_ref === result.receipt_ref)
  assert.equal(received.length, 16, 'the coordinator receipt must bind exactly sixteen records')
  assert.deepEqual(
    expectedIdentities.map(({ pack_id, version, source_path }) => ({ pack_id, version, source_path })).sort((left, right) => left.pack_id.localeCompare(right.pack_id)),
    TOPIC_SUCCESSORS.map(([, predecessorRoot, packId]) => ({
      pack_id: packId,
      version: '1.0.1',
      source_path: `${predecessorRoot}-v1.0.1`,
    })).sort((left, right) => left.pack_id.localeCompare(right.pack_id)),
    'expected identities must cover all and only the mapped successor identities',
  )
  assert.deepEqual(
    received.map(({ receipt_ref: _receiptRef, status: _status, ...identity }) => identity).sort((left, right) => left.pack_id.localeCompare(right.pack_id)),
    expectedIdentities.map(({ status: _status, ...identity }) => identity).sort((left, right) => left.pack_id.localeCompare(right.pack_id)),
    'the coordinator receipt must retain every issued identity field except mutable lifecycle status',
  )
  assert.ok(received.every(record => record.status === EXPECTED_RECEIPT_STATUS),
    `receipt-bound successors must all be ${EXPECTED_RECEIPT_STATUS}; partial lifecycle transitions are forbidden`)
})

for (const row of REVIEWED_ROWS) {
  test(`capacity: ${row.slug}`, async () => {
    await assertRowCapacity(row)
  })
}

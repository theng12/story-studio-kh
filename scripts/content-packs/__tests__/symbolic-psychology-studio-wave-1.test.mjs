import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REGISTRY_PATH = join(ROOT, 'content-packs', 'authoring-registry.json')
const KIT_ROOT = join(ROOT, 'content-packs', 'symbolic-psychology-studio', 'kit', 'symbolic-psychology-studio')
const CANDIDATE_LEDGER = '/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/evidence-ledger.json'
const CANDIDATE_HANDOFFS = '/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/candidate-handoffs.json'
const RECEIVER_HANDOFF = '/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/receiver-handoff.json'

const RECIPE_RECEIPT = 'authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa'
const IMPASTO_RECEIPT = 'authoring:befab004ee2231cdbfc5f076f5b8a87d1fae03b58716cf5ab45d512fce7904b5'
const CLOSURE = [
  ['com.storystudio.pack.formula.human-behavior-explained', '1.0.0', 'com.storystudio.formula.human-behavior-explained', 'series-formula'],
  ['com.storystudio.pack.topic.human-behavior-social-dynamics', '1.0.0', 'com.storystudio.topic.human-behavior-social-dynamics', 'topic-pack'],
  ['com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split', '1.0.0', 'com.storystudio.thumbnail.editorial-psychology-symbolic-split', 'thumbnail-recipe'],
  ['com.storystudio.pack.style.pastel-surreal-psychological-collage', '1.0.0', 'com.storystudio.style.pastel-surreal-psychological-collage', 'visual-style'],
  ['com.storystudio.pack.style.impasto-psychological-animals', '1.0.0', 'com.storystudio.style.impasto-psychological-animals', 'visual-style'],
  ['com.storystudio.pack.style.oil-painting-classical', '1.0.0', 'com.storystudio.style.oil-painting-classical', 'visual-style'],
]

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function recordFor(registry, packId) {
  const record = registry.records.find(candidate => candidate.pack_id === packId && candidate.version === '1.0.0')
  assert.ok(record, `registry must contain ${packId}@1.0.0`)
  return record
}

function receiptRequestFor(registry, receipt, packId) {
  const batch = registry.batches.find(candidate => candidate.receipt_ref === receipt)
  assert.ok(batch, `registry must retain the original ${receipt} reservation request`)
  const record = batch.request.records.find(candidate => candidate.pack_id === packId && candidate.version === '1.0.0')
  assert.ok(record, `${receipt} must reserve ${packId}@1.0.0`)
  return record
}

function closurePairs(entries) {
  return entries.map(({ pack_id, version }) => [pack_id, version])
}

test('promotion receipts: the original Capi and Impasto reservations are the only path to authored sources', async () => {
  const registry = await readJson(REGISTRY_PATH)
  const expected = [
    [CLOSURE[2][0], RECIPE_RECEIPT],
    [CLOSURE[3][0], RECIPE_RECEIPT],
    [CLOSURE[4][0], IMPASTO_RECEIPT],
  ]

  for (const [packId, receipt] of expected) {
    const reservation = receiptRequestFor(registry, receipt, packId)
    const current = recordFor(registry, packId)
    assert.equal(reservation.status, 'reserved', `${packId} must originate in its exact reservation receipt`)
    assert.equal(current.receipt_ref, receipt)
    assert.equal(current.status, 'authored', `${packId} must be promoted before Wave 1 composition`)
  }
})

test('kit closure: the coordinator is a pack-only exact six-node closure', async () => {
  assert.deepEqual(await readdir(KIT_ROOT), ['pack.json'])
  const manifest = await readJson(join(KIT_ROOT, 'pack.json'))
  const dependencies = CLOSURE.map(([pack_id, version]) => ({ pack_id, version }))
  const components = CLOSURE.map(([pack_id, version, item_id, kind]) => ({ pack_id, version, item_id, kind }))

  assert.deepEqual(manifest.dependencies, dependencies)
  assert.equal(manifest.bundles?.length, 1)
  assert.equal(manifest.bundles[0].id, 'com.storystudio.bundle.symbolic-psychology-studio')
  assert.equal(manifest.bundles[0].kind, 'channel-kit')
  assert.equal(manifest.bundles[0].name, 'Symbolic Psychology Studio')
  assert.deepEqual(manifest.bundles[0].components, components)
  assert.deepEqual(closurePairs(manifest.dependencies), closurePairs(manifest.bundles[0].components))

  const registry = await readJson(REGISTRY_PATH)
  const oil = recordFor(registry, CLOSURE[5][0])
  assert.equal(oil.status, 'authored')
  assert.match(oil.receipt_ref, /^authoring:[a-f0-9]{64}$/)
  const reservation = receiptRequestFor(registry, oil.receipt_ref, oil.pack_id)
  assert.equal(reservation.status, 'reserved')
  for (const key of ['pack_id', 'item_id', 'version', 'publisher_id', 'min_app_version', 'kind', 'source_path']) {
    assert.equal(reservation[key], oil[key])
  }
})

test('candidate summaries: each new candidate uses the minimal Story-owned v1 summary', async () => {
  const ledger = await readJson(CANDIDATE_LEDGER)
  const expected = new Map([
    [CLOSURE[2][0], { kind: 'thumbnail-recipe', slots: { 'thumbnail-recipe': 1 }, summary: 'Sparse single-subject psychology thumbnail grammar with an AI-rendered concise title.' }],
    [CLOSURE[3][0], { kind: 'visual-style', slots: { 'visual-style': 1 } }],
    [CLOSURE[5][0], { kind: 'visual-style', slots: { 'visual-style': 1 } }],
    ['com.storystudio.pack.kit.symbolic-psychology-studio', {
      kind: 'channel-kit',
      slots: { 'series-formula': 1, 'topic-pack': 1, 'visual-style': 3, 'thumbnail-recipe': 1 },
      summary: 'Evidence-aware symbolic psychology with three compatible visual styles.',
    }],
  ])
  const artifacts = ledger.artifacts.filter(candidate => expected.has(candidate.pack_id))

  assert.deepEqual([...artifacts.map(candidate => candidate.pack_id).sort()], [...expected.keys()].sort())
  for (const candidate of artifacts) {
    const expectedSummary = expected.get(candidate.pack_id)
    const summary = candidate.component_summary
    assert.deepEqual(Object.keys(summary).sort(), ['kind', 'schema_version', 'slots', 'summary'])
    assert.equal(summary.schema_version, 1)
    assert.equal(summary.kind, expectedSummary.kind)
    assert.deepEqual(summary.slots, expectedSummary.slots)
    assert.equal(typeof summary.summary, 'string')
    assert.ok(summary.summary.length > 0)
    if (expectedSummary.summary) assert.equal(summary.summary, expectedSummary.summary)
    for (const forbidden of ['pack_id', 'version', 'sha256', 'closure']) assert.equal(forbidden in summary, false)
  }
})

test('candidate handoffs keep Recipe and Oil review-pending, Pastel and coordinator blocked, and the receiver non-mutating', async () => {
  const handoffs = await readJson(CANDIDATE_HANDOFFS)
  const receiver = await readJson(RECEIVER_HANDOFF)
  const requiredFields = [
    'status', 'component', 'reservation', 'identity', 'stocking_proposal', 'source', 'intent',
    'compatibility', 'dependencies', 'originality_provenance', 'evidence', 'review_requests', 'blocked_by',
  ]
  const reviewNames = [
    'schema', 'originality/provenance', 'compatibility', 'prompt-equivalence', 'visual', 'thumbnail',
    'safety', 'copy', 'commercial-boundary',
  ]

  assert.equal(handoffs.status, 'candidate-built-review-pending')
  assert.equal(handoffs.handoffs.length, 4)
  for (const handoff of handoffs.handoffs) {
    assert.deepEqual(Object.keys(handoff).sort(), [...requiredFields].sort())
    const isPastel = handoff.identity.pack_id === CLOSURE[3][0]
    assert.equal(handoff.status, handoff.component === 'coordinator' || isPastel ? 'blocked' : 'candidate-built-review-pending')
    assert.deepEqual(Object.keys(handoff.review_requests), reviewNames)
    for (const reviewName of reviewNames) {
      const expected = reviewName === 'thumbnail' && handoff.component !== 'recipe'
        ? 'not_applicable'
        : isPastel && reviewName === 'visual'
          ? 'blocked'
          : handoff.component === 'coordinator' && reviewName === 'safety'
            ? 'blocked'
            : 'requested'
      assert.equal(handoff.review_requests[reviewName].status, expected, `${handoff.identity.pack_id}: ${reviewName}`)
      if (expected === 'not_applicable') assert.ok(handoff.review_requests[reviewName].reason)
    }
    assert.ok(handoff.blocked_by.some(blocker => blocker.status === 'review-pending'))
    if (isPastel) {
      assert.equal(handoff.source.candidate, null)
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'visual-preview' && blocker.status === 'blocked'))
    }
    if (handoff.component === 'coordinator') {
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'publisher-contract' && blocker.status === 'blocked'))
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'safety-compatibility' && blocker.status === 'blocked'))
      assert.match(handoff.intent, /commerce terms are undecided and not supplied/i)
      assert.doesNotMatch(handoff.intent, /\bfree\b|\bpaid\b|\bprice\b/i)
    }
  }

  assert.equal(receiver.status, 'candidate-built-review-pending')
  assert.notEqual(receiver.status, 'ready-for-owner-stocking')
  for (const excluded of [
    'upload', 'product draft creation', 'release draft creation', 'price decision', 'discount decision',
    'purchase', 'grant', 'production signing', 'publication', 'GenStudio mutation',
  ]) assert.ok(receiver.explicitly_not_done.includes(excluded), `receiver handoff must exclude ${excluded}`)
  assert.ok(receiver.blocked_by.some(blocker => blocker.status === 'review-pending'))
  assert.ok(receiver.blocked_by.some(blocker => blocker.status === 'blocked-and-excluded' && blocker.component === 'Gothic Charcoal Animal Editorial'))
})

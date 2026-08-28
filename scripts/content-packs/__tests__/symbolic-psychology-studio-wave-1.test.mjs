import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REGISTRY_PATH = join(ROOT, 'content-packs', 'authoring-registry.json')
const FORMULA_PROMOTION = join(
  ROOT,
  '.superpowers',
  'sdd',
  '2026-08-23-symbolic-psychology-studio-unblock',
  'promotions',
  'human-behavior-explained-v1.0.1.json',
)
const KIT_ROOT = join(ROOT, 'content-packs', 'symbolic-psychology-studio', 'kit', 'symbolic-psychology-studio')
const EVIDENCE_ROOT = process.env.STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT
if (EVIDENCE_ROOT && !isAbsolute(EVIDENCE_ROOT)) {
  throw new Error('STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT must be an absolute path')
}
const CANDIDATE_LEDGER = EVIDENCE_ROOT ? join(EVIDENCE_ROOT, 'evidence-ledger.json') : undefined
const CANDIDATE_HANDOFFS = EVIDENCE_ROOT ? join(EVIDENCE_ROOT, 'candidate-handoffs.json') : undefined
const RECEIVER_HANDOFF = EVIDENCE_ROOT ? join(EVIDENCE_ROOT, 'receiver-handoff.json') : undefined
const REVIEW_REQUESTS = EVIDENCE_ROOT ? join(EVIDENCE_ROOT, 'review-requests.json') : undefined
const EVIDENCE_TEST = EVIDENCE_ROOT
  ? {}
  : { skip: 'Set STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT to an absolute artifact root to run external evidence assertions.' }

const RECIPE_RECEIPT = 'authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa'
const IMPASTO_RECEIPT = 'authoring:befab004ee2231cdbfc5f076f5b8a87d1fae03b58716cf5ab45d512fce7904b5'
const LEAF_SUCCESSOR_RECEIPT = 'authoring:f12a9e8de181d536fe2e8367df5028460ce9e84948f43cc6978bfe5b5340bdfd'
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

function recordVersionFor(registry, packId, version) {
  const record = registry.records.find(candidate => candidate.pack_id === packId && candidate.version === version)
  assert.ok(record, `registry must contain ${packId}@${version}`)
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

test('promotion receipts: the original Editorial and Impasto reservations are the only path to authored sources', async () => {
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

test('Formula v1.0.1 promotion is one receipt-bound reserved-to-authored transition', async () => {
  const registry = await readJson(REGISTRY_PATH)
  const promotion = await readJson(FORMULA_PROMOTION)
  const packId = 'com.storystudio.pack.formula.human-behavior-explained'
  const predecessor = recordVersionFor(registry, packId, '1.0.0')
  const successor = recordVersionFor(registry, packId, '1.0.1')
  const reservation = registry.batches
    .find(batch => batch.receipt_ref === LEAF_SUCCESSOR_RECEIPT)
    ?.request.records.find(record => record.pack_id === packId && record.version === '1.0.1')
  const transitions = registry.transitions.filter(transition => (
    transition.request.receipt_ref === LEAF_SUCCESSOR_RECEIPT
    && transition.request.pack_id === packId
    && transition.request.version === '1.0.1'
  ))

  assert.equal(predecessor.receipt_ref, `baseline:${packId}@1.0.0`)
  assert.equal(predecessor.status, 'authored')
  assert.ok(reservation, 'the shared leaf receipt must retain the Formula v1.0.1 reservation')
  assert.equal(reservation.status, 'reserved')
  assert.equal(successor.receipt_ref, LEAF_SUCCESSOR_RECEIPT)
  assert.equal(successor.status, 'authored')
  assert.deepEqual(promotion, {
    expected_revision: 17,
    coordinator: {
      task: 'symbolic-psychology-studio-unblock-leaf-successors',
      branch: 'codex/content-expansion-portfolio',
    },
    receipt_ref: LEAF_SUCCESSOR_RECEIPT,
    pack_id: packId,
    version: '1.0.1',
    changes: { status: 'authored' },
  })
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].revision, 18)
  assert.deepEqual(transitions[0].request, promotion)

  // The other two leaves share this receipt, so the point of the block below is
  // that THIS transition promoted the Formula and nothing else. It used to say so
  // by asserting the pair was still `reserved` and that no Kit record existed --
  // a snapshot of the wave mid-flight, which went stale the moment the wave
  // finished and promoted them at revisions 88 and 89. Stated as "each leaf has
  // its own promotion, distinct from the Formula's", the same claim survives the
  // wave completing, which is what a test of a shared receipt should do.
  for (const siblingPackId of [
    'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split',
    'com.storystudio.pack.style.pastel-surreal-psychological-collage',
  ]) {
    const record = recordVersionFor(registry, siblingPackId, '1.0.1')
    assert.equal(record.receipt_ref, LEAF_SUCCESSOR_RECEIPT)
    const own = registry.transitions.filter(transition => (
      transition.request.receipt_ref === LEAF_SUCCESSOR_RECEIPT
      && transition.request.pack_id === siblingPackId
      && transition.request.version === '1.0.1'
    ))
    assert.equal(own.length, 1, `${siblingPackId} must be promoted by exactly one transition of its own`)
    assert.notEqual(own[0].revision, transitions[0].revision)
    assert.equal(record.status, 'authored')
  }

  // The Kit is a separate reservation under its own receipt, never part of the
  // shared leaf receipt.
  const kit = registry.records.find(record => (
    record.pack_id === 'com.storystudio.pack.kit.symbolic-psychology-studio' && record.version === '1.0.1'
  ))
  assert.ok(kit, 'the Kit v1.0.1 must be registered')
  assert.notEqual(kit.receipt_ref, LEAF_SUCCESSOR_RECEIPT)
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

test('evidence audit: each new candidate uses the minimal Story-owned v1 summary', EVIDENCE_TEST, async () => {
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

test('evidence audit: Oil is stocking-ready while Recipe, Pastel, and Kit remain blocked', EVIDENCE_TEST, async () => {
  const handoffs = await readJson(CANDIDATE_HANDOFFS)
  const receiver = await readJson(RECEIVER_HANDOFF)
  const reviewRequests = await readJson(REVIEW_REQUESTS)
  const requiredFields = [
    'status', 'component', 'reservation', 'identity', 'stocking_proposal', 'source', 'intent',
    'compatibility', 'dependencies', 'originality_provenance', 'evidence', 'review_requests', 'blocked_by',
  ]
  const reviewNames = [
    'schema', 'originality/provenance', 'compatibility', 'prompt-equivalence', 'visual', 'thumbnail',
    'safety', 'copy', 'commercial-boundary',
  ]

  assert.equal(handoffs.status, 'partial-review-complete-blocked')
  assert.equal(handoffs.handoffs.length, 4)
  for (const handoff of handoffs.handoffs) {
    assert.deepEqual(Object.keys(handoff).sort(), [...requiredFields].sort())
    const isRecipe = handoff.identity.pack_id === CLOSURE[2][0]
    const isPastel = handoff.identity.pack_id === CLOSURE[3][0]
    const isOil = handoff.identity.pack_id === CLOSURE[5][0]
    assert.equal(handoff.status, isOil ? 'ready-for-owner-stocking' : 'blocked')
    assert.deepEqual(Object.keys(handoff.review_requests), reviewNames)
    for (const reviewName of reviewNames) {
      const expected = reviewName === 'thumbnail' && handoff.component !== 'recipe'
        || handoff.component === 'coordinator' && reviewName === 'visual'
        ? 'not_applicable'
        : isRecipe && ['originality/provenance', 'prompt-equivalence', 'visual', 'thumbnail'].includes(reviewName)
          || isPastel && ['originality/provenance', 'prompt-equivalence', 'visual'].includes(reviewName)
          || handoff.component === 'coordinator' && ['schema', 'compatibility', 'prompt-equivalence', 'safety'].includes(reviewName)
          ? 'blocked'
          : 'passed'
      assert.equal(handoff.review_requests[reviewName].status, expected, `${handoff.identity.pack_id}: ${reviewName}`)
      if (expected === 'not_applicable') assert.ok(handoff.review_requests[reviewName].reason)
    }
    assert.equal(handoff.blocked_by.some(blocker => blocker.status === 'review-pending'), false)
    if (isRecipe) {
      assert.equal(handoff.source.candidate, null)
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'gallery-diversity' && blocker.status === 'blocked'))
    }
    if (isPastel) {
      assert.equal(handoff.source.candidate, null)
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'visual-preview' && blocker.status === 'blocked'))
    }
    if (isOil) {
      assert.match(handoff.source.candidate, /^archives\//)
      assert.deepEqual(handoff.blocked_by, [])
    }
    if (handoff.component === 'coordinator') {
      assert.equal(handoff.source.candidate, null)
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'publisher-contract' && blocker.status === 'blocked'))
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'blocked-dependency' && blocker.status === 'blocked'))
      assert.ok(handoff.blocked_by.some(blocker => blocker.gate === 'safety-compatibility' && blocker.status === 'blocked'))
      assert.match(handoff.intent, /commerce terms are undecided and not supplied/i)
      assert.doesNotMatch(handoff.intent, /\bfree\b|\bpaid\b|\bprice\b/i)
    }
  }

  assert.equal(receiver.status, 'partial-review-complete-blocked')
  assert.notEqual(receiver.status, 'ready-for-owner-stocking')
  assert.deepEqual(receiver.candidate_state, {
    candidate_eligible: 1,
    blocked: 3,
    independent_reviews_complete: 9,
    independent_reviews_requested: 9,
  })
  const oil = receiver.content_identities.find(candidate => candidate.pack_id === CLOSURE[5][0])
  assert.equal(oil.candidate_status, 'ready-for-owner-stocking')
  for (const blockedPack of [CLOSURE[2][0], CLOSURE[3][0], 'com.storystudio.pack.kit.symbolic-psychology-studio']) {
    const candidate = receiver.content_identities.find(entry => entry.pack_id === blockedPack)
    assert.equal(candidate.candidate_status, 'blocked')
    assert.equal(candidate.archive_sha256, null)
    assert.equal(candidate.archive_bytes, null)
  }
  for (const excluded of [
    'upload', 'product draft creation', 'release draft creation', 'price decision', 'discount decision',
    'purchase', 'grant', 'production signing', 'publication', 'GenStudio mutation',
  ]) assert.ok(receiver.explicitly_not_done.includes(excluded), `receiver handoff must exclude ${excluded}`)
  assert.deepEqual(receiver.review_evidence.pending, [])
  assert.equal(receiver.blocked_by.some(blocker => blocker.status === 'review-pending'), false)
  assert.ok(receiver.blocked_by.some(blocker => blocker.status === 'blocked-and-excluded' && blocker.component === 'Gothic Charcoal Animal Editorial'))

  const promptEquivalence = reviewRequests.reviews.find(review => review.id === 'prompt-equivalence')
  assert.equal(reviewRequests.status, 'review-complete-with-blockers')
  assert.equal(promptEquivalence?.status, 'complete-with-blockers')
  for (const blockedPack of [CLOSURE[3][0], 'com.storystudio.pack.kit.symbolic-psychology-studio']) {
    const handoff = handoffs.handoffs.find(candidate => candidate.identity.pack_id === blockedPack)
    assert.ok(handoff)
    assert.equal(handoff.evidence.golden_prompt_parity.status, 'blocked')
    assert.match(handoff.evidence.golden_prompt_parity.missing, /\bcomplete\b/i)
    assert.doesNotMatch(handoff.evidence.golden_prompt_parity.missing, /\breview requested\b/i)
  }

  const commercialBoundary = reviewRequests.reviews.find(review => review.id === 'commercial-boundary')
  assert.equal(commercialBoundary?.status, 'complete')
  const commercialAcceptance = commercialBoundary?.acceptance.join(' ') ?? ''
  assert.match(commercialAcceptance, /partial-review-complete-blocked/)
  assert.doesNotMatch(commercialAcceptance, /candidate-built-review-pending/)
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const inventoryPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-2-semantic-failure-inventory-v2.json'
const sourcePath = 'content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json'
const reviewPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md'
const expectedInventorySha256 = 'f1189d0e5a905057500ea6c69d6240f1004c639e4d3896cab6d742e8a88d78ab'
const digest = value => createHash('sha256').update(value).digest('hex')

const inventoryBytes = readFileSync(inventoryPath)
const inventory = JSON.parse(inventoryBytes)
const currentBytes = readFileSync(sourcePath)
const current = JSON.parse(currentBytes)
const baselineBytes = execFileSync('git', ['show', `${inventory.sourceCommit}:${sourcePath}`])
const baseline = JSON.parse(baselineBytes)

assert.equal(digest(inventoryBytes), expectedInventorySha256, 'verifier must bind the exact v2 inventory')
assert.equal(digest(baselineBytes), inventory.sourceSha256, 'v2 inventory must bind the exact audited source')
assert.equal(inventory.rows.length, 251)
assert.equal(inventory.summary.failureTypeAssignments, 274)
assert.equal(inventory.summary.conservativeBorderlineRows, 56)

const failures = new Map(inventory.rows.map(row => [row.tupleCoordinate, row]))
assert.equal(failures.size, inventory.rows.length, 'v2 inventory coordinates must be unique')

let auditedTuples = 0
let auditedQuestions = 0
let repairedFlaggedTuples = 0
let reauditedUnflaggedTuples = 0
let changedFlaggedDimensions = 0
let unchangedFlaggedDimensions = 0
let preservedPassingDimensions = 0

assert.equal(current.coverage_profiles.length, baseline.coverage_profiles.length)
for (let profileIndex = 0; profileIndex < baseline.coverage_profiles.length; profileIndex += 1) {
  const beforeProfile = baseline.coverage_profiles[profileIndex]
  const afterProfile = current.coverage_profiles[profileIndex]
  assert.equal(afterProfile.subject, beforeProfile.subject)
  assert.equal(afterProfile.tuples.length, beforeProfile.tuples.length)

  for (let index = 0; index < beforeProfile.tuples.length; index += 1) {
    auditedTuples += 1
    auditedQuestions += 2
    const before = beforeProfile.tuples[index]
    const after = afterProfile.tuples[index]
    const coordinate = `${beforeProfile.subject}#${index + 1}`
    const failure = failures.get(coordinate)

    assert.equal(after.episode_object, before.episode_object, `${coordinate} episode object must remain immutable`)
    assert.equal(after.mechanism, before.mechanism, `${coordinate} mechanism must remain immutable`)

    if (!failure) {
      assert.deepEqual(after, before, `${coordinate} passed both v2 questions and must remain unchanged`)
      reauditedUnflaggedTuples += 1
      preservedPassingDimensions += 2
      continue
    }

    assert.equal(failure.profileIndex, profileIndex)
    assert.equal(failure.index, index)
    assert.equal(failure.episodeObject, before.episode_object)
    assert.equal(failure.mechanism, before.mechanism)
    assert.equal(failure.scope, before.time_place_scope)
    assert.equal(failure.evidenceLens, before.evidence_lens)

    const scopeFailed = failure.questionVerdicts.scopeDepictsAssertedEvent === 'FAIL'
    const evidenceFailed = failure.questionVerdicts.evidenceMeasuresIndispensableVariable === 'FAIL'
    assert.equal(scopeFailed, failure.failureTypes.some(type => type.startsWith('scope:')))
    assert.equal(evidenceFailed, failure.failureTypes.some(type => type.startsWith('evidence:')))

    const expectedScope = scopeFailed ? failure.recommendedScopeWording : before.time_place_scope
    const expectedEvidence = evidenceFailed
      ? `${beforeProfile.subject}: ${failure.recommendedEvidenceMethodWording}`
      : before.evidence_lens
    assert.equal(after.time_place_scope, expectedScope, `${coordinate} must use the exact v2 scope recommendation`)
    assert.equal(after.evidence_lens, expectedEvidence, `${coordinate} must use the exact v2 evidence recommendation`)

    for (const [failed, beforeValue, afterValue] of [
      [scopeFailed, before.time_place_scope, after.time_place_scope],
      [evidenceFailed, before.evidence_lens, after.evidence_lens],
    ]) {
      if (failed) {
        if (afterValue === beforeValue) unchangedFlaggedDimensions += 1
        else changedFlaggedDimensions += 1
      } else {
        assert.equal(afterValue, beforeValue, `${coordinate} passing dimension must be preserved`)
        preservedPassingDimensions += 1
      }
    }
    repairedFlaggedTuples += 1
  }
}

assert.equal(auditedTuples, 1_000)
assert.equal(auditedQuestions, 2_000)
assert.equal(repairedFlaggedTuples, 251)
assert.equal(reauditedUnflaggedTuples, 749)
assert.equal(changedFlaggedDimensions, 274)
assert.equal(unchangedFlaggedDimensions, 0)
assert.equal(preservedPassingDimensions, 1_726)

for (const field of ['episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']) {
  const tupleField = {
    episode_objects: 'episode_object',
    time_place_scopes: 'time_place_scope',
    mechanisms: 'mechanism',
    evidence_lenses: 'evidence_lens',
  }[field]
  assert.deepEqual(current[field], current.coverage_profiles.flatMap(profile => profile.tuples.map(tuple => tuple[tupleField])),
    `${field} must exactly mirror repaired tuple order`)
}

const metadata = document => {
  const copy = structuredClone(document)
  delete copy.coverage_profiles
  delete copy.episode_objects
  delete copy.time_place_scopes
  delete copy.mechanisms
  delete copy.evidence_lenses
  return copy
}
assert.deepEqual(metadata(current), metadata(baseline), 'repair must preserve every non-corpus source field')

const review = readFileSync(reviewPath, 'utf8')
const reviewRows = [...review.matchAll(/^\d+\. \*\*(.+?)\*\* — (.+)$/gm)]
assert.equal(reviewRows.length, 50)
assert.deepEqual(reviewRows.map(match => match[1]), current.subjects)
let tupleVerdicts = 0
for (const [rowIndex, match] of reviewRows.entries()) {
  const verdicts = [...match[2].matchAll(/(?:^|; )(\d{2}) PASS/g)].map(verdict => verdict[1])
  assert.deepEqual(verdicts, Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(2, '0')),
    `${current.subjects[rowIndex]} must contain exactly 20 ordered PASS verdicts`)
  tupleVerdicts += verdicts.length
}
assert.equal(tupleVerdicts, 1_000)
assert.match(review, new RegExp(digest(currentBytes)), 'semantic review must bind the repaired source digest')

console.log(JSON.stringify({
  inventorySha256: digest(inventoryBytes),
  baselineSourceSha256: digest(baselineBytes),
  repairedSourceSha256: digest(currentBytes),
  auditedTuples,
  auditedQuestions,
  repairedFlaggedTuples,
  reauditedUnflaggedTuples,
  changedFlaggedDimensions,
  unchangedFlaggedDimensions,
  preservedPassingDimensions,
  conservativeBorderlineRows: inventory.summary.conservativeBorderlineRows,
  semanticReviewSubjectRows: reviewRows.length,
  semanticReviewTupleVerdicts: tupleVerdicts,
}))

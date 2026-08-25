import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const inventoryPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-2-semantic-failure-inventory.json'
const sourcePath = 'content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json'
const reviewPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md'
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
const currentBytes = readFileSync(sourcePath)
const current = JSON.parse(currentBytes)
const baselineBytes = execFileSync('git', ['show', `${inventory.sourceCommit}:${sourcePath}`])
const baseline = JSON.parse(baselineBytes)
const digest = value => createHash('sha256').update(value).digest('hex')

assert.equal(digest(baselineBytes), inventory.sourceSha256, 'inventory must bind the audited baseline source')
assert.equal(inventory.rows.length, 184, 'inventory must contain the reviewed 184-coordinate failure set')

const failures = new Map(inventory.rows.map(row => [row.tupleCoordinate, row]))
assert.equal(failures.size, inventory.rows.length, 'inventory coordinates must be unique')

let audited = 0
let repaired = 0
let unchanged = 0
let changedFlaggedDimensions = 0
let unchangedFlaggedDimensions = 0

assert.equal(current.coverage_profiles.length, baseline.coverage_profiles.length)
for (let profileIndex = 0; profileIndex < baseline.coverage_profiles.length; profileIndex += 1) {
  const beforeProfile = baseline.coverage_profiles[profileIndex]
  const afterProfile = current.coverage_profiles[profileIndex]
  assert.equal(afterProfile.subject, beforeProfile.subject)
  assert.equal(afterProfile.tuples.length, beforeProfile.tuples.length)

  for (let index = 0; index < beforeProfile.tuples.length; index += 1) {
    audited += 1
    const before = beforeProfile.tuples[index]
    const after = afterProfile.tuples[index]
    const coordinate = `${beforeProfile.subject}#${index + 1}`
    const failure = failures.get(coordinate)

    assert.equal(after.episode_object, before.episode_object, `${coordinate} episode object must remain immutable`)
    assert.equal(after.mechanism, before.mechanism, `${coordinate} mechanism must remain immutable`)

    if (!failure) {
      assert.deepEqual(after, before, `${coordinate} was re-audited as unflagged and must remain unchanged`)
      unchanged += 1
      continue
    }

    const scopeFailed = failure.failureTypes.some(type => type.startsWith('scope:'))
    const evidenceFailed = failure.failureTypes.some(type => type.startsWith('evidence:'))
    const expectedScope = scopeFailed ? failure.recommendedScopeWording : before.time_place_scope
    const expectedEvidence = evidenceFailed
      ? `${beforeProfile.subject}: ${failure.recommendedEvidenceMethodWording}`
      : before.evidence_lens

    assert.equal(after.time_place_scope, expectedScope, `${coordinate} must use the audited scope repair`)
    assert.equal(after.evidence_lens, expectedEvidence, `${coordinate} must use the audited evidence repair`)
    if (scopeFailed) {
      if (after.time_place_scope === before.time_place_scope) unchangedFlaggedDimensions += 1
      else changedFlaggedDimensions += 1
    }
    if (evidenceFailed) {
      if (after.evidence_lens === before.evidence_lens) unchangedFlaggedDimensions += 1
      else changedFlaggedDimensions += 1
    }
    repaired += 1
  }
}

assert.equal(audited, 1_000, 'the re-audit must account for all 1,000 tuples')
assert.equal(repaired, 184, 'the re-audit must account for all 184 flagged tuples')
assert.equal(unchanged, 816, 'the re-audit must account for all 816 unflagged tuples')
assert.equal(changedFlaggedDimensions, 208, 'all 98 scope and 110 evidence failures must change')
assert.equal(unchangedFlaggedDimensions, 0, 'no inventory-flagged dimension may remain unchanged')

for (const field of ['episode_objects', 'time_place_scopes', 'mechanisms', 'evidence_lenses']) {
  const tupleField = {
    episode_objects: 'episode_object',
    time_place_scopes: 'time_place_scope',
    mechanisms: 'mechanism',
    evidence_lenses: 'evidence_lens',
  }[field]
  const flattened = current.coverage_profiles.flatMap(profile => profile.tuples.map(tuple => tuple[tupleField]))
  assert.deepEqual(current[field], flattened, `${field} must exactly mirror the repaired tuple order`)
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
assert.equal(reviewRows.length, 50, 'semantic review must contain exactly 50 subject rows')
assert.deepEqual(reviewRows.map(match => match[1]), current.subjects, 'semantic review rows must follow exact source subject order')
let tupleVerdicts = 0
for (const [rowIndex, match] of reviewRows.entries()) {
  const verdicts = [...match[2].matchAll(/(?:^|; )(\d{2}) PASS/g)].map(verdict => verdict[1])
  assert.deepEqual(verdicts, Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(2, '0')),
    `${current.subjects[rowIndex]} must contain exactly 20 ordered PASS verdicts`)
  tupleVerdicts += verdicts.length
}
assert.equal(tupleVerdicts, 1_000, 'semantic review must contain exactly 1,000 tuple verdicts')
assert.match(review, new RegExp(digest(currentBytes)), 'semantic review must bind the repaired source digest')

console.log(JSON.stringify({
  sourceSha256: digest(currentBytes),
  auditedTuples: audited,
  repairedFlaggedTuples: repaired,
  reauditedUnflaggedTuples: unchanged,
  changedFlaggedDimensions,
  unchangedFlaggedDimensions,
  semanticReviewSubjectRows: reviewRows.length,
  semanticReviewTupleVerdicts: tupleVerdicts,
}))

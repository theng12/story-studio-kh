import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const inventoryPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-2-semantic-failure-inventory-v2.json'
const sourcePath = 'content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json'
const expectedInventorySha256 = 'f1189d0e5a905057500ea6c69d6240f1004c639e4d3896cab6d742e8a88d78ab'
const inventoryBytes = readFileSync(inventoryPath)
const inventory = JSON.parse(inventoryBytes)
const sourceBytes = readFileSync(sourcePath)
const source = JSON.parse(sourceBytes)
const digest = value => createHash('sha256').update(value).digest('hex')

assert.equal(digest(inventoryBytes), expectedInventorySha256, 'repair must use the exact v2 inventory')
assert.equal(digest(sourceBytes), inventory.sourceSha256, 'repair must start from the exact v2 inventory-bound source')

for (const row of inventory.rows) {
  const profile = source.coverage_profiles[row.profileIndex]
  const tuple = profile?.tuples[row.index]
  assert.equal(profile?.subject, row.subject, `${row.tupleCoordinate} subject must match v2 inventory`)
  assert.equal(tuple?.episode_object, row.episodeObject, `${row.tupleCoordinate} object must match v2 inventory`)
  assert.equal(tuple?.mechanism, row.mechanism, `${row.tupleCoordinate} mechanism must match v2 inventory`)
  assert.equal(tuple?.time_place_scope, row.scope, `${row.tupleCoordinate} scope must match v2 inventory`)
  assert.equal(tuple?.evidence_lens, row.evidenceLens, `${row.tupleCoordinate} evidence must match v2 inventory`)

  if (row.questionVerdicts.scopeDepictsAssertedEvent === 'FAIL') {
    tuple.time_place_scope = row.recommendedScopeWording
  }
  if (row.questionVerdicts.evidenceMeasuresIndispensableVariable === 'FAIL') {
    tuple.evidence_lens = `${row.subject}: ${row.recommendedEvidenceMethodWording}`
  }
}

const tuples = source.coverage_profiles.flatMap(profile => profile.tuples)
source.episode_objects = tuples.map(tuple => tuple.episode_object)
source.time_place_scopes = tuples.map(tuple => tuple.time_place_scope)
source.mechanisms = tuples.map(tuple => tuple.mechanism)
source.evidence_lenses = tuples.map(tuple => tuple.evidence_lens)
writeFileSync(sourcePath, `${JSON.stringify(source)}\n`)

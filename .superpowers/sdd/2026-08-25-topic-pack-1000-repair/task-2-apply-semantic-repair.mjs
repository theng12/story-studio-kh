import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const inventoryPath = '.superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-2-semantic-failure-inventory.json'
const sourcePath = 'content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json'
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
const sourceBytes = readFileSync(sourcePath)
const source = JSON.parse(sourceBytes)
const digest = createHash('sha256').update(sourceBytes).digest('hex')

assert.equal(digest, inventory.sourceSha256, 'repair must start from the exact inventory-bound source')

for (const row of inventory.rows) {
  const profile = source.coverage_profiles[row.profileIndex]
  const tuple = profile?.tuples[row.index]
  assert.equal(profile?.subject, row.subject, `${row.tupleCoordinate} subject must match inventory`)
  assert.equal(tuple?.episode_object, row.episodeObject, `${row.tupleCoordinate} object must match inventory`)
  assert.equal(tuple?.mechanism, row.mechanism, `${row.tupleCoordinate} mechanism must match inventory`)
  assert.equal(tuple?.time_place_scope, row.scope, `${row.tupleCoordinate} scope must match inventory`)
  assert.equal(tuple?.evidence_lens, row.evidenceLens, `${row.tupleCoordinate} evidence must match inventory`)

  if (row.failureTypes.some(type => type.startsWith('scope:'))) {
    tuple.time_place_scope = row.recommendedScopeWording
  }
  if (row.failureTypes.some(type => type.startsWith('evidence:'))) {
    tuple.evidence_lens = `${row.subject}: ${row.recommendedEvidenceMethodWording}`
  }
}

const tuples = source.coverage_profiles.flatMap(profile => profile.tuples)
source.episode_objects = tuples.map(tuple => tuple.episode_object)
source.time_place_scopes = tuples.map(tuple => tuple.time_place_scope)
source.mechanisms = tuples.map(tuple => tuple.mechanism)
source.evidence_lenses = tuples.map(tuple => tuple.evidence_lens)
writeFileSync(sourcePath, `${JSON.stringify(source)}\n`)

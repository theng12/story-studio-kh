import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_PATH = path.join(ROOT, 'content-packs', 'authoring-registry.json')
const QUESTION_LADDER_SOURCE = 'content-packs/reusable-primitives/formula/question-ladder'
const AUDIENCE_QUESTION_SEEDER_SOURCE = 'content-packs/reusable-primitives/topic/audience-question-seeder'
const OBJECT_HERO_QUESTION_SOURCE = 'content-packs/reusable-primitives/thumbnail/object-hero-question'

type RegistryRecord = {
  receipt_ref: string
  pack_id: string
  item_id: string
  version: string
  publisher_id: string
  min_app_version: string
  min_app_version_status: string
  kind: string
  source_path: string
  status: string
  dependencies: unknown[]
  stocking_proposal: {
    family: { id: string, status: string }
    sku: { id: string, status: string }
  }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

async function registryRecord(sourcePath: string): Promise<RegistryRecord> {
  const registry = await readJson(REGISTRY_PATH) as { records: RegistryRecord[] }
  const matches = registry.records.filter(record => record.source_path === sourcePath)
  assert.equal(matches.length, 1, `${sourcePath} must have one exact registry record`)
  return matches[0]!
}

test('Question Ladder Formula is receipt-bound and preserves its evidence-safe explanatory ladder', async () => {
  const formulaRecord = await registryRecord(QUESTION_LADDER_SOURCE)
  const topicRecord = await registryRecord(AUDIENCE_QUESTION_SEEDER_SOURCE)
  const recipeRecord = await registryRecord(OBJECT_HERO_QUESTION_SOURCE)
  assert.equal(topicRecord.receipt_ref, formulaRecord.receipt_ref)
  assert.equal(recipeRecord.receipt_ref, formulaRecord.receipt_ref)

  const sourceRoot = path.join(ROOT, formulaRecord.source_path)
  const manifest = await readJson(path.join(sourceRoot, 'pack.json'))
  const formula = await readJson(path.join(sourceRoot, 'content', 'series-formula.json'))
  parseContentPackDocument('series-formula', formula)

  assert.deepEqual(manifest, {
    pack_format: 1,
    pack_id: formulaRecord.pack_id,
    publisher_id: formulaRecord.publisher_id,
    key_id: '{{KEY_ID}}',
    version: formulaRecord.version,
    min_app_version: formulaRecord.min_app_version,
    lifecycle: 'active',
    entitlement: {
      sku: formulaRecord.stocking_proposal.sku.id,
      family: formulaRecord.stocking_proposal.family.id,
    },
  })
  assert.equal(formula.id, formulaRecord.item_id)
  assert.equal(formula.kind, formulaRecord.kind)
  assert.equal(formula.schema_version, 1)
  assert.equal(formula.channel_promise, 'Question → Mechanism → Boundary')

  const scriptStructure = formula.script_structure as { pacing_arc: string[], additional_rules: string[] }
  assert.deepEqual(scriptStructure.pacing_arc, [
    'Concrete question.',
    'Scope and definitions.',
    'Mechanism.',
    'Trade-off.',
    'Exception.',
    'Bounded conclusion.',
  ])
  const ideaAxes = formula.idea_axes as Array<{ id: string, values: string[] }>
  assert.deepEqual(ideaAxes.map(axis => axis.id), [
    'question-intent',
    'mechanism-depth',
    'trade-off',
    'exception-class',
    'conclusion-boundary',
  ])
  assert.ok(ideaAxes.every(axis => axis.values.length >= 3), 'each Formula axis must offer usable variation')

  assert.match((formula.evidence_expectations as string[]).join(' '), /claim.*evidence.*uncertainty/i)
  assert.match(scriptStructure.additional_rules.join(' '), /recency.*before.*queued|before.*queued.*recency/i)
  assert.match(String(formula.perspective_policy), /non-diagnostic/i)

  const titleRules = (formula.title_rules as string[]).join(' ')
  assert.match(titleRules, /bait/i)
  assert.match(titleRules, /medical.*legal.*certainty|legal.*medical.*certainty/i)
  assert.match(titleRules, /one-size-fits-all/i)
  assert.doesNotMatch(titleRules, /guarantee results|certain cure/i)

  assert.deepEqual(formula.compatible_topic_pack_ids, [topicRecord.item_id])
  assert.deepEqual(formula.recommended_thumbnail_recipe_ids, [recipeRecord.item_id])
  assert.equal(Object.hasOwn(formula, 'default_thumbnail_recipe_id'), false)
  assert.deepEqual(formula.recommended_visual_style_ids, [])
})

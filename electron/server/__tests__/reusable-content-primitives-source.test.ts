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

const QUESTION_LADDER_SAFETY_CONTRACT = {
  perspective_policy: "Use an evidence-aware, non-diagnostic narrator who explains the question without prescribing a universal answer or pretending to know the viewer's circumstances.",
  narrative_quality_contract: {
    opening_policy: 'Open with one concrete audience question and state the scope that the episode can responsibly answer.',
    forbidden_patterns: [
      "You won't believe",
      'The truth they hid',
      'Watch what happens next',
      'diagnosing the viewer',
      'medical or legal certainty',
      'one-size-fits-all directives',
      'unsupported causal claims',
    ],
    required_habits: [
      'Define important terms before explaining the mechanism.',
      'Distinguish claims, supporting evidence, and uncertainty.',
      'Name a meaningful trade-off and at least one exception.',
      'Keep the conclusion inside the stated evidence boundary.',
    ],
    closing_policy: 'End with the bounded conclusion the evidence supports, the important uncertainty that remains, and no universal directive.',
  },
  title_rules: [
    'Frame one concrete, answerable question in plain language.',
    'Reject bait, fear framing, secret-reveal language, and promises the episode cannot prove.',
    'Reject medical and legal certainty, diagnostic labels, and one-size-fits-all directives.',
    'Do not imply a universal result, guaranteed outcome, or individualized professional guidance.',
  ],
  idea_system_prompt_role: 'Generate distinct, concrete audience questions that can be answered through a mechanism, a real trade-off, an exception, and a bounded evidence-aware conclusion. Reject duplicates, bait, diagnosis, medical or legal certainty, and universal directives.',
  idea_guidance_text: "Make every candidate's question intent, mechanism depth, trade-off, exception class, and conclusion boundary explicit. Do not queue a candidate until normalized-title and question fingerprints have been checked against existing episodes and the current batch.",
  script_context: 'Answer one concrete question in six dependent steps: define the scope, explain the mechanism, weigh a trade-off, test an exception, and stop at the strongest conclusion the evidence supports. Separate claim, evidence, inference, anecdote, and uncertainty in plain language.',
  script_system_prompt_role: 'You are a clear, evidence-aware, non-diagnostic explainer. You neither sensationalize uncertainty nor disguise it. You never diagnose the viewer, claim medical or legal certainty, fabricate evidence, or turn a general explanation into individualized professional advice.',
  title_shape_rules: [
    'Use a direct question whose nouns reveal the concrete subject.',
    'A comparison question must name the options or criteria rather than promise one universal winner.',
    'An observation question must not imply causation before the episode weighs evidence and alternatives.',
  ],
} as const

function assertQuestionLadderSafety(formula: Record<string, unknown>): void {
  assert.deepEqual({
    perspective_policy: formula.perspective_policy,
    narrative_quality_contract: formula.narrative_quality_contract,
    title_rules: formula.title_rules,
    idea_system_prompt_role: formula.idea_system_prompt_role,
    idea_guidance_text: formula.idea_guidance_text,
    script_context: formula.script_context,
    script_system_prompt_role: formula.script_system_prompt_role,
    title_shape_rules: formula.title_shape_rules,
  }, QUESTION_LADDER_SAFETY_CONTRACT, 'Question Ladder must preserve the approved prohibitive safety contract')
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
  assertQuestionLadderSafety(formula)

  const unsafeFormula = structuredClone(formula)
  unsafeFormula.title_rules = [
    'Use bait, medical and legal certainty, and one-size-fits-all directives.',
  ]
  assert.throws(
    () => assertQuestionLadderSafety(unsafeFormula),
    /must preserve the approved prohibitive safety contract/,
  )

  assert.deepEqual(formula.compatible_topic_pack_ids, [topicRecord.item_id])
  assert.deepEqual(formula.recommended_thumbnail_recipe_ids, [recipeRecord.item_id])
  assert.equal(Object.hasOwn(formula, 'default_thumbnail_recipe_id'), false)
  assert.deepEqual(formula.recommended_visual_style_ids, [])
})

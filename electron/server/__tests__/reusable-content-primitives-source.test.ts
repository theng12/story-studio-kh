import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import sharp from 'sharp'

import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REGISTRY_PATH = path.join(ROOT, 'content-packs', 'authoring-registry.json')
const QUESTION_LADDER_SOURCE = 'content-packs/reusable-primitives/formula/question-ladder'
const AUDIENCE_QUESTION_SEEDER_SOURCE = 'content-packs/reusable-primitives/topic/audience-question-seeder'
const BEFORE_AFTER_TIMELINE_SOURCE = 'content-packs/reusable-primitives/formula/before-after-timeline'
const OBJECT_HERO_QUESTION_SOURCE = 'content-packs/reusable-primitives/thumbnail/object-hero-question'
const ROUTE_MAP_ONE_PROMISE_SOURCE = 'content-packs/reusable-primitives/thumbnail/route-map-one-promise'

const BEFORE_AFTER_TIMELINE_PACING = [
  'Starting baseline.',
  'Change introduced.',
  'Timeline checkpoints.',
  'Measurements or observations.',
  'Confounders and alternatives.',
  'Bounded result.',
] as const

const BEFORE_AFTER_TIMELINE_AXES = [
  'baseline',
  'change',
  'time-window',
  'measurement-or-observation',
  'confounder',
  'result-boundary',
] as const

const BEFORE_AFTER_TIMELINE_REQUIREMENTS = [
  'Every episode must name the starting baseline, the change introduced, and the time window before presenting a result.',
  'Separate measurements or observations from interpretation, then name confounders and plausible alternatives.',
  'End with a bounded result that does not exceed the evidence or imply a universal outcome.',
  'Do not hide a missing baseline, fabricate a measurement, or treat sequence alone as causation.',
] as const

const BEFORE_AFTER_TIMELINE_TITLE_SAFETY = [
  'No transformation promise: never imply that the named change guarantees improvement, recovery, growth, or success.',
  'No causal claim: never present before/after sequence or correlation as proof that the change caused the result.',
  'Name the baseline, change, and bounded observation without universal outcome language.',
] as const

const BEFORE_AFTER_TIMELINE_GOLDEN_PROMPT = {
  pacingArc: BEFORE_AFTER_TIMELINE_PACING,
  ideaSystemPromptRole: 'Generate distinct before/after episode ideas with a named baseline, one change, a stated time window, measurements or observations, confounders, and a bounded result. Reject transformation promises, causal claims, hidden baselines, fabricated measurements, and universal outcomes.',
  ideaGuidanceText: 'Make every assigned baseline, change, time window, measurement or observation, confounder, and result boundary explicit before queueing the candidate.',
  scriptContext: 'Use six dependent stages: establish the starting baseline; introduce the change; mark timeline checkpoints; report measurements or observations; examine confounders and alternatives; state the bounded result. Sequence and correlation do not prove causation.',
  scriptSystemPromptRole: 'You are an evidence-aware before/after narrator. Keep baseline, change, time window, measurements or observations, confounders, and bounded result distinct. Never promise transformation, invent measurements, or claim the change caused the result without adequate evidence.',
  scriptClosingHint: 'Close with the bounded result, the most important confounder or alternative, and the uncertainty that remains.',
} as const

const AUDIENCE_QUESTION_AXES = {
  'audience-context': [
    'first-time learner',
    'busy caregiver',
    'budget-conscious household',
    'small-team operator',
    'hobby beginner',
    'returning learner',
  ],
  'question-intent': [
    'understand a mechanism',
    'compare options',
    'plan a bounded next step',
    'identify a trade-off',
    'check an exception',
    'evaluate an observation',
  ],
  constraint: [
    'time',
    'budget',
    'access',
    'safety',
    'uncertainty',
    'competing priorities',
  ],
  'evidence-type': [
    'primary source',
    'measurement log',
    'official guidance',
    'controlled comparison',
    'expert explanation',
    'lived observation labelled as anecdotal',
  ],
  actionability: [
    'observe',
    'ask a professional',
    'compare criteria',
    'run a reversible low-risk experiment',
    'defer pending evidence',
    'choose among stated options',
  ],
} as const

const AUDIENCE_QUESTION_EXCLUSIONS = [
  'Reject questions that ask for a diagnosis, medical treatment, or a legal conclusion.',
  'Do not claim individualized medical, legal, financial, or other professional guidance.',
  'Reject causal or universal conclusions that exceed the stated evidence.',
  'Do not turn this Topic Pack into a UI seeding feature, live directory, local listing, or answer-structure system.',
] as const

const AUDIENCE_QUESTION_COMPATIBILITY_RULES = [
  'Reject a candidate when its normalized question duplicates an existing episode or an in-batch candidate; store the rejection reason with the candidate fingerprint.',
  'Reject a candidate when its subject, audience-context, question-intent, and constraint tuple repeats; store the rejection reason with the candidate fingerprint.',
  'Reject a candidate when the question asks for a diagnosis, legal conclusion, or medical treatment.',
  'Reject a candidate when lived observation labelled as anecdotal is paired with a causal or universal conclusion.',
  'For a retry, reuse the same seed and persisted fingerprint rejection reasons so accepted order and rejection outcomes remain deterministic.',
] as const

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

type QuestionCandidate = {
  question: string
  subject: string
  audienceContext: string
  questionIntent: string
  constraint: string
  evidenceType: string
  actionability: string
  conclusion: 'bounded' | 'causal' | 'universal'
}

type PlannedQuestions = {
  orderedFingerprints: string[]
  rejections: Array<{ fingerprint: string, reason: string }>
}

function normalizedQuestion(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function questionFingerprint(candidate: QuestionCandidate): string {
  return [
    normalizedQuestion(candidate.question),
    candidate.subject,
    candidate.audienceContext,
    candidate.questionIntent,
    candidate.constraint,
    candidate.evidenceType,
    candidate.actionability,
    candidate.conclusion,
  ].join('|')
}

function planQuestionCandidates(
  seed: string,
  candidates: QuestionCandidate[],
  existingQuestions: string[] = [],
): PlannedQuestions {
  const ranked = candidates.map(candidate => {
    const fingerprint = questionFingerprint(candidate)
    const rank = createHash('sha256').update(`${seed}\0${fingerprint}`).digest('hex')
    return { candidate, fingerprint, rank }
  }).sort((left, right) => left.rank.localeCompare(right.rank) || left.fingerprint.localeCompare(right.fingerprint))
  const seenQuestions = new Set(existingQuestions.map(normalizedQuestion))
  const seenTuples = new Set<string>()
  const orderedFingerprints: string[] = []
  const rejections: PlannedQuestions['rejections'] = []

  for (const { candidate, fingerprint } of ranked) {
    const normalized = normalizedQuestion(candidate.question)
    const tuple = [candidate.subject, candidate.audienceContext, candidate.questionIntent, candidate.constraint].join('|')
    let reason: string | undefined
    if (seenQuestions.has(normalized)) {
      reason = 'normalized question duplicates an existing or in-batch candidate'
    } else if (seenTuples.has(tuple)) {
      reason = 'subject, audience-context, question-intent, and constraint tuple repeats'
    } else if (/\bdiagnos(?:e|is)|\bmedical treatment\b|\blegal conclusion\b/i.test(candidate.question)) {
      reason = 'question asks for diagnosis, medical treatment, or legal conclusion'
    } else if (candidate.evidenceType === 'lived observation labelled as anecdotal'
      && (candidate.conclusion === 'causal' || candidate.conclusion === 'universal')) {
      reason = 'anecdotal observation cannot support a causal or universal conclusion'
    }
    if (reason) {
      rejections.push({ fingerprint, reason })
      continue
    }
    seenQuestions.add(normalized)
    seenTuples.add(tuple)
    orderedFingerprints.push(fingerprint)
  }
  return { orderedFingerprints, rejections }
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

function hasRecursiveKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true
  return Object.values(value).some(child => hasRecursiveKey(child, key))
}

test('Wave 2 source qualification is exactly three authored text leaves with no structured release summary', async () => {
  const expected = new Map<string, { registryStatus: string, sourceExpected: boolean }>([
    [QUESTION_LADDER_SOURCE, { registryStatus: 'authored', sourceExpected: true }],
    [AUDIENCE_QUESTION_SEEDER_SOURCE, { registryStatus: 'authored', sourceExpected: true }],
    [BEFORE_AFTER_TIMELINE_SOURCE, { registryStatus: 'authored', sourceExpected: true }],
    [OBJECT_HERO_QUESTION_SOURCE, { registryStatus: 'reserved', sourceExpected: true }],
    [ROUTE_MAP_ONE_PROMISE_SOURCE, { registryStatus: 'reserved', sourceExpected: true }],
  ])
  for (const [sourcePath, { registryStatus, sourceExpected }] of expected) {
    const record = await registryRecord(sourcePath)
    assert.equal(record.status, registryStatus)
    const sourceRoot = path.join(ROOT, sourcePath)
    if (!sourceExpected) {
      await assert.rejects(fs.access(sourceRoot))
      continue
    }
    const manifest = await readJson(path.join(sourceRoot, 'pack.json'))
    const contentDirectory = path.join(sourceRoot, 'content')
    const contentNames = await fs.readdir(contentDirectory)
    const documents = await Promise.all(contentNames.filter(name => name.endsWith('.json'))
      .map(name => readJson(path.join(contentDirectory, name))))
    assert.equal(hasRecursiveKey(manifest, 'component_summary'), false)
    assert.equal(documents.some(document => hasRecursiveKey(document, 'component_summary')), false)
  }
})

test('Object Hero + Question is a receipt-bound exact-title PNG recipe with byte-level provenance', async () => {
  const recipeRecord = await registryRecord(OBJECT_HERO_QUESTION_SOURCE)
  const questionLadder = await registryRecord(QUESTION_LADDER_SOURCE)
  const beforeAfterTimeline = await registryRecord(BEFORE_AFTER_TIMELINE_SOURCE)
  assert.equal(recipeRecord.status, 'reserved')
  assert.equal(recipeRecord.receipt_ref, questionLadder.receipt_ref)
  assert.equal(recipeRecord.receipt_ref, beforeAfterTimeline.receipt_ref)

  const sourceRoot = path.join(ROOT, recipeRecord.source_path)
  const manifest = await readJson(path.join(sourceRoot, 'pack.json'))
  const recipe = await readJson(path.join(sourceRoot, 'content', 'thumbnail-recipe.json'))
  const parsed = parseContentPackDocument('thumbnail-recipe', recipe)
  assert.equal(parsed.kind, 'thumbnail-recipe')
  assert.deepEqual(manifest, {
    pack_format: 1,
    pack_id: recipeRecord.pack_id,
    publisher_id: recipeRecord.publisher_id,
    key_id: '{{KEY_ID}}',
    version: recipeRecord.version,
    min_app_version: recipeRecord.min_app_version,
    lifecycle: 'active',
    entitlement: {
      sku: recipeRecord.stocking_proposal.sku.id,
      family: recipeRecord.stocking_proposal.family.id,
    },
  })
  assert.equal(recipe.id, recipeRecord.item_id)
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.match(recipe.headline_guidance as string, /complete exact episode title.*do not paraphrase.*post-render/i)
  assert.match((recipe.composition_rules as string[]).join(' '), /upper third.*title-safe|lower two-thirds.*object/i)
  assert.match((recipe.required_elements as string[]).join(' '), /one concrete object|complete exact episode title/i)
  assert.match((recipe.avoid_elements as string[]).join(' '), /collage|logo|watermark|post-render|illegible/i)
  assert.deepEqual(recipe.headline_formats, [
    'WHY DOES THIS {OBJECT} MATTER?',
    'WHAT DOES THIS {OBJECT} CHANGE?',
    'CAN A {OBJECT} WORK?',
  ])
  assert.deepEqual(recipe.compatible_formula_ids, [questionLadder.item_id, beforeAfterTimeline.item_id])

  const previewAssets = recipe.preview_assets as string[]
  assert.deepEqual(previewAssets, [
    'assets/object-hero-question-1.png',
    'assets/object-hero-question-2.png',
    'assets/object-hero-question-3.png',
  ])

  const ledgerText = await fs.readFile(path.join(ROOT, 'content-packs', 'reusable-primitives', 'PREVIEW-PROVENANCE.md'), 'utf8')
  const ledgerMatch = ledgerText.match(/<!-- preview-provenance-ledger:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- preview-provenance-ledger:end -->/)
  assert.ok(ledgerMatch, 'preview provenance ledger must expose a machine-verifiable JSON record')
  const ledger = JSON.parse(ledgerMatch[1]!) as { records: Array<Record<string, unknown>> }
  const records = ledger.records.filter(record => String(record.asset_path).startsWith('thumbnail/object-hero-question/'))
  assert.equal(records.length, 3)

  const expectedEvidence = new Map([
    ['assets/object-hero-question-1.png', {
      title: 'WHY DOES THIS WRENCH MATTER?', lineCount: 1, sha256: 'ea7bb1f244434db1c62e9027cc4fbae196ce820da6c3c2170545fc916131550a', byteSize: 1957419,
    }],
    ['assets/object-hero-question-2.png', {
      title: 'WHAT DOES THIS ENERGY METER CHANGE?', lineCount: 2, sha256: '03a5755f22727eb85f5ed669d7b99e8f7d975ba4ab1aa471b7bcd664a56a202f', byteSize: 2172953,
    }],
    ['assets/object-hero-question-3.png', {
      title: 'CAN A FIELD NOTEBOOK WORK?', lineCount: 3, sha256: '110f5f642fe6bcd544bc0087164e3b0223a5c232a267c4985b034cf743b82ae7', byteSize: 2336354,
    }],
  ])
  const diversity = new Set<string>()
  for (const [assetPath, expected] of expectedEvidence) {
    const preview = await fs.readFile(path.join(sourceRoot, assetPath))
    const metadata = await sharp(preview).metadata()
    const { info } = await sharp(preview).raw().toBuffer({ resolveWithObject: true })
    assert.equal(metadata.format, 'png')
    assert.equal(info.width, 1672)
    assert.equal(info.height, 941)
    assert.equal(createHash('sha256').update(preview).digest('hex'), expected.sha256)
    assert.equal(preview.length, expected.byteSize)

    const record = records.find(candidate => candidate.asset_path === `thumbnail/object-hero-question/${assetPath}`)
    assert.ok(record, `${assetPath} must have one provenance record`)
    assert.equal(record.mime_type, 'image/png')
    assert.equal(record.sha256, expected.sha256)
    assert.equal(record.byte_size, expected.byteSize)
    assert.deepEqual(record.dimensions, { width: 1672, height: 941 })
    assert.equal(record.title_transcription, expected.title)
    assert.equal(record.line_count, expected.lineCount)
    assert.equal(record.origin, 'owner-supplied original generated with ChatGPT built-in image generation')
    assert.match(String(record.rights_basis), /owner authorization/i)
    assert.match(String(record.prompt), /unavailable/i)
    const axes = ['subject', 'side_or_angle', 'distance', 'setting', 'palette_or_symbol']
    assert.ok(axes.every(axis => typeof record[axis] === 'string' && String(record[axis]).length > 0))
    diversity.add(axes.map(axis => String(record[axis])).join('|'))
  }
  assert.equal(diversity.size, 3, 'every preview must vary at least one of the five documented diversity axes')
})

test('Route Map + One Promise is a receipt-bound symbolic exact-title PNG recipe with byte-level provenance', async () => {
  const recipeRecord = await registryRecord(ROUTE_MAP_ONE_PROMISE_SOURCE)
  assert.equal(recipeRecord.status, 'reserved')

  const sourceRoot = path.join(ROOT, recipeRecord.source_path)
  const manifest = await readJson(path.join(sourceRoot, 'pack.json'))
  const recipe = await readJson(path.join(sourceRoot, 'content', 'thumbnail-recipe.json'))
  const parsed = parseContentPackDocument('thumbnail-recipe', recipe)
  assert.equal(parsed.kind, 'thumbnail-recipe')
  assert.deepEqual(manifest, {
    pack_format: 1,
    pack_id: recipeRecord.pack_id,
    publisher_id: recipeRecord.publisher_id,
    key_id: '{{KEY_ID}}',
    version: recipeRecord.version,
    min_app_version: recipeRecord.min_app_version,
    lifecycle: 'active',
    entitlement: {
      sku: recipeRecord.stocking_proposal.sku.id,
      family: recipeRecord.stocking_proposal.family.id,
    },
  })
  assert.equal(recipe.id, recipeRecord.item_id)
  assert.equal(recipe.layout, 'hero')
  assert.equal(recipe.aspect_ratio, '16:9')
  assert.equal(recipe.title_mode, 'ai')
  assert.equal(recipe.headline_mode, 'episode-title')
  assert.match(recipe.composition_guidance as string, /symbolic.*route|wayfinding.*anchor|start.*end/i)
  assert.match(recipe.headline_guidance as string, /complete exact episode title.*do not paraphrase.*post-render/i)
  assert.match((recipe.required_elements as string[]).join(' '), /one route.*anchor|start.*end|qualified promise/i)
  assert.match((recipe.avoid_elements as string[]).join(' '), /navigation|distance|boundary|endorsement|logo|booking|hours|post-render/i)
  assert.deepEqual(recipe.headline_formats, [
    'THE SIMPLE ROUTE TO {ACTIVITY}',
    'ONE REALISTIC WAY TO {ACTIVITY}',
    'A BETTER WAY TO {ACTIVITY}',
  ])
  assert.deepEqual(recipe.compatible_formula_ids, [])

  const previewAssets = recipe.preview_assets as string[]
  assert.deepEqual(previewAssets, [
    'assets/route-map-one-promise-1.png',
    'assets/route-map-one-promise-2.png',
    'assets/route-map-one-promise-3.png',
  ])

  const ledgerText = await fs.readFile(path.join(ROOT, 'content-packs', 'reusable-primitives', 'PREVIEW-PROVENANCE.md'), 'utf8')
  const ledgerMatch = ledgerText.match(/<!-- preview-provenance-ledger:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- preview-provenance-ledger:end -->/)
  assert.ok(ledgerMatch, 'preview provenance ledger must expose a machine-verifiable JSON record')
  const ledger = JSON.parse(ledgerMatch[1]!) as { records: Array<Record<string, unknown>> }
  const records = ledger.records.filter(record => String(record.asset_path).startsWith('thumbnail/route-map-one-promise/'))
  assert.equal(records.length, 3)

  const expectedEvidence = new Map([
    ['assets/route-map-one-promise-1.png', {
      title: 'A BETTER WAY TO WALK THE PARK LOOP', lineCount: 1, sha256: '8be6f8a4027a9904268042e5106102bf119326c605f345afe46ce02ba7204905', byteSize: 2403617,
    }],
    ['assets/route-map-one-promise-2.png', {
      title: 'THE SIMPLE ROUTE TO A NEIGHBORHOOD WALK', lineCount: 2, sha256: '0ed39e74bb7dca0e08eb9643ce2696291843b507c1c8ecd936fc08bb35d0ce9e', byteSize: 2151962,
    }],
    ['assets/route-map-one-promise-3.png', {
      title: 'ONE REALISTIC WAY TO LEARN A NEW SKILL', lineCount: 3, sha256: '30e6757837a3edf1dc6753440eaabae3dbda0b6c8685e8d9b4936f4cd43fcaec', byteSize: 2374090,
    }],
  ])
  const diversity = new Set<string>()
  for (const [assetPath, expected] of expectedEvidence) {
    const preview = await fs.readFile(path.join(sourceRoot, assetPath))
    const metadata = await sharp(preview).metadata()
    const { info } = await sharp(preview).raw().toBuffer({ resolveWithObject: true })
    assert.equal(metadata.format, 'png')
    assert.equal(info.width, 1672)
    assert.equal(info.height, 941)
    assert.equal(createHash('sha256').update(preview).digest('hex'), expected.sha256)
    assert.equal(preview.length, expected.byteSize)

    const record = records.find(candidate => candidate.asset_path === `thumbnail/route-map-one-promise/${assetPath}`)
    assert.ok(record, `${assetPath} must have one provenance record`)
    assert.equal(record.mime_type, 'image/png')
    assert.equal(record.sha256, expected.sha256)
    assert.equal(record.byte_size, expected.byteSize)
    assert.deepEqual(record.dimensions, { width: 1672, height: 941 })
    assert.equal(record.title_transcription, expected.title)
    assert.equal(record.line_count, expected.lineCount)
    assert.equal(record.origin, 'owner-supplied original generated with ChatGPT built-in image generation')
    assert.match(String(record.rights_basis), /owner authorization/i)
    assert.match(String(record.prompt), /unavailable/i)
    const axes = ['subject', 'side_or_angle', 'distance', 'setting', 'palette_or_symbol']
    assert.ok(axes.every(axis => typeof record[axis] === 'string' && String(record[axis]).length > 0))
    diversity.add(axes.map(axis => String(record[axis])).join('|'))
  }
  assert.equal(diversity.size, 3, 'every preview must vary at least one of the five documented diversity axes')
})

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

test('Audience Question Seeder is receipt-bound and deterministically rejects duplicate question assignments', async () => {
  const topicRecord = await registryRecord(AUDIENCE_QUESTION_SEEDER_SOURCE)
  const formulaRecord = await registryRecord(QUESTION_LADDER_SOURCE)
  assert.equal(topicRecord.receipt_ref, formulaRecord.receipt_ref)

  const sourceRoot = path.join(ROOT, topicRecord.source_path)
  const manifest = await readJson(path.join(sourceRoot, 'pack.json'))
  const topic = await readJson(path.join(sourceRoot, 'content', 'topic-pack.json'))
  parseContentPackDocument('topic-pack', topic)

  assert.deepEqual(manifest, {
    pack_format: 1,
    pack_id: topicRecord.pack_id,
    publisher_id: topicRecord.publisher_id,
    key_id: '{{KEY_ID}}',
    version: topicRecord.version,
    min_app_version: topicRecord.min_app_version,
    lifecycle: 'active',
    entitlement: {
      sku: topicRecord.stocking_proposal.sku.id,
      family: topicRecord.stocking_proposal.family.id,
    },
  })
  assert.equal(topic.id, topicRecord.item_id)
  assert.equal(topic.kind, topicRecord.kind)
  assert.equal(topic.schema_version, 1)

  const ideaAxes = topic.idea_axes as Array<{ id: string, values: string[] }>
  assert.deepEqual(ideaAxes.map(axis => axis.id), [
    'audience-context',
    'question-intent',
    'constraint',
    'evidence-type',
    'actionability',
  ])
  assert.deepEqual(Object.fromEntries(ideaAxes.map(axis => [axis.id, axis.values])), AUDIENCE_QUESTION_AXES)
  assert.equal(topic.max_siblings_per_subject, 1)

  const sourceLists = [
    topic.subjects,
    topic.episode_objects,
    topic.time_place_scopes,
    topic.mechanisms,
    topic.evidence_lenses,
  ] as string[][]
  for (const list of sourceLists) {
    assert.ok(list.length >= 6)
    assert.equal(new Set(list.map(value => value.toLowerCase())).size, list.length)
  }
  assert.deepEqual(topic.subjects, AUDIENCE_QUESTION_AXES['question-intent'])
  assert.deepEqual(topic.episode_objects, AUDIENCE_QUESTION_AXES['audience-context'])
  assert.deepEqual(topic.time_place_scopes, AUDIENCE_QUESTION_AXES.constraint)
  assert.deepEqual(topic.evidence_lenses, AUDIENCE_QUESTION_AXES['evidence-type'])
  assert.deepEqual(topic.mechanisms, AUDIENCE_QUESTION_AXES.actionability)
  assert.deepEqual(topic.compatible_formula_ids, [formulaRecord.item_id])
  assert.deepEqual(topic.exclusions, AUDIENCE_QUESTION_EXCLUSIONS)
  assert.deepEqual(topic.compatibility_rules, AUDIENCE_QUESTION_COMPATIBILITY_RULES)
  assert.equal(
    topic.prompt_context,
    'Generate one bounded audience question from the selected axes. This Topic Pack supplies question domains only; it does not decide answer structure, act as a UI seeding feature or live directory, or provide individualized medical or legal guidance.',
  )

  const candidates: QuestionCandidate[] = [
    {
      question: 'Why does a simple timer affect task switching?',
      subject: 'task switching',
      audienceContext: 'small-team operator',
      questionIntent: 'understand a mechanism',
      constraint: 'time',
      evidenceType: 'measurement log',
      actionability: 'observe',
      conclusion: 'bounded',
    },
    {
      question: 'Which note-taking method fits a returning learner?',
      subject: 'note-taking',
      audienceContext: 'returning learner',
      questionIntent: 'compare options',
      constraint: 'access',
      evidenceType: 'controlled comparison',
      actionability: 'compare criteria',
      conclusion: 'bounded',
    },
    {
      question: 'Could another note-taking method fit this learner?',
      subject: 'note-taking',
      audienceContext: 'returning learner',
      questionIntent: 'compare options',
      constraint: 'access',
      evidenceType: 'expert explanation',
      actionability: 'choose among stated options',
      conclusion: 'bounded',
    },
  ]
  const firstPlan = planQuestionCandidates('wave-2-seed', candidates)
  const repeatedPlan = planQuestionCandidates('wave-2-seed', [...candidates].reverse())
  assert.deepEqual(repeatedPlan, firstPlan)
  assert.deepEqual(firstPlan, {
    orderedFingerprints: [
      'could another note taking method fit this learner|note-taking|returning learner|compare options|access|expert explanation|choose among stated options|bounded',
      'why does a simple timer affect task switching|task switching|small-team operator|understand a mechanism|time|measurement log|observe|bounded',
    ],
    rejections: [{
      fingerprint: 'which note taking method fits a returning learner|note-taking|returning learner|compare options|access|controlled comparison|compare criteria|bounded',
      reason: 'subject, audience-context, question-intent, and constraint tuple repeats',
    }],
  })
})

test('Before/After Timeline Formula is receipt-bound and preserves a no-causality six-stage prompt', async () => {
  const formulaRecord = await registryRecord(BEFORE_AFTER_TIMELINE_SOURCE)
  const recipeRecord = await registryRecord(OBJECT_HERO_QUESTION_SOURCE)
  assert.equal(recipeRecord.receipt_ref, formulaRecord.receipt_ref)

  const sourceRoot = path.join(ROOT, formulaRecord.source_path)
  const manifest = await readJson(path.join(sourceRoot, 'pack.json'))
  const formula = await readJson(path.join(sourceRoot, 'content', 'series-formula.json'))
  const parsed = parseContentPackDocument('series-formula', formula)
  assert.equal(parsed.kind, 'series-formula')
  if (parsed.kind !== 'series-formula') assert.fail('Before/After Timeline must parse as a series-formula')

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
  assert.equal(formula.channel_promise, 'Baseline → Change → Evidence Boundary')

  const scriptStructure = formula.script_structure as { pacing_arc: string[], additional_rules: string[] }
  assert.deepEqual(scriptStructure.pacing_arc, BEFORE_AFTER_TIMELINE_PACING)
  const ideaAxes = formula.idea_axes as Array<{ id: string, values: string[] }>
  assert.deepEqual(ideaAxes.map(axis => axis.id), BEFORE_AFTER_TIMELINE_AXES)
  assert.ok(ideaAxes.every(axis => axis.values.length >= 3), 'each timeline axis must offer usable variation')
  assert.deepEqual(formula.narrative_rules, BEFORE_AFTER_TIMELINE_REQUIREMENTS)
  assert.deepEqual(formula.title_rules, BEFORE_AFTER_TIMELINE_TITLE_SAFETY)
  assert.deepEqual(scriptStructure.additional_rules, [
    'Require the baseline, change, time window, measurements or observations, confounders, and bounded result before a candidate is queued.',
    'Keep the six stages in order because each stage qualifies the result that follows.',
    'Reject a candidate when the baseline, time window, measurement or observation method, or confounder boundary is missing.',
    'Reject transformation promises, causal claims inferred from sequence or correlation, and universal results.',
  ])

  assert.deepEqual(formula.compatible_topic_pack_ids, [])
  assert.deepEqual(formula.default_topic_pack_ids, [])
  assert.deepEqual(formula.recommended_thumbnail_recipe_ids, [recipeRecord.item_id])
  assert.equal(Object.hasOwn(formula, 'default_thumbnail_recipe_id'), false)
  assert.deepEqual(formula.recommended_visual_style_ids, [])

  const runtimeFormula = contentPackDocumentToNiche(parsed)
  assert.ok(runtimeFormula.scriptStructure, 'runtime Formula adapter must preserve script structure')
  assert.deepEqual({
    pacingArc: runtimeFormula.scriptStructure.pacingArc,
    ideaSystemPromptRole: runtimeFormula.ideaSystemPromptRole,
    ideaGuidanceText: runtimeFormula.ideaGuidanceText,
    scriptContext: runtimeFormula.scriptContext,
    scriptSystemPromptRole: runtimeFormula.scriptSystemPromptRole,
    scriptClosingHint: runtimeFormula.scriptClosingHint,
  }, BEFORE_AFTER_TIMELINE_GOLDEN_PROMPT)
})

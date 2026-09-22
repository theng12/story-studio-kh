/**
 * DS-14 / M-08 — proof that the model-drift guard actually catches the forms it
 * claims to catch.
 *
 * The guard is a source grep, and its failure mode is invisible from outside:
 * when a rule stops matching, the check keeps printing "passed". M-08 recorded
 * exactly that gap — "no synthetic missed-pattern guard run was reported" — and
 * the guard's own comments name three historical misses:
 *
 *   1. `max(?:imum)?` was absent from the published-field list, so every
 *      `maximum_*` field GenStudio publishes was invisible.
 *   2. bare `credits` was absent, so `credits ?? 0` (which reads as FREE) was
 *      not covered.
 *   3. a guarded ternary with a SCREAMING_CASE constant evaded both the `??`
 *      rule and the numeric-literal rule, and one shipped to a job log.
 *
 * These fixtures run through `scanForModelDrift` — the SAME file walk, coarse
 * gate and analyzer the release gate runs — pointed at a temporary directory, so
 * nothing is ever planted into production source. Assertions are in both
 * directions: every declared rule must fire on a real violation, and every
 * legitimate control must stay silent.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

import {
  analyzeModelDriftSource,
  modelDriftRules,
  modelDriftScanRoots,
  scanForModelDrift,
} from '../../check-model-drift.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')

/**
 * One violating fixture per rule. `historicalMiss: true` marks the three the
 * guard's comments record shipping in spite of the guard — those are the ones
 * this file exists for.
 */
const VIOLATIONS = [
  {
    rule: 'product-identifier',
    file: 'electron/server/fixture-model.ts',
    source: `export const MODEL_ID = 'gpt-4o-mini'\n`,
  },
  {
    rule: 'price-literal',
    file: 'electron/server/fixture-price.ts',
    source: `export const PRICE = { credits_per_image: 300 }\n`,
  },
  {
    rule: 'catalogue-field-literal',
    file: 'electron/server/fixture-limit.ts',
    source: `export const LIMITS = { max_output_tokens: 8192 }\n`,
  },
  {
    rule: 'published-value-fallback',
    file: 'electron/server/fixture-fallback-wrapped.ts',
    source: `export const CAP = optionalCount(payload?.maximum_input_characters) ?? 0\n`,
    historicalMiss: true,
  },
  {
    rule: 'published-value-fallback',
    file: 'electron/server/fixture-fallback-credits.ts',
    source: `export const AMOUNT = payload?.credits ?? 0\n`,
    historicalMiss: true,
  },
  {
    rule: 'published-value-guarded-fallback',
    file: 'electron/server/fixture-fallback-ternary.ts',
    source: `export const CAP = Number.isInteger(product?.max_output_tokens) && product.max_output_tokens >= 1\n`
      + `  ? product.max_output_tokens\n`
      + `  : FALLBACK_OUTPUT_TOKEN_CAP\n`,
    historicalMiss: true,
  },
  {
    rule: 'capability-list',
    file: 'frontend/utils/fixture-ratios.ts',
    source: `export const RATIOS = ['16:9', '9:16']\n`,
  },
  {
    rule: 'named-control',
    file: 'frontend/utils/fixture-control.ts',
    source: `export const value = controls.stability\n`,
  },
  {
    rule: 'private-routing-identity',
    file: 'frontend/utils/fixture-identity.ts',
    source: `export const note = 'Trying Kie before the gateway handled it.'\n`,
  },
  {
    rule: 'private-routing-identity-backend',
    file: 'electron/server/fixture-identity.ts',
    source: `export function fail() { throw new Error('No OpenRouter or Studio Hub fallback was attempted.') }\n`,
  },
  {
    rule: 'currency-symbol',
    file: 'frontend/utils/fixture-currency.ts',
    source: 'export const label = `Estimated cost: $${amount}`\n',
  },
]

/** Every one of these must produce NOTHING. */
const CONTROLS = {
  'valid-annotation.ts': [
    '// model-drift-allow: a frozen digest component that must never follow the catalogue',
    "export const DIGEST = 'gpt-4o-mini'",
    '',
  ].join('\n'),
  'exempt-minimum.ts': [
    'export const minimum = payload?.min_reference_images ?? 0',
    '',
  ].join('\n'),
  'subscript-lookup.ts': [
    'export const factor = RESOLUTION_FACTOR[settings.resolution] || 1',
    '',
  ].join('\n'),
  'gated-control.ts': [
    "export const allowed = productPublishesControl(product, 'temperature')",
    '',
  ].join('\n'),
  'live-read.ts': [
    'export const published = model.max_output_tokens',
    'export const dims = model.max_image_dimension',
    '',
  ].join('\n'),
  'module-specifier.ts': [
    "import type { Client } from 'gpt-4o-sdk'",
    '',
  ].join('\n'),
  'consistent-cast.ts': [
    'export function pick(model, fallback) {',
    '  return model.max_output_tokens ?? fallback',
    '}',
    '',
  ].join('\n'),
}

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'model-drift-fixture-'))
  for (const fixture of VIOLATIONS) {
    const path = join(root, fixture.file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, fixture.source, 'utf8')
  }
  await mkdir(join(root, 'frontend/utils'), { recursive: true })
  for (const [name, source] of Object.entries(CONTROLS)) {
    await writeFile(join(root, 'frontend/utils', name), source, 'utf8')
  }
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('every declared rule fires on a real violating fixture', async () => {
  const scan = await scanForModelDrift({ root, roots: ['.'] })
  const caught = new Set(scan.violations.map(violation => violation.rule))

  const declared = new Set(modelDriftRules.map(rule => rule.id))
  const missing = [...declared].filter(id => !caught.has(id))
  assert.deepEqual(missing, [],
    'a rule that never fires on a fixture cannot be trusted to fire on real code')

  const undeclared = [...caught].filter(id => !declared.has(id))
  assert.deepEqual(undeclared, [], 'every violation must belong to a declared rule')
})

test('the three historical misses are caught, by name and by file', async () => {
  const scan = await scanForModelDrift({ root, roots: ['.'] })
  for (const fixture of VIOLATIONS.filter(entry => entry.historicalMiss)) {
    const hit = scan.violations.find(violation => violation.file.endsWith(fixture.file))
    assert.ok(hit, `${fixture.file} must be flagged — this exact shape shipped once`)
    assert.equal(hit.rule, fixture.rule, `${fixture.file} must be flagged by ${fixture.rule}`)
  }
})

test('the violating fixtures are all reported, at the right line', async () => {
  const scan = await scanForModelDrift({ root, roots: ['.'] })
  // At least one per fixture: one line naming two identities (the backend prose
  // fixture names both OpenRouter and Studio Hub) legitimately reports twice.
  assert.ok(scan.violations.length >= VIOLATIONS.length,
    `every violating fixture must be reported (got ${scan.violations.length} findings for ${VIOLATIONS.length} fixtures)`)

  const currency = scan.violations.find(violation => violation.file.endsWith('fixture-currency.ts'))
  assert.equal(currency.line, 1, 'the reported line must be the line the literal is on')
  assert.match(currency.detail, /currency amount/i,
    'the message must teach which rule was broken, not just that something was')
})

test('every legitimate control stays silent', async () => {
  const scan = await scanForModelDrift({ root, roots: ['.'] })
  const controlNames = Object.keys(CONTROLS)
  const flagged = scan.violations.filter(violation => controlNames.some(name => violation.file.endsWith(name)))
  assert.deepEqual(flagged, [],
    'a guard that cries wolf gets annotated away by the next person in a hurry')

  assert.equal(scan.allowedCount, 1,
    'the deliberately annotated control is allowed exactly once, and counted')
})

test('a malformed justification is a failure, not a pass', async () => {
  const analyzed = analyzeModelDriftSource(
    '// model-drift-allow: legacy\n'
    + "export const DIGEST = 'gpt-4o-mini'\n",
    'electron/server/short-justification.ts',
  )
  assert.deepEqual(analyzed.violations, [], 'the annotation itself suppresses the violation')
  assert.equal(analyzed.malformedAllowances.length, 1,
    'an annotation without a written reason must fail the check, or it becomes a blanket suppression')
  assert.match(analyzed.malformedAllowances[0].reason, /at least 4 words/)
})

test('no pre-filter may hide a violating file', async () => {
  // The guard used to skip any file whose text matched none of a list of
  // catalogue-ish words. Two real shapes slipped through it — `controls.X`
  // (which contains none of those words) and a published field such as
  // `max_reference_images` — and removing that gate is what surfaced a live
  // currency finding in frontend/utils/genstudio-relaxed-queue.ts. This test
  // keeps the gate gone: every violating fixture below is deliberately free of
  // any catalogue vocabulary except the violation itself.
  const scan = await scanForModelDrift({ root, roots: ['.'] })
  const names = new Set(scan.violations.map(violation => violation.file))
  for (const fixture of VIOLATIONS) {
    assert.ok([...names].some(name => name.endsWith(fixture.file)),
      `${fixture.file} was skipped — a real violation could hide there`)
  }
  assert.ok(scan.filesScanned >= VIOLATIONS.length)
})

test('live application code is still clean (the guard on the real tree)', async () => {
  // The positive control in the other direction: the same analyzer, the real
  // scan roots. If this fails, the release gate fails too — and this test says
  // so in a lane that runs far more often than a release.
  const scan = await scanForModelDrift({ root: repoRoot, roots: modelDriftScanRoots })
  assert.deepEqual(scan.violations.map(violation => `${violation.file}:${violation.line} ${violation.detail}`), [])
  assert.deepEqual(scan.malformedAllowances, [])
  assert.ok(scan.filesScanned > 100, 'the real scan must still be reading the application tree')
})

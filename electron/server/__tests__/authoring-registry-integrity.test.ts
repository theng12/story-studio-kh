import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// @ts-expect-error — publisher tooling is plain ESM with no type declarations.
import { validateAuthoringRegistry } from '../../../scripts/content-packs/authoring-registry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * The committed authoring registry must validate against its own rules.
 *
 * WHY THIS EXISTS. On 2026-08-28 the registry on `main` was internally
 * inconsistent and every registry write was refused, because both
 * `reserveAuthoringBatch` and `transitionAuthoringRecord` validate the current
 * document before they mutate anything. Two waves of content work were blocked
 * behind it.
 *
 * It got there through a fully green suite. `validateAuthoringRegistry` was
 * only ever exercised by `scripts/content-packs/__tests__/`, and the backend
 * gate collects `electron/server/__tests__/*.test.ts` and nothing else — so the
 * one check that would have caught it was not part of any gate. This file moves
 * that check inside the gate.
 *
 * WHAT IT CATCHES. `receipt_ref` and `transition_ref` are
 * `sha256(canonical(request))` over a request that includes `expected_revision`.
 * Re-sequencing entries during a merge therefore invalidates their refs unless
 * the refs are re-minted in the same edit. Two merges did exactly that:
 * `8fae08f0` re-sequenced transitions 66 and 67, and `b6fb166d` re-sequenced
 * batch 15 and transition 68. This test fails on both.
 *
 * It is deliberately the whole document, not a spot check: any future rule the
 * validator gains is enforced here for free.
 */
test('the committed authoring registry validates against its own rules', async () => {
  const validated = await validateAuthoringRegistry({
    registryPath: path.join(ROOT, 'content-packs', 'authoring-registry.json'),
    repositoryRoot: ROOT,
  })

  assert.ok(Number.isSafeInteger(validated.revision) && validated.revision >= 2,
    'the registry must carry a usable revision')
  assert.ok(validated.records.length > 0, 'the registry must hold records')
})

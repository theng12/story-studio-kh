/**
 * A channel type SUGGESTS a look. It never dictates one.
 *
 * The owner's ruling, 2026-08-25: *"art style is a selection, a preference for
 * the user. they can't be dictated this way."*
 *
 * Before v1.4.64 eleven of the twenty-two built-in Formulas silently decided
 * how a channel's images looked. The prose lived in `visualStyleSheet` /
 * `defaultStyleKeywords` / `thumbnailStyleSheet` and was welded into every
 * prompt by `applyNicheToFormat`, invisibly, with no UI showing it and no way
 * to turn it off. Two more hardcoded a `builtin-` style id that the Settings
 * page then WROTE into the project on save.
 *
 * This file is the fence. It sweeps the whole built-in Formula directory, so
 * a dictate cannot come back one file at a time.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const NICHES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'niches')
const NICHE_FILES = readdirSync(NICHES_DIR).filter(name => name.endsWith('.json')).sort()

function read(name: string): any {
  return JSON.parse(readFileSync(join(NICHES_DIR, name), 'utf8'))
}

test('the built-in Formula directory is non-empty (a passing sweep over nothing proves nothing)', () => {
  assert.ok(NICHE_FILES.length >= 20, `expected the full built-in catalog, saw ${NICHE_FILES.length}`)
})

test('no built-in Formula bakes a scene style into every prompt', () => {
  const offenders = NICHE_FILES.filter(name => {
    const niche = read(name)
    return Boolean(niche.visualStyleSheet) || Boolean(niche.defaultStyleKeywords?.length)
  })
  assert.deepEqual(offenders, [], 'these Formulas still dictate a scene art style')
})

test('no built-in Formula bakes a thumbnail style into every cover', () => {
  const offenders = NICHE_FILES.filter(name => Boolean(read(name).thumbnailStyleSheet))
  assert.deepEqual(offenders, [], 'these Formulas still dictate a thumbnail art style')
})

test('no built-in Formula names a visual style id, in any shape', () => {
  const offenders: string[] = []
  for (const name of NICHE_FILES) {
    const raw = readFileSync(join(NICHES_DIR, name), 'utf8')
    if (raw.includes('recommendedVisualStyleId')) offenders.push(`${name} (recommendedVisualStyleId)`)
    // `builtin-` ids belong to the style library, not to a Formula. A Formula
    // that mentions one is reaching across the boundary again.
    if (/"builtin-/.test(raw)) offenders.push(`${name} (builtin- id)`)
  }
  assert.deepEqual(offenders, [], 'a Formula must not name the look the customer should use')
})

test('a Formula still owns everything that is genuinely its own', () => {
  // The point is not to strip Formulas bare. Content, structure, thumbnail
  // LAYOUT and the human-facing hint are the Formula's job; only the rendering
  // look moved out. If this ever fails, the fence above cut too deep.
  const sleep = read('sleep.json')
  assert.ok(sleep.visualStyleHint, 'the descriptive one-liner stays — it never reaches a prompt')
  const business = read('business-economics.json')
  assert.equal(business.thumbnailProfile?.layout, 'annotated-collage')
  assert.match(String(business.thumbnailProfile?.conceptGuidance), /annotated ownership-economics cover/i)
  assert.equal(read('hidden-mechanics-history.json').defaultThumbnailTemplateId, 'archival-map-investigation')
})

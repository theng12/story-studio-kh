/**
 * The same Formula may not be sold twice under two covers.
 *
 * WHY THIS FILE EXISTS. On 2026-08-28 a workstream asked for "the missing
 * standalone signed Series Formula component" for the built-in
 * `hidden-mechanics-history`. It is not missing. That built-in was already cut
 * over, under the name it ships as: `com.storystudio.formula.archival-ledger`,
 * a signed, priced component at 1.0.1. Measured on that day, the built-in file
 * and the shipped component carry byte-identical generative machinery — all
 * four idea axes and their twenty-eight values, the nine-chapter structure, the
 * quality contract, every prompt role, the narrator styles, the title/logline/
 * theme rules and the metadata hooks. Only the id, the display name, the
 * tagline and the topic-pack id spellings differ, and those topic ids map one
 * to one. Authoring a second component from that same material would have
 * produced a second SKU over content already bought once.
 *
 * That request was refused with the measurement. This file is what stops the
 * next one, because the next one will not arrive labelled as a duplicate — it
 * will arrive as a reasonable-sounding gap, six weeks from now, in a sentence
 * that reads exactly like the last one.
 *
 * WHAT IT CHECKS. Not names, and not descriptions: a rebill would reword those
 * first and keep the machine. It fingerprints the generative machinery itself —
 * the fields that actually decide what an episode becomes — and asserts that no
 * two distinct signed Formula ids share one.
 *
 * WHEN IT FAILS. Read the fingerprint before touching the test. Two signed ids
 * with one machinery fingerprint means the second is the first in new packaging.
 * Either it needs real distinct substance, or it should not exist. Widening the
 * allowlist to make a collision disappear is the failure mode this file is for.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(SERVER_ROOT, '..', '..')
const NICHES_DIR = join(SERVER_ROOT, 'niches')
const PACKS_DIR = join(REPO_ROOT, 'content-packs')

/**
 * The generative machinery: the fields that decide what an episode BECOMES.
 *
 * Deliberately an allowlist, not "everything except". `id`, `name`, `tagline`,
 * `description` and `channel_promise` are the cover, and a rebill changes the
 * cover. They are not in here on purpose. Topic-pack ids are excluded too —
 * the legacy and signed spellings of one pack differ while naming one pack.
 */
const MACHINERY_FIELDS = [
  'formula_family',
  'idea_axes',
  'idea_system_prompt_role',
  'idea_guidance_text',
  'example_topics',
  'script_context',
  'script_system_prompt_role',
  'script_closing_hint',
  'script_structure',
  'narrative_quality_contract',
  'narrator_styles',
  'default_narrator_style_id',
  'vocabulary',
  'audience_hint',
  'title_shape_rules',
  'title_length_range',
  'logline_shape_rules',
  'logline_sentence_range',
  'theme_shape_rules',
  'theme_count_range',
  'structural_variety',
  'metadata_title_style_hint',
  'metadata_title_hook_rules',
  'metadata_tags_hook_rules',
  'youtube_tags_hint',
] as const

/**
 * Built-in Formulas are camelCase; signed pack components are snake_case. The
 * two spellings are the same field, so a comparison that respects the casing
 * would report every pair as different and catch nothing.
 */
function toSnake(key: string): string {
  return key.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()
}

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [key, child] of Object.entries(value)) {
      if (child === null || child === undefined) continue
      out[toSnake(key)] = normalize(child)
    }
    return out
  }
  return value
}

/**
 * Below this many machinery fields there is not enough of an episode-writing
 * machine present for a fingerprint to mean anything. Signed Formulas must all
 * clear it; a built-in below it is excluded from comparison, not failed.
 */
const MACHINERY_FLOOR = 10

interface Fingerprint {
  digest: string
  fieldCount: number
}

function fingerprint(doc: any): Fingerprint {
  const normalized = normalize(doc)
  const present: Record<string, any> = {}
  for (const field of MACHINERY_FIELDS) {
    if (field in normalized) present[field] = normalized[field]
  }
  return {
    fieldCount: Object.keys(present).length,
    digest: createHash('sha256').update(JSON.stringify(present)).digest('hex').slice(0, 16),
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Every `content/*.json` under `content-packs/`, at any depth. */
function packContentFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) packContentFiles(absolute, found)
    else if (entry.isFile() && entry.name.endsWith('.json') && basename(dir) === 'content') found.push(absolute)
  }
  return found
}

interface SignedFormula {
  id: string
  path: string
  print: Fingerprint
}

const SIGNED_FORMULAS: SignedFormula[] = packContentFiles(PACKS_DIR)
  .map(path => ({ path, doc: readJson(path) }))
  .filter(({ doc }) => typeof doc?.id === 'string' && doc.id.includes('.formula.'))
  .map(({ path, doc }) => ({ id: doc.id as string, path, print: fingerprint(doc) }))
  .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path))

const BUILTIN_FORMULAS = readdirSync(NICHES_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => ({ name, print: fingerprint(readJson(join(NICHES_DIR, name))) }))

test('the sweep actually swept something (a fence around nothing holds nothing)', () => {
  assert.ok(
    SIGNED_FORMULAS.length >= 15,
    `expected the signed Formula catalog, saw ${SIGNED_FORMULAS.length} component files`,
  )
  assert.ok(
    BUILTIN_FORMULAS.length >= 20,
    `expected the full built-in Formula catalog, saw ${BUILTIN_FORMULAS.length}`,
  )
})

test('every signed Formula exposes enough machinery to be compared at all', () => {
  // If a future component renames its fields wholesale, the allowlist would
  // match nothing, every such component would hash identically, and the
  // collision check below would fire for the wrong reason. Catch that here,
  // where the message says what actually happened. Measured 2026-08-28, the
  // thinnest signed Formula carries 13 of these fields.
  const thin = SIGNED_FORMULAS
    .filter(formula => formula.print.fieldCount < MACHINERY_FLOOR)
    .map(formula => `${formula.id} (${formula.print.fieldCount} machinery fields, ${formula.path})`)
  assert.deepEqual(thin, [], 'these signed Formulas expose too little machinery to be compared — the allowlist has drifted')
})

test('the built-ins excluded from comparison are the ones that were never narrative', () => {
  // `music-mix` is a music channel: no idea axes, no script structure, nothing
  // that writes an episode. It cannot be duplicated because there is nothing
  // there to duplicate, so it is excluded rather than forced through the floor.
  // Pinned so that a REAL Formula quietly losing its machinery shows up here
  // instead of silently dropping out of the duplicate check.
  assert.deepEqual(
    BUILTIN_FORMULAS.filter(entry => entry.print.fieldCount < MACHINERY_FLOOR).map(entry => entry.name),
    ['music-mix.json'],
    'a narrative built-in Formula fell below the comparison floor — it is no longer covered by the duplicate check',
  )
})

test('no two distinct signed Formula ids share one machinery fingerprint', () => {
  // Same id across versioned directories is normal and expected: a component
  // that evolved, or two published versions of one product. Two DIFFERENT ids
  // over one machine is the thing that must not ship.
  const byPrint = new Map<string, Map<string, string>>()
  for (const formula of SIGNED_FORMULAS) {
    if (!byPrint.has(formula.print.digest)) byPrint.set(formula.print.digest, new Map())
    byPrint.get(formula.print.digest)!.set(formula.id, formula.path)
  }

  const collisions = [...byPrint.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([digest, ids]) => `${digest}: ${[...ids.keys()].sort().join(' == ')}`)
    .sort()

  assert.deepEqual(
    collisions,
    [],
    'these signed Formulas are the same Formula under different ids — the second would be sold over content already bought',
  )
})

test('Hidden Mechanics of History is already cut over, and Archival Ledger is where it went', () => {
  // The measurement that refused the 2026-08-28 authoring request, kept
  // executable. If this ever stops holding, the discard reason has expired and
  // the question genuinely reopens — but it reopens with evidence, not with a
  // fresh assumption that the component is missing.
  const builtin = BUILTIN_FORMULAS.find(entry => entry.name === 'hidden-mechanics-history.json')
  assert.ok(builtin, 'the hidden-mechanics-history built-in Formula went missing')

  const twins = SIGNED_FORMULAS.filter(formula => formula.print.digest === builtin!.print.digest)
  const twinIds = [...new Set(twins.map(formula => formula.id))].sort()
  assert.deepEqual(
    twinIds,
    ['com.storystudio.formula.archival-ledger'],
    'the built-in Hidden Mechanics machinery must resolve to exactly one signed identity',
  )
})

test('the built-in Hidden Mechanics Formula is the only one with a signed twin', () => {
  // Not a rule that every built-in must stay untwinned — cutovers are expected,
  // and this list is meant to grow. It is a tripwire: a NEW entry here is either
  // a deliberate cutover (update the list, in the same commit that authored it)
  // or a copy of content that already sells. Both deserve a human reading it.
  const signedPrints = new Set(SIGNED_FORMULAS.map(formula => formula.print.digest))
  const twinned = BUILTIN_FORMULAS
    .filter(entry => entry.print.fieldCount >= MACHINERY_FLOOR && signedPrints.has(entry.print.digest))
    .map(entry => entry.name)
  assert.deepEqual(
    twinned,
    ['hidden-mechanics-history.json'],
    'a built-in Formula gained a signed twin — confirm it is a cutover and not a second sale, then update this list',
  )
})

test('the project-pin migration table agrees on that signed identity', () => {
  // `HIDDEN_MECHANICS_MIGRATION_TARGETS` is module-private on purpose, so this
  // reads the source rather than forcing an export just to be asserted on. The
  // point is only that the mapping and the measured twin above name one id
  // between them; nothing here should be the reason that table becomes public.
  const source = readFileSync(join(SERVER_ROOT, 'content-packs', 'project-pins.ts'), 'utf8')
  const table = source.slice(source.indexOf('const HIDDEN_MECHANICS_MIGRATION_TARGETS'))
  const formulaBlock = table.slice(0, table.indexOf('topics:'))
  assert.match(formulaBlock, /from:\s*'hidden-mechanics-history'/, 'the migration table no longer starts at the legacy id')
  assert.match(
    formulaBlock,
    /to:\s*'com\.storystudio\.formula\.archival-ledger'/,
    'the migration table and the measured signed twin must name the same component',
  )
})

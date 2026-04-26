/**
 * Tests for the pattern CRUD layer added in pattern-loader.ts:
 * saveUserPattern, deleteUserPattern, isBuiltinPatternId,
 * checkPatternShape — plus the prompt-extraction parser.
 *
 * Coverage targets:
 *   - shape validation catches every required-field gap
 *   - saveUserPattern writes to ${PROJECTS_ROOT}/.patterns and refuses
 *     to overwrite without the explicit flag
 *   - saveUserPattern refuses built-in id collisions unless caller
 *     opts in via allowShadowBuiltin
 *   - deleteUserPattern rejects built-ins and missing ids with
 *     distinguishable error messages
 *   - LLM extraction parser strips fences + handles bare JSON
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pl: typeof import('../services/pattern-loader.js')
let pm: typeof import('../services/project-manager.js')
let promptMod: typeof import('../lib/pattern-extraction-prompt.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

// Minimum-viable valid pattern. Used as a base for shape tests so each
// case only needs to mutate the specific field under test.
const VALID = {
  id: 'test-pattern',
  name: 'Test Pattern {X}',
  description: 'A pattern for testing.',
  builtin: false,
  schemaVersion: 1,
  titleTemplate: 'Test {X}',
  subjectLabel: 'Subject',
  pov: 'second',
  openingDevice: 'Open with a hook.',
  closingDevice: 'Close with a fade.',
}

// Single top-level describe so node:test serialises the before/after
// hooks. Two top-level describes would race on STORY_STUDIO_DATA_DIR
// (a module-global env var) and node:test would cancel one branch
// when the other's setup mutates the env mid-run.
describe('pattern-loader (CRUD + shape + extract)', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    pl = await import('../services/pattern-loader.js')
    promptMod = await import('../lib/pattern-extraction-prompt.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    pl._clearPatternCaches()
  })

  // ── Shape validation ────────────────────────────────────────────────

  test('valid minimal pattern → ok', () => {
    const r = pl.checkPatternShape(VALID)
    assert.equal(r.ok, true)
  })

  test('missing id → reports id', () => {
    const r = pl.checkPatternShape({ ...VALID, id: '' })
    assert.equal(r.ok, false)
    assert.ok((r as any).missing.includes('id'))
  })

  test('id with leading hyphen → fails slug rule', () => {
    // Uppercase letters ARE allowed in pattern ids (built-ins use the
    // `-X` suffix to mirror the {X} placeholder convention). The slug
    // rule rejects leading/trailing hyphens + non-alphanumeric chars.
    const r = pl.checkPatternShape({ ...VALID, id: '-bad-id' })
    assert.equal(r.ok, false)
    const missing = (r as any).missing as string[]
    assert.ok(missing.some(m => m.startsWith('id ')), 'slug rule message present')
  })

  test('id with uppercase X (built-in convention) → ok', () => {
    const r = pl.checkPatternShape({ ...VALID, id: 'fall-asleep-to-X' })
    assert.equal(r.ok, true)
  })

  test('titleTemplate without {X} → flagged', () => {
    const r = pl.checkPatternShape({ ...VALID, titleTemplate: 'No placeholder here' })
    assert.equal(r.ok, false)
    const missing = (r as any).missing as string[]
    assert.ok(missing.some(m => m.includes('{X}')))
  })

  test('schemaVersion not 1 → flagged', () => {
    const r = pl.checkPatternShape({ ...VALID, schemaVersion: 2 })
    assert.equal(r.ok, false)
  })

  test('pov outside enum → flagged', () => {
    const r = pl.checkPatternShape({ ...VALID, pov: 'fourth' })
    assert.equal(r.ok, false)
  })

  test('bodyStructure with non-string element → flagged', () => {
    const r = pl.checkPatternShape({ ...VALID, bodyStructure: ['ok', 42] })
    assert.equal(r.ok, false)
  })

  test('preferredFormats wrong type → flagged', () => {
    const r = pl.checkPatternShape({ ...VALID, preferredFormats: 'sleep-story' })
    assert.equal(r.ok, false)
  })

  test('suggestedLengthMinutes wrong shape → flagged', () => {
    const r = pl.checkPatternShape({ ...VALID, suggestedLengthMinutes: [30] })
    assert.equal(r.ok, false)
  })

  // ── saveUserPattern + deleteUserPattern ─────────────────────────────

  test('saves a fresh user pattern at .patterns/<id>.json', async () => {
    const saved = await pl.saveUserPattern({ ...VALID, id: 'fresh-pattern' })
    assert.equal(saved.id, 'fresh-pattern')
    assert.equal(saved.builtin, false)
    assert.equal(saved.schemaVersion, 1)
    const filePath = path.join(pm.PROJECTS_ROOT, '.patterns', 'fresh-pattern.json')
    assert.ok(existsSync(filePath), 'file written to disk')
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    assert.equal(onDisk.titleTemplate, 'Test {X}')
  })

  test('listPatterns picks up the new user pattern', async () => {
    await pl.saveUserPattern({ ...VALID, id: 'listed-pattern' })
    const all = await pl.listPatterns()
    const found = all.find(p => p.id === 'listed-pattern')
    assert.ok(found, 'pattern surfaces via listPatterns')
  })

  test('refuses to overwrite an existing user pattern without overwrite flag', async () => {
    await pl.saveUserPattern({ ...VALID, id: 'collide' })
    await assert.rejects(
      () => pl.saveUserPattern({ ...VALID, id: 'collide', name: 'Renamed {X}' }),
      /already exists/,
    )
  })

  test('overwrite:true replaces the file', async () => {
    await pl.saveUserPattern({ ...VALID, id: 'collide-2', name: 'Original {X}' })
    const updated = await pl.saveUserPattern(
      { ...VALID, id: 'collide-2', name: 'Updated {X}' },
      { overwrite: true },
    )
    assert.equal(updated.name, 'Updated {X}')
    const reloaded = await pl.loadPattern('collide-2')
    assert.equal(reloaded?.name, 'Updated {X}')
  })

  test('refuses built-in id collision unless allowShadowBuiltin', async () => {
    // fall-asleep-to-X is a known built-in (electron/server/patterns/).
    await assert.rejects(
      () => pl.saveUserPattern({ ...VALID, id: 'fall-asleep-to-X' }),
      /matches a built-in/,
    )
  })

  test('allowShadowBuiltin lets the user shadow a built-in', async () => {
    const saved = await pl.saveUserPattern(
      { ...VALID, id: 'fall-asleep-to-X', name: 'My override {X}' },
      { allowShadowBuiltin: true },
    )
    assert.equal(saved.name, 'My override {X}')
    // loadPattern prefers user dir → user override wins.
    const loaded = await pl.loadPattern('fall-asleep-to-X')
    assert.equal(loaded?.name, 'My override {X}')
  })

  test('rejects invalid input via checkPatternShape', async () => {
    await assert.rejects(
      () => pl.saveUserPattern({ ...VALID, titleTemplate: 'no placeholder' }),
      /Cannot save pattern/,
    )
  })

  test('deleteUserPattern removes the file + invalidates cache', async () => {
    await pl.saveUserPattern({ ...VALID, id: 'to-delete' })
    const r = await pl.deleteUserPattern('to-delete')
    assert.ok(r.deletedPath.endsWith('to-delete.json'))
    const reloaded = await pl.loadPattern('to-delete')
    assert.equal(reloaded, null, 'cache invalidated → loadPattern misses')
  })

  test('deleteUserPattern rejects built-ins with a clear message', async () => {
    await assert.rejects(
      () => pl.deleteUserPattern('fall-asleep-to-X'),
      /built-in and cannot be deleted/,
    )
  })

  test('deleteUserPattern reports missing-not-found distinctly from built-in', async () => {
    await assert.rejects(
      () => pl.deleteUserPattern('does-not-exist-anywhere'),
      /not found/,
    )
  })

  test('isBuiltinPatternId correctly identifies built-in vs custom', async () => {
    assert.equal(pl.isBuiltinPatternId('fall-asleep-to-X'), true)
    assert.equal(pl.isBuiltinPatternId('made-up-id'), false)
    await pl.saveUserPattern({ ...VALID, id: 'user-only-id' })
    // Custom-only ids are NOT considered built-in (the function checks
    // the bundled patterns dir specifically, not user dir).
    assert.equal(pl.isBuiltinPatternId('user-only-id'), false)
  })

  // ── parseExtractedPatternJson ───────────────────────────────────────

  test('parses bare JSON', () => {
    const r = promptMod.parseExtractedPatternJson('{"id":"x","name":"y {X}"}')
    assert.deepEqual(r, { id: 'x', name: 'y {X}' })
  })

  test('strips ```json fences', () => {
    const raw = '```json\n{"id":"fenced","schemaVersion":1}\n```'
    const r = promptMod.parseExtractedPatternJson(raw) as any
    assert.equal(r.id, 'fenced')
  })

  test('strips bare ``` fences', () => {
    const raw = '```\n{"id":"plain"}\n```'
    const r = promptMod.parseExtractedPatternJson(raw) as any
    assert.equal(r.id, 'plain')
  })

  test('strips leading commentary before the JSON object', () => {
    const raw = 'Sure! Here is your pattern:\n\n{"id":"after-text"}'
    const r = promptMod.parseExtractedPatternJson(raw) as any
    assert.equal(r.id, 'after-text')
  })

  test('throws when no JSON object is present', () => {
    assert.throws(
      () => promptMod.parseExtractedPatternJson('I cannot help with that, sorry.'),
      /No JSON object found/,
    )
  })

  // ── buildPatternExtractionPrompt ────────────────────────────────────

  test('embeds the user-supplied desired name verbatim', () => {
    const p = promptMod.buildPatternExtractionPrompt({
      samples: ['some script text'],
      desiredName: 'History of {X} explained',
    })
    assert.ok(p.includes('History of {X} explained'), 'name appears in prompt')
  })

  test('embeds known format ids when provided', () => {
    const p = promptMod.buildPatternExtractionPrompt({
      samples: ['x'],
      knownFormatIds: ['sleep-story', 'comedy', 'documentary'],
    })
    assert.ok(p.includes('sleep-story, comedy, documentary'),
      'format ids passed to the prompt')
  })

  test('falls back to inline format hints when knownFormatIds empty', () => {
    const p = promptMod.buildPatternExtractionPrompt({ samples: ['x'] })
    assert.ok(p.includes('sleep-story') || p.includes('documentary'),
      'fallback format hints embedded')
  })

  test('truncates oversized samples (anti-blowup)', () => {
    const huge = 'x'.repeat(50000)
    const p = promptMod.buildPatternExtractionPrompt({ samples: [huge] })
    // Each sample is capped at 12000 chars; total prompt should be way
    // below the original 50k.
    assert.ok(p.length < 25000, `prompt should truncate; got ${p.length} chars`)
  })
})

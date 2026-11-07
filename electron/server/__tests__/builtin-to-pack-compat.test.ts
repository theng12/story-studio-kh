/**
 * Built-in → compatible pack, proved statically (owner-approved conversion).
 *
 * The removal of the file-backed legacy fallback is gated on this proof: every
 * stored legacy id must have a compatible pack answer before the built-in
 * source goes away. Nothing here rewrites stored data — it reads the identity
 * table (`content-packs/legacy-migration-dispositions.json`), the executable
 * alias map (`LEGACY_FORMULA_ALIASES`), and the pack sources on disk, and
 * requires the three to agree for all 24 niche entries (18 authored + 6
 * absorbed) and all 24 subtitle entries.
 *
 * Also pins the AGENTS §5 decided exception: `electron/server/niches/sleep.json`
 * keeps the SLEEP starting-rhythm seed, byte-equal to the sleep Formula pack,
 * so a packaged app can seed a new sleep channel without the pack being
 * installed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { LEGACY_FORMULA_ALIASES, resolveFormulaAlias } from '../services/niche-loader.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const ledger = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'content-packs', 'legacy-migration-dispositions.json'), 'utf8'),
) as {
  dispositions: Array<{
    legacy_key: string
    disposition: string
    source: string
    target: { kind: string; id?: string; pack_id?: string; version?: string; status?: string; source_path?: string }
  }>
}

const nicheEntries = ledger.dispositions.filter(entry => entry.legacy_key.startsWith('niche:'))
const subtitleEntries = ledger.dispositions.filter(entry => entry.legacy_key.startsWith('subtitle:'))

/** The `id` of the series-formula document inside a pack source tree. */
function formulaDocId(packSourcePath: string): string | null {
  const base = path.join(ROOT, packSourcePath)
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()!
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name)
      if (name.isDirectory()) stack.push(full)
      else if (name.name.endsWith('.json')) {
        try {
          const doc = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (doc && doc.kind === 'series-formula' && typeof doc.id === 'string') return doc.id
        } catch { /* one bad sidecar must not hide the pack */ }
      }
    }
  }
  return null
}

test('all 24 niche ledger entries: alias, pack source and document id agree', () => {
  assert.equal(nicheEntries.length, 24, 'the niche ledger has one entry per shipped built-in niche')
  let authored = 0
  let absorbed = 0
  for (const entry of nicheEntries) {
    const legacyId = entry.legacy_key.slice('niche:'.length)
    assert.ok(fs.existsSync(path.join(ROOT, entry.source)), `${entry.source} is on disk`)
    assert.equal(entry.target.kind, 'registry-record', `${legacyId} targets a registry pack`)
    assert.equal(entry.target.status, 'authored', `${legacyId} pack is authored`)
    assert.ok(entry.target.source_path, `${legacyId} names its pack source`)
    assert.ok(
      fs.existsSync(path.join(ROOT, entry.target.source_path!, 'pack.json')),
      `${entry.target.source_path} pack.json is on disk`,
    )
    if (entry.disposition === 'authored-standalone') authored++
    else if (entry.disposition === 'absorbed') absorbed++
    else assert.fail(`${legacyId} has unexpected disposition ${entry.disposition}`)

    const alias = LEGACY_FORMULA_ALIASES[legacyId]
    assert.ok(alias, `${legacyId} keeps its read-time alias`)
    assert.equal(resolveFormulaAlias(legacyId), alias, `${legacyId} resolves through the alias map`)
    assert.equal(
      formulaDocId(entry.target.source_path!),
      alias,
      `${legacyId} alias '${alias}' is the formula document id inside ${entry.target.source_path}`,
    )
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, entry.target.source_path!, 'pack.json'), 'utf8'))
    assert.equal(manifest.pack_id, entry.target.pack_id, `${legacyId} pack_id matches the ledger`)
    assert.equal(manifest.version, entry.target.version, `${legacyId} version matches the ledger`)
  }
  assert.equal(authored, 18, 'eighteen niches authored their own pack')
  assert.equal(absorbed, 6, 'six niches were absorbed into a shared pack')
})

test('every alias in the map — including the three adopted forks — resolves to a pack on disk', () => {
  const packSources = [
    ...new Set([
      ...nicheEntries.map(entry => entry.target.source_path!),
      // The three owner forks adopted as store packs carry no legacy-key entry.
      'content-packs/illustrated-history/formula/a-world-before-us',
      'content-packs/free-starters/formula/coffee-jazz-ambient',
      'content-packs/free-starters/formula/wildlife-under-pressure',
    ]),
  ]
  const resolved = new Set(packSources.map(source => formulaDocId(source)).filter((id): id is string => id !== null))
  const targets = [...new Set(Object.values(LEGACY_FORMULA_ALIASES))]
  // 24 niche keys + 2 adopted user forks + the Khmer owner Formula; several
  // legacy ids deliberately share one target, so unique targets are fewer.
  assert.ok(Object.keys(LEGACY_FORMULA_ALIASES).length >= 27, 'the alias map keeps every legacy id')
  assert.ok(targets.length >= 19, `expected at least 19 distinct pack targets, got ${targets.length}`)
  for (const target of targets) {
    assert.ok(resolved.has(target), `alias target '${target}' is the formula document of a pack on disk`)
  }
})

test('AGENTS §5 sleep seed exception: sleep.json keeps the pack-identical starting rhythm', () => {
  const sleepPath = path.join(ROOT, 'electron', 'server', 'niches', 'sleep.json')
  assert.ok(fs.existsSync(sleepPath), 'sleep.json stays shipped — the decided seed exception, never blanket-deleted')
  const sleep = JSON.parse(fs.readFileSync(sleepPath, 'utf8'))
  assert.ok(sleep.startingScenePacing, 'the SLEEP four-tier starting rhythm is present')
  const pack = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'content-packs/free-starters/formula/sleep-story-v1.0.3/content/series-formula.json'),
    'utf8',
  ))
  assert.deepEqual(
    sleep.startingScenePacing,
    pack.starting_scene_pacing,
    'the built-in seed is byte-equal to the sleep Formula pack, so seeding does not depend on the pack being installed',
  )
})

test('all 24 subtitle ledger entries target their authored pack, style deep-equal to the shipped preset', () => {
  assert.equal(subtitleEntries.length, 24)
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content-packs', 'authoring-registry.json'), 'utf8'),
  ) as { records: Array<{ pack_id: string; version: string; status: string; source_path: string }> }
  const presetById = new Map(BUILT_IN_SUBTITLE_PRESETS.map(preset => [preset.id, preset]))
  assert.equal(presetById.size, 24, 'the shipped gallery carries twenty-four built-in looks')

  for (const entry of subtitleEntries) {
    const id = entry.legacy_key.slice('subtitle:'.length)
    assert.equal(entry.target.kind, 'registry-record', `${id} now points at its pack`)
    assert.equal(entry.target.status, 'authored', `${id} pack is authored`)
    const record = registry.records.find(
      candidate => candidate.pack_id === entry.target.pack_id && candidate.version === entry.target.version,
    )
    assert.ok(record, `${id} has an authoring-registry record`)
    assert.equal(record!.source_path, entry.target.source_path, `${id} registry source_path matches the ledger`)
    assert.ok(fs.existsSync(path.join(ROOT, entry.target.source_path!, 'pack.json')), `${id} pack.json on disk`)

    const preset = presetById.get(id)
    assert.ok(preset, `${id} is a shipped built-in preset`)
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, entry.target.source_path!, 'content', `${id}.json`), 'utf8'))
    assert.equal(doc.kind, 'subtitle-style', `${id} pack document kind`)
    assert.equal(doc.id, `com.storystudio.subtitle-style.${id}`, `${id} pack document id`)
    assert.deepEqual(doc.style, preset.style, `${id} pack style is deep-equal to the shipped preset`)
  }
})

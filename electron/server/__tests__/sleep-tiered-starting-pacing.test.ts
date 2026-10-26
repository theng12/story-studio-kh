/**
 * The tiered Sleep rhythm (owner decision, 2026-10-26): every Sleep channel
 * starts episodes on 5–10 s scenes for 0–3 minutes, 10–20 s from 3–5 minutes,
 * 20–30 s from 5–10 minutes, and 50–60 s from 10 minutes on. It is a STARTING
 * value: a channel copies it at creation, an episode that saves its own rhythm
 * keeps it, and no stored channel or episode is rewritten.
 *
 * The tiers live in data — the built-in `sleep` Formula and every Sleep-family
 * Store Formula — and travel through the existing `variable` pacing shape, the
 * same one Scene Plan's Visual timing & motion panel writes. This file pins the
 * data on both sides and the moment each tier takes over.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { pacingBandAt, parseScenePacing } from '../contracts/pacing.js'
import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { parseContentPackDocument } from '../content-packs/schemas.js'
import { startingDefaultsFromFormula } from '../services/formula-starting-defaults.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readJson = async (rel: string) => JSON.parse(await fs.readFile(path.join(root, rel), 'utf-8'))

const SLEEP_FORMULAS = [
  'content-packs/free-starters/formula/sleep-story-v1.0.3/content/series-formula.json',
  'content-packs/sleep-history/formula/sleep-history-compilation-v1.0.2/content/series-formula.json',
  'content-packs/free-starters/formula/calm-science-for-sleep-v1.0.1/content/series-formula.json',
  'content-packs/free-starters/formula/mythology-for-sleep-v1.0.1/content/series-formula.json',
  'content-packs/illustrated-history/formula/illustrated-history-for-sleep-v1.0.1/content/series-formula.json',
]

/** The owner's four tiers, in the existing variable-periods shape. */
const TIERS = {
  mode: 'variable',
  min_sec: 5,
  max_sec: 10,
  periods: [
    { start_sec: 0, end_sec: 180, min_sec: 5, max_sec: 10 },
    { start_sec: 180, end_sec: 300, min_sec: 10, max_sec: 20 },
    { start_sec: 300, end_sec: 600, min_sec: 20, max_sec: 30 },
    { start_sec: 600, end_sec: null, min_sec: 50, max_sec: 60 },
  ],
} as const

describe('the tiered Sleep starting rhythm', () => {
  test('every Sleep Formula resolves to the same four tiers', async () => {
    const legacy = startingDefaultsFromFormula(await readJson('electron/server/niches/sleep.json'))
    assert.deepEqual(legacy.default_scene_pacing, TIERS, 'the built-in sleep Formula')

    for (const rel of SLEEP_FORMULAS) {
      const document = parseContentPackDocument('series-formula', await readJson(rel))
      assert.equal(document.kind, 'series-formula', rel)
      if (document.kind !== 'series-formula') throw new Error(`${rel} is not a series formula`)
      const niche = contentPackDocumentToNiche(document)
      const defaults = startingDefaultsFromFormula(niche)
      assert.deepEqual(defaults.default_scene_pacing, TIERS, rel)
      // The pack no longer states one band beside the tiers: one statement only.
      assert.equal(document.starting_scene_seconds, undefined, `${rel} keeps a second band`)
    }
  })

  test('each tier takes over exactly at its minute mark', async () => {
    const pacing = parseScenePacing(TIERS)
    assert.equal(pacing.mode, 'variable')
    const bandAt = (second: number) => pacingBandAt(pacing, second)
    // 0–3 min: a new scene every 5–10 s.
    assert.deepEqual(bandAt(0), { min_sec: 5, max_sec: 10 }, 'the first second')
    assert.deepEqual(bandAt(179), { min_sec: 5, max_sec: 10 }, 'one second before 3 min')
    assert.deepEqual(bandAt(179.9), { min_sec: 5, max_sec: 10 }, 'the last moment of the first tier')
    // 3–5 min: every 10–20 s.
    assert.deepEqual(bandAt(180), { min_sec: 10, max_sec: 20 }, 'exactly 3 min')
    assert.deepEqual(bandAt(299.9), { min_sec: 10, max_sec: 20 }, 'the last moment of the second tier')
    // 5–10 min: every 20–30 s.
    assert.deepEqual(bandAt(300), { min_sec: 20, max_sec: 30 }, 'exactly 5 min')
    assert.deepEqual(bandAt(599.9), { min_sec: 20, max_sec: 30 }, 'the last moment of the third tier')
    // From 10 min on: every 50–60 s, to the end of any episode length.
    assert.deepEqual(bandAt(600), { min_sec: 50, max_sec: 60 }, 'exactly 10 min')
    assert.deepEqual(bandAt(3_600), { min_sec: 50, max_sec: 60 }, 'one hour')
    assert.deepEqual(bandAt(4 * 3_600), { min_sec: 50, max_sec: 60 }, 'a four-hour sleep mix')
  })

  test('the tiers are contiguous, open-ended and inside the pacing contract', async () => {
    const pacing = parseScenePacing(TIERS)
    assert.equal(pacing.mode, 'variable')
    const periods = pacing.mode === 'variable' ? pacing.periods : []
    assert.equal(periods.length, 4)
    assert.equal(periods[0]!.start_sec, 0)
    for (let index = 1; index < periods.length; index++) {
      assert.equal(periods[index]!.start_sec, periods[index - 1]!.end_sec, `tier ${index} starts where the previous ended`)
    }
    assert.equal(periods.at(-1)!.end_sec, null, 'the last tier runs to the end of the episode')
    for (const period of periods) {
      assert.ok(period.min_sec >= 1 && period.max_sec <= 60, 'the contract caps a scene at 60 s')
      assert.ok(period.max_sec >= period.min_sec)
    }
    // Slow down as the episode lengthens: a longer episode never cuts faster.
    for (let index = 1; index < periods.length; index++) {
      assert.ok(periods[index]!.min_sec >= periods[index - 1]!.min_sec, `tier ${index} is not slower than the one before`)
    }
  })

  test('a channel keeps the Owner standard tiers only when its Formula has none', async () => {
    // The 2026-10-19 owner standard is still what a Formula-less channel gets;
    // Sleep is the more specific choice and does not replace it.
    const noFormula = startingDefaultsFromFormula({} as any)
    assert.deepEqual(noFormula, {})
  })
})

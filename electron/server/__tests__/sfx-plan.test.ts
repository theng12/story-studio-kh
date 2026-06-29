/**
 * Tests for the SFX plan sidecar store (services/sfx-plan.ts).
 *
 * Safety-critical coverage (the sound layer is opt-in + reversible):
 *   - normalizePlan never throws and coerces garbage to a safe plan
 *   - a missing/corrupt sidecar reads as null (render unaffected)
 *   - planAffectsRender is false unless enabled AND a cue is resolved+live
 *   - round-trip write→read preserves a valid plan
 *   - delete removes the sidecar (reverts to no-SFX behaviour)
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  emptyPlan,
  normalizePlan,
  planAffectsRender,
  isCueLive,
  readPlanAt,
  writePlanAt,
  deletePlanAt,
  type SfxPlan,
} from '../services/sfx-plan.js'

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfx-plan-'))
  return path.join(dir, 'sfx_plan.json')
}

describe('normalizePlan — defensive', () => {
  test('garbage coerces to an empty, disabled plan (never throws)', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { schema_version: 9 }]) {
      const p = normalizePlan(junk as any)
      assert.equal(p.schema_version, 1)
      assert.equal(p.enabled, false)
      assert.deepEqual(p.beds, [])
      assert.deepEqual(p.spots, [])
    }
  })

  test('partial cues get defaults; bad numbers fall back; gains clamp', () => {
    const p = normalizePlan({
      enabled: true,
      beds: [{ label: 'rain', start_sec: 'x', end_sec: 5, gain_db: -999 }],
      spots: [{ label: 'whoosh', at_sec: 2.5, gain_db: 999, source: 'bogus' }, 'not-an-object'],
    })
    assert.equal(p.enabled, true)
    assert.equal(p.beds.length, 1)
    assert.equal(p.beds[0]!.start_sec, 0) // 'x' → 0
    assert.equal(p.beds[0]!.end_sec, 5)
    assert.equal(p.beds[0]!.gain_db, -60) // clamped floor
    assert.equal(p.beds[0]!.source, '') // unknown → unresolved
    assert.equal(p.spots.length, 1) // the string was dropped
    assert.equal(p.spots[0]!.gain_db, 12) // clamped ceiling
    assert.equal(p.spots[0]!.source, '') // 'bogus' → ''
  })

  test('end_sec is never before start_sec', () => {
    const p = normalizePlan({ enabled: true, beds: [{ label: 'x', start_sec: 10, end_sec: 2 }] })
    assert.ok(p.beds[0]!.end_sec >= p.beds[0]!.start_sec)
  })

  test('beds + spots come out time-ordered', () => {
    const p = normalizePlan({
      enabled: true,
      beds: [{ label: 'b', start_sec: 9, end_sec: 10 }, { label: 'a', start_sec: 1, end_sec: 2 }],
      spots: [{ label: 'late', at_sec: 8 }, { label: 'early', at_sec: 1 }],
    })
    assert.deepEqual(p.beds.map(b => b.label), ['a', 'b'])
    assert.deepEqual(p.spots.map(s => s.label), ['early', 'late'])
  })
})

describe('planAffectsRender — the opt-in gate', () => {
  test('empty plan does not affect render', () => {
    assert.equal(planAffectsRender(emptyPlan()), false)
    assert.equal(planAffectsRender(null), false)
    assert.equal(planAffectsRender(undefined), false)
  })

  test('enabled but with only unresolved/muted cues does not affect render', () => {
    const p = normalizePlan({
      enabled: true,
      beds: [{ label: 'rain', start_sec: 0, end_sec: 5 }], // no clip/source → unresolved
      spots: [{ label: 'x', at_sec: 1, source: 'pool', clip: 'a.mp3', status: 'muted' }],
    })
    assert.equal(planAffectsRender(p), false)
  })

  test('resolved+live cue while enabled DOES affect render; disabled never does', () => {
    const live: SfxPlan = normalizePlan({
      enabled: true,
      spots: [{ label: 'door', at_sec: 12.4, source: 'pool', clip: 'door.mp3', status: 'matched' }],
    })
    assert.equal(planAffectsRender(live), true)
    assert.equal(isCueLive(live.spots[0]!), true)

    const disabled = { ...live, enabled: false }
    assert.equal(planAffectsRender(disabled), false) // master toggle wins
  })
})

describe('sidecar I/O', () => {
  test('missing file reads as null', async () => {
    const f = await tmpFile()
    assert.equal(await readPlanAt(f), null)
  })

  test('corrupt JSON reads as null (never throws)', async () => {
    const f = await tmpFile()
    await fs.writeFile(f, '{ this is not json', 'utf-8')
    assert.equal(await readPlanAt(f), null)
  })

  test('round-trip write→read preserves a valid plan (normalized)', async () => {
    const f = await tmpFile()
    const plan: SfxPlan = normalizePlan({
      enabled: true,
      beds: [{ label: 'city night', start_sec: 0, end_sec: 30, source: 'pool', clip: 'city.mp3', gain_db: -20, status: 'matched' }],
      spots: [{ label: 'door', at_sec: 12.4, source: 'freesound', clip: 'door.mp3', gain_db: -12, status: 'matched' }],
    })
    await writePlanAt(f, plan)
    assert.ok(existsSync(f))
    const back = await readPlanAt(f)
    assert.deepEqual(back, plan)
  })

  test('delete removes the sidecar', async () => {
    const f = await tmpFile()
    await writePlanAt(f, emptyPlan())
    assert.ok(existsSync(f))
    await deletePlanAt(f)
    assert.equal(existsSync(f), false)
    // deleting a missing file is a no-op (reversibility helper must be safe)
    await deletePlanAt(f)
  })
})

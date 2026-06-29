/**
 * Tests for the scripted-broll plan sidecar (services/broll-plan.ts).
 * Safety: normalize never throws; opt-in gate; round-trip; reversible delete.
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
  planDrivesAssembly,
  isBeatLive,
  readPlanAt,
  writePlanAt,
  deletePlanAt,
  type BrollPlan,
} from '../services/broll-plan.js'

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'broll-plan-'))
  return path.join(dir, 'broll_plan.json')
}

describe('normalizePlan — defensive', () => {
  test('garbage → empty disabled plan', () => {
    for (const junk of [null, undefined, 7, 'x', []]) {
      const p = normalizePlan(junk as any)
      assert.equal(p.enabled, false)
      assert.deepEqual(p.beats, [])
      assert.equal(p.broll_style, '')
    }
  })
  test('beats normalize: queries cleaned, end≥start, time-ordered', () => {
    const p = normalizePlan({
      enabled: true,
      beats: [
        { start_sec: 9, end_sec: 4, line: 'b', queries: [' x ', '', 3, 'y'] },
        { start_sec: 0, end_sec: 4, line: 'a', queries: 'nope' },
      ],
    })
    assert.deepEqual(p.beats.map(b => b.line), ['a', 'b'])
    assert.ok(p.beats[1]!.end_sec >= p.beats[1]!.start_sec)
    assert.deepEqual(p.beats[1]!.queries, ['x', 'y'])
    assert.deepEqual(p.beats[0]!.queries, []) // non-array → []
  })
})

describe('planDrivesAssembly — opt-in gate', () => {
  test('empty / disabled / unresolved → false', () => {
    assert.equal(planDrivesAssembly(emptyPlan()), false)
    assert.equal(planDrivesAssembly(null), false)
    const proposed = normalizePlan({ enabled: true, beats: [{ start_sec: 0, end_sec: 4, line: 'a', queries: ['x'] }] })
    assert.equal(planDrivesAssembly(proposed), false) // no clip yet
  })
  test('enabled + resolved beat → true; disabled wins', () => {
    const live = normalizePlan({
      enabled: true,
      beats: [{ start_sec: 0, end_sec: 4, line: 'a', queries: ['x'], source: 'pexels', clip: 'c.mp4', status: 'matched' }],
    })
    assert.equal(planDrivesAssembly(live), true)
    assert.equal(isBeatLive(live.beats[0]!), true)
    assert.equal(planDrivesAssembly({ ...live, enabled: false }), false)
  })
})

describe('sidecar I/O', () => {
  test('missing → null; corrupt → null', async () => {
    const f = await tmpFile()
    assert.equal(await readPlanAt(f), null)
    await fs.writeFile(f, '{bad', 'utf-8')
    assert.equal(await readPlanAt(f), null)
  })
  test('round-trip preserves normalized plan', async () => {
    const f = await tmpFile()
    const plan: BrollPlan = normalizePlan({
      enabled: true,
      broll_style: 'flat editorial illustration',
      beats: [{ start_sec: 0, end_sec: 4.2, line: 'gas', queries: ['gas station'], source: 'pexels', clip: 'g.mp4', in_point_sec: 1, status: 'matched' }],
    })
    await writePlanAt(f, plan)
    assert.deepEqual(await readPlanAt(f), plan)
  })
  test('delete reverts (and is safe to repeat)', async () => {
    const f = await tmpFile()
    await writePlanAt(f, emptyPlan())
    await deletePlanAt(f)
    assert.equal(existsSync(f), false)
    await deletePlanAt(f)
  })
})

import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { resolveScenePlanPacing, resolveScenePlanRepairPacing } from '../services/scene-plan-pacing.js'

const dirs: string[] = []

async function episodeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-pacing-'))
  dirs.push(dir)
  return dir
}

const continuityFormat = (visualPacingProfile?: unknown) => ({
  visualSource: 'continuity-chain',
  script: { visualPacingProfile },
}) as any

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('resolveScenePlanPacing', () => {
  test('uses the one canonical uniform default when no episode pacing is saved', async () => {
    const resolved = await resolveScenePlanPacing('project', await episodeDir(), continuityFormat({
      opening_duration_sec: 30,
      opening: { min_sec: 8, max_sec: 10 },
      settled: { min_sec: 12, max_sec: 20 },
    }))

    assert.deepEqual(resolved.pacing, { min_sec: 1, max_sec: 3, mode: 'live' })
  })

  test('resolves explicit legacy opening/settled pacing without changing its effective bands', async () => {
    const dir = await episodeDir()
    await fs.writeFile(path.join(dir, 'continuity.json'), JSON.stringify({
      pacing: {
        min_sec: 2,
        max_sec: 4,
        opening_duration_sec: 30,
        settled_min_sec: 8,
        settled_max_sec: 12,
      },
    }))

    const resolved = await resolveScenePlanPacing('project', dir, continuityFormat())
    assert.deepEqual(resolved.pacing, {
      min_sec: 2,
      max_sec: 4,
      mode: 'documentary',
      opening_duration_sec: 30,
      settled_min_sec: 8,
      settled_max_sec: 12,
      periods: [
        { start_sec: 0, end_sec: 30, min_sec: 2, max_sec: 4 },
        { start_sec: 30, end_sec: null, min_sec: 8, max_sec: 12 },
      ],
    })
  })

  test('returns three saved variable periods for new planning', async () => {
    const dir = await episodeDir()
    const periods = [
      { start_sec: 0, end_sec: 20, min_sec: 1, max_sec: 3 },
      { start_sec: 20, end_sec: 50, min_sec: 3, max_sec: 6 },
      { start_sec: 50, end_sec: null, min_sec: 6, max_sec: 12 },
    ]
    await fs.writeFile(path.join(dir, 'continuity.json'), JSON.stringify({
      pacing: { mode: 'variable', periods },
    }))

    const resolved = await resolveScenePlanPacing('project', dir, continuityFormat())
    assert.deepEqual(resolved.pacing, {
      min_sec: 1,
      max_sec: 3,
      mode: 'variable',
      periods,
    })
  })

  test('fails malformed explicitly saved pacing instead of silently choosing the default', async () => {
    const dir = await episodeDir()
    await fs.writeFile(path.join(dir, 'continuity.json'), JSON.stringify({
      pacing: { mode: 'variable', periods: [
        { start_sec: 0, end_sec: 10, min_sec: 1, max_sec: 3 },
        { start_sec: 12, end_sec: null, min_sec: 4, max_sec: 8 },
      ] },
    }))

    await assert.rejects(
      resolveScenePlanPacing('project', dir, continuityFormat()),
      /continuity\.json: pacing\.periods\[1\]\.start_sec must equal the previous period's end_sec \(10\)/,
    )
  })
})

describe('resolveScenePlanRepairPacing', () => {
  test('keeps the historical repair band only when episode pacing is truly absent', () => {
    assert.deepEqual(resolveScenePlanRepairPacing(undefined), { min_sec: 3, max_sec: 12 })
    assert.deepEqual(resolveScenePlanRepairPacing(undefined, JSON.stringify({ schema_version: 1 })), { min_sec: 3, max_sec: 12 })
  })

  test('strictly parses explicit legacy-plan draft pacing, including variable periods', () => {
    const pacing = { mode: 'variable', periods: [
      { start_sec: 0, end_sec: 20, min_sec: 1, max_sec: 3 },
      { start_sec: 20, end_sec: null, min_sec: 6, max_sec: 10 },
    ] }
    assert.deepEqual(resolveScenePlanRepairPacing(undefined, JSON.stringify({ pacing })), {
      pacing: { ...pacing, min_sec: 1, max_sec: 3 }, min_sec: 1, max_sec: 3,
    })
    assert.throws(
      () => resolveScenePlanRepairPacing(undefined, JSON.stringify({ pacing: { min_sec: 4 } })),
      /pacing\.max_sec must be a finite number/,
    )
  })

  test('saved plan pacing is authoritative and does not parse an unrelated malformed draft', () => {
    assert.deepEqual(resolveScenePlanRepairPacing({ mode: 'live', min_sec: 4, max_sec: 8 }, '{"pacing":'), {
      pacing: { mode: 'uniform', min_sec: 4, max_sec: 8 }, min_sec: 4, max_sec: 8,
    })
  })

  test('normalizes the explicit documentary representation saved by existing plans', () => {
    const saved = {
      mode: 'documentary', min_sec: 2, max_sec: 4,
      opening_duration_sec: 20, settled_min_sec: 6, settled_max_sec: 10,
      periods: [
        { start_sec: 0, end_sec: 20, min_sec: 2, max_sec: 4 },
        { start_sec: 20, end_sec: null, min_sec: 6, max_sec: 10 },
      ],
    }
    assert.deepEqual(resolveScenePlanRepairPacing(saved), {
      pacing: {
        mode: 'variable', min_sec: 2, max_sec: 4,
        periods: saved.periods,
        opening_duration_sec: 20, settled_min_sec: 6, settled_max_sec: 10,
      },
      min_sec: 2,
      max_sec: 4,
    })
    assert.throws(
      () => resolveScenePlanRepairPacing({
        ...saved,
        periods: [
          { start_sec: 0, end_sec: 20, min_sec: 3, max_sec: 5 },
          { start_sec: 20, end_sec: null, min_sec: 6, max_sec: 10 },
        ],
      }),
      /documentary pacing periods do not match/i,
    )
  })
})

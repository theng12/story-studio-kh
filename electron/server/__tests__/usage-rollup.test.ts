/**
 * Tests for the persistent usage rollup (services/usage-tracker.ts).
 *
 * Coverage:
 *   - empty rollup when history file missing
 *   - tracked entries persist + roll up by model / provider / day
 *   - filters out entries outside the [since, until] range
 *   - skips malformed JSONL lines without throwing
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tracker: typeof import('../services/usage-tracker.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  tmp = await useTempDataDir()
  pm = await import('../services/project-manager.js')
  tracker = await import('../services/usage-tracker.js')
  tracker._resetHistoryPathCache()
})

after(async () => {
  await tmp.cleanup()
})

beforeEach(async () => {
  await tracker._clearUsageHistory()
})

async function appendRaw(line: string): Promise<void> {
  const fp = path.join(pm.getUserDataDir(), 'usage-history.jsonl')
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await fs.appendFile(fp, line + '\n', 'utf-8')
}

describe('getUsageRollup', () => {
  test('returns empty rollup when history file missing', async () => {
    const r = await tracker.getUsageRollup()
    assert.equal(r.total_cost, 0)
    assert.equal(r.entries, 0)
    assert.deepEqual(r.by_model, {})
    assert.deepEqual(r.by_provider, {})
    assert.deepEqual(r.by_day, {})
  })

  test('tracks live entries to disk and rolls them up', async () => {
    // Two calls to claude-sonnet-4-6 + one to gpt-4o-mini
    tracker.trackUsage('claude-sonnet-4-6', 10_000, 5_000)
    tracker.trackUsage('claude-sonnet-4-6', 5_000, 2_000)
    tracker.trackUsage('gpt-4o-mini', 8_000, 4_000)
    // The disk write is fire-and-forget; flush by awaiting a microtask cycle.
    await new Promise(r => setImmediate(r))
    // And one more tick — appendFile resolves on the next tick.
    await new Promise(r => setTimeout(r, 50))

    const r = await tracker.getUsageRollup()
    assert.equal(r.entries, 3)
    assert.ok(r.total_cost > 0, 'cost should be nonzero')
    assert.ok(r.by_model['claude-sonnet-4-6'])
    assert.equal(r.by_model['claude-sonnet-4-6']!.calls, 2)
    assert.equal(r.by_model['gpt-4o-mini']!.calls, 1)
    assert.ok(r.by_provider['anthropic'])
    assert.ok(r.by_provider['openai'])
    assert.equal(r.by_provider['anthropic']!.calls, 2)
    assert.equal(r.by_provider['openai']!.calls, 1)
  })

  test('filters by [since, until] inclusive', async () => {
    // Hand-craft entries on three different days.
    const make = (model: string, day: string, cost: number) => JSON.stringify({
      model, provider: 'anthropic',
      input_tokens: 1, output_tokens: 1,
      cost,
      timestamp: `${day}T12:00:00.000Z`,
    })
    await appendRaw(make('claude-sonnet-4-6', '2026-04-01', 0.10))
    await appendRaw(make('claude-sonnet-4-6', '2026-04-15', 0.20))
    await appendRaw(make('claude-sonnet-4-6', '2026-04-30', 0.30))

    const r = await tracker.getUsageRollup({ since: '2026-04-10', until: '2026-04-20' })
    assert.equal(r.entries, 1, 'only the middle entry falls in range')
    assert.ok(Math.abs(r.total_cost - 0.20) < 0.0001)
  })

  test('skips malformed JSONL lines without throwing', async () => {
    await appendRaw(JSON.stringify({
      model: 'claude-sonnet-4-6', provider: 'anthropic',
      input_tokens: 1, output_tokens: 1, cost: 0.05,
      timestamp: new Date().toISOString(),
    }))
    await appendRaw('{ not valid json')                       // malformed
    await appendRaw('')                                       // empty line
    await appendRaw(JSON.stringify({
      model: 'gpt-4o-mini', provider: 'openai',
      input_tokens: 1, output_tokens: 1, cost: 0.02,
      timestamp: new Date().toISOString(),
    }))

    const r = await tracker.getUsageRollup()
    assert.equal(r.entries, 2, 'two valid entries survive')
    assert.equal(Object.keys(r.by_model).length, 2)
  })

  test('rolls up by_day correctly', async () => {
    const make = (day: string, cost: number) => JSON.stringify({
      model: 'claude-sonnet-4-6', provider: 'anthropic',
      input_tokens: 1, output_tokens: 1, cost,
      timestamp: `${day}T08:00:00.000Z`,
    })
    await appendRaw(make('2026-04-15', 0.10))
    await appendRaw(make('2026-04-15', 0.05))
    await appendRaw(make('2026-04-16', 0.20))

    const r = await tracker.getUsageRollup({ since: '2026-04-10', until: '2026-04-20' })
    assert.equal(r.by_day['2026-04-15']!.calls, 2)
    assert.ok(Math.abs(r.by_day['2026-04-15']!.cost - 0.15) < 0.0001)
    assert.equal(r.by_day['2026-04-16']!.calls, 1)
  })
})

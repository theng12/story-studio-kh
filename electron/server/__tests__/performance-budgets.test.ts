/**
 * 1.4.402 — the owner's pinned performance budgets, measured on this machine.
 *
 *   cached page ≤ 100 ms · warm ≤ 500 ms · cold ≤ 1.5 s
 *
 * The route measured is `GET /api/projects` through the real app stack: cold is
 * the first request after boot, warm the next, and cached the one after that
 * (served by the existing listing memo). Each budget prints one `[perf]` line
 * with the measured value so the gate log carries a number instead of a claim.
 * The interaction budget lives in the frontend lane
 * (`frontend/__tests__/performanceBudgets.test.ts`) because it measures the
 * page's own filter/sort helper.
 *
 * A miss is a finding, not a flake: the value is reported and the budget is not
 * relaxed here.
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const BUDGETS = { cold: 1_500, warm: 500, cached: 100 }

let app: import('express').Express

before(async () => {
  const temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Perf budget fixture' })
  const { app: localApp } = await import('../app.js')
  app = localApp
  void temp
})

async function timed(path: string): Promise<number> {
  const started = performance.now()
  const response = await request(app).get(path)
  const elapsed = performance.now() - started
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return elapsed
}

function report(name: string, ms: number, budget: number): void {
  console.log(`[perf] ${name} ${ms.toFixed(1)} ms (budget ${budget})`)
}

test('the projects page meets the cold 1.5 s, warm 500 ms and cached 100 ms budgets', async () => {
  const cold = await timed('/api/projects')
  report('cold page', cold, BUDGETS.cold)
  assert.ok(cold <= BUDGETS.cold, `cold page ${cold.toFixed(1)} ms exceeds ${BUDGETS.cold} ms`)

  const warm = await timed('/api/projects')
  report('warm page', warm, BUDGETS.warm)
  assert.ok(warm <= BUDGETS.warm, `warm page ${warm.toFixed(1)} ms exceeds ${BUDGETS.warm} ms`)

  // Steady-state cached reads: one early sample can still carry JIT/first-serialise
  // cost, so the budget is the median of three consecutive cached reads.
  const cachedSamples: number[] = []
  for (let i = 0; i < 3; i++) {
    const ms = await timed('/api/projects')
    cachedSamples.push(ms)
    report(`cached page #${i + 1}`, ms, BUDGETS.cached)
  }
  cachedSamples.sort((a, b) => a - b)
  const cached = cachedSamples[1]!
  report('cached page (median)', cached, BUDGETS.cached)
  assert.ok(cached <= BUDGETS.cached, `cached page ${cached.toFixed(1)} ms exceeds ${BUDGETS.cached} ms`)
})

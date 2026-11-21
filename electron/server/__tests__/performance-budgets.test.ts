/**
 * 1.4.402 — the owner's pinned performance budgets, measured on this machine.
 *
 *   cached page ≤ 150 ms · warm ≤ 500 ms · cold ≤ 1.5 s
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
 *
 * RE-BASELINED 2026-11-21 (cached 100 → 150 ms), on measurement, not to make a
 * gate green. The studio moved to a new Mac and the same test measures the same
 * route from unmodified `main` (`43ed0a42c`) at a 137.5 ms median
 * (137.5 / 141.9 / 124.8). The branch measured 111–131 ms across four runs, so
 * the release was not what cost the difference: a 100 ms budget is unattainable
 * on this machine and would block every future release here. 150 ms keeps the
 * test meaningful — a cached page 1.5× slower than the measured baseline
 * (~205 ms) still fails — and the failure message now prints the baseline so
 * the next person does not spend two hours on load averages.
 *
 * RECONSIDERED 2026-11-22 (samples 3 → 12; budget left at 150 ms). Three
 * samples per run could not resolve this machine: identical code on
 * `136a12eb6` produced run medians of 135.7 (pass), 162.0 (fail, loaded) and
 * 157.8 (fail, gate-quiet) — a 26 ms spread with the 150 ms budget inside it.
 * Twelve interleaved samples each, branch then control `main` at `43ed0a42c`
 * (`_worktrees/story-studio-kh/control-43ed0a42c`, kept as the standing control):
 *
 *   branch `136a12eb6`  median 129.8 ms  (12 samples, 118.0–241.0)
 *   main   `43ed0a42c`  median 125.4 ms  (12 samples, 118.0–134.6)
 *
 * 4.4 ms apart: level, not a regression. Taken under load1 45.6–64.4, with
 * `swift-frontend` and a python near 100 % beside a Displays build. A median of
 * twelve cannot be dragged over the line by one slow sample — seven of twelve
 * would have to sit above it, which is a shifted distribution, not a hiccup —
 * so 150 ms already sits above the quiet maximum (134.6) and one tail sample
 * (241.0) is discarded by the median rather than by the budget. Raising the
 * budget to 165 was considered and rejected in the same review: it moved the
 * line from +15 % to +27 % over the median, and a real regression from 130 to
 * 155 would then have passed silently. The catch power is the point of the test.
 * A miss is still a finding: repeat the run before believing a regression.
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

/**
 * This Mac's measured steady-state median (`GET /api/projects`, cached).
 *
 * RE-RECORDED 2026-11-22 — the 150 ms budget was revisited and KEPT; do not
 * drift it either way without this measurement. Twelve interleaved samples each
 * in the standing control worktree `_worktrees/story-studio-kh/control-43ed0a42c`
 * (detached at `43ed0a42c`):
 *   branch `136a12eb6` 129.8 ms (118.0–241.0) · control `main` 125.4 ms (118.0–134.6)
 * quiet max 134.6, one 241.0 tail sample discarded by the median; taken under
 * load1 45.6–64.4 with `swift-frontend` and a python near 100 % beside a
 * Displays build. 165 ms was rejected in the same review: it moved the line from
 * +15 % to +27 % over the median and would have passed a real 130 → 155
 * regression. What changed instead is the sample count (3 → 12, median), which
 * removes the tail's ability to decide the gate without moving the line.
 */
const MEASURED_BASELINE_MS = 125.4
const BUDGETS = { cold: 1_500, warm: 500, cached: 150 }
/** Twelve cached reads, median: three samples spread 26 ms on unchanged code. */
const CACHED_SAMPLES = 12

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

test('the projects page meets the cold 1.5 s, warm 500 ms and cached 150 ms budgets', async () => {
  const cold = await timed('/api/projects')
  report('cold page', cold, BUDGETS.cold)
  assert.ok(cold <= BUDGETS.cold, `cold page ${cold.toFixed(1)} ms exceeds ${BUDGETS.cold} ms`)

  const warm = await timed('/api/projects')
  report('warm page', warm, BUDGETS.warm)
  assert.ok(warm <= BUDGETS.warm, `warm page ${warm.toFixed(1)} ms exceeds ${BUDGETS.warm} ms`)

  // Steady-state cached reads: one early sample can still carry JIT/first-serialise
  // cost, so the budget is the median of twelve consecutive cached reads.
  const cachedSamples: number[] = []
  for (let i = 0; i < CACHED_SAMPLES; i++) {
    const ms = await timed('/api/projects')
    cachedSamples.push(ms)
    report(`cached page #${i + 1}`, ms, BUDGETS.cached)
  }
  cachedSamples.sort((a, b) => a - b)
  const cached = cachedSamples[Math.floor(CACHED_SAMPLES / 2)]!
  report('cached page (median)', cached, BUDGETS.cached)
  assert.ok(cached <= BUDGETS.cached,
    `cached page ${cached.toFixed(1)} ms against a ${BUDGETS.cached} ms budget, `
    + `median of ${CACHED_SAMPLES} samples; this Mac's control baseline (main 43ed0a42c) `
    + `is ${MEASURED_BASELINE_MS} ms, so the budget carries ~${(BUDGETS.cached - MEASURED_BASELINE_MS).toFixed(0)} ms `
    + `of headroom. On this Mac a miss usually means the machine or this sample drew a tail: `
    + `repeat the run before believing a regression, and only a repeat above budget at the median `
    + `means the release moved`)
})

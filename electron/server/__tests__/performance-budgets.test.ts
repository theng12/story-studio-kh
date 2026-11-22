/**
 * 1.4.402 — the owner's pinned performance budgets, measured on this machine.
 *
 *   cached page ≤ 176 ms · warm ≤ 500 ms · cold ≤ 1.5 s
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
 * RE-CALIBRATED 2026-11-22 (cached 150 → 176 ms; samples 3 → 12, median).
 *
 * The lesson, because it cost a night: a latency budget must be calibrated in
 * the same execution context that ENFORCES it. Every earlier calibration was
 * taken from an interactive shell; the gate runs under launchd, and that context
 * costs ~20–25 ms at the median on this Mac. Same commit, same route, same
 * minute: 117–125 ms from a shell, 141–148 ms under launchd. Three samples could
 * not resolve that either: identical code on `136a12eb6` gave run medians of
 * 135.7 (pass), 162.0 (fail, loaded) and 157.8 (fail, gate-quiet).
 *
 * DERIVATION — six gate-context runs (three per side, interleaved through
 * `gate-run.sh`, twelve samples each, branch `4074311e7` vs control `43ed0a42c`
 * in `_worktrees/story-studio-kh/control-43ed0a42c`, which carries the same
 * instrument and identical app code):
 *   run medians 154.9 · 149.7 · 154.6 · 149.3 · 159.5 · 151.2  → median 152.9
 *   +15 % headroom → 175.8 → **176 ms**
 *   branch 154.6–159.5 vs control 149.3–151.2: branch ~5 ms (3.4 %) above,
 *   inside the sample spread — level, not a regression.
 * Ambient floor those samples were taken under: `mediaanalysisd` 192–274 %, a
 * python 100–126 %, load1 10–15.
 *
 * TWO HEADROOM FIGURES, named separately:
 *   pooled isolated launchd median        143.9 ms (48 samples, 109.5–234.2)
 *   earlier gate-step medians             157.8 and 165.9 ms
 * 176 is ~6 % above the highest gate-step median. That is thin, and it is why
 * the control below exists rather than a larger number.
 *
 * STANDING CONTROL PROCEDURE — a median-of-twelve above the budget → run the
 * `43ed0a42c` control in the same conditions → control also above means the
 * machine or the harness and the number is re-examined; control below means the
 * release and nothing ships.
 *
 * This absolute number is a stopgap: the 1.4.418 backlog carries the ratio
 * design (release median against a control measured in the same run), which
 * makes the harness's execution context unable to move the line at all.
 *
 * To take a gate-context measurement, do not use a terminal:
 *   _orchestra/tools/run-detached.sh perf-probe <script>
 * runs under launchd exactly as the gate does; read the `[perf]` lines from its
 * log. A terminal-based number will look ~20 ms optimistic and calibrate wrong.
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

/**
 * This Mac's measured steady-state median (`GET /api/projects`, cached) IN THE
 * GATE CONTEXT (launchd), which is where the budget is enforced: pooled isolated
 * launchd median 143.9 ms over 48 samples (range 109.5–234.2), and gate-step
 * medians of 157.8 and 165.9 ms. The same route measures ~118–125 ms from an
 * interactive shell — a different context, and the reason the earlier 137.5 ms
 * shell baseline produced a budget the gate kept missing.
 *
 * Budget 176 ms = median of six gate-context run medians (152.9) + 15 % headroom;
 * branch ~5 ms above control, inside the spread. It is ~6 % above the highest
 * gate-step median — thin by design, which is why the standing control procedure
 * above arbitrates a red. Stopgap: 1.4.418 carries the ratio-against-control
 * design that removes the context from the question.
 * Printed beside the budget when anything fails, so a red reads as "how far from
 * the distribution this budget was calibrated to".
 */
const MEASURED_BASELINE_MS = 143.9
const BUDGETS = { cold: 1_500, warm: 500, cached: 176 }
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

test('the projects page meets the cold 1.5 s, warm 500 ms and cached 176 ms budgets', async () => {
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
    + `median of ${CACHED_SAMPLES} samples, measured in the gate's own context as the budget is; `
    + `this Mac's gate-context baseline (launchd, 48 samples) is ${MEASURED_BASELINE_MS} ms, `
    + `so the budget carries ~${(BUDGETS.cached - MEASURED_BASELINE_MS).toFixed(0)} ms of headroom. `
    + `A miss at the median of twelve is a finding: check the samples and the machine, then `
    + `compare against the control worktree at 43ed0a42c before calling it a regression`)
})

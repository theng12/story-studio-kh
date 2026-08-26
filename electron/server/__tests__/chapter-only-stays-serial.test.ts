/**
 * `chapter-only` MUST STAY A SINGLE-SLOT LANE.
 *
 * v1.4.72 merged two queue changes at once: `research_run` joined the shared
 * writing budget, and every writer of `scene_plan.json` learned to take a lock.
 * Both are safe on their own. Together they raise a fair question that had been
 * asked before and never actually answered — did anything in those edits let
 * chapter regens run in parallel too?
 *
 * They must not. Every `chapter-only` job calls `assembleUnifiedNarration`
 * (lib/narration-assembly.ts), which rebuilds ONE shared narration document for
 * the episode from every chapter file and overwrites it. That function contains
 * no mutual exclusion of any kind, so two overlapping calls interleave and the
 * later write wins wholesale — silent, and it looks like the model dropped a
 * chapter. Widening this lane is a data-loss change, not a throughput change.
 *
 * The static argument for why it is safe — `chapter-only` is in no group set,
 * so `groupOf` returns the type name and `groupLimit` falls through to 1 — has
 * been recited twice without being demonstrated. This file demonstrates it.
 *
 * IT LIVES IN ITS OWN FILE ON PURPOSE. Written as a case inside
 * `job-queue-concurrency.test.ts` it passed even with `'chapter-only'` forced
 * into `LLM_TYPES`: the shared budget still carried `groupActive` residue from
 * the thirteen tests ahead of it, so only one slot was free and the peak was 1
 * for the wrong reason. A test whose green light survives the bug it guards is
 * worse than no test. Its own file means its own module state and its own
 * budget, and the mutation genuinely turns it red.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

/** Poll until `cond` holds. Used only for "has something STARTED yet", never
 *  for "is the peak still 1" — polling for the latter is how a concurrency
 *  test passes by catching the counter on its way up. */
async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  jq.setLlmConcurrency(50)
  await cleanup()
})

test('several chapters of one episode never run at the same time', async () => {
  const proj = await pm.createProject({ name: 'CHAPTER-LANE' })

  let active = 0
  let peak = 0
  let done = 0
  const releases: Array<() => void> = []
  jq.registerExecutor('chapter-only', async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>(resolve => releases.push(resolve))
    active--
    done++
  })

  // As high as the app allows. If the lane ever joins a shared budget, this is
  // the number it would inherit — so the test fails loudly rather than subtly.
  jq.setLlmConcurrency(50)

  const queued: Job[] = []
  for (const chapter of [1, 2, 3]) {
    // Mirror routes/scripts.ts exactly: its dedupe predicate is narrowed to
    // `chapter_number`, so two clicks on ch.5 dedupe while ch.1 + ch.2 + ch.3
    // all enqueue. That narrowing is the whole reason the lane's width matters.
    queued.push(jq.enqueuePreparedForTest({
      project_slug: proj.slug,
      type: 'chapter-only',
      episode_id: 'EP001',
      title: `EP001 ch${chapter}`,
      params: { chapter_number: chapter },
      dedupeParams: (params: any) => Number(params?.chapter_number) === chapter,
    }))
  }
  // Without three DISTINCT jobs contending, a peak of 1 would mean nothing.
  assert.equal(new Set(queued.map(j => j.job_id)).size, 3, 'all three chapters were really queued')

  // Wait for the queue to start SOMETHING (poll — this machine may be busy),
  // then hold still for a fixed window so a widened lane has every chance to
  // start the other two. The window is deliberately not a poll: a widened lane
  // must be caught at its peak, not at the moment it happened to be passing 1.
  await waitFor(() => active >= 1)
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(active, 1, 'exactly one chapter regen may hold the lane')
  assert.equal(peak, 1, 'peak concurrency for chapter-only must be 1, never 2')

  // Drain, checking after each release that the next chapter took the slot
  // alone rather than joining the one already running.
  for (let i = 0; i < 3; i++) {
    assert.equal(releases.length, 1, `only chapter ${i + 1} may be in flight`)
    releases.shift()!()
    await waitFor(() => done === i + 1)
    if (i < 2) {
      await waitFor(() => releases.length === 1)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(active, 1, 'the freed slot was taken by one chapter, not two')
    }
  }

  assert.equal(done, 3, 'all three chapters ran')
  assert.equal(peak, 1, 'and no two of them ever overlapped')
})

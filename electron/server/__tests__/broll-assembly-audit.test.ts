/**
 * Group 1.1b — the `broll_assemble` auditor.
 *
 * THE DEFECT. The assembler trims each clip to its sidecar `target_duration`,
 * mixes narration + B-Roll audio + music, and encodes with `-shortest`. When the
 * selection covers less than the narration the video simply STOPS at the last
 * clip while the narration continues — and nothing failed. `broll_assemble` had
 * NO auditor and NO `requireJobCompletion`, so it reported Done over a render
 * that cuts off mid-sentence, with the Production Board's final-video cell green.
 * The selector knew: it warns "Pool too small to fill Ns of narration… Got Ms".
 *
 * These tests exercise the auditor directly rather than driving the generator,
 * which would run ffmpeg. The mechanism that turns a `repair-required` verdict
 * into a failed job is already pinned generically by
 * `job-cancel.test.ts` — "a locally-completed job whose executor declared
 * nothing is failed when its auditor finds output missing" — so an auditor unit
 * test plus that one is a complete proof without a real encode.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let audit: typeof import('../boot/executors.js')
let sidecarStore: typeof import('../services/broll-selection-sidecar.js')
let pm: typeof import('../services/project-manager.js')

const SLUG = 'broll-audit-project'
const EPISODE = 'EP0001'
const TITLE = 'A Real Episode'

before(async () => {
  tmp = await useTempDataDir()
  audit = await import('../boot/executors.js')
  sidecarStore = await import('../services/broll-selection-sidecar.js')
  pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Broll Audit Project' })
})

after(async () => { await tmp?.cleanup() })

/** A valid sidecar: `selection` covers `coveredSec`, against `narrationSec`. */
function sidecar(narrationSec: number, coveredSec: number): any {
  return {
    // `pool_id` is required by `isSelectionSidecar`; without it the sidecar
    // fails to round-trip and the auditor — correctly — reports that it cannot
    // judge the output. My first fixture omitted it and four tests "failed" for
    // that reason rather than for anything the auditor did.
    pool_id: 'pool-1',
    selection_mode: 'auto',
    pacing_mode: 'timed',
    broll_volume: 0.3,
    target_duration: narrationSec,
    generated_at: new Date().toISOString(),
    selection: [{ filename: 'clip-1.mp4', sha256: 'a'.repeat(64), target_duration: coveredSec }],
  }
}

const job = () => ({ project_slug: SLUG, episode_id: EPISODE, title: TITLE, params: {} })

describe('the b-roll assembly auditor refuses to bless a truncated render', () => {
  test('a selection far short of the narration is repair-required', async () => {
    // The audit's own example: 900s of narration, 420s of clips — the video ends
    // at 7:00 while the narration runs to 15:00.
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(900, 420))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
  })

  test('a selection that covers the narration is complete', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(900, 900))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('a rounding-level shortfall is NOT failed', async () => {
    // Within COVERAGE_FAIL_SEC (2s) — a clip trimmed by a frame must not fail a
    // job that produced a usable video.
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(900, 899))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('an OVER-covering selection is complete', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(900, 940))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('a legacy sidecar with no narration target is not failed for missing data', async () => {
    // `target_duration` did not always exist. Failing a sidecar that never
    // carried a coverage claim would invent a requirement — the mirror-image
    // defect of the one being fixed.
    const legacy = sidecar(0, 420)
    delete legacy.target_duration
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, legacy)
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('an empty selection is repair-required, not silently complete', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, { ...sidecar(900, 0), selection: [] })
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
  })
})

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
 * These tests exercise the shared post-render auditor with disposable ffmpeg
 * artifacts rather than driving the full pool renderer. The mechanism that
 * turns a `repair-required` verdict into a failed job is already pinned by
 * `job-cancel.test.ts` — "a locally-completed job whose executor declared
 * nothing is failed when its auditor finds output missing" — so an auditor unit
 * test plus that one is a complete proof without a real encode.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let audit: typeof import('../boot/executors.js')
let sidecarStore: typeof import('../services/broll-selection-sidecar.js')
let pm: typeof import('../services/project-manager.js')
let provenance: typeof import('../services/video-visual-source.js')

const SLUG = 'broll-audit-project'
const EPISODE = 'EP0001'
const TITLE = 'A Real Episode'
const NARRATION_SEC = 3.1
let finalPath = ''
let stampPath = ''
let narrationPath = ''
let episodePaths: Awaited<ReturnType<(typeof import('../services/utils.js'))['resolveEpisodePaths']>>

before(async () => {
  tmp = await useTempDataDir()
  audit = await import('../boot/executors.js')
  sidecarStore = await import('../services/broll-selection-sidecar.js')
  provenance = await import('../services/video-visual-source.js')
  pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Broll Audit Project' })
  const { resolveEpisodePaths } = await import('../services/utils.js')
  episodePaths = await resolveEpisodePaths(SLUG, EPISODE, TITLE)
  finalPath = path.join(episodePaths.video_dir, `${EPISODE}_final_video.mp4`)
  stampPath = provenance.videoAssemblySourceStampPath(finalPath, EPISODE)
  narrationPath = path.join(episodePaths.merged_audio_dir, `${EPISODE}_merged_audio.mp3`)
  await Promise.all([
    fs.mkdir(episodePaths.video_dir, { recursive: true }),
    fs.mkdir(episodePaths.merged_audio_dir, { recursive: true }),
  ])
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${NARRATION_SEC}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', narrationPath,
  ])
})

after(async () => { await tmp?.cleanup() })
beforeEach(async () => {
  await Promise.all([
    fs.rm(finalPath, { force: true }),
    fs.rm(stampPath, { force: true }),
  ])
})

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

async function writeVideo(durationSec: number): Promise<void> {
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=10:d=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', finalPath,
  ])
}

async function writeProducerProof(): Promise<void> {
  const source = await provenance.readVideoVisualSource(SLUG, EPISODE)
  const narration = await provenance.snapshotBrollNarration(narrationPath, episodePaths, EPISODE)
  await provenance.writeVideoAssemblySourceStamp(
    finalPath, EPISODE, source.source, source.image_pool, narration,
  )
}

const job = () => ({
  project_slug: SLUG, episode_id: EPISODE, title: TITLE, params: {},
  output_dir: episodePaths.video_dir, output_lines: [] as string[],
})

describe('the b-roll assembly auditor refuses to bless a truncated render', () => {
  test('a selection far short of the narration is repair-required', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(NARRATION_SEC, 0.2))
    await writeVideo(0.2)
    await writeProducerProof()
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
  })

  test('a selection that covers the narration is complete', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(NARRATION_SEC, NARRATION_SEC))
    await writeVideo(NARRATION_SEC)
    await writeProducerProof()
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('a rounding-level shortfall is NOT failed', async () => {
    // Within COVERAGE_FAIL_SEC (2s) — a clip trimmed by a frame must not fail a
    // job that produced a usable video.
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(NARRATION_SEC, 2.1))
    await writeVideo(2.1)
    await writeProducerProof()
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('an OVER-covering selection is complete', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, sidecar(NARRATION_SEC, 3.5))
    await writeVideo(3.5)
    await writeProducerProof()
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
  })

  test('a legacy sidecar with no narration target is repair-required', async () => {
    // 2026-09-21: unknown is not complete. Without a producer stamp or legacy
    // target, no artifact can prove that it covers the narration.
    const legacy = sidecar(0, 0.2)
    delete legacy.target_duration
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, legacy)
    await writeVideo(NARRATION_SEC)
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
  })

  test('an empty selection is repair-required, not silently complete', async () => {
    await sidecarStore.saveSelectionSidecar(SLUG, EPISODE, TITLE, { ...sidecar(NARRATION_SEC, 0), selection: [] })
    await writeVideo(NARRATION_SEC)
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
  })
})

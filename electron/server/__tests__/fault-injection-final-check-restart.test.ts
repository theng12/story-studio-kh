/**
 * Fault injection S4(b) — the app restarts during a final check.
 *
 * The check now runs in the background and the update drain waits for it, so the ordinary update
 * no longer kills it. A crash, a force quit, or "Install now (don't wait)" still ends the process
 * mid-decode, and nothing was written beside the video.
 *
 * The invariant: "the check was asked for and never finished" and "nobody has ever asked about this
 * file" are two different answers (AGENTS.md §6). A later process must be able to say which one it
 * is looking at, and the row's own line must say it too.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { finalCheckProgress, finalCheckSummary } from '../lib/final-video-check.js'
import { waitFor } from './_timing.js'

/** Run one short-lived process that starts a check and dies before any verdict exists. */
async function dieMidCheck(videoPath: string, dataDir: string): Promise<void> {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'final-check-restart-worker.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', worker], {
    env: { ...process.env, VIDEO_PATH: videoPath, STORY_STUDIO_DATA_DIR: dataDir },
    stdio: 'pipe',
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`final-check worker exited ${code}: ${stderr}`)))
  })
}

test('S4: a final check the process died in the middle of is not "never asked"', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalcheck-restart-'))
  const videoPath = path.join(dir, 'EP0001_final_video.mp4')
  try {
    await fs.writeFile(videoPath, Buffer.alloc(2_048))
    await dieMidCheck(videoPath, dir)

    // A fresh process: the in-memory run registry is empty, exactly as after a restart, and no
    // verdict was ever written beside the video.
    const progress = finalCheckProgress(videoPath)
    assert.equal(progress.running, false, 'nothing is measuring it any more')
    assert.equal(progress.error, null, 'and no in-process failure explains why')

    const line = finalCheckSummary(null, progress)
    assert.notEqual(line, 'Final check: not run yet',
      'a check that was asked for and never finished is not the answer for a file nobody asked about')
    assert.match(line, /did not finish/i)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('S4: a check that ran to its end leaves nothing behind that says it did not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalcheck-restart-done-'))
  const videoPath = path.join(dir, 'EP0002_final_video.mp4')
  const { __setFinalCheckRunnerForTests, finalCheckProgress, startFinalCheck } = await import('../lib/final-video-check.js')
  try {
    await fs.writeFile(videoPath, Buffer.alloc(2_048))
    __setFinalCheckRunnerForTests(async (file, expected) => ({
      checked_at: new Date().toISOString(),
      file: { size: 2_048, mtime_ms: 0 },
      expected,
      actual: {
        duration_sec: 0, video_sec: null, audio_sec: null, width: 0, height: 0,
        tail_lufs: null, black: [], silence: [],
      },
      passed: true,
      issues: [],
    }))
    startFinalCheck(videoPath, {
      planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
      width: 0, height: 0, subtitles_path: null,
    })
    await waitFor(() => finalCheckProgress(videoPath).running === false, { label: 'the check to finish' })

    // The run ended on its own terms, so the durable "asked" record must be gone: a file whose
    // check completed is not a file whose check was cut short.
    assert.equal(finalCheckProgress(videoPath).interrupted, false)
    assert.equal(await fs.stat(`${videoPath}.finalcheck.json.running`).then(() => true, () => false), false)
  } finally {
    __setFinalCheckRunnerForTests(null)
    await fs.rm(dir, { recursive: true, force: true })
  }
})

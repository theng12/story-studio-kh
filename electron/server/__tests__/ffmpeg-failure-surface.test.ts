/**
 * Tests that `runFfmpeg` surfaces a meaningful error when the underlying
 * ffmpeg process exits non-zero.
 *
 * The audit's worry was a generator silently passing a "success" status
 * up the queue when ffmpeg actually choked on its inputs (corrupted MP3,
 * missing image, encoder mismatch). The runFfmpeg helper rejects with
 * the exit code + last 5 stderr lines for non-zero exits, separates
 * watchdog timeouts, and tags SIGTERM/SIGKILL as "killed" so cancels
 * don't look like crashes. This test pins those shapes against a real
 * ffmpeg invocation with deliberately bad args.
 *
 * Skipped automatically if no ffmpeg binary is available in the test
 * environment — the assertion would otherwise be a "ffmpeg failed to
 * start" path which is already covered by `runFfmpeg`'s `proc.on('error')`
 * branch.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let runFfmpeg: typeof import('../lib/ffmpeg-utils.js').runFfmpeg
let ffmpegAvailable = false

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  const ffu = await import('../lib/ffmpeg-utils.js')
  runFfmpeg = ffu.runFfmpeg
  // Probe — getFFmpegPath() in test mode hits the resolution chain
  // (custom path → app-data → bundled → PATH). If none are present we
  // skip the assertion-bearing tests rather than fail spuriously.
  try {
    const { getFFmpegPath } = await import('../services/ffmpeg-manager.js')
    const p = await getFFmpegPath()
    await fs.access(p)
    ffmpegAvailable = true
  } catch {
    ffmpegAvailable = false
  }
})

describe('runFfmpeg — non-zero exit surfaces stderr', () => {
  test('rejects with exit code + tail-of-stderr when input file is missing', async (t) => {
    if (!ffmpegAvailable) {
      t.skip('no ffmpeg binary available in test env')
      return
    }
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-ffmpeg-fail-'))
    try {
      const missingInput = path.join(tmpRoot, 'does-not-exist.mp3')
      const output = path.join(tmpRoot, 'out.mp3')

      await assert.rejects(
        () => runFfmpeg(['-y', '-i', missingInput, output]),
        (err: Error) => {
          // Shape locked by ffmpeg-utils.ts:136 — caller can match either
          // the exit-code prefix or the stderr tail to surface it in the UI.
          assert.match(err.message, /FFmpeg exited with code/,
            `expected exit-code message; got: ${err.message}`)
          // ffmpeg's missing-input error words can be one of:
          //   "No such file or directory", "Error opening input", "could not find"
          // — accept any of them so a future ffmpeg version's wording change
          // doesn't fail the test on a benign cosmetic shift.
          assert.match(
            err.message,
            /(No such file or directory|Error opening input|could not find|Invalid)/i,
            `expected stderr tail in message; got: ${err.message}`,
          )
          return true
        },
      )
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('rejects with watchdog message when timeoutMs trips before ffmpeg exits', async (t) => {
    if (!ffmpegAvailable) {
      t.skip('no ffmpeg binary available in test env')
      return
    }
    // `-re` paces lavfi input at realtime, so generating 60s of audio
    // takes ~60s wall-clock. The 1s watchdog must fire long before that.
    // The watchdog SIGTERMs the proc; runFfmpeg surfaces the watchdog
    // path as a distinct "exceeded N-minute watchdog" message rather
    // than a generic exit-code error.
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-ffmpeg-watchdog-'))
    try {
      const out = path.join(tmpRoot, 'out.wav')
      await assert.rejects(
        () => runFfmpeg([
          '-re',
          '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
          '-t', '60', out,
        ], { timeoutMs: 1000 }),
        (err: Error) => {
          // Either the watchdog message OR a SIGTERM-killed message is
          // acceptable depending on which event the runtime sees first.
          assert.match(
            err.message,
            /watchdog|FFmpeg killed|SIGTERM/i,
            `expected watchdog/SIGTERM message; got: ${err.message}`,
          )
          return true
        },
      )
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// Wire cleanup explicitly — node:test's `after` block at module scope
// runs after all describe blocks resolve. Without this, the temp data
// dir leaks across the suite.
test.after?.(async () => { await cleanup?.() })

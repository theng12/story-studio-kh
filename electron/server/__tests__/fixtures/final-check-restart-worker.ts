/**
 * Start a final check and die at once: the app quitting in the middle of a measurement.
 *
 * Night Atlas Mythology EP0008, 2026-10-19 — the app quit to install an update eight minutes and
 * twenty-three seconds into a check and no verdict was written. The on-demand check runs in the
 * background now and the update drain waits for it, but a crash, a force quit, or "Install now
 * (don't wait)" still ends the process mid-decode.
 *
 * The check is started for real (through the module's own entry point, not a stub) and the process
 * then exits without waiting for it, so whatever the module records durably is all a later process
 * can know.
 */
import { __setFinalCheckRunnerForTests, startFinalCheck } from '../../lib/final-video-check.js'

const videoPath = process.env.VIDEO_PATH!
if (!videoPath) throw new Error('VIDEO_PATH is required')

// A decode that never comes back: the process dies while the check is still measuring, which is
// the only shape that matters here. A runner that fails fast would end the run and clean up.
__setFinalCheckRunnerForTests(() => new Promise(() => {}))

startFinalCheck(videoPath, {
  planned_sec: 0, tail: { sec: 0, from_end_sec: 0 }, closing_music: false,
  width: 0, height: 0, subtitles_path: null,
})

// One tick, so an asynchronous start record has landed; then die as a quitting app does.
await new Promise(resolve => setTimeout(resolve, 250))
process.exit(0)

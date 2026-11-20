/**
 * A real child process for the blocked-loop test: starts the real watch, waits
 * for the main loop's first state file, then either blocks its main thread
 * synchronously (a wedge) or stays healthy. The worker thread is real in both
 * cases; only the external commands are stubbed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitFor } from '../_timing.js'
import { noteWedgeStage, startWedgeWatch } from '../../services/wedge-watch.js'

const logDir = process.env.WEDGE_LOG_DIR!
const exitSeconds = Number(process.env.WEDGE_EXIT_SECONDS)
const checkMs = Number(process.env.WEDGE_CHECK_MS)
const mode = process.env.WEDGE_MODE

noteWedgeStage('serving')
await startWedgeWatch({
  logDir,
  exitSeconds,
  checkMs,
  // fileURLToPath, not .pathname: the repo lives under "My Own Apps", and a raw
  // pathname keeps %20, so the Worker looked for a file that does not exist and
  // this test silently proved nothing.
  workerPath: fileURLToPath(new URL('./wedge-watch-test-worker.ts', import.meta.url)),
})

// Block only after the state snapshot exists, so the capture can report it.
await waitFor(() => fs.existsSync(path.join(logDir, 'wedge-state.json')), { label: 'the first state snapshot' })

if (mode === 'block') {
  const until = Date.now() + 4_000
  // A synchronous wedge, the shape Production sampled. No timer on this thread
  // can run — only the worker's own thread can end it.
  while (Date.now() < until) { /* busy */ }
  console.error('[wedge-child] survived the synchronous block')
} else {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.WEDGE_STAY_ALIVE_MS)))
  console.log('[wedge-child] stayed alive with a fresh heartbeat')
  process.exit(0)
}

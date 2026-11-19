/**
 * Heap snapshot on request — the artefact that names a retention instead of guessing at one.
 *
 * OFF by default and never on in server mode: a heap snapshot holds prompts, project text and
 * provider payloads, which is exactly why this app keeps V8 snapshots disabled. It is enabled only by
 * pointing `SS_HEAP_SNAPSHOT_DIR` at a directory the operator is willing to have such a file in, and
 * the file is written there and nowhere else.
 */
import { Router } from 'express'
import path from 'node:path'
import v8 from 'node:v8'
import { isServerMode } from '../lib/server-mode.js'

export const router = Router()

router.post('/diagnostics/heap-snapshot', (_req, res) => {
  const dir = process.env.SS_HEAP_SNAPSHOT_DIR
  if (!dir) return res.status(404).json({ detail: 'Heap snapshots are off. Set SS_HEAP_SNAPSHOT_DIR to enable.' })
  // A serving Mac is not a profiling host: its snapshots would hold the owner's work.
  if (isServerMode() && process.env.SS_HEAP_SNAPSHOT_ALLOW_SERVER !== '1') {
    return res.status(404).json({ detail: 'Heap snapshots are off in server mode.' })
  }
  const file = path.join(dir, `story-heap-${Date.now()}.heapsnapshot`)
  const rssMb = Math.round(process.memoryUsage().rss / 1048576)
  try {
    v8.writeHeapSnapshot(file)
  } catch (error) {
    return res.status(500).json({ detail: `Snapshot failed: ${String(error)}` })
  }
  res.json({ file, rss_mb: rssMb })
})

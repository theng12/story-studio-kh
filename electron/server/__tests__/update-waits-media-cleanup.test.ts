/**
 * The updater never restarts the Mac while one of these operations runs (Free up space, Clear
 * Uploaded Videos), and refuses new ones from the moment it claims its drain.
 *
 * Why it must not interrupt one: the operation registry (services/episode-media-cleanup.ts) is
 * in-memory, so a restart kills a run mid-file and nothing resumes it. The updater's own wait
 * covered queue jobs only (`waitingFor`), so before this a cleanup was interrupted silently.
 *
 * These are the registry/gate halves. The drain-side halves — a running operation keeping the
 * release staged with the queue NOT paused for it, and a terminal one letting the drain be claimed —
 * live in `app-update.test.ts`, where the drain harness is.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import type { UpdatePhase } from '../services/app-update.js'

let cleanup: typeof import('../services/episode-media-cleanup.js')
let pm: typeof import('../services/project-manager.js')
let updater: typeof import('../services/app-update.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'update-wait-cleanup'
/** What `bulkCleanupFinalVideos` returns; this file never inspects it. */
const CLEAN = { items: [], item_count: 0, bytes_freed: 0, deleted_count: 0, skipped_count: 0, failed_count: 0 }
/** The phases at which an install owns the Mac and will restart it. */
const HOLDING: UpdatePhase[] = ['draining', 'installing']
/** Every other phase: the hold is lifted, including the ones an install settles into. */
const SETTLED: UpdatePhase[] = ['idle', 'ready', 'installed', 'failed', 'rolled_back']

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** The registry has no active operation left — i.e. the updater's wait would now be satisfied. */
const ended = () => waitFor(() => cleanup.activeMaintenanceOperation() === null, { label: 'the operation to end' })

before(async () => {
  tmp = await useTempDataDir()
  cleanup = await import('../services/episode-media-cleanup.js')
  pm = await import('../services/project-manager.js')
  updater = await import('../services/app-update.js')
})

beforeEach(async () => {
  await tmp.cleanup()
  tmp = await useTempDataDir()
  cleanup._resetMediaCleanupStateForTests()
  updater.writeState({ phase: 'idle' })
  const projectDir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Update Wait Cleanup',
    episode_prefix: 'EP',
    episode_digits: 4,
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: DEFAULT_SUBFOLDER_NAMES,
    created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(projectDir, 'config.json'), '{}')
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 1, recycled_numbers: [],
  }))
})

after(async () => { await tmp.cleanup() })

test('a running cleanup holds the Mac, and a stop request keeps holding until the current file finishes', async () => {
  const gate = deferred()
  const { operation_id } = await cleanup.startTrackedCleanup(SLUG, 'verifying', async () => {
    await gate.promise
    return CLEAN
  })

  // `beginOperation` files the operation as `queued` and its executor only starts on the next tick,
  // so wait for the state that actually parks on the gate instead of assuming the tick has run.
  await waitFor(() => cleanup.activeMaintenanceOperation()?.status === 'running',
    { label: 'the operation to start running' })
  const running = cleanup.activeMaintenanceOperation()
  assert.equal(running?.kind, 'run', 'a run, not a read-only review, is what an install waits for')
  assert.equal(running?.status, 'running')

  assert.equal(cleanup.stopMediaCleanupOperation(SLUG, operation_id)?.status, 'stopping')
  assert.equal(cleanup.activeMaintenanceOperation()?.status, 'stopping',
    'the current file still finishes, so the Mac is still held')

  gate.resolve()
  await ended()
  assert.equal(cleanup.getMediaCleanupOperation(SLUG, operation_id)?.status, 'stopped')
})

test('an operation that fails also releases the Mac, and says what happened', async () => {
  const { operation_id } = await cleanup.startTrackedCleanup(SLUG, 'verifying', async () => {
    throw new Error('the disk went away')
  })

  await ended()
  const failed = cleanup.getMediaCleanupOperation(SLUG, operation_id)
  assert.equal(failed?.status, 'failed')
  assert.match(String(failed?.error), /the disk went away/)
})

test('the hold is the update\'s own: it refuses while the drain is claimed and lifts with the update\'s phase', async () => {
  for (const phase of HOLDING) {
    updater.writeState({ phase })
    await assert.rejects(
      cleanup.startTrackedCleanup(SLUG, 'verifying', async () => CLEAN),
      /installing an update and will restart in a moment/,
      `${phase} refuses a new operation`,
    )
    assert.equal(cleanup.activeMaintenanceOperation(), null, `${phase}: nothing was started`)
  }

  // Every other phase releases it — including the ones an install settles into. Nothing else (a
  // finished cleanup, a settled install) may leave a hold standing.
  for (const phase of SETTLED) {
    updater.writeState({ phase })
    const { operation_id } = await cleanup.startTrackedCleanup(SLUG, 'verifying', async () => CLEAN)
    await ended()
    assert.equal(cleanup.getMediaCleanupOperation(SLUG, operation_id)?.status, 'completed', `${phase} does not hold`)
  }
})

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let dir: string
let cleanup: () => Promise<void>
let queue: typeof import('../services/job-queue.js')
let settings: typeof import('../services/app-settings.js')

before(async () => {
  const temp = await useTempDataDir()
  dir = temp.dir
  cleanup = temp.cleanup
  settings = await import('../services/app-settings.js')
  queue = await import('../services/job-queue.js')
})
after(async () => { await cleanup() })

async function snapshot() {
  return JSON.parse(await fs.readFile(path.join(dir, 'app-settings.json'), 'utf8'))
}

test('owned pause and its boolean persist atomically, and a restart releases the operation hold', async () => {
  await queue.setQueuePaused(false)
  const seen: Array<[unknown, unknown]> = []
  const unsubscribe = settings.onAppSettingWritten(key => {
    if (key === 'job_queue_paused' || key === 'job_queue_pause_owner') {
      // Both announcements happen after the one settings write; inspect in a later explicit read.
      seen.push([key, queue.isQueuePaused()])
    }
  })
  try {
    assert.equal(await queue.acquireQueuePauseOwned('owned-restart'), true)
    const stored = await snapshot()
    assert.equal(stored.job_queue_paused, true, 'old binaries still read a boolean hold')
    assert.equal(stored.job_queue_pause_owner, 'owned-restart')
    assert.equal(seen.length, 2, 'both changed keys announce after one write')
    // A restart finds an operation hold with no operation behind it. The contract is explicit —
    // never a persisted latch, a restart always resumes — so boot releases it and says so
    // (angkor 2026-11-19 came back taking no work and told nobody).
    queue._resetQueuePauseStateForTesting()
    await queue.initializeQueuePauseState()
    assert.equal(queue.isQueuePaused(), false, 'an operation hold never outlives its process')
    assert.equal(queue.getQueuePauseOwner(), null)
    assert.equal(await queue.releaseQueuePauseOwned('owned-restart'), false, 'nothing left to release')
    const released = await snapshot()
    assert.equal(released.job_queue_paused, false)
    assert.equal(released.job_queue_pause_owner, null)
  } finally { unsubscribe() }
})

test('an app that starts paused says so: health names the hold and its owner', async () => {
  await queue.setQueuePaused(false)
  await queue.acquireQueuePauseOwned('visible-hold')
  // Same expression app.ts serves on /api/health, without booting the whole app.
  const { isQueuePaused, getQueuePauseOwner } = queue
  assert.deepEqual(
    isQueuePaused() ? { paused: true, owner: getQueuePauseOwner(), holds_dispatch: true } : { paused: false },
    { paused: true, owner: 'visible-hold', holds_dispatch: true },
  )
  await queue.releaseQueuePauseOwned('visible-hold')
})

test('manual intents ahead of conditional release keep FIFO priority and revoke ownership', async () => {
  await queue.setQueuePaused(false)
  assert.equal(await queue.acquireQueuePauseOwned('before-owner'), true)
  // No awaits between calls: all three compete for the actual transition lock in this order.
  const resume = queue.setQueuePaused(false)
  const repause = queue.setQueuePaused(true)
  const staleRelease = queue.releaseQueuePauseOwned('before-owner')
  await Promise.all([resume, repause])
  assert.equal(await staleRelease, false)
  assert.equal(queue.isQueuePaused(), true)
  assert.equal(queue.getQueuePauseOwner(), 'operator')
  const stored = await snapshot()
  assert.equal(stored.job_queue_paused, true)
  // A person's Pause records its owner now: an unowned pause is one nothing can be held to, and on
  // angkor 2026-11-19 a null-owner pause survived every restart and stopped all work.
  assert.equal(stored.job_queue_pause_owner, 'operator')
  assert.equal(await queue.acquireQueuePauseOwned('later-updater'), false, 'cannot acquire the owner\'s pause')
  await queue.setQueuePaused(false)
})

test('concurrent acquisition shares one token; an explicit Pause supersedes it even while held', async () => {
  await queue.setQueuePaused(false)
  assert.deepEqual(await Promise.all([
    queue.acquireQueuePauseOwned('shared'), queue.acquireQueuePauseOwned('shared'),
  ]), [true, true])
  assert.equal(queue.getQueuePauseOwner(), 'shared')
  await queue.setQueuePaused(true)
  assert.equal(await queue.releaseQueuePauseOwned('shared'), false)
  assert.equal(queue.isQueuePaused(), true)
  await queue.setQueuePaused(false)
})

test('owned release preserves queued order and leaves an individually paused job alone', async () => {
  const projects = await import('../services/project-manager.js')
  const project = await projects.createProject({ name: 'Owned Pause Queue Order' })
  await queue.setQueuePaused(false)
  await queue.acquireQueuePauseOwned('ordered-release')
  const started: string[] = []
  const restore = queue._setExecutorForTesting('chapter-only', async job => { started.push(job.episode_id!) })
  try {
    const rows = ['FIRST', 'MANUAL', 'SECOND'].map(episode_id => queue.enqueuePreparedForTest({
      project_slug: project.slug, type: 'chapter-only', episode_id, title: episode_id, params: {},
    }))
    await queue.pauseJob(rows[1]!.job_id)
    assert.equal(await queue.releaseQueuePauseOwned('ordered-release'), true)
    await waitFor(() => queue.getJob(rows[2]!.job_id)?.status === 'done', { label: 'original queue order finishing' })
    assert.deepEqual(started, ['FIRST', 'SECOND'])
    assert.equal(queue.getJob(rows[1]!.job_id)?.status, 'paused')
    assert.equal(queue.getJob(rows[1]!.job_id)?.pause_origin, 'manual')
  } finally { restore() }
})

test('a failed atomic release retains the durable boolean and owner for Retry', async t => {
  await queue.setQueuePaused(false)
  await queue.acquireQueuePauseOwned('release-retry')
  const originalRename = fs.rename
  const mock = t.mock.method(fs, 'rename', async (from: any, to: any) => {
    if (String(to) === path.join(dir, 'app-settings.json')) throw new Error('fixture write failure')
    return originalRename(from, to)
  })
  await assert.rejects(queue.releaseQueuePauseOwned('release-retry'), /fixture write failure/)
  mock.mock.restore()
  assert.equal(queue.isQueuePaused(), true)
  assert.equal(queue.getQueuePauseOwner(), 'release-retry')
  const stored = await snapshot()
  assert.equal(stored.job_queue_paused, true)
  assert.equal(stored.job_queue_pause_owner, 'release-retry')
  queue._resetQueuePauseStateForTesting()
  await queue.initializeQueuePauseState()
  // Same rule as above: the write never landed, so after a restart there is nothing to release.
  assert.equal(await queue.releaseQueuePauseOwned('release-retry'), false)
  assert.equal(queue.isQueuePaused(), false)
})

/** Behavioral fail-before: this file also runs against the pre-ownership updater. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import * as updater from '../services/app-update.js'

let cleanup: () => Promise<void>
let queue: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  queue = await import('../services/job-queue.js')
})
after(async () => { updater._resetForTesting(); await cleanup() })

function options(version = '1.4.257'): updater.UpdaterOptions {
  // Keep the old setPaused wiring for running this exact regression on BASE. The fixed
  // updater uses the owned API; BASE ignores those extra methods and takes its original path.
  const owned = queue as any
  return {
    currentVersion: version, appBundle: '/fixture/not-installed.app', port: 1, quit: () => {},
    queue: {
      isPaused: queue.isQueuePaused,
      setPaused: queue.setQueuePaused,
      pauseOwner: () => owned.getQueuePauseOwner?.() ?? null,
      acquirePause: (token: string) => owned.acquireQueuePauseOwned(token),
      releasePause: (token: string) => owned.releaseQueuePauseOwned(token),
      running: () => 1,
      summary: () => ({ running: 1, queued: 0, paused: 0 }),
      wouldNotResume: async () => ['music_video'],
    } as any,
    getSettings: async () => ({ auto_install: true }), saveSettings: async () => {},
    gateway: async () => { throw new Error('No network in this regression') }, channels: async () => 0,
    fetch: (async () => Response.json({ status: 'ok', version: '1.4.258', boot_complete: true })) as typeof fetch,
  }
}

async function acquireThroughUpdater(): Promise<updater.UpdateState> {
  updater._resetForTesting()
  await queue.setQueuePaused(false)
  updater.writeState({ phase: 'ready', release: { version: '1.4.258', signature: 'fixture' } as updater.ReleaseDescriptor })
  updater._configureForTesting(options())
  await updater.maybeInstall()
  assert.equal(updater.readState().phase, 'draining')
  assert.equal(queue.isQueuePaused(), true, 'the actual updater acquired the real queue hold')
  const state = updater.readState()
  updater._resetForTesting() // cancel the drain; boot settlement below must be the only release
  return state
}

for (const outcome of ['healthy boot', 'rollback'] as const) {
  test(`owner Resume then Pause survives updater settlement at ${outcome}`, async () => {
    const state = await acquireThroughUpdater()
    await queue.setQueuePaused(false)
    await queue.setQueuePaused(true)
    updater.writeState({ ...state, phase: 'installing', installing_at: Date.now() })
    await updater.onBoot(options(outcome === 'healthy boot' ? '1.4.258' : '1.4.257'))
    assert.equal(updater.readState().phase, outcome === 'healthy boot' ? 'installed' : 'rolled_back')
    assert.equal(queue.isQueuePaused(), true, 'updater must not release the owner\'s later pause')
    await queue.setQueuePaused(false)
  })
}

test('owner Pause while already held supersedes updater ownership', async () => {
  const state = await acquireThroughUpdater()
  await queue.setQueuePaused(true)
  updater.writeState({ ...state, phase: 'installing', installing_at: Date.now() })
  await updater.onBoot(options('1.4.258'))
  assert.equal(queue.isQueuePaused(), true, 'an explicit owner Pause is authoritative even without a Resume')
  await queue.setQueuePaused(false)
})

test('genuine updater hold is released by a healthy boot', async () => {
  const state = await acquireThroughUpdater()
  updater.writeState({ ...state, phase: 'installing', installing_at: Date.now() })
  await updater.onBoot(options('1.4.258'))
  assert.equal(queue.isQueuePaused(), false, 'preserving owner pauses must not leak a genuine updater hold')
})

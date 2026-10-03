/**
 * Cancel must stop a video render — no fallback encode for a cancelled job.
 *
 * Dreamlands E2E 2026-10-03: Cancel SIGKILLed the final encoder, the tier
 * loop read that as an encode failure and started tier 4 "no effects
 * (recovery)" — a subtitle-less re-encode for a job already marked cancelled.
 */

import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let video: typeof import('../generators/video.js')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  video = await import('../generators/video.js')
})
after(async () => { await cleanup() })

function tiers() {
  return [
    { label: 'H.264 · VideoToolbox', build: () => ['full'] },
    { label: 'H.264 · no effects (recovery)', build: () => ['minimal'], degraded: 'all post effects removed', dropsBurnedInFeatures: true },
  ]
}

describe('final encode tier chain', () => {
  test('a cancel that kills the encoder ends the chain — the recovery tier never runs', async () => {
    let cancelled = false
    const ran: string[][] = []
    const log: string[] = []
    const result = await video.runEncodeTierChain(tiers(), {
      run: async (args) => {
        ran.push(args)
        cancelled = true // the user pressed Cancel; the job queue killed this encoder
        throw new Error('FFmpeg killed (SIGKILL)')
      },
      validate: async () => {},
      log: line => log.push(line),
      logCmd: () => {},
      isCancelled: () => cancelled,
    })
    assert.equal(result.cancelled, true)
    assert.equal(result.succeededTier, null)
    assert.deepEqual(ran, [['full']], 'no fallback encode may start for a cancelled job')
    assert.ok(!log.some(line => /Trying tier/.test(line)), log.join('\n'))
  })

  test('a cancel that lands while a finished encode is being checked is still a cancel', async () => {
    let cancelled = false
    const result = await video.runEncodeTierChain(tiers(), {
      run: async () => { cancelled = true },
      validate: async () => { throw new Error('should not validate a cancelled render') },
      log: () => {},
      logCmd: () => {},
      isCancelled: () => cancelled,
    })
    assert.equal(result.cancelled, true)
    assert.equal(result.succeededTier, null)
  })

  test('a real encode failure (not cancelled) still falls through to the recovery tier', async () => {
    const ran: string[][] = []
    const result = await video.runEncodeTierChain(tiers(), {
      run: async (args) => {
        ran.push(args)
        if (args[0] === 'full') throw Object.assign(new Error('FFmpeg exited with code 1'), { stderr: 'filter graph rejected' })
      },
      validate: async () => {},
      log: () => {},
      logCmd: () => {},
      isCancelled: () => false,
    })
    assert.equal(result.cancelled, false)
    assert.equal(result.succeededTier?.label, 'H.264 · no effects (recovery)')
    assert.deepEqual(ran, [['full'], ['minimal']])
  })
})

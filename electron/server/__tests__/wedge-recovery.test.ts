/**
 * The self-healing exit: a wait past the bound ends the freeze itself.
 *
 * Nothing supervises Story, so a wedge stayed a wedge until a human
 * restarted. Pinned here, with an injected clock (milliseconds, never
 * minutes): a wait under the bound does nothing; `wedge_recovery_enabled`
 * false emits nothing; a wait past `wedge_exit_seconds` pauses once, parks
 * (or names) once, writes exactly ONE sentence, and quits once — in that
 * order. The sentence reports what was observed; no line claims a resume.
 *
 * Zero paid calls, no real timers crossed, no provider.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { _setStallWatchClockForTests, watchWait } from '../lib/stall-watch.js'
import { closeLogStream, flushLogLines } from '../services/logger.js'

let tempDir: string
let cleanup: () => Promise<void>
let fakeNow = 0
let scheduled: Array<() => void> = []

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  _setStallWatchClockForTests({
    now: () => fakeNow,
    schedule: fn => {
      scheduled.push(fn)
      return () => {
        const index = scheduled.indexOf(fn)
        if (index >= 0) scheduled.splice(index, 1)
      }
    },
  })
})

after(async () => {
  _setStallWatchClockForTests(null)
  closeLogStream()
  await cleanup()
})

async function wedgeLines(): Promise<string[]> {
  await flushLogLines()
  const file = path.join(tempDir, 'logs', `server-${new Date().toISOString().slice(0, 10)}.log`)
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter(line => line.includes('Story is wedged'))
}

function deps(calls: string[]) {
  return {
    quit: () => calls.push('quit'),
    pauseQueue: async () => { calls.push('pause') },
    parkRunning: async () => { calls.push('park') },
    readSettings: () => ({ enabled: true, exitSeconds: 180 }),
  }
}

// Order matters: the recovery is a one-shot, so the firing case runs last.
test('a wait under the bound does nothing', async () => {
  const wedge = await import('../services/wedge-recovery.js')
  fakeNow = 1_000
  const wait = watchWait('app-settings:read /tmp/under-bound', 'GET /jobs/all/history')
  fakeNow = 1_000 + 100_000 // 100 s < the 180 s bound
  const calls: string[] = []
  await wedge.checkWedgeOnce(deps(calls))
  assert.deepEqual(calls, [])
  assert.deepEqual(await wedgeLines(), [])
  wait.done()
  scheduled.splice(0)
})

test('recovery off by setting emits nothing even far past the bound', async () => {
  const wedge = await import('../services/wedge-recovery.js')
  fakeNow = 10_000
  const wait = watchWait('app-settings:read /tmp/switched-off', 'GET /jobs/all/history')
  fakeNow = 10_000 + 400_000
  const calls: string[] = []
  await wedge.checkWedgeOnce({
    ...deps(calls),
    readSettings: () => ({ enabled: false, exitSeconds: 180 }),
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(await wedgeLines(), [])
  wait.done()
  scheduled.splice(0)
})

test('a wait past the bound pauses, parks, says one sentence, then quits — once', async () => {
  const wedge = await import('../services/wedge-recovery.js')
  fakeNow = 5_000
  const wait = watchWait('app-settings:read /tmp/past-bound', 'GET /jobs/all/history')
  fakeNow = 5_000 + 181_000
  const calls: string[] = []
  const held = deps(calls)
  await wedge.checkWedgeOnce(held)
  await wedge.checkWedgeOnce(held) // the one-shot guard: still once
  assert.deepEqual(calls, ['pause', 'park', 'quit'], 'pause before quit, each exactly once')

  const lines = await wedgeLines()
  assert.equal(lines.length, 1, 'exactly one sentence')
  assert.match(lines[0],
    /Story is wedged: app-settings:read \/tmp\/past-bound \(GET \/jobs\/all\/history\) has waited 181 s \(bound 180 s\)/)
  wait.done()
  scheduled.splice(0)
})

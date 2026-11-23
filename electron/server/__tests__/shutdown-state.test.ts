/**
 * A quit is bounded by its own ceiling, and a quitting app still answers.
 *
 * Production (angkor, 2026-11-19) sampled a frozen Story whose main thread sat in
 * `_handleAEQuit -> _terminateFromSender:askIfShouldTerminate:saveWindows:` — an Apple Event quit that
 * never finished. That explains the ignored SIGTERM, the updater's "the app did not quit", and a
 * maintenance hold that never answered. These tests pin the two consequences: the deadline ends the
 * process and names what was in flight, and the hold answers at once with a plain sentence.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import {
  _resetShutdownStateForTests,
  armShutdownDeadline,
  beginShutdown,
  cancelShutdown,
  isShuttingDown,
  shutdownSentence,
  shutdownSnapshot,
} from '../lib/shutdown-state.js'
import { maintenanceHoldPost } from '../routes/system.js'

// The hold route answers only the Launcher now (server/hold-auth.ts), so these tests carry the
// Launcher's credential the way the updater does — the shutdown behaviour is what is under test.
const HOLD_TOKEN = randomBytes(32).toString('hex')
const tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-hold-token-'))
process.env.KHU_HOLD_TOKEN_FILE = path.join(tokenDir, 'hold-token')
await fs.writeFile(process.env.KHU_HOLD_TOKEN_FILE, HOLD_TOKEN, { mode: 0o600 })
const holdHeaders = { 'x-hub-token': HOLD_TOKEN }

test('a quit that does not finish ends at its ceiling, naming what was in flight', () => {
  _resetShutdownStateForTests()
  beginShutdown(['job-a', 'job-b'])
  const scheduled: Array<() => void> = []
  const lines: string[] = []
  const exits: number[] = []
  armShutdownDeadline({
    deadlineMs: 15_000,
    exit: code => exits.push(code),
    log: message => lines.push(message),
    schedule: (fn) => { scheduled.push(fn); return () => {} },
    now: () => 15_500,
  })

  assert.equal(scheduled.length, 1, 'one ceiling, armed once')
  assert.deepEqual(exits, [], 'nothing exits before the ceiling')
  scheduled[0]!()

  assert.deepEqual(exits, [1], 'the deadline exits hard, not through the graceful quit')
  assert.equal(lines.length, 1, 'one plain sentence')
  assert.match(lines[0]!, /did not finish quitting/)
  assert.match(lines[0]!, /job-a, job-b/, 'the ids the next start can follow are named')
})

test('a quitting app answers the maintenance hold at once instead of going silent', async () => {
  _resetShutdownStateForTests()
  beginShutdown(['job-a'])
  assert.equal(isShuttingDown(), true)
  assert.deepEqual(shutdownSnapshot()?.inFlight, ['job-a'])

  let body: any = null
  await maintenanceHoldPost(
    { method: 'POST', headers: holdHeaders, query: { timeout_s: '20' } } as any,
    { json: (payload: unknown) => { body = payload } } as any,
  )

  assert.equal(body?.safe, false)
  assert.deepEqual(body?.in_flight, ['job-a'])
  assert.equal(body?.detail, shutdownSentence())
  assert.match(body.detail, /quitting/)
})

test('the first shutdown snapshot stands; a later call cannot rewrite it', () => {
  _resetShutdownStateForTests()
  const first = beginShutdown(['job-a'])
  const second = beginShutdown(['job-z'])
  assert.equal(first, second)
  assert.deepEqual(shutdownSnapshot()?.inFlight, ['job-a'])
})

test('a cancelled quit clears the deadline, so nothing exits later', () => {
  _resetShutdownStateForTests()
  beginShutdown(['job-a'])
  const scheduled: Array<() => void> = []
  const cancelled: string[] = []
  const exits: number[] = []
  armShutdownDeadline({
    deadlineMs: 15_000,
    exit: code => exits.push(code),
    log: () => {},
    schedule: () => { scheduled.push(() => {}); return () => cancelled.push('cancel') },
    now: () => 0,
  })

  cancelShutdown()

  assert.equal(isShuttingDown(), false)
  assert.deepEqual(shutdownSnapshot(), null)
  assert.deepEqual(cancelled, ['cancel'], 'the armed ceiling was cancelled with the quit')
  assert.deepEqual(exits, [], 'a cancelled quit never exits on its own')
})

test('a quitting app also takes DELETE plainly', async () => {
  _resetShutdownStateForTests()
  beginShutdown([])
  let body: any = null
  const { maintenanceHoldDelete } = await import('../routes/system.js')
  await maintenanceHoldDelete(
    { method: 'DELETE', headers: holdHeaders } as any,
    { json: (payload: unknown) => { body = payload } } as any,
  )
  assert.equal(body?.ok, true)
  assert.equal(body?.detail, shutdownSentence())
})

test('after Cancel nothing exits, even a real ceiling later', () => {
  _resetShutdownStateForTests()
  beginShutdown(['job-a'])
  const exits: number[] = []
  // The real scheduler is mocked, not the code under test: `armShutdownDeadline` keeps its own
  // setTimeout, and the clock is jumped four ceilings past it. That proves the cancel, not the machine.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    armShutdownDeadline({ deadlineMs: 40, exit: code => exits.push(code), log: () => {} })
    cancelShutdown()
    mock.timers.tick(160)
    assert.deepEqual(exits, [], 'a cancelled quit must not exit on its own, however long it waits')
    assert.equal(isShuttingDown(), false)
  } finally {
    mock.timers.reset()
  }
})

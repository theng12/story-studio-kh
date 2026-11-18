/**
 * Shared waits must be visible, and the deadline must tell the truth.
 *
 * Production (angkor, 2026-11-18): four routes hung exactly 600 s → 503 while
 * an in-memory route answered in milliseconds, with nothing logged. What held
 * the disk is a hypothesis, not a finding — this file pins only that waits
 * are registered, say ONE line past the threshold, clear on release, that the
 * 503 names what held the request, and that /api/health answers with a
 * `waiting` surface while a lock is outstanding.
 *
 * Every clock here is injected; no real timeout is crossed. Zero paid calls.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import fsp from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { withLock } from '../lib/atomic-store.js'
import {
  _setStallWatchClockForTests,
  currentWaits,
  setStallReporter,
} from '../lib/stall-watch.js'
import { getAppSetting } from '../services/app-settings.js'
import { closeLogStream, flushLogLines, logLine } from '../services/logger.js'
import { _setRequestDeadlineForTests, requestDeadline } from '../lib/server-timeouts.js'

process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

let tempDir: string
let cleanup: () => Promise<void>
let fakeNow = Date.now()
let scheduled: Array<() => void> = []

function installFakeClock(): void {
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
}

async function logText(): Promise<string> {
  await flushLogLines()
  const file = path.join(tempDir, 'logs', `server-${new Date().toISOString().slice(0, 10)}.log`)
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
  installFakeClock()
  // app.ts installs this reporter at boot; the test asserts on the real log file.
  setStallReporter((level, message, meta) => logLine(level, message, meta))
})

after(async () => {
  _setStallWatchClockForTests(null)
  setStallReporter(null)
  _setRequestDeadlineForTests(null)
  closeLogStream()
  await cleanup()
})

test('a held lock key shows one wait, says one stall line, and clears on release', async () => {
  const key = path.join(tempDir, 'stall-watch-lock.json')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = withLock(key, () => held)

  // Registration is synchronous inside withLock, so the waiter is visible now.
  const second = withLock(key, async () => 'second', 'the second caller')
  const forKey = () => currentWaits().filter(wait => wait.operation === key)
  assert.equal(forKey().length, 1, 'the queued caller is on the surface')
  assert.equal(forKey()[0].label, 'the second caller')

  fakeNow += 11_000
  const due = scheduled.splice(0)
  assert.equal(due.length, 1, 'the threshold timer was scheduled once')
  due.forEach(fn => fn())
  // Re-crossing with the same fired timer must not add a second line.
  fakeNow += 5_000
  due.forEach(fn => fn())

  const lines = (await logText()).split('\n').filter(line => line.includes(`on ${key}`))
  assert.equal(lines.length, 1, 'exactly one stall line for the wait')
  assert.match(lines[0], /request the second caller has been waiting 11 s on /)

  release()
  await second
  await first
  assert.equal(forKey().length, 0, 'the entry clears when the lock releases')
})

test('a settings read that outlives the threshold says one line naming the read', async () => {
  const settingsPath = path.join(tempDir, 'app-settings.json')
  const stalled: Array<() => Promise<void>> = []
  const realReadFile = (fsp as { readFile: (...args: any[]) => Promise<string> }).readFile
  ;(fsp as { readFile: unknown }).readFile = (target: unknown, ...rest: unknown[]) => {
    if (String(target) === settingsPath) {
      // Hold THIS read only; every other read in the process keeps working.
      // The release callback must settle THIS promise — readJsonOr awaits it.
      return new Promise<string>((resolve, reject) => {
        stalled.push(async () => {
          try {
            resolve(await realReadFile(target as never, ...(rest as never[])))
          } catch (error) {
            reject(error) // a missing file is an expected ENOENT readJsonOr catches
          }
        })
      })
    }
    return realReadFile(target as never, ...(rest as never[]))
  }
  try {
    const operation = `app-settings:read ${settingsPath}`
    const firstRead = getAppSetting('stall_join_probe')
    await waitFor(() => currentWaits().some(wait => wait.operation === operation),
      { label: 'the in-flight settings read is visible' })
    const joinedRead = getAppSetting('stall_join_probe')

    fakeNow += 11_000
    const due = scheduled.splice(0)
    assert.equal(due.length, 1, 'one threshold timer for the shared read')
    due.forEach(fn => fn())

    const lines = (await logText()).split('\n').filter(line => line.includes(operation))
    assert.equal(lines.length, 1, 'the read plus its joiner say one line, not two')
    assert.match(lines[0], /has been waiting 11 s on app-settings:read /)

    // The joiner went through the pending branch: only ONE readFile opened.
    assert.equal(stalled.length, 1, 'the second reader joined the in-flight read')

    for (const releaseRead of stalled.splice(0)) await releaseRead()
    await Promise.all([firstRead, joinedRead])
    assert.equal(currentWaits().some(wait => wait.operation === operation), false,
      'the entry clears when the read settles')
  } finally {
    ;(fsp as { readFile: unknown }).readFile = realReadFile
  }
})

test('the deadline 503 says the request never got its turn and names held_by', async () => {
  _setRequestDeadlineForTests(50)
  const key = path.join(tempDir, 'deadline-lock.json')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const holder = withLock(key, () => held)

  const app = express()
  app.use(requestDeadline())
  app.get('/hang', async (_req, res) => {
    // This request QUEUES behind the external holder — that queue is its wait.
    await withLock(key, async () => {
      if (!res.headersSent) res.json({ ok: true })
    })
  })
  try {
    const res = await request(app).get('/hang').timeout({ response: 5_000, deadline: 5_000 })
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'REQUEST_TIMED_OUT')
    assert.match(res.body.detail, /never got its turn/)
    assert.match(res.body.detail, /It was held by/)
    assert.ok(String(res.body.held_by).includes(key), 'held_by names what held the request')
    assert.doesNotMatch(res.body.detail, /provider that stopped answering|disk being busy/)
  } finally {
    _setRequestDeadlineForTests(null)
    release()
    await holder
  }
})

test('health answers with waiting while a lock is outstanding', async () => {
  const { app, healthVersionReady } = await import('../app.js')
  await healthVersionReady

  const key = path.join(tempDir, 'health-lock.json')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const holder = withLock(key, () => held)
  const second = withLock(key, async () => 'queued')
  try {
    const res = await request(app).get('/api/health').timeout({ response: 10_000, deadline: 10_000 })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
    assert.equal(typeof res.body.version, 'string')
    assert.equal(typeof res.body.boot_complete, 'boolean')
    assert.ok(Array.isArray(res.body.waiting))
    assert.ok(res.body.waiting.some((wait: { operation: string }) => wait.operation === key),
      'the held lock is on the health surface')
  } finally {
    release()
    await second
    await holder
  }
})

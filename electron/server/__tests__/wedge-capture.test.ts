/**
 * The evidence a wedge leaves behind — and the limit of an in-process watcher.
 *
 * Production froze four times. In one timed observation static files served in
 * 2 ms while `/api/health` never answered; the earlier freezes served static
 * files too, but nothing timed the event loop itself. So "the loop stays alive
 * while an API path hangs" is MEASURED here, not assumed: a handler never
 * returns, and while it is outstanding this file records real elapsed times for
 * a `setTimeout`, a static route and the stall-watcher line. If the loop itself
 * were ever blocked, the watcher could not fire and there would be no capture —
 * the code comment says so plainly; no test here can prove the opposite.
 *
 * Second, the order that must hold when the watcher does fire: capture, flush
 * to disk, pause, park, then the hard exit. The capture file is read back
 * inside the exit callback, so a file still sitting in a buffer would fail.
 *
 * Every external command is stubbed. Zero paid calls, no real timers crossed
 * beyond the short measurements above.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { _setStallWatchClockForTests, setStallLogSeconds, setStallReporter, watchWait } from '../lib/stall-watch.js'
import { closeLogStream, flushLogLines, logLine } from '../services/logger.js'
import { _setWedgeCaptureExecForTests, captureWedgeEvidence } from '../services/wedge-capture.js'

let tempDir: string
let cleanup: () => Promise<void>

const execCalls: Array<{ file: string; args: string[]; timeout: number; maxBuffer: number }> = []

before(async () => {
  const isolated = await useTempDataDir()
  tempDir = isolated.dir
  cleanup = isolated.cleanup
})

after(async () => {
  _setWedgeCaptureExecForTests(null)
  _setStallWatchClockForTests(null)
  setStallReporter(null)
  setStallLogSeconds(10)
  closeLogStream()
  await cleanup()
})

async function logText(): Promise<string> {
  await flushLogLines()
  const file = path.join(tempDir, 'logs', `server-${new Date().toISOString().slice(0, 10)}.log`)
  return fs.readFile(file, 'utf8').catch(() => '')
}

test('one incident file holds why, watcher state, thread sample, handles and the log tail', async () => {
  execCalls.length = 0
  _setWedgeCaptureExecForTests(async (file, args, options) => {
    execCalls.push({ file, args, timeout: options.timeout, maxBuffer: options.maxBuffer })
    return file === 'sample' ? 'Sample of process 1234\nthread 0x1 main' : 'node 1234 owner *:5000 (LISTEN)'
  })
  logLine('info', 'pre-wedge marker line from the request log')

  const file = await captureWedgeEvidence({
    reason: 'Story is wedged: app-settings:read /tmp/lock (GET /jobs/all/history) has waited 181 s (bound 180 s); hard-exiting so the next start can follow the in-flight work.',
    waits: [
      { operation: 'app-settings:read /tmp/lock', label: 'GET /jobs/all/history', waited_ms: 181_000 },
      { operation: 'project:lock my-channel', label: null, waited_ms: 2_000 },
    ],
    inFlight: ['chapter-only my-channel/EP0001'],
    stage: 'wedge detected, before pause',
    boundSeconds: 180,
  })

  assert.equal(path.dirname(file), path.join(tempDir, 'logs'), 'beside the existing logs, never a new location')
  assert.match(path.basename(file), /^incident-\d{8}T\d{6}\.txt$/)

  // Read back from disk: the function resolves only after write + fsync.
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /^Story Studio KH — wedge incident capture/)
  assert.match(text, /bound: a live wait older than 180 s/)
  assert.match(text, /exit path: hard-exit via app\.exit\(1\) — a graceful quit is what is stuck/)

  // WHY
  assert.ok(text.includes('Story is wedged: app-settings:read /tmp/lock'))

  // WATCHER STATE
  assert.match(text, /health silence .*181000 ms \(181 s\)/)
  assert.match(text, /app-settings:read \/tmp\/lock \(GET \/jobs\/all\/history\) — waited 181000 ms/)
  assert.match(text, /project:lock my-channel — waited 2000 ms/)
  assert.ok(text.includes('chapter-only my-channel/EP0001'))

  // THREAD SAMPLE + HANDLES
  assert.ok(text.includes('Sample of process 1234'))
  assert.ok(text.includes('*:5000 (LISTEN)'))

  // LOG TAIL
  assert.ok(text.includes('LAST 200 LOG LINES'))
  assert.ok(text.includes('pre-wedge marker line from the request log'))

  const lsof = execCalls.find(call => call.file === 'lsof')
  assert.ok(lsof, 'lsof ran')
  assert.deepEqual(lsof.args, ['-p', String(process.pid), '-nP', '-iTCP'])
  assert.equal(lsof.timeout, 10_000)
  assert.ok(lsof.maxBuffer > 0)
  if (process.platform === 'darwin') {
    const sample = execCalls.find(call => call.file === 'sample')
    assert.ok(sample, 'sample ran on macOS')
    assert.deepEqual(sample.args, [String(process.pid), '10'])
    assert.equal(sample.timeout, 15_000)
  } else {
    assert.ok(text.includes('not available on this platform (macOS only)'))
  }
})

test('a failing external command is recorded in the file and capture still returns', async () => {
  _setWedgeCaptureExecForTests(async () => { throw new Error('ETIMEDOUT after 10000 ms') })
  const file = await captureWedgeEvidence({
    reason: 'Story is wedged: a lock has waited 181 s (bound 180 s)',
    waits: [],
    inFlight: [],
    stage: 'wedge detected, before pause',
    boundSeconds: 180,
  })
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /\(failed: Error: ETIMEDOUT after 10000 ms\)/)
  assert.match(text, /\(no live waits\)/)
  assert.match(text, /in flight when this fired:\n {2}\(none recorded\)/)
})

test('PREMISE, MEASURED: with an API handler never returning, timers, static files and the watcher still run', async () => {
  const staticDir = path.join(tempDir, 'static')
  await fs.mkdir(staticDir, { recursive: true })
  await fs.writeFile(path.join(staticDir, 'probe.txt'), 'alive\n')

  // The real app wires the stall reporter to the log file at boot; do the same.
  setStallReporter((level, message, meta) => logLine(level, message, meta))
  setStallLogSeconds(1)

  const probeApp = express()
  let healthHits = 0
  const neverSettles = new Promise<void>(() => { /* a lock/fetch that is never released */ })
  probeApp.get('/api/health-like', async (_req, _res) => {
    healthHits += 1
    await neverSettles
  })
  probeApp.use(express.static(staticDir))

  const server = http.createServer(probeApp)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  try {
    const healthStartedAt = Date.now()
    const health = fetch(`${base}/api/health-like`).catch(() => undefined) // deliberately outstanding
    await waitFor(() => healthHits === 1, { label: 'the hanging request reached its handler' })

    const timerStartedAt = Date.now()
    let timerFiredAt = 0
    const timerFired = new Promise<void>(resolve => {
      setTimeout(() => { timerFiredAt = Date.now(); resolve() }, 100)
    })

    const staticStartedAt = Date.now()
    const staticRes = await fetch(`${base}/probe.txt`)
    const staticText = (await staticRes.text()).trim()
    const staticMs = Date.now() - staticStartedAt
    await timerFired
    const timerMs = timerFiredAt - timerStartedAt

    const held = watchWait('wedge-premise:never-released-lock', 'GET /api/health-like')
    const waitStartedAt = Date.now()
    await waitFor(async () => (await logText()).includes('has been waiting'), {
      label: 'the stall watcher line',
      timeoutMs: 5_000,
    })
    const stallLineMs = Date.now() - waitStartedAt

    const wedgeCalls: string[] = []
    const wedge = await import('../services/wedge-recovery.js')
    wedge._resetWedgeRecoveryForTests()
    await wedge.checkWedgeOnce({
      quit: () => wedgeCalls.push('quit'),
      capture: async () => { wedgeCalls.push('capture'); return '/tmp/premise-incident.txt' },
      pauseQueue: async () => { wedgeCalls.push('pause') },
      parkRunning: async () => { wedgeCalls.push('park') },
      readSettings: () => ({ enabled: true, exitSeconds: 1 }),
    })
    held.done()

    // The numbers are the point: print what was actually measured by this run.
    console.log(`[premise] hanging request outstanding ${Date.now() - healthStartedAt} ms; `
      + `static served in ${staticMs} ms; setTimeout(100) fired after ${timerMs} ms; `
      + `stall line after ${stallLineMs} ms; wedge check ran: ${wedgeCalls.join(',')}`)

    assert.equal(staticRes.status, 200)
    assert.equal(staticText, 'alive')
    assert.ok(staticMs < 5_000, `static route answered in ${staticMs} ms while the API handler hung`)
    assert.ok(timerFiredAt > 0 && timerMs < 5_000, `setTimeout fired after ${timerMs} ms while the API handler hung`)
    assert.equal(healthHits, 1, 'the hanging request was really in flight')
    assert.deepEqual(wedgeCalls, ['capture', 'pause', 'park', 'quit'])

    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    await health
  } finally {
    setStallReporter(null)
    setStallLogSeconds(10)
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('capture is written and flushed before the hard exit is called', async () => {
  _setWedgeCaptureExecForTests(async () => 'stub output')
  logLine('info', 'wedge-order marker line')
  const wedge = await import('../services/wedge-recovery.js')
  wedge._resetWedgeRecoveryForTests()

  const events: string[] = []
  let capturedPath = ''
  let textAtExit = ''
  const held = watchWait('wedge-order:lock', 'GET /api/health-like')
  await wedge.checkWedgeOnce({
    readSettings: () => ({ enabled: true, exitSeconds: 0 }),
    capture: async evidence => {
      events.push('capture')
      const file = await captureWedgeEvidence(evidence)
      capturedPath = file
      events.push('captured')
      return file
    },
    pauseQueue: async () => { events.push('pause') },
    parkRunning: async () => { events.push('park') },
    quit: () => {
      events.push('quit')
      // Synchronous read INSIDE the exit: a capture still in a buffer fails here.
      textAtExit = fsSync.readFileSync(capturedPath, 'utf8')
    },
  })
  held.done()

  assert.deepEqual(events, ['capture', 'captured', 'pause', 'park', 'quit'])
  assert.match(textAtExit, /^Story Studio KH — wedge incident capture/)
  assert.match(textAtExit, /exit path: hard-exit via app\.exit\(1\)/)
  assert.ok(textAtExit.includes('wedge-order marker line'))
  assert.equal(await fs.readFile(capturedPath, 'utf8'), textAtExit)

  const text = await logText()
  assert.match(text, /Story is wedged: wedge-order:lock \(GET \/api\/health-like\) has waited \d+ s \(bound 0 s\)/)
  assert.match(text, new RegExp(`evidence written to ${capturedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

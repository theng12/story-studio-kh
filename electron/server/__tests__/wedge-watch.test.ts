/**
 * The watchdog that survives a blocked main thread — measured, not simulated.
 *
 * Production sampled a frozen Story: 6,790 of 6,790 main-thread samples sat in
 * `_handleAEQuit -> _terminateFromSender:…`, a synchronous block. A timer on that
 * thread cannot fire there, so the old in-process check and the shutdown deadline
 * were both dead exactly when they were needed. Here a real child process starts
 * the real watch, then busy-waits on its main thread: only the worker thread can
 * see the silence, write the incident, and SIGKILL the process. The assertions
 * are on the child's actual exit signal and on the file it left behind.
 *
 * The worker's external commands are stubbed by a fixture worker (the real
 * `sample` takes 10 s); nothing else is simulated. Zero paid calls, no provider.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  _resetWedgeWatchWorkerForTests,
  checkWedgeFromWorker,
  shouldFireWedge,
  type WedgeWorkerData,
} from '../services/wedge-watch-worker.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const childScript = path.join(fixturesDir, 'wedge-watch-child.ts')

let rootDir: string

before(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-wedge-watch-'))
})

after(async () => {
  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {})
})

interface ChildResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function runChild(logDir: string, overrides: Record<string, string>, timeoutMs = 30_000): Promise<ChildResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, WEDGE_LOG_DIR: logDir, ...overrides }
  // The child is its own process with its own temp directories; the parent's
  // test-isolation claim must not follow it.
  delete env.NODE_TEST_CONTEXT
  delete env.STORY_STUDIO_DATA_DIR
  const child = spawn(process.execPath, ['--import', 'tsx', childScript], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk) })
  child.stderr!.on('data', chunk => { stderr += String(chunk) })

  return new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the child did not exit within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeoutMs)
    timer.unref()
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function incidentTexts(logDir: string): Promise<string[]> {
  const files = (await fs.readdir(logDir).catch(() => [] as string[])).filter(name => name.startsWith('incident-'))
  return Promise.all(files.map(file => fs.readFile(path.join(logDir, file), 'utf8')))
}

test('a blocked main thread: a real worker thread writes the evidence and SIGKILLs the process', { timeout: 30_000 }, async () => {
  const logDir = path.join(rootDir, 'blocked', 'logs')
  const result = await runChild(logDir, { WEDGE_EXIT_SECONDS: '1.5', WEDGE_CHECK_MS: '100', WEDGE_MODE: 'block' })

  // The point: the process ended by the worker's signal, not by a graceful handler
  // that a blocked loop could never have run.
  assert.equal(result.signal, 'SIGKILL', `expected the worker's SIGKILL, got code ${result.code}\n${result.stderr}`)
  assert.equal(result.code, null)
  assert.ok(!result.stderr.includes('survived the synchronous block'), 'the child never reached the end of its block')

  const texts = await incidentTexts(logDir)
  assert.equal(texts.length, 1, 'exactly one incident file')
  const text = texts[0]!
  assert.match(text, /^Story Studio KH — wedge incident capture/)
  assert.match(text, /captured_by: the off-thread watchdog \(a worker thread\)/)
  assert.match(text, /exit path: hard-exit via SIGKILL from the off-thread watchdog/)
  // Heartbeat age: the silence, measured off the blocked thread, past the bound.
  const age = text.match(/main loop heartbeat: last beat (\d+) ms \((\d+) s\) ago, measured from another thread/)
  assert.ok(age, 'the heartbeat age is the measured silence')
  assert.ok(Number(age![1]) >= 1_500, `fired before the bound: ${age![1]} ms`)
  // The state the loop wrote before it blocked, and a plain statement of the limit.
  assert.ok(text.includes('could not be read: the main thread was blocked'))
  assert.ok(text.includes('"stage":"serving"'))
  assert.ok(text.includes('"shutting_down":false'))
  assert.match(text, /last state the main loop wrote \(\d+ ms old\)/)
})

test('a fresh heartbeat keeps the worker quiet', { timeout: 30_000 }, async () => {
  const logDir = path.join(rootDir, 'healthy', 'logs')
  // A quiet test must survive a loaded machine: 3 s of life against a 2.5 s bound.
  const result = await runChild(logDir, {
    WEDGE_EXIT_SECONDS: '2.5', WEDGE_CHECK_MS: '100', WEDGE_MODE: 'alive', WEDGE_STAY_ALIVE_MS: '3000',
  })
  assert.equal(result.signal, null, 'nothing killed it')
  assert.equal(result.code, 0)
  assert.ok(result.stdout.includes('stayed alive'))
  assert.deepEqual(await incidentTexts(logDir), [], 'no incident file while the loop is beating')
})

test('the rule: a fresh beat or a bounded shutdown stays quiet; real silence fires', () => {
  const now = 1_000_000
  assert.equal(shouldFireWedge({ ageMs: 500, boundMs: 60_000, snapshot: null, now }), false, 'fresh beat')
  assert.equal(shouldFireWedge({
    ageMs: 90_000, boundMs: 60_000, snapshot: { shutting_down: true, written_at: now - 5_000 }, now,
  }), false, 'a shutdown still inside its deadline is a quit, not a wedge')
  assert.equal(shouldFireWedge({
    ageMs: 90_000, boundMs: 60_000, snapshot: { shutting_down: true, written_at: now - 61_000 }, now,
  }), true, 'a shutdown that stopped publishing past the bound is a wedge')
  assert.equal(shouldFireWedge({
    ageMs: 90_000, boundMs: 60_000, snapshot: { shutting_down: false, written_at: now - 1_000 }, now,
  }), true, 'the loop died just after its last snapshot')
})

test('a failed capture still ends the process, once', async () => {
  _resetWedgeWatchWorkerForTests()
  const heartbeat = new SharedArrayBuffer(8)
  Atomics.store(new BigInt64Array(heartbeat), 0, BigInt(1_000))
  const data: WedgeWorkerData = { heartbeat, logDir: path.join(rootDir, 'unused'), exitSeconds: 1, enabled: true }
  const kills: Array<[number, NodeJS.Signals]> = []
  const deps = {
    now: () => 5_000,
    readState: () => ({ text: '(none)', ageMs: null, parsed: null }),
    capture: async () => { throw new Error('the disk refused the write') },
    kill: (pid: number, signal: NodeJS.Signals) => { kills.push([pid, signal]) },
  }
  const originalError = console.error
  const errors: string[] = []
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    assert.equal(await checkWedgeFromWorker(data, deps), true)
    assert.equal(await checkWedgeFromWorker(data, deps), false, 'the bound is crossed once')
  } finally {
    console.error = originalError
  }
  assert.deepEqual(kills, [[process.pid, 'SIGKILL']])
  assert.ok(errors.some(line => line.includes('incident capture failed')), 'the failure is said, not hidden')
})

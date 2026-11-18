/**
 * Evidence for a wedge, written while the watchdog can still run.
 *
 * Story has no outside supervisor, so the check that ends a wedge lives INSIDE
 * this process: `wedge-recovery.ts` when the event loop is alive, and
 * `wedge-watch-worker.ts` (a worker thread) when the main thread is blocked and
 * that event loop is not. This module is the one capture path both use: it
 * records what could honestly be seen, into one file beside the server logs,
 * before the process hard-exits. When the main thread is blocked, the capture
 * says so and reports the last state file the loop managed to write rather than
 * inventing live state. A missing incident file means "nothing got to write
 * one", never "nothing was wrong".
 *
 * Nothing here may hang or throw the capture away: every external command has
 * its own ceiling and its failure is written into the file, and the file is
 * written and fsynced (file and directory) before returning — the process dies
 * straight after, so an unflushed file is worthless.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import type { CurrentWait } from '../lib/stall-watch.js'
import { flushLogLines, getLogDir } from './logger.js'

/** The exit path this capture was written for; named in the header on purpose. */
export const WEDGE_HARD_EXIT_PATH = 'hard-exit via app.exit(1) — a graceful quit is what is stuck'

export interface WedgeEvidence {
  /** The watcher's own sentence: what waited, for how long, and the bound it crossed. */
  reason: string
  /** Live waits at the moment the check fired, oldest first. */
  waits: CurrentWait[]
  /** Rows the queue held in flight, one plain line each. */
  inFlight: string[]
  /** Where the recovery was when it fired (e.g. "wedge detected, before pause"). */
  stage: string
  /** `wedge_exit_seconds`, so the header names the bound. */
  boundSeconds: number
  /**
   * Set when the off-thread watchdog wrote this: the main loop's heartbeat age,
   * measured from that thread. Its presence means the waits and in-flight rows
   * could NOT be read — they live in the blocked thread — and the file says so
   * instead of inventing them.
   */
  mainThreadBlockedMs?: number
  /** The last state the main loop managed to publish, verbatim, and its age. */
  stateSnapshot?: { text: string; ageMs: number | null }
  /** The exit this capture was written for, when it is not the main-thread one. */
  exitPath?: string
}

type Exec = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<string>

const defaultExec: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: options.timeout, maxBuffer: options.maxBuffer, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
})

let exec: Exec = defaultExec

/** Test hook: replace the external-command runner (no real `sample`/`lsof`). */
export function _setWedgeCaptureExecForTests(fn: Exec | null): void {
  exec = fn ?? defaultExec
}

function stamp(date: Date): string {
  // 2026-11-18T12:34:56.789Z -> 20261118T123456
  return date.toISOString().replace(/[-:]/g, '').slice(0, 15)
}

/**
 * Run one external command under a hard ceiling. A timeout or a throw becomes
 * a line in the file instead of an exception.
 */
async function runBounded(label: string, file: string, args: string[], ceilingMs: number, maxBuffer = 1024 * 1024): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const output = await Promise.race([
      exec(file, args, { timeout: ceilingMs, maxBuffer }),
      new Promise<never>((_, reject) => {
        // Belt and braces over execFile's own timeout: an injected or stuck
        // runner must not hold the capture past its ceiling.
        timer = setTimeout(() => reject(new Error(`no answer within ${ceilingMs} ms`)), ceilingMs + 1_000)
        timer.unref()
      }),
    ])
    const text = output.trim()
    if (!text) return '(no output)'
    return text.length > 200_000 ? `${text.slice(0, 200_000)}\n(truncated for the incident file)` : text
  } catch (error) {
    return `(failed: ${String(error)})`
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function threadSample(pid: number): Promise<string> {
  if (process.platform !== 'darwin') return 'not available on this platform (macOS only)'
  return `$ sample ${pid} 10\n${await runBounded('sample', 'sample', [String(pid), '10'], 15_000, 2 * 1024 * 1024)}`
}

async function tcpHandles(pid: number): Promise<string> {
  return `$ lsof -p ${pid} -nP -iTCP\n${await runBounded('lsof', 'lsof', ['-p', String(pid), '-nP', '-iTCP'], 10_000)}`
}

/** Last 200 lines of today's server log, read from the tail rather than whole (the log has a size cap in GB). */
async function logTail(logDir: string): Promise<string> {
  const name = `server-${new Date().toISOString().slice(0, 10)}.log`
  const file = path.join(logDir, name)
  try {
    // Buffered request lines may not have reached the disk yet; this is bounded at 2 s.
    await flushLogLines()
    const handle = await fs.open(file, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, 256 * 1024)
      const buffer = Buffer.alloc(length)
      if (length > 0) await handle.read(buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n').filter(line => line.length > 0)
      return lines.length ? lines.slice(-200).join('\n') : '(log file is empty)'
    } finally {
      await handle.close()
    }
  } catch (error) {
    return `(today's log could not be read: ${String(error)})`
  }
}

function waitLines(waits: CurrentWait[]): string {
  if (!waits.length) return '(no live waits)'
  return waits.map(wait => `  ${wait.operation}${wait.label ? ` (${wait.label})` : ''} — waited ${wait.waited_ms} ms`).join('\n')
}

function render(
  evidence: WedgeEvidence,
  capturedAt: Date,
  pid: number,
  logDir: string,
  sample: string,
  handles: string,
  tail: string,
): string {
  const oldest = evidence.waits[0]
  const silent = oldest ? `oldest live wait ${oldest.waited_ms} ms (${Math.round(oldest.waited_ms / 1_000)} s)` : 'no live wait recorded'
  const offThread = evidence.mainThreadBlockedMs !== undefined
  const blockedS = Math.round((evidence.mainThreadBlockedMs ?? 0) / 1_000)
  const inMemory = offThread
    ? [
        'could not be read: the main thread was blocked, so the live waits and in-flight queue rows it holds in',
        'memory are unavailable. Nothing here is invented; below is the last state the main loop managed to write.',
      ]
    : [
        'read on the main thread when this fired:',
        'waits (oldest first):',
        waitLines(evidence.waits),
        'in flight when this fired:',
        evidence.inFlight.length ? evidence.inFlight.map(row => `  ${row}`).join('\n') : '  (none recorded)',
      ]
  const snapshotAge = evidence.stateSnapshot?.ageMs
  return [
    'Story Studio KH — wedge incident capture',
    `captured_at: ${capturedAt.toISOString()}`,
    `pid: ${pid}`,
    `captured_by: ${offThread ? 'the off-thread watchdog (a worker thread)' : 'the main-thread wedge check'}`,
    `stage: ${evidence.stage}`,
    `bound: ${offThread ? `a main-loop heartbeat older than` : 'a live wait older than'} ${evidence.boundSeconds} s (wedge_exit_seconds)`,
    `exit path: ${evidence.exitPath ?? WEDGE_HARD_EXIT_PATH}`,
    '',
    'WHY',
    evidence.reason,
    '',
    'WATCHER STATE',
    offThread
      ? `main loop heartbeat: last beat ${evidence.mainThreadBlockedMs} ms (${blockedS} s) ago, measured from another thread — that silence IS the wedge`
      : `health silence (how long the oldest live wait has been outstanding): ${silent}`,
    '',
    'IN-MEMORY JS STATE',
    ...inMemory,
    ...(offThread
      ? [
          '',
          `last state the main loop wrote (${snapshotAge === null || snapshotAge === undefined ? 'age unknown' : `${snapshotAge} ms old`}):`,
          evidence.stateSnapshot?.text ?? '(no state snapshot was available)',
        ]
      : []),
    '',
    'THREAD SAMPLE',
    sample,
    '',
    'HANDLES',
    handles,
    '',
    `LAST 200 LOG LINES (${path.basename(path.join(logDir, `server-${capturedAt.toISOString().slice(0, 10)}.log`))})`,
    tail,
    '',
  ].join('\n')
}

/** Write the file, then fsync it and its directory before returning. */
async function writeAndSync(file: string, body: string): Promise<void> {
  assertWriteIsolatedInTests(file, 'wedge-capture')
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const handle = await fs.open(file, 'w')
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    const dirHandle = await fs.open(dir, 'r')
    try { await dirHandle.sync() } finally { await dirHandle.close() }
  } catch {
    // Content is already on disk; a directory that refuses sync does not justify losing the capture.
  }
}

/**
 * Write one timestamped incident file into the app's existing log directory.
 * Returns its path. Throws only when the file itself cannot be written — the
 * caller must still exit and say the capture failed.
 *
 * `logDir` is passed by the off-thread watchdog: inside a worker, `getLogDir()`
 * cannot reach Electron's `app.getPath`, so the main thread hands the directory
 * over instead of the worker guessing one.
 */
export async function captureWedgeEvidence(evidence: WedgeEvidence, options?: { logDir?: string }): Promise<string> {
  const capturedAt = new Date()
  const pid = process.pid
  const logDir = options?.logDir ?? getLogDir()
  const file = path.join(logDir, `incident-${stamp(capturedAt)}.txt`)
  // Parallel: sample may use its full 15 s on its own; lsof is the short one.
  const [sample, handles, tail] = await Promise.all([threadSample(pid), tcpHandles(pid), logTail(logDir)])
  await writeAndSync(file, render(evidence, capturedAt, pid, logDir, sample, handles, tail))
  return file
}

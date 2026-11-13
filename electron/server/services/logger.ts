/**
 * File-based server logger.
 * Writes to {userData}/logs/server-YYYY-MM-DD.log, keeps last 7 days.
 */

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { redactSecrets, redactSensitiveValue } from '../lib/redact-secrets.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { moveToTrashSync, libraryTrashDir, DEFAULT_TRASH_HANDOFF_GB, TRASH_HANDOFF_GB_KEY } from '../lib/trash-move.js'
import { trashDir } from '../lib/app-paths.js'

const require = createRequire(import.meta.url)

/**
 * The log directory, resolved on EVERY access.
 *
 * Deliberately not captured in a module-scope variable, even a lazily-set
 * one. `STORY_STUDIO_DATA_DIR` is what redirects logs into an isolated
 * directory, and it is set by the caller — the Electron main process at boot,
 * `useTempDataDir()` in tests. Memoising on first CALL still froze the path:
 * whichever test happened to log first — in any file sharing this test worker
 * process — bound the directory for every later test, including ones that had
 * already claimed their own temp dir. Same shape as `services/app-settings.ts`.
 * Directory creation is deferred to the actual write sites below (`logLine`,
 * `pruneOldLogs`), not done here, so a plain read (`getLogDir`, used only to
 * report the path) never side-effects the filesystem.
 */
function resolveLogDir(): string {
  // Test override
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'logs')
  }
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'logs')
    }
  } catch {
    // Not in Electron — fall through
  }
  return path.join(process.cwd(), 'logs')
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function currentLogFile(): string {
  return path.join(resolveLogDir(), `server-${todayStamp()}.log`)
}

/**
 * One expired log into Story's Trash. A rename cannot cross volumes, so a Library
 * on another drive falls back to the app's own `<data>/_trash/_logs`.
 */
function moveLogToTrash(file: string, name: string, libraryTrash: string): void {
  try {
    moveToTrashSync(file, path.join(libraryTrash, name), 'logs')
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error
    moveToTrashSync(file, path.join(trashDir(), '_logs', name), 'logs')
  }
}

/** The owner's size cap (services/retention.ts `trash_handoff_gb`): the same number that bounds
 *  Story's Trash bounds this folder, so a log storm cannot fill the disk inside the 7 days.
 *  Read lazily: importing this module must not touch app-settings.json. */
async function logCapBytes(): Promise<number> {
  try {
    const { getAppSetting } = await import('./app-settings.js')
    const gb = Math.floor(Number(await getAppSetting(TRASH_HANDOFF_GB_KEY)))
    return (Number.isFinite(gb) && gb >= 1 ? gb : DEFAULT_TRASH_HANDOFF_GB) * 1024 ** 3
  } catch { return DEFAULT_TRASH_HANDOFF_GB * 1024 ** 3 }
}

/** Move log files older than 7 days — or, once the folder passes the cap, the OLDEST ones on top
 *  of that — into Story's Trash (`<Library>/_trash/_logs`, the app's own `_trash/_logs` when the
 *  Library is on another drive) instead of unlinking them (owner rule: every removal goes to
 *  `_trash`; the retention sweep hands them to the Mac's Trash later). Covers both request logs
 *  (`server-YYYY-MM-DD.log`) and main-process crash logs
 *  (`main-YYYY-MM-DD.log`, introduced alongside the uncaughtException
 *  handler in `main.ts`). Any other `.log` file in this dir is left alone.
 *
 *  ── Why this is async and why it is no longer called from `logLine` ──
 *
 *  This is a directory listing plus a stat and a move per file. It used to
 *  run INSIDE the request logger, hourly, on whichever unlucky request happened
 *  to cross the hour boundary — synchronously, on the event loop, which meant
 *  that request and every other request in flight stopped dead until the disk
 *  answered. On a machine whose disk is saturated by an FFmpeg render, that is
 *  not milliseconds. Sweeping old logs is housekeeping; it has no business on
 *  the path a person is waiting on. */
export async function pruneOldLogs(): Promise<void> {
  const dir = resolveLogDir()
  // Outside the try/catch below on purpose: under the node test runner, a
  // prune whose directory falls outside the claimed temp data dir must fail
  // loudly, not be swallowed as just another benign fs error (e.g. ENOENT for
  // a directory that hasn't been written to yet). See lib/test-isolation.ts.
  assertWriteIsolatedInTests(dir, 'logger')
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    // Story's one Trash; the app's own volume takes it when the Library is on another drive
    // A move that fails leaves the file for the next sweep.
    const { projectsRoot } = await import('./project-manager.js')
    const target = path.join(libraryTrashDir(projectsRoot()), '_logs')
    // Same guard as the log dir itself: a test may only sweep inside its claimed temp dir.
    assertWriteIsolatedInTests(target, 'logger')
    const cap = await logCapBytes()
    const kept: Array<{ full: string; name: string; mtime: number; size: number }> = []
    for (const name of await fs.promises.readdir(dir)) {
      if (!name.endsWith('.log')) continue
      if (!name.startsWith('server-') && !name.startsWith('main-')) continue
      const full = path.join(dir, name)
      try {
        const stat = await fs.promises.stat(full)
        if (stat.mtimeMs < cutoff) { moveLogToTrash(full, name, target); continue }
        kept.push({ full, name, mtime: stat.mtimeMs, size: stat.size })
      } catch { /* a file that vanished under us needs no pruning */ }
    }
    // The age sweep above kept a file younger than 7 days; the size cap still takes the oldest.
    kept.sort((a, b) => a.mtime - b.mtime)
    let total = kept.reduce((n, file) => n + file.size, 0)
    for (const file of kept) {
      if (total <= cap) break
      total -= file.size
      moveLogToTrash(file.full, file.name, target)
    }
  } catch {}
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000
let pruneTimer: NodeJS.Timeout | null = null

/**
 * Start the hourly log sweep. Called once from a real server boot, never at
 * module load — importing this module (which every test that touches a route
 * does) must not start a timer or touch the filesystem. Same shape as the
 * live-output flush timer in `services/job-queue.ts`; `.unref()` keeps it from
 * holding the process alive at shutdown.
 */
export function startLogPruning(): void {
  if (pruneTimer) return
  void pruneOldLogs()
  pruneTimer = setInterval(() => { void pruneOldLogs() }, PRUNE_INTERVAL_MS)
  pruneTimer.unref()
}

export function stopLogPruning(): void {
  if (!pruneTimer) return
  clearInterval(pruneTimer)
  pruneTimer = null
}

/**
 * The open append stream for the current log file, or null if it could not be
 * opened.
 *
 * ── Why a stream, and why it is keyed on the target path ──
 *
 * `logLine` ran `mkdirSync` + `appendFileSync` on EVERY request. Two synchronous
 * disk operations, on the event loop, per request, forever. While FFmpeg is
 * saturating the disk those calls do not return promptly, and because they are
 * synchronous nothing else in the process runs while they wait — which is how a
 * video render made the home page appear frozen. A request logger blocking the
 * server it is logging is a plain defect, not a tuning question.
 *
 * The stream is keyed on the full target path rather than memoised once. That is
 * not incidental: `resolveLogDir()` is deliberately re-resolved on every call
 * (see its comment) because `STORY_STUDIO_DATA_DIR` changes underneath us in
 * tests, and the date in the filename rolls at midnight. Keying on the resolved
 * path means both of those reopen the stream instead of writing to the wrong
 * file, and the mkdir happens once per file rather than once per request.
 */
let streamTarget = ''
let stream: fs.WriteStream | null = null

function streamFor(target: string): fs.WriteStream | null {
  if (streamTarget === target && stream && !stream.destroyed) return stream
  if (stream) {
    try { stream.end() } catch { /* closing a broken stream is not worth failing over */ }
  }
  stream = null
  streamTarget = target
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const next = fs.createWriteStream(target, { flags: 'a' })
    // A stream that errors (disk full, directory removed under us) must not
    // throw asynchronously and take the process down. Drop it; the next line
    // reopens.
    next.on('error', () => {
      if (stream === next) { stream = null; streamTarget = '' }
    })
    stream = next
  } catch {
    stream = null
    streamTarget = ''
  }
  return stream
}

/** Close the open log stream. Exported for tests and orderly shutdown. */
export function closeLogStream(): void {
  if (!stream) return
  try { stream.end() } catch { /* noop */ }
  stream = null
  streamTarget = ''
}

export function logLine(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, any>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: redactSecrets(message),
    ...(redactSensitiveValue(meta || {})),
  }
  const line = JSON.stringify(entry) + '\n'
  const target = currentLogFile()
  // Outside the try/catch below on purpose — see pruneOldLogs above.
  assertWriteIsolatedInTests(target, 'logger')
  try {
    // `write()` buffers and returns immediately; the disk work happens off the
    // event loop. A full buffer is back-pressure to be ignored here — dropping
    // a log line is strictly better than stalling a request to record one.
    streamFor(target)?.write(line)
  } catch {}
  if (level === 'error') console.error(line.trim())
}

/**
 * Flush anything buffered in the open stream to disk.
 *
 * Writes are asynchronous now, so a caller that must READ the log file back —
 * a test, a support-bundle export — has to wait for the buffer to drain first.
 * Resolves immediately when there is nothing open.
 */
export async function flushLogLines(): Promise<void> {
  const open = stream
  if (!open || open.destroyed) return
  if (!open.writableLength) return
  await new Promise<void>((resolve) => {
    const done = () => resolve()
    open.once('drain', done)
    open.once('error', done)
    open.once('close', done)
    // Never hang a caller on a stream that will not drain.
    setTimeout(done, 2_000).unref()
  })
}

export function getLogDir(): string {
  return resolveLogDir()
}

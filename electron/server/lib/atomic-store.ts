/**
 * Atomic JSON persistence with per-path mutexes.
 *
 * Two primitives callers need:
 *   - writeJsonAtomic: crash-safe write (temp file + rename). A mid-write
 *     crash leaves the original file intact rather than truncated.
 *   - withLock: serialises a read-modify-write sequence against a file path
 *     so two concurrent callers doing `read → mutate → write` can't clobber
 *     each other.
 *
 * We deliberately avoid a native dep (async-mutex) — the queue is tiny and
 * in-process; a promise chain does the job.
 */

import { randomUUID } from 'node:crypto'
import fs from 'fs/promises'
import os from 'node:os'
import path from 'path'

import { assertWriteIsolatedInTests } from './test-isolation.js'

const locks = new Map<string, Promise<unknown>>()
const CROSS_PROCESS_LOCK_WAIT_MS = 10_000
const CROSS_PROCESS_LOCK_RETRY_MS = 20
const CROSS_PROCESS_STALE_LOCK_MS = 60_000

interface CrossProcessLockOwner {
  token: string
  pid: number
  hostname: string
  created_at_ms: number
}

/**
 * Run `fn` while holding an exclusive lock on `key`. Subsequent callers with
 * the same key queue up and run in order. Rejections in one run do not block
 * the next one.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  // Chain fn whether prev resolved or rejected — one failure shouldn't deadlock the lock.
  const next: Promise<T> = prev.then(fn, fn)
  // Store a rejection-swallowing version so later waiters aren't poisoned.
  const tail = next.catch(() => {})
  locks.set(key, tail)
  // Opportunistic GC — if nothing else queued after us, drop the entry.
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function readLockOwner(lockPath: string): Promise<CrossProcessLockOwner | null> {
  try {
    const stat = await fs.lstat(lockPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Persistence lock is unsafe; manual recovery is required')
    const value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Partial<CrossProcessLockOwner>
    if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 128
      || !Number.isInteger(value.pid) || (value.pid ?? 0) <= 0
      || typeof value.hostname !== 'string' || value.hostname.length < 1 || value.hostname.length > 255
      || !Number.isSafeInteger(value.created_at_ms) || (value.created_at_ms ?? 0) < 0) {
      throw new Error('invalid lock fields')
    }
    return value as CrossProcessLockOwner
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError || error instanceof TypeError || (error as Error).message === 'invalid lock fields') {
      throw new Error('Persistence lock is corrupt; manual recovery is required', { cause: error })
    }
    throw error
  }
}

async function publishLock(lockPath: string, owner: CrossProcessLockOwner): Promise<boolean> {
  const existing = await readLockOwner(lockPath)
  if (existing) return false
  const temporary = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${owner.token}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  let published = false
  try {
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(owner)}\n`)
      await handle.sync()
    } finally {
      await handle?.close().catch(() => {})
    }
    await fs.link(temporary, lockPath)
    published = true
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(lockPath), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    return true
  } catch (error: unknown) {
    if (!published && (error as NodeJS.ErrnoException).code === 'EEXIST') return false
    if (published) {
      try { await releaseLock(lockPath, owner) } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Persistence lock publication and cleanup failed')
      }
    }
    throw error
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

async function releaseLock(lockPath: string, owner: CrossProcessLockOwner): Promise<void> {
  const current = await readLockOwner(lockPath)
  if (!current || current.token !== owner.token || current.hostname !== owner.hostname || current.pid !== owner.pid) return
  await fs.unlink(lockPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

function ownerIsProvenDead(owner: CrossProcessLockOwner): boolean {
  if (owner.hostname !== os.hostname()) throw new Error('Persistence lock belongs to another host; manual recovery is required')
  if (Date.now() - owner.created_at_ms < CROSS_PROCESS_STALE_LOCK_MS) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw new Error('Unable to prove persistence lock owner is dead', { cause: error })
  }
}

async function recoverLockIfProvenStale(lockPath: string): Promise<boolean> {
  const observed = await readLockOwner(lockPath)
  if (!observed) return true
  if (!ownerIsProvenDead(observed)) return false
  const recoveryPath = `${lockPath}.recovery`
  const guard: CrossProcessLockOwner = {
    token: randomUUID(), pid: process.pid, hostname: os.hostname(), created_at_ms: Date.now(),
  }
  if (!await publishLock(recoveryPath, guard)) return false
  try {
    const current = await readLockOwner(lockPath)
    if (!current || current.token !== observed.token || current.hostname !== observed.hostname || current.pid !== observed.pid) return false
    if (!ownerIsProvenDead(current)) return false
    await fs.unlink(lockPath)
    return true
  } finally {
    await releaseLock(recoveryPath, guard)
  }
}

/** Serialize one read-modify-write across processes; reclaim only a proven-dead local owner. */
export function withCrossProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withLock(key, async () => {
    const lockPath = `${key}.lock`
    assertWriteIsolatedInTests(lockPath, 'cross-process-lock')
    const directoryPath = path.dirname(lockPath)
    await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 })
    const directory = await fs.lstat(directoryPath)
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Persistence lock directory is unsafe; manual recovery is required')
    }
    const deadline = Date.now() + CROSS_PROCESS_LOCK_WAIT_MS
    const owner: CrossProcessLockOwner = {
      token: randomUUID(), pid: process.pid, hostname: os.hostname(), created_at_ms: Date.now(),
    }
    while (true) {
      if (await publishLock(lockPath, owner)) break
      if (await recoverLockIfProvenStale(lockPath)) continue
      if (Date.now() >= deadline) throw new Error('Timed out waiting for persistence lock')
      await sleep(CROSS_PROCESS_LOCK_RETRY_MS)
    }
    try {
      return await fn()
    } finally {
      await releaseLock(lockPath, owner)
    }
  })
}

export interface WriteOpts {
  /** POSIX file mode, e.g. 0o600 for secret files. Ignored on Windows. */
  mode?: number
  /** No indentation: a third smaller and twice as fast to serialise. For large machine-written files (jobs.json). */
  compact?: boolean
}

/**
 * Write JSON atomically: stringify, write to a temp file, rename into place.
 * `rename` is atomic on POSIX and on NTFS within the same volume, so readers
 * never observe a half-written file.
 *
 * Callers that do read-modify-write should wrap this in `withLock(filePath, ...)`.
 */
export async function writeJsonAtomic(filePath: string, data: unknown, opts: WriteOpts = {}): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const body = (opts.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) + '\n'
  try {
    await fs.writeFile(tmp, body, opts.mode !== undefined ? { mode: opts.mode } : undefined)
    // Flush the tmp file's bytes from OS page cache to disk before the rename.
    // Without this, a power-loss between writeFile resolving and the kernel
    // flushing can leave the rename reordered ahead of the data — the target
    // file exists but readFile returns '' (and JSON.parse throws).
    // Plain fsync on Darwin is the SQLite-default compromise — no F_FULLFSYNC.
    const tmpFd = await fs.open(tmp, 'r+')
    try {
      await tmpFd.sync()
    } finally {
      await tmpFd.close()
    }
  } catch (e) {
    // A write that dies half-way (a full disk is the likely cause) used to leave its partial temp
    // file behind: on a nearly full volume every retry stranded another few megabytes and made the
    // shortage worse. Only the rename step below cleaned up.
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
  try {
    await fs.rename(tmp, filePath)
  } catch (e) {
    // Best-effort cleanup of the temp file if rename failed.
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
  // On POSIX, fsync the parent directory so the rename entry itself is durable.
  // Skipped on Windows: NTFS directory fsync is a no-op and opening a dir for
  // read is awkward under Win32.
  if (process.platform !== 'win32') {
    try {
      const dirFd = await fs.open(dir, 'r')
      try {
        await dirFd.sync()
      } finally {
        await dirFd.close()
      }
    } catch {
      // Directory fsync is best-effort — some filesystems reject dir opens.
    }
  }
  // Re-apply mode after rename (mkstemp-style flows can lose the bit on some FS).
  if (opts.mode !== undefined) {
    await fs.chmod(filePath, opts.mode).catch(() => {})
  }
}

/**
 * Convenience: read a JSON file, or return `fallback` if it's missing or
 * unreadable. Does NOT take a lock — most call sites want their own read +
 * mutate + write inside `withLock`.
 */
export async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

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

import fs from 'fs/promises'
import path from 'path'

const locks = new Map<string, Promise<unknown>>()

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
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

export interface WriteOpts {
  /** POSIX file mode, e.g. 0o600 for secret files. Ignored on Windows. */
  mode?: number
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
  const body = JSON.stringify(data, null, 2) + '\n'
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

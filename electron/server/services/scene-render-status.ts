import { randomUUID } from 'node:crypto'
import fs from 'fs/promises'
import os from 'node:os'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveEpisodePathsByCode } from './utils.js'

export const RENDER_STATUS_FILENAME = '.render_status.json'
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const hasErrorCode = (error: unknown, code: string): boolean => (
  typeof error === 'object' && error !== null && 'code' in error
  && (error as { code?: unknown }).code === code
)

interface SceneRenderStatusLockOwner {
  created_at_ms: number
  hostname: string
  pid: number
  token: string
}

function parseLockOwner(raw: string): SceneRenderStatusLockOwner {
  try {
    const parsed = JSON.parse(raw) as Partial<SceneRenderStatusLockOwner>
    if (!Number.isSafeInteger(parsed.created_at_ms) || (parsed.created_at_ms ?? 0) < 0
      || typeof parsed.hostname !== 'string' || !parsed.hostname
      || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || typeof parsed.token !== 'string' || !parsed.token) {
      throw new Error('invalid lock owner fields')
    }
    return parsed as SceneRenderStatusLockOwner
  } catch (error) {
    throw new Error('Scene render status lock is corrupt; manual recovery is required', { cause: error })
  }
}

async function readLockOwner(lockPath: string): Promise<SceneRenderStatusLockOwner | null> {
  try {
    return parseLockOwner(await fs.readFile(lockPath, 'utf-8'))
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

async function fsyncParent(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function publishLock(lockPath: string, owner: SceneRenderStatusLockOwner): Promise<boolean> {
  const directory = path.dirname(lockPath)
  const temporary = path.join(directory, `.${path.basename(lockPath)}.${owner.token}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx')
    await handle.writeFile(`${JSON.stringify(owner)}\n`)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  try {
    await fs.link(temporary, lockPath)
    await fsyncParent(directory).catch(() => {})
    return true
  } catch (error: unknown) {
    if (hasErrorCode(error, 'EEXIST')) return false
    throw error
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

async function releaseLock(lockPath: string, owner: SceneRenderStatusLockOwner): Promise<void> {
  const current = await readLockOwner(lockPath)
  if (!current || current.token !== owner.token || current.hostname !== owner.hostname || current.pid !== owner.pid) return
  await fs.unlink(lockPath).catch(error => {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  })
}

function ownerIsProvenDead(owner: SceneRenderStatusLockOwner): boolean {
  if (owner.hostname !== os.hostname()) {
    throw new Error(`Scene render status lock belongs to foreign host ${owner.hostname}; manual recovery is required`)
  }
  if (Date.now() - owner.created_at_ms < LOCK_STALE_MS) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ESRCH')) return true
    throw new Error(`Unable to prove scene render status lock PID ${owner.pid} is dead`, { cause: error })
  }
}

async function acquireRecoveryGuard(lockPath: string, deadline: number): Promise<SceneRenderStatusLockOwner> {
  const recoveryPath = `${lockPath}.recovery`
  const owner: SceneRenderStatusLockOwner = {
    created_at_ms: Date.now(),
    hostname: os.hostname(),
    pid: process.pid,
    token: randomUUID(),
  }
  while (true) {
    if (await publishLock(recoveryPath, owner)) return owner
    const existing = await readLockOwner(recoveryPath)
    if (!existing) continue
    if (existing.hostname !== owner.hostname) {
      throw new Error(`Scene render status recovery guard belongs to foreign host ${existing.hostname}; manual recovery is required`)
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scene render status recovery guard')
    await wait(10)
  }
}

async function recoverLockIfProvenStale(lockPath: string, deadline: number): Promise<boolean> {
  const observed = await readLockOwner(lockPath)
  if (!observed) return true
  if (!ownerIsProvenDead(observed)) return false
  const recoveryPath = `${lockPath}.recovery`
  const guard = await acquireRecoveryGuard(lockPath, deadline)
  try {
    // The recovery guard serializes stale takeovers. Re-check both ownership
    // and liveness before unlinking so an old observation cannot remove a
    // successor that has already published its own marker.
    const current = await readLockOwner(lockPath)
    if (!current || current.token !== observed.token || current.hostname !== observed.hostname || current.pid !== observed.pid) return false
    if (!ownerIsProvenDead(current)) return false
    await fs.unlink(lockPath)
    return true
  } finally {
    await releaseLock(recoveryPath, guard)
  }
}

/**
 * The atomic-store promise lock protects concurrent workers in one process.
 * Scene Review can also be reached by a restarted/overlapping process, so use
 * an exclusive lock file for the short read-check-write critical section.
 * An abandoned owner is recoverable only after it is old and its local PID is
 * proven dead; live and unknown owners fail closed.
 */
async function withSceneRenderStatusLock<T>(statusPath: string, operation: () => Promise<T>): Promise<T> {
  return withLock(statusPath, async () => {
    const lockPath = `${statusPath}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    const owner: SceneRenderStatusLockOwner = {
      created_at_ms: Date.now(),
      hostname: os.hostname(),
      pid: process.pid,
      token: randomUUID(),
    }
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    while (true) {
      if (await publishLock(lockPath, owner)) break
      if (await recoverLockIfProvenStale(lockPath, deadline)) continue
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for scene render status lock: ${statusPath}`)
      await wait(10)
    }
    try {
      return await operation()
    } finally {
      await releaseLock(lockPath, owner)
    }
  })
}

/**
 * Every producer and cleanup path shares this serializer. A terminal cleanup
 * must read and update under the same lock as a live worker's next checkpoint,
 * otherwise its stale read can deactivate a newer batch marker.
 */
export async function writeSceneRenderStatus(statusPath: string, status: Record<string, unknown>): Promise<void> {
  await withSceneRenderStatusLock(statusPath, () => writeJsonAtomic(statusPath, status))
}

/**
 * A render marker is display-only state. Once the owning local batch has
 * settled, retain its progress for diagnostics but never leave it claiming
 * active work.
 */
export async function deactivateSceneRenderStatus(projectSlug: string, episodeId: string, jobId: string): Promise<void> {
  const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
  const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
  await withSceneRenderStatusLock(statusPath, async () => {
    let status: Record<string, unknown>
    try {
      status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof status.job_id === 'string' && status.job_id !== jobId) return
    if (status.active !== true) return
    await writeJsonAtomic(statusPath, {
      ...status,
      active: false,
      in_flight: [],
      updated_at: new Date().toISOString(),
    })
  })
}

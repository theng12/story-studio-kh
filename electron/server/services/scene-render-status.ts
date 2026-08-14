import fs from 'fs/promises'
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

/**
 * The atomic-store promise lock protects concurrent workers in one process.
 * Scene Review can also be reached by a restarted/overlapping process, so use
 * an atomic lock directory for the short read-check-write critical section.
 * A stale owner is moved aside before removal; release only removes its own
 * marker, so it cannot delete a successor's lock.
 */
async function withSceneRenderStatusLock<T>(statusPath: string, operation: () => Promise<T>): Promise<T> {
  return withLock(statusPath, async () => {
    const lockPath = `${statusPath}.lock`
    const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const ownerPath = path.join(lockPath, 'owner')
    const deadline = Date.now() + LOCK_WAIT_MS
    let lastLockError: unknown
    let acquired = false
    while (!acquired) {
      try {
        await fs.mkdir(lockPath)
        await fs.writeFile(ownerPath, owner, { flag: 'wx' })
        acquired = true
      } catch (error: unknown) {
        lastLockError = error
        if (!hasErrorCode(error, 'EEXIST')) throw error
        const stat = await fs.stat(lockPath).catch(() => null)
        if (stat && Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
          const stalePath = `${lockPath}.stale-${owner}`
          try {
            await fs.rename(lockPath, stalePath)
            await fs.rm(stalePath, { recursive: true, force: true })
            continue
          } catch (staleError: unknown) {
            if (!hasErrorCode(staleError, 'ENOENT')) throw staleError
            continue
          }
        }
        if (Date.now() >= deadline) break
        await wait(10)
      }
    }
    if (!acquired) throw new Error(`Timed out waiting for scene render status lock: ${statusPath}`, { cause: lastLockError })
    try {
      return await operation()
    } finally {
      try {
        if (await fs.readFile(ownerPath, 'utf-8') === owner) {
          await fs.unlink(ownerPath)
          await fs.rmdir(lockPath)
        }
      } catch {
        // Another process may have safely reclaimed a stale lock. Never remove
        // a path whose ownership cannot be proven.
      }
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

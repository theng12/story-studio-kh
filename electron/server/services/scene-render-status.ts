import fs from 'fs/promises'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { resolveEpisodePathsByCode } from './utils.js'

export const RENDER_STATUS_FILENAME = '.render_status.json'

/**
 * Every producer and cleanup path shares this serializer. A terminal cleanup
 * must read and update under the same lock as a live worker's next checkpoint,
 * otherwise its stale read can deactivate a newer batch marker.
 */
export async function writeSceneRenderStatus(statusPath: string, status: Record<string, unknown>): Promise<void> {
  await withLock(statusPath, () => writeJsonAtomic(statusPath, status))
}

/**
 * A render marker is display-only state. Once the owning local batch has
 * settled, retain its progress for diagnostics but never leave it claiming
 * active work.
 */
export async function deactivateSceneRenderStatus(projectSlug: string, episodeId: string, jobId: string): Promise<void> {
  const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
  const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
  await withLock(statusPath, async () => {
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

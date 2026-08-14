import fs from 'fs/promises'
import path from 'path'
import { resolveEpisodePathsByCode } from './utils.js'

export const RENDER_STATUS_FILENAME = '.render_status.json'

/**
 * A render marker is display-only state. Once the owning local batch has
 * settled, retain its progress for diagnostics but never leave it claiming
 * active work.
 */
export async function deactivateSceneRenderStatus(projectSlug: string, episodeId: string, jobId: string): Promise<void> {
  const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
  const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
  let status: Record<string, unknown>
  try {
    status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return
  }
  if (typeof status.job_id === 'string' && status.job_id !== jobId) return
  if (status.active !== true) return
  await fs.writeFile(statusPath, JSON.stringify({
    ...status,
    active: false,
    in_flight: [],
    updated_at: new Date().toISOString(),
  }, null, 2), 'utf-8')
}

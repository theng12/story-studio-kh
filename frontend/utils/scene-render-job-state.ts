export interface SceneRenderJob {
  episode_id?: string
  job_id?: string
  status?: string
  type?: string
  [key: string]: unknown
}

const ACTIVE_RENDER_STATUSES = new Set(['running', 'queued', 'paused'])
const SCENE_RENDER_TYPES = new Set(['continuity_render', 'scene_images_batch', 'images', 'scene_images', 'thumb_images'])

function isActiveRenderJob(job: SceneRenderJob | null | undefined, types: readonly string[] | undefined): job is SceneRenderJob {
  if (!job || !ACTIVE_RENDER_STATUSES.has(job.status || '')) return false
  return !types ? SCENE_RENDER_TYPES.has(job.type || '') : types.includes(job.type || '')
}

/**
 * The Scene Review GET payload can be a paused snapshot while the global Jobs
 * SSE stream has already advanced the same batch. Match by job id first so a
 * newer queued/running state resumes the live UI and a terminal state clears
 * it instead of letting the cached paused owner win forever.
 */
export function resolveActiveSceneRenderJob(
  episodeId: string | null | undefined,
  cached: SceneRenderJob | null | undefined,
  jobs: readonly SceneRenderJob[],
  types?: readonly string[],
): SceneRenderJob | null {
  if (!episodeId) return null
  const cachedForEpisode = cached?.episode_id === episodeId ? cached : null
  const liveForCached = cachedForEpisode?.job_id
    ? jobs.find(job => job.job_id === cachedForEpisode.job_id)
    : null
  if (liveForCached) return isActiveRenderJob(liveForCached, types) ? liveForCached : null
  if (isActiveRenderJob(cachedForEpisode, types)) return cachedForEpisode
  return jobs.find(job => job.episode_id === episodeId && isActiveRenderJob(job, types)) || null
}

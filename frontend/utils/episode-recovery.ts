const dependentTypes = new Set(['audio_merge', 'subtitles_transcribe', 'scene_plan_run', 'contextual_cues', 'continuity_render', 'scene_images_batch'])

export function isEpisodeRecoveryType(type: string): boolean { return dependentTypes.has(type) }

/** Send one episode intent; section identities and retry params remain server-owned. */
export function groupEpisodeRecoveryRetries<T extends { job_id: string; type: string; project_slug: string; episode_id: string; status?: string }>(jobs: readonly T[]) {
  const episodes = new Map<string, { project_slug: string; episode_id: string; source_job_ids: string[] }>()
  const other: T[] = []
  for (const job of jobs) {
    if (!isEpisodeRecoveryType(job.type)) other.push(job)
    else {
      const key = `${job.project_slug}:${job.episode_id}`
      const intent = episodes.get(key) || { project_slug: job.project_slug, episode_id: job.episode_id, source_job_ids: [] }
      if (!intent.source_job_ids.includes(job.job_id)) intent.source_job_ids.push(job.job_id)
      episodes.set(key, intent)
    }
  }
  return { episodes: [...episodes.values()], other }
}

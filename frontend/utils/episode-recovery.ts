const dependentTypes = new Set(['audio_merge', 'subtitles_transcribe', 'scene_plan_run', 'contextual_cues', 'continuity_render', 'scene_images_batch'])

export function isEpisodeRecoveryType(type: string): boolean { return dependentTypes.has(type) }

/** Send one episode intent; section identities and retry params remain server-owned. */
export function groupEpisodeRecoveryRetries<T extends { type: string; project_slug: string; episode_id: string; status?: string }>(jobs: readonly T[]) {
  const episodes = new Map<string, { project_slug: string; episode_id: string }>()
  const other: T[] = []
  for (const job of jobs) {
    if (!isEpisodeRecoveryType(job.type) || job.status === 'cancelled') other.push(job)
    else episodes.set(`${job.project_slug}:${job.episode_id}`, { project_slug: job.project_slug, episode_id: job.episode_id })
  }
  return { episodes: [...episodes.values()], other }
}

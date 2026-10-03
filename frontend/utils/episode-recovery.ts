const dependentTypes = new Set(['audio_merge', 'subtitles_transcribe', 'scene_plan_run', 'contextual_cues', 'continuity_render', 'scene_images_batch'])
const AFTER_SUBTITLES = new Set<unknown>([null, 'scene_plan_run', 'contextual_cues', 'continuity_render'])

interface RecoveryDisplayJob {
  type?: string
  status?: string
  /** Set by the backend when every file this failed job was meant to make exists now. */
  resolved?: { reason?: string } | null
  params?: {
    force?: unknown
    generation_action?: { kind?: unknown }
    episode_recovery_id?: unknown
    episode_recovery?: {
      id?: unknown
      completed?: readonly unknown[]
      first_unresolved?: unknown
    }
  }
}

export function isEpisodeRecoveryType(type: string): boolean { return dependentTypes.has(type) }

/** The old attempt stays failed; this only describes its now-verified subtitle output. */
export function isVerifiedRecoveredSubtitleJob(job: RecoveryDisplayJob): boolean {
  if (job.type !== 'subtitles_transcribe' || job.status !== 'error' || job.params?.force === true
    || job.params?.generation_action?.kind === 'fresh') return false
  const recovery = job.params?.episode_recovery
  const recoveryId = recovery?.id
  if (typeof recoveryId !== 'string' || !recoveryId.trim()
    || typeof job.params?.episode_recovery_id !== 'string'
    || recoveryId !== job.params.episode_recovery_id) return false
  return Array.isArray(recovery?.completed)
    && recovery.completed.includes('subtitle_sections')
    && recovery.completed.includes('subtitle_stitch')
    && AFTER_SUBTITLES.has(recovery.first_unresolved)
}

/** A failed row whose work was finished later: kept as history, no longer needs attention. */
export function isRecoveredFailure(job: RecoveryDisplayJob): boolean {
  return job.status === 'error' && (!!job.resolved || isVerifiedRecoveredSubtitleJob(job))
}

export function jobDisplayStatus(job: RecoveryDisplayJob): string {
  return isRecoveredFailure(job) ? 'recovered' : String(job.status || '')
}

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

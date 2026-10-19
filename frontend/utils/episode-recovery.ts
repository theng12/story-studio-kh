import { isScopedChapterTranscription } from '../../electron/server/contracts/subtitle-gaps'
import {
  isRecoveredFailure as isRecoveredFailureShared,
  isVerifiedRecoveredSubtitleJob as isVerifiedRecoveredSubtitleJobShared,
  jobDisplayStatus as jobDisplayStatusShared,
} from '../../electron/server/contracts/jobs-history'

const dependentTypes = new Set(['audio_merge', 'subtitles_transcribe', 'scene_plan_run', 'contextual_cues', 'continuity_render', 'scene_images_batch'])

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

export function isEpisodeRecoveryType(type: string, params?: Record<string, unknown>): boolean {
  return dependentTypes.has(type) && !(type === 'subtitles_transcribe' && isScopedChapterTranscription(params || {}))
}

/**
 * The display-only Recovered rule lives in `contracts/jobs-history.ts`, because
 * the server's history endpoint filters by the same status the page renders —
 * two copies is how the list and its own status chips drift apart.
 */
export function isVerifiedRecoveredSubtitleJob(job: RecoveryDisplayJob): boolean {
  return isVerifiedRecoveredSubtitleJobShared(job as Parameters<typeof isVerifiedRecoveredSubtitleJobShared>[0])
}

/** A failed row whose work was finished later: kept as history, no longer needs attention. */
export function isRecoveredFailure(job: RecoveryDisplayJob): boolean {
  return isRecoveredFailureShared(job as Parameters<typeof isRecoveredFailureShared>[0])
}

export function jobDisplayStatus(job: RecoveryDisplayJob): string {
  return jobDisplayStatusShared(job as Parameters<typeof jobDisplayStatusShared>[0])
}

/** Send one episode intent; section identities and retry params remain server-owned. */
export function groupEpisodeRecoveryRetries<T extends { job_id: string; type: string; project_slug: string; episode_id: string; status?: string; params?: Record<string, unknown> }>(jobs: readonly T[]) {
  const episodes = new Map<string, { project_slug: string; episode_id: string; source_job_ids: string[] }>()
  const other: T[] = []
  for (const job of jobs) {
    if (!isEpisodeRecoveryType(job.type, job.params)) other.push(job)
    else {
      const key = `${job.project_slug}:${job.episode_id}`
      const intent = episodes.get(key) || { project_slug: job.project_slug, episode_id: job.episode_id, source_job_ids: [] }
      if (!intent.source_job_ids.includes(job.job_id)) intent.source_job_ids.push(job.job_id)
      episodes.set(key, intent)
    }
  }
  return { episodes: [...episodes.values()], other }
}

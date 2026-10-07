/**
 * Production Board — "Retry Failed" for the selected episodes only.
 *
 * Picks the same job the Board draws as ✕ (the latest job of that episode
 * step, failed) and runs it through the Jobs page's own Retry-all rules:
 * the per-row admission filter, recovered failures left alone, and the
 * repair triage that refuses to resubmit repairable work nobody has repaired
 * (the v1.0.114 duplicate-charge shape). What is held back is counted, not
 * guessed at; the Jobs page is where it gets checked.
 */
import { isFreeFleetWork } from '../../electron/server/contracts/provider-task-state'
import { statusFieldForJob, type StepJobLike } from './episode-step-jobs'
import { isRecoveredFailure } from './episode-recovery'
import { retryAdmissionAllowed } from './job-presentation'
import { triageFailedJobsForRetryAll, type RepairRecord } from './repair-triage'

export interface BoardRetryJob extends StepJobLike {
  job_id: string
  episode_id?: string | null
  resolved?: { reason?: string } | null
  genstudio_jobs?: ReadonlyArray<{ model_id?: unknown }> | null
  params?: { mode?: unknown; auto_repair_missing_prompts?: unknown; jobs_replace_failed_items?: unknown } | null
}

/** Job types with a free Repair on the Jobs page — keep in step with `REPAIR_ENDPOINTS` in jobs.vue. */
export const REPAIRABLE_JOB_TYPES: ReadonlySet<string> = new Set(['audio', 'thumb_images'])
/** Work done on this Mac (FFmpeg) — never charged (AGENTS.md §7). */
const LOCAL_JOB_TYPES: ReadonlySet<string> = new Set(['audio_merge', 'video_assembly', 'broll_assemble'])
/** Where the Jobs page keeps what each Repair found (same key as jobs.vue). */
export const REPAIR_STATE_KEY = 'story-studio:repair-state:v1'

export interface BoardRetryPlan<J extends BoardRetryJob> {
  /** Safe to resubmit now. */
  retry: J[]
  /** Failed, but left for the Jobs page (needs Repair first, or Retry is not offered for it). */
  held: number
  /** At least one retry may spend GenStudio credits. */
  mayUseCredits: boolean
}

/**
 * `failedCells` holds the Board's ✕ cells for the selection (`${episode}:${field}`),
 * so a step whose files are now on disk is never resubmitted.
 */
export function boardRetryPlan<J extends BoardRetryJob>(
  jobs: readonly J[],
  failedCells: ReadonlySet<string>,
  repairRecord: (jobId: string) => RepairRecord | undefined,
): BoardRetryPlan<J> {
  // Same "latest job per step" choice as episodeStepJobStates().
  const latest = new Map<string, J>()
  for (const job of jobs) {
    const field = statusFieldForJob(job)
    if (!field || !job.episode_id) continue
    const key = `${job.episode_id}:${field}`
    const previous = latest.get(key)
    if (!previous || String(job.created_at || '') >= String(previous.created_at || '')) latest.set(key, job)
  }
  const failed = [...latest].filter(([key, job]) => failedCells.has(key) && job.status === 'error').map(([, job]) => job)
  const eligible = failed.filter(job => !isRecoveredFailure(job as any)
    && job.params?.auto_repair_missing_prompts !== true
    && !job.params?.jobs_replace_failed_items
    && retryAdmissionAllowed(job))
  const { retry } = triageFailedJobsForRetryAll(eligible, job => REPAIRABLE_JOB_TYPES.has(job.type), repairRecord)
  return {
    retry,
    held: failed.length - retry.length,
    mayUseCredits: retry.some(job => !LOCAL_JOB_TYPES.has(job.type) && !isFreeFleetWork(job.genstudio_jobs)),
  }
}

/** The Jobs page's saved repair outcomes; empty when unreadable. */
export function readRepairRecords(storage: Pick<Storage, 'getItem'> | undefined): Record<string, RepairRecord> {
  try {
    const parsed = JSON.parse(storage?.getItem(REPAIR_STATE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

import type { Job, JobType } from '../models/types.js'

/** A producer-specific proof that remote provider output is complete on disk. */
export type JobCancellationAuditor = (job: Job) => Promise<'complete' | 'repair-required'>

const auditors = new Map<JobType, JobCancellationAuditor>()

export function registerJobCancellationAuditor(type: JobType, auditor: JobCancellationAuditor): void {
  // Provider success does not make malformed or unreadable local output
  // complete. Convert audit faults into repair-first evidence rather than a
  // transport retry loop in the cancellation reconciler.
  auditors.set(type, async job => {
    try {
      return await auditor(job)
    } catch {
      return 'repair-required'
    }
  })
}

export function hasJobCancellationAuditor(type: JobType): boolean {
  return auditors.has(type)
}

export function getJobCancellationAuditor(type: JobType): JobCancellationAuditor | undefined {
  return auditors.get(type)
}

import type { Job, JobType } from '../models/types.js'

/** A producer-specific proof that remote provider output is complete on disk. */
export type JobCancellationAuditor = (job: Job) => Promise<'complete' | 'repair-required'>

const auditors = new Map<JobType, JobCancellationAuditor>()

export function registerJobCancellationAuditor(type: JobType, auditor: JobCancellationAuditor): void {
  auditors.set(type, auditor)
}

export function hasJobCancellationAuditor(type: JobType): boolean {
  return auditors.has(type)
}

export function getJobCancellationAuditor(type: JobType): JobCancellationAuditor | undefined {
  return auditors.get(type)
}

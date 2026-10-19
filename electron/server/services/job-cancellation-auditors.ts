import type { Job, JobType } from '../models/types.js'

export type JobCancellationVerdict = 'complete' | 'repair-required'

/**
 * What an auditor proved, and — when it says `repair-required` — WHAT is wrong.
 *
 * A bare verdict was all this ever returned, so the restart-reconciliation path could only say
 * "Provider output needs repair before this job can be marked complete." about a job whose own
 * auditor had already worked out the exact scenes at fault. AGENTS.md §8: an error must name the
 * missing or invalid items. An auditor that knows them returns `{ verdict, detail }`; one that
 * does not keeps returning the bare verdict, which still works everywhere.
 */
export type JobCancellationAudit = JobCancellationVerdict | { verdict: JobCancellationVerdict; detail: string }

/** A producer-specific proof that remote provider output is complete on disk. */
export type JobCancellationAuditor = (job: Job) => Promise<JobCancellationAudit>

/** Flatten either shape, so every caller reads one thing. */
export function readCancellationAudit(result: JobCancellationAudit): { verdict: JobCancellationVerdict; detail?: string } {
  if (typeof result === 'string') return { verdict: result }
  const detail = result.detail.trim()
  return detail ? { verdict: result.verdict, detail } : { verdict: result.verdict }
}

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

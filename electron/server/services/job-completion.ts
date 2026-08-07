import type { Job } from '../models/types.js'

export interface JobCompletionAudit {
  label: string
  expected: number
  completed: number
  missing?: Array<string | number>
  invalid?: Array<string | number>
  retry_hint?: string
}

function formatItems(items: Array<string | number>): string {
  const shown = items.slice(0, 20).join(', ')
  return items.length > 20 ? `${shown}, +${items.length - 20} more` : shown
}

/**
 * `missing` and `invalid` are compiled independently by most generators, so the
 * same item legitimately lands in both (a scene with no file on disk is missing
 * AND unverified). Reporting it twice makes the error read like two separate
 * failures. De-dupe on the rendered value, keeping first-seen order.
 */
function dedupeItems(items: Array<string | number>): Array<string | number> {
  const seen = new Set<string>()
  const unique: Array<string | number> = []
  for (const item of items) {
    const key = String(item)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

export function completionErrorMessage(audit: JobCompletionAudit): string {
  const problems = dedupeItems([...(audit.missing || []), ...(audit.invalid || [])])
  const itemLabel = problems.length ? ` Missing/invalid: ${formatItems(problems)}.` : ''
  const retry = audit.retry_hint ? ` ${audit.retry_hint}` : ''
  return `${audit.label} incomplete: ${audit.completed}/${audit.expected} required item(s) verified.${itemLabel}${retry}`
}

/**
 * Persist a machine-readable completion declaration on the job and fail loudly
 * when it is incomplete. Successful partial files stay on disk; callers should
 * make Retry skip those files and process only the declared gaps.
 */
export function requireJobCompletion(job: Job, audit: JobCompletionAudit): void {
  const complete = audit.expected >= 0
    && audit.completed === audit.expected
    && !(audit.missing?.length)
    && !(audit.invalid?.length)
  const completionError = complete ? undefined : completionErrorMessage(audit)
  job.result = {
    ...(job.result || {}),
    complete,
    completion: {
      ...audit,
      complete,
      ...(completionError ? { error: completionError } : {}),
    },
  }
  if (!complete) {
    job.output_lines.push(`✗ INCOMPLETE — ${completionError}`)
    throw new Error(completionError)
  }
}

export interface JobDegradation {
  /** The recovery path that actually produced the output. */
  tier: string
  /** Why the preferred path was abandoned. */
  reason: string
  /** Everything the user asked to have burned into the output. */
  requested: string[]
  /** Of those, the ones present in the delivered file. */
  survived: string[]
  /** Of those, the ones this path discarded. Non-empty ⇒ degraded. */
  dropped: string[]
}

/** Marker the Jobs UI keys on to render a degraded run distinctly from a clean one. */
export const DEGRADED_LINE_PREFIX = '⚠ DEGRADED'

/**
 * Declare that a job produced usable output via a path that silently discarded
 * part of what was requested. No-op when nothing was dropped, so callers can
 * call it unconditionally after any fallback.
 *
 * `status` stays `'done'` and `result.complete` stays `true`, deliberately:
 *
 *  - A complete-but-degraded video genuinely beats a failed render, so the
 *    fallback that produces it must keep existing.
 *  - Setting `result.complete = false` would make `assertJobDidNotDeclareIncomplete`
 *    throw and convert this into an `error` job — destroying the very output we
 *    deliberately chose to keep, and deleting the user's only watchable file.
 *  - A new `JobStatus` value is not viable either: every poll loop and terminal
 *    watcher in the UI treats exactly `done | error | cancelled` as terminal, so
 *    an unrecognised status would hang them indefinitely.
 *
 * The defect was never that the run ended in `done` — it is that `done` carried
 * no record of the loss. So the loss becomes structured, machine-readable fact
 * on `result.degraded`, plus an `output_lines` entry the Jobs UI promotes to the
 * summary. A caller can no longer report success without also reporting what it
 * threw away.
 */
export function declareJobDegraded(job: Job, degradation: JobDegradation): void {
  if (!degradation.dropped.length) return
  job.result = { ...(job.result || {}), degraded: { ...degradation } }
  const survived = degradation.survived.length ? degradation.survived.join(', ') : 'none'
  job.output_lines.push(
    `${DEGRADED_LINE_PREFIX} — the delivered video is MISSING: ${degradation.dropped.join(', ')}.`,
  )
  job.output_lines.push(`   Requested: ${degradation.requested.join(', ')}`)
  job.output_lines.push(`   Survived:  ${survived}`)
  job.output_lines.push(`   Produced by ${degradation.tier} after: ${degradation.reason}`)
  job.output_lines.push('   The file is playable but does not match the request — re-run to get the missing features.')
}

/** Queue-level backstop for executors that set `result.complete = false` but
 * accidentally return instead of throwing. */
export function assertJobDidNotDeclareIncomplete(job: Job): void {
  if (job.result?.complete !== false) return
  const declared = job.result.completion?.error
    || job.result.completion_error
    || 'The generator declared incomplete output. Retry to repair the missing items.'
  throw new Error(String(declared))
}

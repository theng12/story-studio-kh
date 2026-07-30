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

/** Queue-level backstop for executors that set `result.complete = false` but
 * accidentally return instead of throwing. */
export function assertJobDidNotDeclareIncomplete(job: Job): void {
  if (job.result?.complete !== false) return
  const declared = job.result.completion?.error
    || job.result.completion_error
    || 'The generator declared incomplete output. Retry to repair the missing items.'
  throw new Error(String(declared))
}

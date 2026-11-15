/**
 * What a Gateway writing pool tried, kept as data (1.4.402, job286aa756).
 *
 * Gateway publishes `pool_attempts` when a pool walks its members. Story used to keep only the
 * final human sentence, so a mixed failure ("one member ran out of output, one was offline, one
 * had a bad key") collapsed into whichever member spoke last — and a length failure could read as
 * an auth failure. These attempts are preserved structurally: member, outcome, code/status, a
 * sanitized detail, finish reason and retryability.
 *
 * Field names are read tolerantly because the contract is Gateway's: the snake_case names it
 * publishes today and the camelCase variants of the same facts. Nothing here invents a fact the
 * response did not carry. Human fields pass the shared secret redactor and a bounded scrub of
 * known credential shapes; only the allowlisted fields below are stored, never a raw body/header.
 */
import { redactSensitiveValue } from '../lib/redact-secrets.js'

export interface PoolAttempt {
  /** The pool member — a model id or fleet group id. Empty only when the response named none. */
  member: string
  /** The member's own outcome word (`failed`, `unavailable`, …), lower-cased. */
  outcome: string
  code: string | null
  status: number | null
  /** The member's reason, with keys and tokens removed. */
  detail: string | null
  finish_reason: string | null
  retryable: boolean | null
}

export interface GenStudioFailureRecord {
  /** The pool name, when the response named it. */
  pool: string | null
  /** Gateway's job / request identifier, when it published one. */
  job_id: string | null
  /** The request's own correlation id (the idempotency key or request identity) when no job id. */
  correlation_id: string | null
  /** The selected product Story asked for. */
  model: string | null
  attempts: PoolAttempt[]
  /** One sentence a person can read; mixed failures stay mixed. */
  summary: string
  at: string
}

const MAX_DETAIL = 300

/** Remove credential-shaped text before it can be stored or shown. */
export function sanitizeAttemptDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // The shared redactor covers the exact secrets this process holds and Bearer/sk- shapes; the
  // patterns below add the header forms it does not, then the field is bounded.
  const cleaned = String(redactSensitiveValue(value))
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[key removed]')
    .replace(/\b(?:x-api-key|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '[key removed]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[key removed]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[key removed]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[key removed]')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned.length > MAX_DETAIL ? `${cleaned.slice(0, MAX_DETAIL - 1)}…` : cleaned
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name]
  return undefined
}

/** Read `pool_attempts` from a Gateway body/job. Anything unreadable yields an empty list. */
export function parsePoolAttempts(value: unknown): PoolAttempt[] {
  if (!Array.isArray(value)) return []
  const out: PoolAttempt[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const member = text(pick(row, 'member', 'model', 'model_id', 'product', 'id'))
    const outcome = text(pick(row, 'outcome', 'state', 'result')).toLowerCase()
    const code = text(pick(row, 'code', 'failure_code', 'error_code')) || null
    const rawStatus = pick(row, 'status', 'http_status', 'status_code')
    const status = Number.isInteger(rawStatus) ? rawStatus as number : null
    const detail = sanitizeAttemptDetail(pick(row, 'detail', 'failure_reason', 'message', 'error'))
    const finishReason = text(pick(row, 'finish_reason', 'native_finish_reason', 'finishReason')) || null
    // Only names that state retry ELIGIBILITY. `retry_attempted` says an attempt happened, not that
    // another is safe, so it is deliberately not read.
    const rawRetryable = pick(row, 'retryable', 'retryable_error')
    const retryable = typeof rawRetryable === 'boolean' ? rawRetryable : null
    // A row with no member and no fact is not an attempt; a member with no detail is still one.
    if (!member && !code && status === null && !detail) continue
    out.push({ member, outcome, code, status, detail, finish_reason: finishReason, retryable })
  }
  return out
}

/**
 * The output-limit cause is claimed only when the response proves it: a `length` finish reason or a
 * token-limit code. `INCOMPLETE_OUTPUT` alone can be a dropped connection or an unreadable answer,
 * so it stays the generic `incomplete` — an accurate cause, not an invented one.
 */
function category(attempt: PoolAttempt): 'auth' | 'output_limit' | 'incomplete' | 'unavailable' | 'other' {
  const code = (attempt.code || '').toUpperCase()
  if (attempt.status === 401 || attempt.status === 403 || code.includes('AUTH') || code.includes('UNAUTHORIZED')) return 'auth'
  if ((attempt.finish_reason || '').toLowerCase() === 'length'
    || /OUTPUT[_ -]?LIMIT|MAX[_ -]?TOKENS|TOKEN[_ -]?LIMIT|LENGTH[_ -]?LIMIT/.test(code)) return 'output_limit'
  if (code.includes('INCOMPLETE')) return 'incomplete'
  if (code.includes('UNAVAILABLE') || attempt.outcome === 'unavailable' || /offline|unavailable/i.test(attempt.detail || '')) return 'unavailable'
  return 'other'
}

/**
 * One sentence for a mixed failure. Categories are counted, never collapsed: a pool that ended on
 * an auth error after a length failure must not tell the owner "authentication failed".
 */
export function summarizePoolFailure(pool: string | null, attempts: readonly PoolAttempt[]): string {
  if (!attempts.length) return ''
  const counts = { auth: 0, output_limit: 0, incomplete: 0, unavailable: 0, other: 0 }
  for (const attempt of attempts) counts[category(attempt)]++
  const parts = [
    counts.output_limit ? `${counts.output_limit} stopped at its output limit` : '',
    counts.incomplete ? `${counts.incomplete} stopped incomplete` : '',
    counts.auth ? `${counts.auth} could not authenticate` : '',
    counts.unavailable ? `${counts.unavailable} ${counts.unavailable === 1 ? 'was' : 'were'} unavailable` : '',
    counts.other ? `${counts.other} failed` : '',
  ].filter(Boolean)
  const where = pool ? `pool "${pool}"` : 'the writing pool'
  return `${attempts.length} ${attempts.length === 1 ? 'model' : 'models'} in ${where}: ${parts.join(', ')}.`
}

/** The durable record a failed job keeps. */
export function genStudioFailureRecord(input: {
  pool?: string | null
  jobId?: string | null
  correlationId?: string | null
  model?: string | null
  attempts: readonly PoolAttempt[]
  at?: string
}): GenStudioFailureRecord {
  const attempts = [...input.attempts]
  return {
    pool: input.pool?.trim() || null,
    job_id: input.jobId?.trim() || null,
    correlation_id: input.correlationId?.trim() || null,
    model: input.model?.trim() || null,
    attempts,
    summary: summarizePoolFailure(input.pool ?? null, attempts),
    at: input.at || new Date().toISOString(),
  }
}

/**
 * Read the pool facts from a Gateway HTTP error body. Both shapes are accepted: `pool_attempts` at
 * the top level, or nested under `detail` (the same nesting `detail` prose already uses).
 */
export function parseGenStudioFailureBody(body: unknown): { pool: string | null; jobId: string | null; attempts: PoolAttempt[] } {
  const top = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const detail = top.detail && typeof top.detail === 'object' ? top.detail as Record<string, unknown> : {}
  const pool = top.pool ?? top.pool_name ?? detail.pool ?? detail.pool_name
  const jobId = top.job_id ?? top.request_id ?? detail.job_id ?? detail.request_id
  return {
    pool: typeof pool === 'string' && pool.trim() ? pool.trim() : null,
    jobId: typeof jobId === 'string' && jobId.trim() ? jobId.trim() : null,
    attempts: parsePoolAttempts(top.pool_attempts ?? detail.pool_attempts),
  }
}

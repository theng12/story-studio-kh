/**
 * Redacted "what did Story Studio actually send to GenStudio?" snapshot.
 *
 * Why this exists: when a generation fails the user sees an error string and
 * has no way to tell whether the request itself was wrong — which product was
 * submitted, which response_format was asked for, what the prompt actually
 * said after every template and style layer had been folded in. This module
 * builds a bounded, credential-free preview of each submitted request; the
 * client stores it on the job's existing `genstudio_jobs` evidence entry and
 * the Jobs page renders it inside the per-job output expander.
 *
 * Three hard rules:
 *   1. NO credentials, ever. The builder has no parameter that can carry a
 *      header map, and every string it emits goes through `redactSecrets`
 *      (exact-match against every registered runtime key + Bearer/sk-/gsk_
 *      patterns) before it is stored. The final object also passes through
 *      `redactSensitiveValue`, which drops any credential-shaped field name.
 *   2. Redact BEFORE truncating. Truncating first could slice a secret in
 *      half and leave a partial credential behind the "…truncated" marker.
 *   3. Bounded size. Prompts routinely run tens of thousands of characters and
 *      jobs.json is rewritten on every update, so each message is capped and
 *      only the newest few entries keep their preview at all.
 */

import { isSensitiveFieldName, redactSecrets, redactSensitiveValue } from './redact-secrets.js'

/**
 * Characters kept per message/prompt before the truncation marker.
 *
 * Calibrated against real chat jobs, not the original image-batch workload:
 * a representative system prompt runs ~8,200 characters and the accompanying
 * user message ~3,100 — roughly 11.3 KB combined. 20,000 keeps that whole
 * shape intact with headroom for a bigger-than-typical prompt, while still
 * capping a pathological one (a runaway template, a pasted transcript) well
 * below the point where it would dominate `jobs.json`. Chat requests only
 * ever carry a couple of messages (see `GENSTUDIO_REQUEST_MAX_MESSAGES`), so
 * raising this does not reintroduce the "hundreds of evidence entries"
 * ballooning problem the retention/count caps below exist to prevent.
 */
export const GENSTUDIO_REQUEST_MESSAGE_LIMIT = 20_000
/** Characters kept per scalar field value (ids, aspect ratios, file names). */
export const GENSTUDIO_REQUEST_FIELD_LIMIT = 400
/** Messages kept per request (system + user is the normal shape). */
export const GENSTUDIO_REQUEST_MAX_MESSAGES = 8
/** Modality-specific submitted fields kept per request. */
export const GENSTUDIO_REQUEST_MAX_FIELDS = 16
/**
 * How many evidence entries may keep a request preview. A 200-scene image job
 * records 200 entries; keeping a 2 KB preview on each would add ~400 KB to
 * jobs.json on every single update. The newest entries are the ones a user
 * inspects after a failure, so older previews are dropped.
 */
export const GENSTUDIO_REQUEST_PREVIEW_RETAINED = 8

export interface GenStudioRequestMessagePreview {
  role: string
  text: string
  /** True character length of the redacted text before truncation. */
  length: number
  truncated: boolean
}

export interface GenStudioRequestFieldPreview {
  label: string
  value: string
}

export interface GenStudioRequestPreview {
  method: string
  /** API path only — never a full URL, never a query string. */
  path: string
  /** The product/model id actually submitted on the wire. */
  model_id?: string
  /** `response_format` as submitted, serialised for display. */
  response_format?: string
  /** Wire field name → value, e.g. `{ max_completion_tokens: 2048 }`. */
  token_limits?: Record<string, number>
  idempotency_key?: string
  messages?: GenStudioRequestMessagePreview[]
  fields?: GenStudioRequestFieldPreview[]
  captured_at: string
}

export interface GenStudioRequestPreviewInput {
  method?: string
  path: string
  modelId?: string | null
  responseFormat?: unknown
  tokenLimits?: Record<string, unknown>
  idempotencyKey?: string | null
  messages?: Array<{ role: string; content: unknown }>
  fields?: Array<[string, unknown]>
  capturedAt?: string
}

/**
 * Evidence-entry id used for the preview recorded *before* submission.
 *
 * The remote job id does not exist until GenStudio accepts the request, but a
 * request that fails at submission is exactly the one the user wants to read.
 * So the preview lands first under this deterministic placeholder, and the
 * real evidence write adopts the entry once the id arrives (see
 * `recordGenStudioJob` in services/job-queue.ts).
 */
export function pendingGenStudioEntryId(idempotencyKey: string): string {
  return `pending:${idempotencyKey}`
}

export function isPendingGenStudioEntryId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('pending:')
}

/** Strip any query string / fragment and keep a leading-slash API path. */
function normalizePath(value: string): string {
  const raw = String(value || '').trim()
  const withoutQuery = raw.split('?')[0]!.split('#')[0]!
  // A caller that accidentally passed a full URL still yields a bare path.
  const pathOnly = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
  const cleaned = pathOnly.trim()
  if (!cleaned) return '/'
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`
}

function scrubAndClamp(value: string, limit: number): { text: string; length: number; truncated: boolean } {
  // Redaction runs first on purpose: truncating first could cut a secret in
  // half and leave the surviving prefix in the stored snapshot.
  const safe = redactSecrets(String(value ?? ''))
  const length = safe.length
  if (length <= limit) return { text: safe, length, truncated: false }
  const marker = `\n… [truncated — showing ${limit.toLocaleString()} of ${length.toLocaleString()} characters]`
  return { text: `${safe.slice(0, limit)}${marker}`, length, truncated: true }
}

function stringifyFieldValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (Array.isArray(value)) return value.map(item => stringifyFieldValue(item)).join(', ')
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // Defensive: a future multipart message shape must still render as text
    // rather than dumping `[object Object]` into the preview.
    return content
      .map(part => (typeof part === 'string' ? part : stringifyFieldValue(part)))
      .join('\n')
  }
  return stringifyFieldValue(content)
}

/**
 * Build the stored preview. The returned object is already redacted and
 * bounded — callers persist it as-is and have no way to bypass the scrub,
 * which is deliberate: there is no parameter here that accepts a header map,
 * an api key, or an `Authorization` value.
 */
export function buildGenStudioRequestPreview(
  input: GenStudioRequestPreviewInput,
): GenStudioRequestPreview {
  const preview: GenStudioRequestPreview = {
    method: (input.method || 'POST').toUpperCase(),
    path: normalizePath(input.path),
    captured_at: input.capturedAt || new Date().toISOString(),
  }

  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (modelId) preview.model_id = scrubAndClamp(modelId, GENSTUDIO_REQUEST_FIELD_LIMIT).text

  if (input.responseFormat !== undefined && input.responseFormat !== null) {
    const serialized = typeof input.responseFormat === 'string'
      ? input.responseFormat
      : stringifyFieldValue(input.responseFormat)
    preview.response_format = scrubAndClamp(serialized, GENSTUDIO_REQUEST_MESSAGE_LIMIT).text
  }

  if (input.tokenLimits) {
    const limits: Record<string, number> = {}
    for (const [name, value] of Object.entries(input.tokenLimits)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) limits[name] = numeric
    }
    if (Object.keys(limits).length) preview.token_limits = limits
  }

  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
  if (idempotencyKey) {
    preview.idempotency_key = scrubAndClamp(idempotencyKey, GENSTUDIO_REQUEST_FIELD_LIMIT).text
  }

  if (input.messages?.length) {
    const messages = input.messages
      .slice(0, GENSTUDIO_REQUEST_MAX_MESSAGES)
      .map(message => {
        const clamped = scrubAndClamp(messageText(message.content), GENSTUDIO_REQUEST_MESSAGE_LIMIT)
        return {
          role: String(message.role || 'user'),
          text: clamped.text,
          length: clamped.length,
          truncated: clamped.truncated,
        }
      })
      .filter(message => message.text.length > 0)
    if (messages.length) preview.messages = messages
  }

  if (input.fields?.length) {
    const fields: GenStudioRequestFieldPreview[] = []
    for (const [label, value] of input.fields) {
      if (value === undefined || value === null || value === '') continue
      // `fields` is a name/value LIST, so the deep scrubber only ever sees the
      // keys `label` and `value` — a credential-named entry has to be dropped
      // here or it would slip past `redactSensitiveValue` entirely.
      if (isSensitiveFieldName(label)) continue
      if (fields.length >= GENSTUDIO_REQUEST_MAX_FIELDS) break
      fields.push({
        label: String(label),
        value: scrubAndClamp(stringifyFieldValue(value), GENSTUDIO_REQUEST_FIELD_LIMIT).text,
      })
    }
    if (fields.length) preview.fields = fields
  }

  // Final belt-and-braces scrub over the whole object: drops any
  // credential-shaped key name and re-runs pattern redaction on every string.
  return redactSensitiveValue(preview)
}

/**
 * Keep only the newest `GENSTUDIO_REQUEST_PREVIEW_RETAINED` previews so a
 * large batch job cannot balloon jobs.json. Entries themselves are untouched
 * apart from having `request` removed.
 */
export function boundGenStudioRequestPreviews<T extends { request?: unknown }>(entries: T[]): T[] {
  const carrying: number[] = []
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.request) carrying.push(index)
  }
  if (carrying.length <= GENSTUDIO_REQUEST_PREVIEW_RETAINED) return entries
  const drop = new Set(carrying.slice(0, carrying.length - GENSTUDIO_REQUEST_PREVIEW_RETAINED))
  return entries.map((entry, index) => {
    if (!drop.has(index)) return entry
    const { request: _dropped, ...rest } = entry as Record<string, unknown>
    return rest as T
  })
}

/**
 * Redact API keys from arbitrary text before it travels to logs, the
 * renderer, or a job-queue output line.
 *
 * Why: every provider adapter (kie/fal/genaipro/anthropic/openai) slices an
 * upstream response or SDK error message into `throw new Error(... ${text} ...)`.
 * If the upstream ever echoes the submitted key — kie/fal/genaipro have not
 * been verified against this — that key lands in plaintext in `logs/*.log`,
 * which the operator mails between machines as a support bundle.
 *
 * Two layers:
 *   1. Exact-match scrub for any secret the caller has in scope (the actual
 *      apiKey passed to `fetch()`). This is the load-bearing case.
 *   2. Defensive pattern scrub for `Bearer <token>` and `sk-<token>` shapes,
 *      so a key the caller forgot to thread in still gets masked.
 *
 * Zero deps — `String.prototype.replaceAll` and one regex per pattern.
 */

const REDACTED = '[REDACTED]'
const activeSecrets = new Set<string>()

const SENSITIVE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|session[_-]?secret|client[_-]?secret|password|passphrase|bot[_-]?token|hub[_-]?token|genstudio[_-]?api[_-]?key)$/i

/**
 * Does this name identify a credential-bearing field?
 *
 * `redactSensitiveValue` applies this to object *keys*. Callers that carry
 * name/value pairs in some other shape — a `{ label, value }` list, for
 * instance — must apply it themselves, because the deep scrubber only ever
 * sees `label` and `value` as the keys in that case.
 */
export function isSensitiveFieldName(name: string): boolean {
  const normalized = String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SENSITIVE_FIELD.test(normalized) || /_api_key$/i.test(normalized)
}

/**
 * Register a runtime secret once it crosses the trusted main-process boundary.
 *
 * Crash handlers and generic loggers do not receive the provider key as an
 * argument, so pattern-only redaction is not enough for arbitrary scoped
 * tokens. Keeping an in-memory exact-match set lets those final boundaries
 * scrub every key that has actually been loaded without reading the secrets
 * file merely for logging.
 */
export function registerSecretForRedaction(secret: string | undefined | null): void {
  if (typeof secret !== 'string') return
  const trimmed = secret.trim()
  if (trimmed.length >= 4) activeSecrets.add(trimmed)
}

/**
 * Replace every non-empty secret occurrence in `text` with `[REDACTED]`.
 *
 * Pass any number of secrets — `undefined` / `null` / empty strings are
 * skipped, so callers can pass `apiKey` without a guard. Common case-shifted
 * forms (lowercase / uppercase) are also redacted in case the upstream
 * normalises the key before echoing it.
 *
 * After exact-match scrubbing, defensive patterns redact bare
 * `Bearer <token>` headers and `sk-<token>` shapes that look like
 * unrecognised API keys.
 */
export function redactSecrets(text: string, ...secrets: Array<string | undefined | null>): string {
  if (!text) return text
  let out = text
  for (const secret of [...secrets, ...activeSecrets]) {
    if (!secret || typeof secret !== 'string') continue
    // Case-insensitive scan: provider may normalise the key before echoing
    // (lowercased header values are common). Walk the lowercased mirror,
    // splice [REDACTED] over each match in the original.
    const needle = secret.toLowerCase()
    if (!needle) continue
    let scanFrom = 0
    let rebuilt = ''
    const haystack = out.toLowerCase()
    while (true) {
      const hit = haystack.indexOf(needle, scanFrom)
      if (hit === -1) {
        rebuilt += out.slice(scanFrom)
        break
      }
      rebuilt += out.slice(scanFrom, hit) + REDACTED
      scanFrom = hit + needle.length
    }
    out = rebuilt
  }
  // Defensive: a Bearer header value (Authorization: Bearer XXX) — the
  // token itself is the secret, the literal `Bearer` prefix is fine to keep.
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g, `Bearer ${REDACTED}`)
  // fal.ai and a few other APIs use `Authorization: Key <secret>`.
  out = out.replace(/\bKey\s+[A-Za-z0-9._\-+/=]{8,}/g, `Key ${REDACTED}`)
  // Defensive: any `sk-XXXX` token (OpenAI / Anthropic / kie style).
  out = out.replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, REDACTED)
  // GenStudio scoped keys use the gsk_* family. Keep this explicit even
  // though loaded keys are exact-match registered above: it protects error
  // text produced before the secrets store has been read in this process.
  out = out.replace(/\bgsk_[A-Za-z0-9._\-]{8,}/gi, REDACTED)
  // Key/value text and JSON snippets frequently appear in provider errors.
  // Preserve the field name so diagnostics remain understandable.
  out = out.replace(
    /((?:["']?(?:authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|session[_-]?secret|client[_-]?secret|password|passphrase|bot[_-]?token|hub[_-]?token|genstudio[_-]?api[_-]?key)["']?)\s*[:=]\s*)(["']?)(?!Bearer\b|Key\b)([^\s,;}"']{4,})(["']?)/gi,
    `$1$2${REDACTED}$4`,
  )
  // Query strings and credential-bearing URLs must never be copied into a
  // log or renderer-visible diagnostic.
  out = out.replace(
    /([?&](?:api[_-]?key|key|token|access[_-]?token|secret|password)=)[^&#\s]+/gi,
    `$1${REDACTED}`,
  )
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, `$1${REDACTED}@`)
  return out
}

/** Deep-clone JSON-like diagnostic data while removing secret-bearing keys. */
export function redactSensitiveValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (value == null || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return '[BINARY]' as T
  if (value instanceof Date) return value.toISOString() as T
  if (seen.has(value as object)) return '[CIRCULAR]' as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveValue(item, seen)) as T
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveFieldName(key)) {
      out[key] = item ? REDACTED : item
    } else {
      out[key] = redactSensitiveValue(item, seen)
    }
  }
  return out as T
}

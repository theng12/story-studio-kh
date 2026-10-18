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

const SENSITIVE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-story-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|session[_-]?secret|client[_-]?secret|password|passphrase|bot[_-]?token|hub[_-]?token|genstudio[_-]?api[_-]?key)$/i

/**
 * Does this name identify a credential-bearing field?
 *
 * `redactSensitiveValue` applies this to object *keys*. Callers that carry
 * name/value pairs in some other shape — a `{ label, value }` list, for
 * instance — must apply it themselves, because the deep scrubber only ever
 * sees `label` and `value` as the keys in that case.
 */
export function isSensitiveFieldName(name: string): boolean {
  const key = String(name ?? '')
  const known = sensitiveNameCache.get(key)
  if (known !== undefined) return known
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  const result = SENSITIVE_FIELD.test(normalized) || /_api_key$/i.test(normalized)
  // Job records repeat the same few dozen field names thousands of times; ids used as keys must
  // not grow this without bound.
  if (sensitiveNameCache.size >= 2_000) sensitiveNameCache.clear()
  sensitiveNameCache.set(key, result)
  return result
}
const sensitiveNameCache = new Map<string, boolean>()

/**
 * Every pattern pass below needs one of these substrings to match at all. A string without any of
 * them (nearly every job log line: "Scene 12 saved ... in 4.2s") skips all eight regex scans. This
 * is a superset test: it must contain a trigger for EVERY pattern, and the equivalence test pins it
 * against the full scan on a corpus.
 */
const PATTERN_TRIGGERS = /bearer|key|sk-|gsk_|ssk_|authorization|token|secret|password|passphrase|:\/\//i

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
  // Case-insensitive scan: provider may normalise the key before echoing
  // (lowercased header values are common). Walk a lowercased mirror, splice
  // [REDACTED] over each match in the original.
  //
  // The mirror is built once per text and only rebuilt after a match changed
  // it, and a text that does not CONTAIN a secret is returned untouched. Both
  // matter: this runs on every string of every job in the public serialization
  // path, so the previous shape — a fresh lowercase copy plus a full `slice`
  // rebuild per loaded key, matching or not — put two extra copies of every
  // job log line on the heap per registered secret (measured: 1.47 s of the
  // 2.85 s a 14,250-job / 5.15M-string snapshot spent redacting).
  let mirror = ''
  for (const secret of [...secrets, ...activeSecrets]) {
    if (!secret || typeof secret !== 'string') continue
    const needle = secret.toLowerCase()
    if (!needle) continue
    if (!mirror) mirror = out.toLowerCase()
    if (mirror.indexOf(needle) === -1) continue
    let scanFrom = 0
    let rebuilt = ''
    while (true) {
      const hit = mirror.indexOf(needle, scanFrom)
      if (hit === -1) {
        rebuilt += out.slice(scanFrom)
        break
      }
      rebuilt += out.slice(scanFrom, hit) + REDACTED
      scanFrom = hit + needle.length
    }
    out = rebuilt
    mirror = ''
  }
  if (!PATTERN_TRIGGERS.test(out)) return out
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
  // Story Studio's own server-mode automation keys (`ssk_` + 43 base64url).
  // The length floor keeps the `ssk_session` cookie name itself readable.
  out = out.replace(/\bssk_[A-Za-z0-9_-]{40,}/g, REDACTED)
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

/**
 * Deep-clone JSON-like diagnostic data while removing secret-bearing keys.
 *
 * `ancestors` holds only the objects on the path from the root to this value, so a real cycle
 * becomes '[CIRCULAR]' but an object merely referenced twice (a Pipeline's shared `pacing`) is
 * copied both times. Before 1.4.266 this was a global "seen" set, and every second reference
 * was saved to jobs.json as the string '[CIRCULAR]'.
 */
export function redactSensitiveValue<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (value == null || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return '[BINARY]' as T
  if (value instanceof Date) return value.toISOString() as T
  if (ancestors.has(value as object)) return '[CIRCULAR]' as T
  ancestors.add(value as object)
  try {
    if (Array.isArray(value)) {
      return value.map(item => redactSensitiveValue(item, ancestors)) as T
    }

    const out: Record<string, unknown> = {}
    // `Object.keys` + index, not `Object.entries`: entries allocates an array of
    // [key, value] pairs for every object on the path. A public job snapshot
    // walks millions of objects, and this walk is the whole cost of it.
    const source = value as Record<string, unknown>
    for (const key of Object.keys(source)) {
      if (isSensitiveFieldName(key)) {
        out[key] = source[key] ? REDACTED : source[key]
      } else {
        out[key] = redactSensitiveValue(source[key], ancestors)
      }
    }
    return out as T
  } finally {
    ancestors.delete(value as object)
  }
}

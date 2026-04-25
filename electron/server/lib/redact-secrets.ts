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
  for (const secret of secrets) {
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
  // Defensive: any `sk-XXXX` token (OpenAI / Anthropic / kie style).
  out = out.replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, REDACTED)
  return out
}

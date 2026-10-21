// ── Filter-graph argument escaping ──────────────────────────────────────

/**
 * Escape an arbitrary value for use as an FFmpeg *filter option value*
 * inside a `-filter_complex` / `-vf` graph description.
 *
 * FFmpeg unescapes a filter option value TWICE, both passes via
 * `av_get_token()`:
 *
 *   1. The filtergraph parser takes a filter's whole argument list as one
 *      token (terminators: `[`, `]`, `,`, `;`).
 *   2. `av_opt_set_from_string()` then splits that argument list into
 *      `key=value` pairs (terminator: `:`).
 *
 * At *each* level `\` escapes the next character, and a `'` opens a literal
 * run that ends at the next `'`. The trap: **a backslash is not an escape
 * inside a quoted run**. So the intuitive "wrap the value in single quotes"
 * approach fails the instant the value itself contains an apostrophe — the
 * value's own `'` closes the quote early and everything after it is
 * reparsed as filter syntax. That is exactly how one contextual cue reading
 * `Constantinople's main avenue` took down an entire 333-scene render: the
 * whole graph was rejected, not just that cue.
 *
 * Quoting also cannot express a literal newline, so two-line overlays were
 * impossible to encode inline no matter how the quotes were arranged.
 *
 * Therefore: do not quote at all. Backslash-escape for level 2, then
 * backslash-escape that result again for level 1, and emit the value bare
 * (`text=...`, no surrounding quotes). It then survives both passes
 * byte-for-byte — apostrophes, colons, commas, percent signs, backslashes,
 * brackets, semicolons and literal newlines included.
 *
 * Verified against the real FFmpeg parser in
 * `__tests__/ffmpeg-filter-escape.test.ts`, which feeds each case through
 * an actual `ffmpeg -filter_complex` invocation rather than regex-matching
 * our own output.
 */
export function escapeFilterArgValue(value: string): string {
  // Level 2 — the option-value tokenizer stops at ':'.
  const level2 = value.replace(/([\\':])/g, '\\$1')
  // Level 1 — the filtergraph tokenizer stops at '[', ']', ',' and ';'.
  return level2.replace(/([\\'[\],;])/g, '\\$1')
}

/**
 * Escape a filesystem path for use as an FFmpeg filter option value —
 * `ass=filename=…`, `subtitles=filename=…`.
 *
 * Two steps. Windows separators are normalised to forward slashes first:
 * FFmpeg accepts them on every platform, and it stops `C:\Users\…` becoming a
 * thicket of escaped backslashes. Then the ordinary two-level filter escape
 * applies — which is the part a path containing an apostrophe needs. An
 * episode folder like `EP0068 - Rome's Fall` used to close the quoted run
 * early and take the whole graph down with it, dropping the burned-in
 * subtitles into the no-effects recovery tier. Same defect as the contextual
 * cues, same fix, one implementation.
 *
 * The result is emitted unquoted, so call sites must NOT wrap it in quotes.
 */
export function escapeFilterPath(p: string): string {
  return escapeFilterArgValue(p.replace(/\\/g, '/'))
}

/**
 * well-formed-text — keep model-generated text valid Unicode on the way out.
 *
 * The bug this exists for (1.4.9): a YouTube Finalizer run died with
 *
 *   GenStudio KH rejected the product request before generation:
 *   'utf-8' codec can't encode character '\ud83e' in position 651:
 *   surrogates not allowed.
 *
 * `\ud83e` is a lone HIGH SURROGATE. Characters above U+FFFF — every emoji a
 * model likes to sprinkle into a title or a description — are stored in a
 * JavaScript string as a SURROGATE PAIR of two UTF-16 code units. UTF-8 has no
 * encoding for half a pair, so any consumer that encodes the string (GenStudio
 * is a Python service) refuses it. GenStudio's refusal is CORRECT; the invalid
 * string is ours.
 *
 * Two ways a lone surrogate gets into an outbound request, and this module
 * covers both:
 *
 *   1. WE SPLIT ONE. `String.prototype.slice` counts UTF-16 code units, not
 *      characters, so `text.slice(0, 1500)` cuts straight through a pair
 *      whenever an emoji happens to straddle position 1500. This is why the
 *      failure looked like a flaky provider: regenerate, the text changes,
 *      the emoji lands somewhere else, and the same model succeeds. Use
 *      `truncateChars` instead of `slice` for any length cap on text.
 *
 *   2. THE MODEL EMITTED ONE. Providers do return stray surrogates directly,
 *      and no truncation rule can prevent that. `wellFormedJson` is the
 *      backstop at the network boundary: every request body Story Studio
 *      serialises for GenStudio passes through it.
 *
 * Neither layer mangles text. Truncation cuts BEFORE a pair it would split
 * (losing at most one emoji from an already-truncated excerpt), and the
 * sanitiser replaces a stray surrogate with U+FFFD REPLACEMENT CHARACTER —
 * the standard substitution, and what Node's own UTF-8 encoder would have
 * produced anyway, except that here it happens before the request is built
 * rather than after it has been rejected.
 *
 * Runtime note: `String.prototype.toWellFormed` / `isWellFormed` are ES2024
 * and present in Electron 43's bundled Node 24 (verified in the shipping
 * runtime, not assumed). `toWellFormedText` still falls back to an explicit
 * surrogate scan so the module is safe to reuse anywhere.
 */

/** U+D800..U+DBFF — the first half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** U+DC00..U+DFFF — the second half of a surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Truncate `text` to at most `maxChars` UTF-16 code units WITHOUT splitting a
 * surrogate pair.
 *
 * The cap stays a code-unit cap on purpose: every call site replaced by this
 * function was budgeting prompt size with `.slice(0, n)`, and re-reading the
 * cap as "code points" would silently let an emoji-heavy excerpt grow past
 * the budget it was calibrated for. The only behavioural change is at the
 * boundary — if the last unit kept would be an orphaned high surrogate, the
 * whole character is dropped and the result is one unit shorter.
 */
export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  // Cut before the pair, never through it. A high surrogate in the last kept
  // position has its low half in the discarded remainder — and if it was
  // already a lone surrogate, dropping it is right too.
  const end = isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars
  return text.slice(0, end)
}

/**
 * Return `text` with every lone surrogate replaced by U+FFFD. Well-formed
 * text — including all correctly paired emoji — is returned unchanged.
 */
export function toWellFormedText(text: string): string {
  if (typeof (String.prototype as { toWellFormed?: () => string }).toWellFormed === 'function') {
    return (text as unknown as { toWellFormed: () => string }).toWellFormed()
  }
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isHighSurrogate(code)) {
      if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
        out += text[i] + text[i + 1]
        i++
      } else {
        out += '�'
      }
    } else if (isLowSurrogate(code)) {
      out += '�'
    } else {
      out += text[i]
    }
  }
  return out
}

/** True when `text` contains no lone surrogate. */
export function isWellFormedText(text: string): boolean {
  if (typeof (String.prototype as { isWellFormed?: () => boolean }).isWellFormed === 'function') {
    return (text as unknown as { isWellFormed: () => boolean }).isWellFormed()
  }
  return toWellFormedText(text) === text
}

/**
 * Deep-copy `value`, repairing every string it contains.
 *
 * Object KEYS are repaired as well: a key is just as capable of carrying a
 * stray surrogate, and the receiving service decodes both.
 */
export function toWellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return toWellFormedText(value) as unknown as T
  if (Array.isArray(value)) return value.map(item => toWellFormedDeep(item)) as unknown as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[toWellFormedText(key)] = toWellFormedDeep(item)
    }
    return out as unknown as T
  }
  // Numbers, booleans, null, Dates, Buffers, class instances: nothing here can
  // hold a lone surrogate that `JSON.stringify` would then emit as one.
  return value
}

/**
 * `JSON.stringify` for an outbound request body, guaranteeing the result is
 * encodable as UTF-8.
 *
 * `JSON.stringify` alone is NOT enough. Since ES2019 it escapes a lone
 * surrogate as the six-character sequence `\udXXX`, which makes the JS string
 * well-formed — and then the receiving service's JSON parser faithfully
 * decodes that escape back into a lone surrogate and fails on it. The repair
 * has to happen to the VALUES, before serialisation.
 */
export function wellFormedJson(value: unknown): string {
  return JSON.stringify(toWellFormedDeep(value))
}

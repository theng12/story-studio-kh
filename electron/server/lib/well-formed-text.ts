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

/* ────────────────────────────────────────────────────────────────────────────
 * Emoji removal (v1.4.12)
 *
 * *"about the emojis. i think to make sure we don't generate emojis when we
 * don't have to. it's unprofessional"*
 *
 * This lives HERE, beside the surrogate repair, and not in a module of its own.
 * It is the same problem seen from the other end: 1.4.9 shipped because a cut
 * landed inside an emoji and kept half of one. Anything that removes emoji by
 * code unit — the obvious `text.replace(/[\u{1F300}-\u{1FAFF}]/gu, '')` — can
 * recreate that failure exactly, because a single emoji is often SEVERAL code
 * points: a ZWJ family, a skin-tone modifier, a flag's two regional
 * indicators, a keycap. Remove one piece and the leftovers are garbage.
 *
 * So removal is done by GRAPHEME CLUSTER: what a reader would call one
 * character. `Intl.Segmenter` groups the whole sequence, and a cluster is
 * either kept whole or dropped whole. There is no state in which half of one
 * survives.
 *
 * ── What counts as an emoji, and what deliberately does not ──
 *
 * `\p{Extended_Pictographic}` alone is too greedy: (c), (r), (tm), and marks
 * like the double exclamation carry it, and stripping those from a title would
 * be a surprise, not a service. A cluster is treated as emoji when it holds
 *   - a code point with `\p{Emoji_Presentation}` (defaults to a colour glyph —
 *     every modern emoji, all of them above U+FFFF), or
 *   - U+FE0F, the variation selector that explicitly ASKS for the emoji
 *     rendering of an otherwise-textual character, or
 *   - a regional indicator, which is how flags are written.
 *
 * So a bare (tm) or (c) stays, and the same character followed by U+FE0F goes.
 * That line is where the owner's own judgement would put it: the first is
 * typography, the second is a decoration.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A code point that renders as a colour emoji without being asked to. */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
/** The two halves of a flag. */
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u
/** U+FE0F asks for the emoji rendering; U+20E3 is the keycap enclosure. */
const EMOJI_SELECTORS = /[\uFE0F\u20E3]/

/** True when this ONE grapheme cluster should be read as an emoji. */
function clusterIsEmoji(cluster: string): boolean {
  return EMOJI_PRESENTATION.test(cluster)
    || REGIONAL_INDICATOR.test(cluster)
    || EMOJI_SELECTORS.test(cluster)
}

let segmenter: Intl.Segmenter | null | undefined

/** One shared grapheme segmenter, or null where Intl.Segmenter is absent. */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('en', { granularity: 'grapheme' })
        : null
    } catch { segmenter = null }
  }
  return segmenter
}

/**
 * Tidy the gap a removed emoji leaves behind.
 *
 * "Ancient Rome 🔥 Explained" must not become "Ancient Rome  Explained", and
 * "🔥 Ancient Rome" must not keep its leading space. Runs of spaces and tabs
 * collapse to one; line ends are trimmed. NEWLINES ARE PRESERVED — a YouTube
 * description's paragraph breaks are content, and an emoji sitting alone on
 * its own line leaves that line empty rather than joining two paragraphs.
 */
function tidyGaps(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(line => line.replace(/[^\S\n]+$/, '').replace(/^[^\S\n]+/, ''))
    .join('\n')
    .trim()
}

/**
 * Remove every emoji from `text`, one whole grapheme cluster at a time.
 *
 * Only ever call this on MODEL-GENERATED text. Text the owner typed is his,
 * emoji included — see `stripEmojiFromGenerated` for the rule that enforces
 * that, and never reach past it to call this on a mixed field.
 *
 * Returns `text` unchanged when it holds no emoji, so a caller can compare by
 * identity to know whether anything was removed.
 */
export function stripEmoji(text: string): string {
  if (!text) return text
  const seg = graphemeSegmenter()
  if (!seg) {
    // No Intl.Segmenter: leave the text alone rather than remove by code unit.
    // Half an emoji is the 1.4.9 bug, and it is worse than an emoji.
    return text
  }
  let sawEmoji = false
  let out = ''
  for (const { segment } of seg.segment(text)) {
    if (clusterIsEmoji(segment)) { sawEmoji = true; continue }
    out += segment
  }
  if (!sawEmoji) return text
  return tidyGaps(out)
}

/** True when `text` contains at least one emoji. */
export function containsEmoji(text: string): boolean {
  const seg = graphemeSegmenter()
  if (!seg || !text) return false
  for (const { segment } of seg.segment(text)) {
    if (clusterIsEmoji(segment)) return true
  }
  return false
}

/**
 * The rule that protects his own writing.
 *
 * `generated` is cleaned only when the text he supplied — his script, his
 * title, his standards file, his prompt — contains no emoji of its own. The
 * moment his source has one, he has made a choice about emoji for this piece of
 * work, and the model's are left alone with it rather than the app overruling
 * him on a field it cannot tell apart.
 *
 * Pass every scrap of his text that fed this generation as `sources`. Passing
 * none means "all of this is the model's", which is true for a title written
 * from a topic line but is NOT true for a description assembled around prose he
 * edited — for those, clean the generated block BEFORE it is merged, never the
 * merged result.
 */
export function stripEmojiFromGenerated(
  generated: string,
  sources: Array<string | null | undefined> = [],
): string {
  if (!generated) return generated
  for (const source of sources) {
    if (source && containsEmoji(source)) return generated
  }
  return stripEmoji(generated)
}

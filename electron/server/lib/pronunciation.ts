/**
 * Pronunciation lexicon — pre-TTS substitution helper.
 *
 * Audio generation reads the brand's lexicon and rewrites narration
 * text *before* sending it to the TTS provider. This lets a user fix a
 * single mispronounced proper noun without re-rendering the whole
 * episode.
 *
 * Match semantics:
 *   - ASCII-only terms get a word-boundary match (\b{term}\b) so "Sok"
 *     inside "Sokhom" is left alone.
 *   - Terms containing non-ASCII characters (Khmer, accented Latin)
 *     fall back to literal substring match — \b is ASCII-only and
 *     would skip valid matches in those scripts.
 *   - Case-insensitive by default; entries can opt into case-sensitive
 *     matching with `case_sensitive: true`.
 *
 * Replacement priority (per entry, picked at substitution time):
 *   1. ssml      — full SSML override (when provider supports SSML).
 *   2. ipa       — wrapped as <phoneme alphabet="ipa" ph="…">term</phoneme>
 *                  (when provider supports SSML).
 *   3. alt_spelling — TTS-friendly respelling (any provider).
 *   4. (skip)    — entry contributes nothing usable, no substitution.
 *
 * Today `ssmlSupported: true` is set only for direct ElevenLabs TTS.
 * Other providers fall through to alt_spelling.
 */

import type { BrandPronunciation } from '../models/types.js'

export interface SubstitutionRecord {
  /** The original term as defined in the lexicon. */
  term: string
  /** What it was replaced with (alt_spelling for now). */
  replacement: string
  /** How many occurrences were replaced in this pass. */
  count: number
}

export interface ApplyLexiconResult {
  /** The transformed text. */
  text: string
  /** One entry per term that produced at least one replacement. */
  substitutions: SubstitutionRecord[]
}

/** Escape regex metacharacters so user terms with `.`, `(`, etc. work literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True if every codepoint in `s` is in basic ASCII. \b only works for ASCII word chars. */
function isAsciiOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false
  }
  return true
}

export interface ApplyLexiconOptions {
  /**
   * Whether the downstream TTS provider supports SSML phoneme tags.
   * When true, `ssml` and `ipa` fields on each entry are honoured;
   * when false (default), the helper falls through to alt_spelling
   * and any entry without alt_spelling is skipped.
   */
  ssmlSupported?: boolean
}

/** Escape `&`, `<`, `>`, `"` for safe inclusion in SSML attribute / text content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Pick the replacement string for a single lexicon entry given the
 * provider capability. Returns null when there's nothing to substitute
 * (entry has no usable replacement for this provider).
 */
function pickReplacement(
  entry: BrandPronunciation,
  ssmlSupported: boolean,
): string | null {
  if (ssmlSupported) {
    if (entry.ssml && entry.ssml.trim()) return entry.ssml
    if (entry.ipa && entry.ipa.trim()) {
      return `<phoneme alphabet="ipa" ph="${escapeXml(entry.ipa)}">${escapeXml(entry.term)}</phoneme>`
    }
  }
  if (entry.alt_spelling && entry.alt_spelling.length) return entry.alt_spelling
  return null
}

/**
 * Apply a brand's pronunciation lexicon to a block of narration text.
 * Returns the transformed text plus a record of every substitution
 * that fired (so the caller can log "Lexicon: replaced X → Y (3×)").
 *
 * Empty lexicon (or a lexicon where no entry has a usable replacement
 * for the current provider) is a no-op — text is returned unchanged
 * with an empty substitutions list.
 */
export function applyLexicon(
  text: string,
  lexicon: BrandPronunciation[] | null | undefined,
  options: ApplyLexiconOptions = {},
): ApplyLexiconResult {
  if (!text || !lexicon?.length) return { text, substitutions: [] }
  const ssmlSupported = options.ssmlSupported === true

  let working = text
  const substitutions: SubstitutionRecord[] = []

  for (const entry of lexicon) {
    if (!entry?.term) continue
    const replacement = pickReplacement(entry, ssmlSupported)
    if (!replacement) continue

    const term = entry.term
    if (term === replacement) continue  // identity sub — skip

    const flags = entry.case_sensitive ? 'g' : 'gi'
    const escaped = escapeRegex(term)
    // Word-boundary only for ASCII-only terms (see file JSDoc on why).
    const pattern = isAsciiOnly(term)
      ? new RegExp(`\\b${escaped}\\b`, flags)
      : new RegExp(escaped, flags)

    let count = 0
    const replaced = working.replace(pattern, () => {
      count++
      return replacement
    })
    if (count > 0) {
      working = replaced
      substitutions.push({ term, replacement, count })
    }
  }

  return { text: working, substitutions }
}

/**
 * Format a substitutions list for a single human-readable log line.
 * Returns null when there's nothing to say (empty list) so callers can
 * skip the log entirely.
 */
export function formatSubstitutionsLog(subs: SubstitutionRecord[]): string | null {
  if (!subs.length) return null
  const parts = subs.map(s => `${s.term} → ${s.replacement}${s.count > 1 ? ` (${s.count}×)` : ''}`)
  return `Lexicon: ${parts.join(', ')}`
}

/**
 * normalizeForTts — rewrite narration into clean, spoken-friendly punctuation
 * before it's sent to ANY TTS engine (v1.0.215+).
 *
 * LLM-written narration loves em dashes, smart quotes, ellipses, semicolons,
 * and the odd stray markdown mark. Robust cloud voices (ElevenLabs) mostly
 * cope, but local engines (Kokoro, Bark, …) read an em dash as a garbled
 * run-on ("eyes—a" → "eyesa") or an unnatural pause — which is what makes the
 * audio sound fake. This is the deterministic SAFEGUARD: it runs on every
 * section of every generation, so the audio reads naturally regardless of
 * what the script carried (and regardless of whether the LLM obeyed the
 * TTS-friendly writing instruction in the script prompt).
 *
 * Conservative by design — it only rewrites notation that reliably hurts
 * spoken delivery. A normal ASCII hyphen ("well-being") is left intact.
 *
 * IMPORTANT: must be applied identically everywhere narration is chunked for
 * TTS — the audio generator AND the audio reconciler — or chunk boundaries
 * (and therefore the predicted chunk filenames) would diverge and a fully
 * generated section would look "missing".
 */

export interface TtsNormalizeResult {
  text: string
  /** Count of TTS-hostile marks rewritten (for an operator-facing log line). */
  changes: number
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? m.length : 0
}

export function normalizeForTts(input: string): TtsNormalizeResult {
  if (!input) return { text: input ?? '', changes: 0 }

  let t = input
  let changes = 0

  // 1. em / en / horizontal-bar dashes + double-hyphen used as a clause break
  //    → comma (a natural spoken pause). A single ASCII '-' (e.g. "well-being")
  //    is deliberately NOT touched.
  const DASHES = /\s*(?:—|–|―|--)\s*/g
  changes += countMatches(t, DASHES)
  t = t.replace(DASHES, ', ')

  // 2. smart/curly quotes → ASCII.
  const SMART_QUOTES = /[“”‘’]/g
  changes += countMatches(t, SMART_QUOTES)
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")

  // 3. unicode ellipsis → ASCII "..." (engines handle the three-dot form).
  const ELLIPSIS = /…/g
  changes += countMatches(t, ELLIPSIS)
  t = t.replace(ELLIPSIS, '...')

  // 4. semicolons read awkwardly aloud → comma.
  const SEMI = /\s*;\s*/g
  changes += countMatches(t, SEMI)
  t = t.replace(SEMI, ', ')

  // 5. markdown leaking from LLM output. Strip ONLY leading headings + PAIRED
  //    emphasis markers, keeping the wrapped words. Lone marks are deliberately
  //    left intact so real prose survives — "5 * 3", "rated 4*", a stray
  //    backtick — and underscore emphasis is matched only at word boundaries,
  //    which a snake_case identifier never has (so "snake_case_term" is safe).
  let mdChanges = 0
  // leading ATX heading marker → drop it, keep the heading text.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, () => { mdChanges++; return '' })
  // **bold** / __bold__ → bold (requires a matched pair wrapping non-space).
  t = t.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_m, _mk, inner) => { mdChanges++; return inner })
  // *italic* → italic (paired asterisks wrapping non-space; lone * untouched).
  t = t.replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, (_m, inner) => { mdChanges++; return inner })
  // _italic_ → italic, ONLY at word boundaries so snake_case is never touched.
  t = t.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s).,!?;:'"]|$)/g, (_m, pre, inner) => { mdChanges++; return pre + inner })
  // `code` → code (paired backticks; a lone backtick is left alone).
  t = t.replace(/`([^`\n]+)`/g, (_m, inner) => { mdChanges++; return inner })
  changes += mdChanges

  // 6. cosmetic cleanup (not counted): collapse runs of spaces, pull
  //    punctuation back against its word, and drop comma pile-ups / orphan
  //    commas the substitutions above can create (e.g. "word—." → "word, ." →
  //    "word.").
  t = t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  return { text: t, changes }
}

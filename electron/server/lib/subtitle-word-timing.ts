/**
 * Per-word timings for word-by-word caption modes.
 *
 * ── Honesty first ──────────────────────────────────────────────────────────
 *
 * Word modes need to know when each word is spoken. Story Studio has cue-level
 * SRT and nothing else, so `estimatedWordTimingSource` DERIVES word times by
 * distributing a cue's duration across its words. That is an estimate, every
 * word it returns is stamped `precision: 'estimated'`, and the properties
 * panel says so in plain words. It is not allowed to look like measurement.
 *
 * Real per-word timings do exist upstream — Voice Studio's Whisper returns
 * them and GenStudio stores them — but GenStudio does not publish them yet.
 * `createExactWordTimingSource` is the seam that will carry them: it is
 * deliberately unwired and throws if used, so adopting the real data is a
 * small, obvious change in one place rather than a rewrite of the engine.
 * Building the network call is NOT part of this module.
 *
 * ── Why character-weighted, not even ───────────────────────────────────────
 *
 * Splitting a cue evenly gives "a" and "extraordinary" the same time, which
 * reads visibly wrong on a highlight sweep — short words linger and long words
 * flash past. Weighting by letter count tracks speech far more closely. Each
 * word carries a constant of 1 on top of its letters so a one-letter word is
 * not squeezed to nothing, and punctuation is excluded from the weight because
 * a comma is not spoken.
 */

import type { SrtCue } from './subtitle-builder.js'

export type WordTimingPrecision = 'estimated' | 'exact'

export interface TimedWord {
  /** The word exactly as it appears in the cue, punctuation included. */
  text: string
  start_sec: number
  end_sec: number
  /** `estimated` = interpolated from the cue. `exact` = measured upstream. */
  precision: WordTimingPrecision
}

export interface WordTimingSource {
  /** Stable id for cache keys and diagnostics. */
  readonly id: string
  /** What every word from this source is stamped with. */
  readonly precision: WordTimingPrecision
  /** Word times for one cue, in reading order, inside the cue's window. */
  forCue(cue: SrtCue): TimedWord[]
}

/** Letters and digits only — a comma is not spoken, so it earns no time. */
function spokenLength(word: string): number {
  const core = word.replace(/[^\p{L}\p{N}]/gu, '')
  return core.length
}

/**
 * Weight for one word. `1 +` letters keeps a one-letter word ("a", "I") from
 * collapsing to a near-zero slice, and keeps a pure-punctuation token ("—")
 * from taking zero time and producing a zero-length `\t` window.
 */
export function wordWeight(word: string): number {
  return 1 + spokenLength(word)
}

/**
 * Split a cue's text into words, preserving order and original punctuation.
 * Collapses any whitespace run (including the `\n` inside a wrapped cue).
 */
export function splitCueWords(text: string): string[] {
  return String(text || '').trim().split(/\s+/).filter(Boolean)
}

/**
 * Distribute `[start, end]` across `words` in proportion to `wordWeight`.
 *
 * Exported separately from the source so the distribution itself is directly
 * testable, and so a future exact source can reuse it to fill gaps for words
 * the upstream transcript did not time.
 */
export function distributeWordTimes(
  words: string[],
  startSec: number,
  endSec: number,
  precision: WordTimingPrecision = 'estimated',
): TimedWord[] {
  if (!words.length) return []
  const start = Number.isFinite(startSec) ? startSec : 0
  const end = Number.isFinite(endSec) ? Math.max(start, endSec) : start
  const span = end - start
  const weights = words.map(wordWeight)
  const total = weights.reduce((a, b) => a + b, 0) || words.length

  const out: TimedWord[] = []
  let cursor = start
  for (let i = 0; i < words.length; i++) {
    // Accumulate from the running cursor and pin the LAST word to `end`, so
    // rounding drift never leaves a gap or overshoots the cue window.
    const share = (span * weights[i]!) / total
    const wordEnd = i === words.length - 1 ? end : Math.min(end, cursor + share)
    out.push({ text: words[i]!, start_sec: cursor, end_sec: wordEnd, precision })
    cursor = wordEnd
  }
  return out
}

/**
 * The only source wired today. Interpolates from the cue and stamps every word
 * `estimated`. Never throws — a cue with no words yields an empty list and the
 * caller falls back to whole-cue rendering.
 */
export const estimatedWordTimingSource: WordTimingSource = {
  id: 'interpolated-from-cue',
  precision: 'estimated',
  forCue(cue: SrtCue): TimedWord[] {
    return distributeWordTimes(splitCueWords(cue.text), cue.start_sec, cue.end_sec, 'estimated')
  },
}

/**
 * The seam for real, measured word timings.
 *
 * GenStudio computes per-word times (Voice Studio's Whisper produces them and
 * GenStudio stores them) but does not yet publish an endpoint that serves
 * them, so this is intentionally unwired. When that endpoint exists, the only
 * change needed is to fetch the word list into `words` and hand this source to
 * `buildSubtitleAss` — the engine already reads `precision` off every word and
 * the UI already renders the difference.
 *
 * Words are matched to a cue by overlap with the cue's window. Any cue the
 * upstream data does not cover falls back to interpolation, so a partial
 * transcript degrades to `estimated` for the affected cues instead of losing
 * word mode entirely.
 */
export function createExactWordTimingSource(words: TimedWord[] | null | undefined): WordTimingSource {
  if (!words) {
    throw new Error(
      'Exact word timings are not available yet: The Gateway does not publish per-word times for a transcription. '
      + 'Use estimatedWordTimingSource until that endpoint exists.',
    )
  }
  const sorted = [...words].sort((a, b) => a.start_sec - b.start_sec)
  return {
    // A diagnostic label, deliberately not a product identifier — the source is
    // whatever upstream publishes measured words, and must not name one.
    id: 'upstream-measured-words',
    precision: 'exact',
    forCue(cue: SrtCue): TimedWord[] {
      const inside = sorted.filter(w => w.end_sec > cue.start_sec && w.start_sec < cue.end_sec)
      const expected = splitCueWords(cue.text).length
      if (inside.length !== expected) return estimatedWordTimingSource.forCue(cue)
      return inside.map(w => ({ ...w, precision: 'exact' as const }))
    },
  }
}

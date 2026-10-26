/**
 * Narration plausibility — the wire shape the Audio page and the Pipeline read.
 *
 * A section's script length against the length of the audio made from it, and
 * the speaking rate of the voice that made it. No speech recognition is involved
 * (owner, 2026-10-25: Khmer is script-timed, never transcribed).
 *
 * AGENTS.md §6: "the take is fine" and "there is not enough history to tell"
 * are different answers and never share a value.
 */
export type NarrationPlausibilityState = 'pass' | 'flagged' | 'insufficient_history' | 'unmeasurable'

export type NarrationPlausibilityBasis = 'voice_history' | 'channel_history'

export interface NarrationPlausibilityBand {
  /** `measured` means the numbers below come from real accepted takes. */
  state: 'measured' | 'insufficient_history'
  /** Which earlier takes the band came from. Absent while unmeasured. */
  basis?: NarrationPlausibilityBasis
  /** Sections the band was learned from. */
  samples: number
  median_chars_per_second?: number
  /** How far either side of the median a take may sit before it is flagged. */
  tolerance_percent?: number
  low_chars_per_second?: number
  high_chars_per_second?: number
}

export interface NarrationPlausibilityEvidence {
  state: NarrationPlausibilityState
  /** Normalized characters the narration was made from. */
  chars: number | null
  duration_sec: number | null
  chars_per_second: number | null
  band: NarrationPlausibilityBand
  /** One plain sentence, shown verbatim; it never claims the words were heard back. */
  detail: string
}

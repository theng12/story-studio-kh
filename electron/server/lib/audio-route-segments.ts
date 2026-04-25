/**
 * Phase 6 — multi-character voice routing planner.
 *
 * Decides whether a section should take the per-speaker rendering path
 * (one TTS call per speaker segment, voices stitched together) or the
 * existing single-voice path (one voice for the whole section).
 *
 * Auto-detection: routing kicks in iff (a) the section text contains
 * `[NAME]:` speaker tags AND (b) the project has at least one character
 * with a speech.voiceId set. Otherwise the routing planner returns null
 * and the audio generator falls back to its existing path.
 *
 * This means single-character episodes, zero-character episodes, and
 * episodes whose characters have no voiceId all behave exactly as
 * before — back-compat preserved.
 */

import {
  splitTextBySpeaker,
  hasSpeakerTags,
  selectVoiceForSpeaker,
  type SpeakerSegment,
} from './script-speaker-split.js'
import type { Character } from '../models/types.js'

export interface RoutedSegment {
  /** Speaker name as written in the tag, or null for narration. */
  speaker: string | null
  /** Segment text (already trimmed). */
  text: string
  /**
   * The TTS voice id to render this segment with. May be undefined when
   * neither the speaker's character nor the narrator has a configured
   * voice — caller should fall back to whatever default the TTS provider
   * uses for that condition.
   */
  voiceId: string | undefined
}

export interface RoutingPlan {
  /** True iff at least one segment routes to a non-narrator voice. */
  multiVoice: boolean
  segments: RoutedSegment[]
}

/**
 * Plan how to render a section. Returns null when routing is unnecessary
 * (caller should take the existing single-voice path).
 *
 * Routing is triggered ONLY when both conditions hold:
 *   - At least one project character has a speech.voiceId set.
 *   - The section text contains at least one `[NAME]:` speaker tag.
 */
export function planRoutedSegments(
  sectionText: string,
  characters: Character[],
  narratorVoiceId: string | undefined,
): RoutingPlan | null {
  const hasVoicedCharacters = characters.some(c => !!c.speech?.voiceId)
  if (!hasVoicedCharacters) return null
  if (!hasSpeakerTags(sectionText)) return null

  const splits: SpeakerSegment[] = splitTextBySpeaker(sectionText)
  if (!splits.length) return null

  const segments: RoutedSegment[] = splits.map(s => ({
    speaker: s.speaker,
    text: s.text,
    voiceId: selectVoiceForSpeaker(s.speaker, characters, narratorVoiceId),
  }))

  // Multi-voice when at least one segment uses a voice OTHER than the narrator.
  const distinctVoices = new Set(segments.map(s => s.voiceId).filter(Boolean))
  const multiVoice = distinctVoices.size > 1
    || (distinctVoices.size === 1 && segments.some(s => s.speaker !== null))

  return { multiVoice, segments }
}

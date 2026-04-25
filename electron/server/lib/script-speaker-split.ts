/**
 * Speaker-tag splitter for multi-character voice routing (Phase 6).
 *
 * The script generator (when an episode has 2+ characters) emits dialog
 * lines marked with the convention:
 *
 *   [CHARACTER_NAME]: line of dialog
 *
 * Untagged paragraphs are narration. This module parses a section's text
 * into a list of segments, each carrying the speaker label (or null for
 * narration). The audio generator then maps each segment to a TTS voice
 * (the matching character's voiceId, or the narrator default for
 * untagged segments).
 *
 * Robustness rules:
 *   - Tag must appear at the START of a line (after leading whitespace).
 *     Inline `[name]:` mid-paragraph is NOT a speaker tag — that's
 *     prose like "she replied [tired]: 'yes'", which we leave intact.
 *   - A speaker tag's segment runs until EITHER (a) the next speaker tag
 *     or (b) a blank line (paragraph break). After a paragraph break,
 *     untagged content is narration again. This matches the way the LLM
 *     actually emits multi-character scripts: each dialog turn is its own
 *     paragraph, and narration paragraphs are separated by blank lines.
 *   - Multi-line dialog WITHIN one paragraph (no blank lines between
 *     lines) stays attached to the same speaker.
 *   - Tag matching is case-insensitive on the speaker NAME, but the
 *     output preserves the original casing (consumer matches against
 *     character.name, which is canonical).
 *   - Speaker names with spaces are supported: `[Aria the Knight]:`.
 *   - The colon AFTER the bracket is required — `[Aria]` alone is not
 *     a speaker tag (could be a stage direction or scene label).
 */

export interface SpeakerSegment {
  /** The exact speaker name as it appeared in the tag, or null for narration. */
  speaker: string | null
  /** Segment text (the dialog or narration prose). Trimmed; never empty. */
  text: string
}

const TAG_LINE = /^[ \t]*\[([^\]\n]+)\][ \t]*:[ \t]*(.*)$/

/**
 * Parse a section of script text into speaker-tagged segments. Returns at
 * least one segment when the input has any non-whitespace content; an empty
 * array when the input is blank.
 *
 * Examples:
 *   splitTextBySpeaker("Once upon a time, the knight rode east.")
 *     → [{ speaker: null, text: "Once upon a time, the knight rode east." }]
 *
 *   splitTextBySpeaker("Aria looked up.\n[Aria]: Where are we?\n[Brick]: Lost.\nThey kept walking.")
 *     → [
 *         { speaker: null, text: "Aria looked up." },
 *         { speaker: "Aria", text: "Where are we?" },
 *         { speaker: "Brick", text: "Lost." },
 *         { speaker: null, text: "They kept walking." },
 *       ]
 */
export function splitTextBySpeaker(text: string): SpeakerSegment[] {
  if (!text || !text.trim()) return []

  const lines = text.split(/\r?\n/)
  const out: SpeakerSegment[] = []
  let currentSpeaker: string | null = null
  let buffer: string[] = []

  function flush() {
    const joined = buffer.join('\n').trim()
    if (joined) out.push({ speaker: currentSpeaker, text: joined })
    buffer = []
  }

  for (const line of lines) {
    const m = line.match(TAG_LINE)
    if (m) {
      // New speaker tag — flush whatever accumulated under the previous one.
      flush()
      currentSpeaker = m[1].trim()
      // The same-line content after `:` (if any) starts the new segment.
      const tail = m[2].trim()
      if (tail) buffer.push(tail)
    } else if (line.trim() === '') {
      // Blank line = paragraph break. Flush the current segment and revert
      // to narration (currentSpeaker = null) until a new tag arrives.
      flush()
      currentSpeaker = null
    } else {
      buffer.push(line)
    }
  }
  flush()

  return out
}

/**
 * True iff the text contains at least one speaker-tagged line. Cheap pre-flight
 * check the audio generator uses to decide whether to take the per-speaker
 * routing path or the existing single-voice path. Single regex scan; no
 * full parse.
 */
export function hasSpeakerTags(text: string): boolean {
  if (!text) return false
  return /^[ \t]*\[[^\]\n]+\][ \t]*:/m.test(text)
}

/**
 * Select the voice id for a segment. If the segment has a speaker, look up
 * the matching character (by case-insensitive name). If found and the
 * character has a voiceId, use that. Otherwise fall back to the narrator
 * voice. This is what makes mismatched/unknown speaker tags safe — they
 * default to the narrator instead of crashing.
 */
export function selectVoiceForSpeaker(
  speaker: string | null,
  characters: Array<{ name: string; speech?: { voiceId?: string } }>,
  narratorVoiceId: string | undefined,
): string | undefined {
  if (!speaker) return narratorVoiceId
  const lc = speaker.toLowerCase()
  const c = characters.find(c => c.name.toLowerCase() === lc)
  return c?.speech?.voiceId || narratorVoiceId
}

/**
 * Completeness audit for one written narration section (a regenerated chapter
 * or an introduction). Owner decision 2026-10-07: chapter-only and
 * introduction-only must not finish "done" with an empty, cut-off or
 * implausibly short section.
 */

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

/** Words, with dictionary segmentation for scripts written without spaces (Khmer, Thai…). */
export function countNarrationWords(text: string): number {
  let count = 0
  for (const part of words.segment(text)) if (part.isWordLike) count++
  return count
}

// Sentence ends in Latin scripts and Khmer (khan ។, bariyoosan ៕).
const SENTENCE_END = /[.!?…។៕]$/
// Closing quotes, brackets and markdown emphasis that may follow the stop.
const TRAILING_CLOSERS = /["'”’»)\]*_\s]+$/

/** A section shorter than this share of its target reads as cut off. */
export const MIN_SHARE_OF_TARGET = 0.4

export function auditNarrationSection(text: string, targetWords?: number): string[] {
  const body = text.trim()
  if (!body) return ['it is empty']
  const issues: string[] = []
  if (!SENTENCE_END.test(body.replace(TRAILING_CLOSERS, ''))) {
    issues.push(`it stops mid-sentence ("…${body.slice(-60)}")`)
  }
  const count = countNarrationWords(body)
  if (targetWords && targetWords > 0 && count < targetWords * MIN_SHARE_OF_TARGET) {
    issues.push(`it has ${count} words against a target of about ${targetWords}`)
  }
  return issues
}

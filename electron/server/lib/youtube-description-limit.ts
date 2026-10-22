/**
 * YouTube's description limit, and fitting a description under it.
 *
 * The Data API states `snippet.description` has "a maximum length of 5000
 * bytes" (developers.google.com/youtube/v3/docs/videos) — BYTES of UTF-8, not
 * characters. Khmer is 3 bytes a character, so a 5,000-character cap let a
 * Khmer description reach ~15,000 bytes and YouTube refused the upload. The
 * cap here is 4,900 bytes: 100 bytes of headroom under YouTube's own figure.
 *
 * Owner decision 2026-10-07: never fail a job for length. Trim at a sentence
 * boundary and keep the chapter list intact.
 */

/** The finalizer's private markers around the chapter list (stripped before upload). */
export const CHAPTERS_BEGIN = '<!-- youtube:chapters:start -->'
export const CHAPTERS_END = '<!-- youtube:chapters:end -->'

/**
 * YouTube's own published limit for `snippet.description`: 5,000 bytes.
 *
 * Published as a separate figure from the cap below because they are two
 * different numbers with two different meanings: this one is YouTube's, the
 * cap below is this app's headroom under it. An editor that shows the owner
 * "5,000" and then refuses at 4,900 without saying so is the kind of thing
 * that reads as a bug, so both are named where the owner can see them.
 */
export const YOUTUBE_DESCRIPTION_MAX_BYTES_PUBLISHED = 5000

/**
 * The cap this app enforces: 100 bytes of headroom under YouTube's own
 * figure above.
 */
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 4900

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export interface FittedDescription {
  description: string
  trimmed: boolean
  bytes_before: number
  bytes_after: number
}

// Sentence ends in Latin scripts and Khmer (khan ។, bariyoosan ៕), plus line breaks.
const BOUNDARY = /[.!?…។៕\n]/

/** Remove the last sentence (or line) of `text`; '' when it has only one. */
function dropLastSentence(text: string): string {
  const s = text.trimEnd()
  for (let i = s.length - 2; i >= 0; i--) {
    if (!BOUNDARY.test(s[i]!)) continue
    return (s[i] === '\n' ? s.slice(0, i) : s.slice(0, i + 1)).trimEnd()
  }
  return ''
}

/**
 * Fit `description` under `maxBytes`. The managed chapter block is never cut;
 * prose after it goes first, then prose before it, one sentence at a time. Only
 * when the chapter block alone is too large are its last lines dropped.
 */
export function fitYouTubeDescription(description: string, maxBytes = YOUTUBE_DESCRIPTION_MAX_BYTES): FittedDescription {
  const bytesBefore = utf8Bytes(description)
  if (bytesBefore <= maxBytes) {
    return { description, trimmed: false, bytes_before: bytesBefore, bytes_after: bytesBefore }
  }
  const start = description.indexOf(CHAPTERS_BEGIN)
  const end = start >= 0 ? description.indexOf(CHAPTERS_END, start) : -1
  let before = end >= 0 ? description.slice(0, start) : description
  let block = end >= 0 ? description.slice(start, end + CHAPTERS_END.length) : ''
  let after = end >= 0 ? description.slice(end + CHAPTERS_END.length) : ''
  const join = () => [before.trim(), block, after.trim()].filter(Boolean).join('\n\n')
  while (utf8Bytes(join()) > maxBytes) {
    if (after.trim()) after = dropLastSentence(after)
    else if (before.trim()) before = dropLastSentence(before)
    else if (block) {
      // ponytail: last resort only — a chapter list over 4,900 bytes cannot fit whole.
      const lines = block.split('\n')
      lines.splice(-2, 1)
      block = lines.length > 2 ? lines.join('\n') : ''
    } else break
  }
  const fitted = join()
  return { description: fitted, trimmed: true, bytes_before: bytesBefore, bytes_after: utf8Bytes(fitted) }
}

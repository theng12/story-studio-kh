/**
 * The ONE place a channel's title prefix and suffix are applied.
 *
 * Three call sites used to spell this themselves — the metadata generator's
 * `wrapTitle`, and two in the idea-campaign generator — and each did a bare
 * `${prefix}${title}${suffix}`. Two defects came out of that:
 *
 *   1. A title that ALREADY ended with the channel's sleep wording got the
 *      suffix again ("… For Sleep For Sleep"), because nothing compared the
 *      title to the suffix before appending it. A request that runs twice
 *      (a retry, a regenerated campaign) doubled the copy.
 *   2. The composed title could pass YouTube's 100-character limit, and the
 *      only thing downstream was a cap that silently cut the owner's words.
 *
 * So the rules live here, once:
 *
 *   - Applying the same prefix/suffix twice is a no-op. The comparison ignores
 *     case, spacing and punctuation, so `For Sleep`, `for sleep.` and
 *     `FOR SLEEP!` are the same ending.
 *   - A title that would exceed YouTube's published limit is REFUSED with a
 *     message naming the limit and the length. Nothing is truncated: a title
 *     is the owner's words, and quietly cutting them is the defect, not the fix.
 *
 * No prefix/suffix means this is a pass-through, except for the limit check —
 * a title that YouTube would reject should fail here, where the message can
 * name it, rather than as a provider error after an upload was attempted.
 */

/** YouTube's published maximum for `snippet.title`, in characters. */
export const YOUTUBE_TITLE_MAX_CHARACTERS = 100

/**
 * The letters and digits of a string, lowercased.
 *
 * Punctuation and whitespace are dropped so two spellings of the same ending
 * compare equal. Only letters and digits are significant: `" For Sleep"` and
 * `"for sleep."` both reduce to `forsleep`.
 */
function significantCharacters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export interface ComposeChannelTitleOptions {
  /** Named in the refusal so the owner knows which episode is over the limit. */
  context?: string
}

/**
 * Compose `prefix + title + suffix`, idempotently, and refuse an over-limit
 * result. Throws an error tagged `statusCode: 400` when the result is too long.
 */
export function composeChannelTitle(
  baseTitle: string,
  prefix = '',
  suffix = '',
  options: ComposeChannelTitleOptions = {},
): string {
  let title = String(baseTitle ?? '').trim()
  const before = typeof prefix === 'string' ? prefix : ''
  const after = typeof suffix === 'string' ? suffix : ''

  const beforeKey = significantCharacters(before)
  const afterKey = significantCharacters(after)

  if (beforeKey && !significantCharacters(title).startsWith(beforeKey)) {
    title = before + title
  }
  if (afterKey && !significantCharacters(title).endsWith(afterKey)) {
    title = title + after
  }
  // A suffix usually carries its own leading space; trimming the whole result
  // removes the stray whitespace a bare concatenation leaves at the ends.
  title = title.trim()

  const length = [...title].length
  if (length > YOUTUBE_TITLE_MAX_CHARACTERS) {
    const who = options.context ? `${options.context}'s title` : 'This title'
    throw Object.assign(
      new Error(
        `${who} is ${length} characters once the channel prefix and suffix are applied, over YouTube's `
        + `${YOUTUBE_TITLE_MAX_CHARACTERS}-character title limit. Shorten the title or the channel prefix/suffix — `
        + 'Story Studio did not truncate it for you.',
      ),
      { statusCode: 400 },
    )
  }

  return title
}

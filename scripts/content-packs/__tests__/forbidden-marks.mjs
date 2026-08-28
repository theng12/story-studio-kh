/**
 * The third-party product marks that must not appear in text a customer can
 * read or search.
 *
 * Shared so the Production Looks guard and the published-pack scrub guard can
 * never drift apart: widening this list widens both at once. Word-boundary
 * matched so ordinary words are never caught by accident, and so identifier
 * spellings that are not customer-visible (`youtube_tags_hint`,
 * `youtubeTagsHint`) do not trip it — the character after the mark is a word
 * character there, so the trailing boundary fails.
 */
export const MARKS = [
  /\bMS\s*Paint\b/i,
  /\bMicrosoft\b/i,
  /\bYouTube\b/i,
  /\bPhotoshop\b/i,
  /\bIllustrator\b/i,
  /\bTikTok\b/i,
  /\bInstagram\b/i,
  /\bFacebook\b/i,
  /\bVimeo\b/i,
  /\bTwitch\b/i,
]

/** The first mark `text` names, or undefined. */
export function markIn(text) {
  return typeof text === 'string' ? MARKS.find(mark => mark.test(text)) : undefined
}

/**
 * Every string value in a pack document that is customer-facing or reaches a
 * model prompt. Identifier values are skipped: `metadata_profile.id` and its
 * kin are internal keys, never rendered, and renaming one would churn a
 * content-addressed record for no customer-visible gain.
 */
export function meaningfulStrings(node, keyPath = '') {
  const out = []
  if (typeof node === 'string') {
    out.push([keyPath || '(root)', node])
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => out.push(...meaningfulStrings(item, `${keyPath}[${index}]`)))
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'id' || key.endsWith('_id') || key.endsWith('_ids')) continue
      out.push(...meaningfulStrings(value, keyPath ? `${keyPath}.${key}` : key))
    }
  }
  return out
}

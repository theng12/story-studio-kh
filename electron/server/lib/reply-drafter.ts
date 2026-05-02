/**
 * LLM-driven reply drafter for YouTube comments.
 *
 * Two pure functions:
 *   - buildReplyDraftPrompt(...) builds the user-message string the
 *     LLM sees. Brand persona, channel name, video title, and the
 *     incoming comment all flow in here.
 *   - parseReplyDrafts(...) takes the LLM's raw response and returns
 *     a clean string[] (one entry per candidate reply, in order).
 *
 * The actual callAi invocation lives in the route layer so this module
 * stays unit-testable without provider mocks.
 *
 * Language handling: the prompt instructs the LLM to reply in the same
 * language as the incoming comment. We don't try to detect the language
 * server-side — the LLM is better at it, especially for mixed Khmer +
 * English content where naive script-detection would split a word.
 */

import type { Brand } from '../models/types.js'

export interface BuildReplyDraftOptions {
  /** Plain-text comment we're replying to (textOriginal). */
  commentText: string
  /** Display name of the comment author — for natural greetings. */
  commentAuthor: string
  /** Title of the video the comment is on, for context. Optional. */
  videoTitle?: string
  /** How many candidate replies to ask for. Defaults to 3. */
  count?: number
  /** Brand object — supplies persona + channel name. Optional. */
  brand?: Brand | null
  /** Project name fallback when no brand or no brand.channel.name. */
  projectName?: string
}

export function buildReplyDraftPrompt(opts: BuildReplyDraftOptions): string {
  const count = Math.max(1, Math.min(opts.count ?? 3, 5))
  const channelName = opts.brand?.channel?.name?.trim()
    || opts.projectName?.trim()
    || 'this channel'
  const persona = opts.brand?.narration?.persona?.trim()

  const personaBlock = persona
    ? `\nChannel persona (use this voice when replying):\n${persona}\n`
    : ''
  const titleBlock = opts.videoTitle
    ? `\nThe comment is on the video: "${opts.videoTitle}"\n`
    : ''

  return `You are the channel owner of "${channelName}". Draft ${count} short, friendly reply options to a viewer's comment on one of your videos.
${personaBlock}${titleBlock}
Viewer comment by ${opts.commentAuthor || 'a viewer'}:
"""
${opts.commentText}
"""

Rules:
- Reply in the SAME LANGUAGE the viewer wrote in. If they mixed languages, match their mix.
- Keep each reply short — usually one sentence, two at most. Never longer than ~200 characters.
- Sound human and warm. Never sound like a generic auto-reply.
- Acknowledge what they said specifically. Don't paste a stock thank-you.
- No emojis unless the viewer used emojis. No hashtags.
- No promotion of other videos / Patreon / merch — keep it conversational.
- Don't address yourself in third person.

Return ONLY the ${count} reply option(s), one per line, separated by a blank line. No numbering, headers, quotes around them, or commentary. The user picks one and posts it as-is.`
}

/**
 * Parse the LLM's raw reply output into an array of clean candidates.
 *
 * Splits on blank lines (the format we asked for), then strips numbering
 * artifacts and surrounding quotes that some models emit anyway. Drops
 * empty entries. Caps at the requested count to defend against models
 * that ignore the limit.
 */
export function parseReplyDrafts(raw: string, count: number = 3): string[] {
  if (!raw) return []
  const blocks = raw
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Split on one or more blank lines (the requested separator)
    .split(/\n\s*\n+/)
    .map(b => b.trim())
    .filter(Boolean)

  const cleaned: string[] = []
  for (const b of blocks) {
    let s = b
    // Strip "1.", "1)", "Reply 1:", "Option 1 -" leaders some models add
    s = s.replace(/^(?:reply\s*\d+|option\s*\d+|\d+)\s*[:.\)\-]\s*/i, '')
    // Strip wrapping quotes if a model returned `"reply"` instead of bare text
    s = s.replace(/^["“'`]+|["”'`]+$/g, '').trim()
    if (s) cleaned.push(s)
    if (cleaned.length >= count) break
  }

  // Fallback: when blank-line splitting collapses everything into a
  // single multi-line block (model returned "A\nB\nC" with no blank
  // separator between lines), or produced nothing at all, try splitting
  // by line. We only kick this fallback in when more than one reply
  // was asked for AND the candidate has internal line breaks; otherwise
  // a legitimate two-sentence reply with a paragraph break would get
  // cut into two candidates.
  const needsLineFallback =
    cleaned.length === 0
    || (count > 1 && cleaned.length === 1 && cleaned[0]!.includes('\n'))
  if (needsLineFallback) {
    cleaned.length = 0  // discard the merged block; rebuild from lines
    for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
      let s = line.replace(/^(?:reply\s*\d+|option\s*\d+|\d+)\s*[:.\)\-]\s*/i, '')
      s = s.replace(/^["“'`]+|["”'`]+$/g, '').trim()
      if (s) cleaned.push(s)
      if (cleaned.length >= count) break
    }
  }
  return cleaned
}

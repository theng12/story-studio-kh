/**
 * The channel-wide comment inbox.
 *
 * The rule that shapes it: **a fetch that stopped early is PARTIAL, never
 * "that is all of them".** Those are two different facts, and the second one
 * hides a whole page of a creator's audience behind a screen that looks
 * complete. Quota running out mid-sweep, a video refusing, a bound being hit -
 * each is reported, with which videos were not reached.
 *
 * Comment bodies are cached so opening the inbox costs nothing.
 */

import { listVideoCommentThreads } from '../lib/youtube-comments.js'
import { cursorDecision, cursorKey, type PageCursor } from './youtube-page-cursor.js'
import type { CommentThread } from '../models/types.js'


export interface InboxComment {
  comment_id: string
  video_id: string
  author: string
  /** Untrusted user text. Stored and rendered as data, never interpreted. */
  text: string
  published_at: string
  moderation_status: 'published' | 'heldForReview' | 'rejected'
  /** True when THIS channel has already replied in this thread. */
  channel_replied: boolean
  reply_count: number
  /** The replies YouTube returned, so a thread can be read whole. */
  replies: Array<{ comment_id: string; author: string; text: string; published_at: string; from_channel: boolean }>
  /** False when YouTube says commenting is closed on this thread. */
  can_reply: boolean
}

/**
 * Flatten one thread into an inbox row.
 *
 * Typed against `CommentThread` deliberately. The first version of this used
 * `as any[]` and read flat fields — `thread.author`, `thread.text` — that the
 * contract has never had; they live on `top_comment`. Every one came back
 * empty against real data, and the tests passed because the test double had
 * been shaped to this mapper instead of to the API. The cast is what allowed
 * it: with the real type in place the compiler refuses the mistake.
 */
function toInboxComment(thread: CommentThread, channelId: string): InboxComment {
  const top = thread.top_comment
  const fromChannel = (reply: { author_channel_id?: string }) =>
    reply.author_channel_id === channelId

  return {
    // The COMMENT id, not the thread id. They happen to be equal for a top
    // comment, but replies and moderation address the comment, so relying on
    // that coincidence would break the moment YouTube stopped honouring it.
    comment_id: top.id,
    video_id: thread.video_id,
    author: top.author,
    text: top.text,
    published_at: top.published_at,
    // YouTube only tells the channel owner its moderation status. Absent is
    // not "published": fall back to is_public, which distinguishes visible
    // from held-or-spam, and say no more than that.
    moderation_status: thread.moderation_status === 'rejected' ? 'rejected'
      : thread.moderation_status === 'heldForReview' || thread.moderation_status === 'likelySpam' ? 'heldForReview'
      : thread.moderation_status === 'published' ? 'published'
      : thread.is_public ? 'published' : 'heldForReview',
    // Identity, not display name. Without a channel id we cannot know, so we
    // do not claim to — an unanswered thread is better than a wrong "answered".
    channel_replied: thread.replies.some(fromChannel),
    reply_count: thread.reply_count,
    replies: thread.replies.map(reply => ({
      comment_id: reply.id,
      author: reply.author,
      text: reply.text,
      published_at: reply.published_at,
      from_channel: fromChannel(reply),
    })),
    can_reply: thread.can_reply,
  }
}

export interface CommentInbox {
  fetched_at: string
  comments: InboxComment[]
  /** True when this sweep did NOT see everything it set out to. */
  partial: boolean
  partial_reason?: 'quota_exhausted' | 'provider_error' | 'limit_reached'
  /** Videos this sweep never opened at all, so the gap is nameable. */
  unreached_video_ids: string[]
  /** Videos that WERE read, but hold more than one call could return. */
  partially_read_video_ids: string[]
  /** Where each unfinished video resumes next time. */
  next_cursors: Record<string, PageCursor>
  /** Videos whose stored cursor was discarded, so their sweep began again. */
  restarted_video_ids: string[]
  /** Videos that answered, but have comments turned off. Not the same as none. */
  comments_disabled_video_ids: string[]
}

// `viewsFor`/`filterInbox` lived here and were exported, tested, and never
// called: the shipped classifier is `matchesView` in the Comments page, which
// filters the cache client-side. Two implementations of one rule in two
// languages can only drift, and only one of them was reachable. The page's
// tests cover the rule that runs.

function isQuotaError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  if (code === 'YOUTUBE_QUOTA_EXHAUSTED') return true
  const message = error instanceof Error ? error.message : String(error)
  return /quota/i.test(message)
}

/**
 * Sweep the given videos for comments.
 *
 * Stops at the first quota refusal rather than hammering a spent budget, and
 * reports exactly which videos it never reached.
 */
export type ListThreads = typeof listVideoCommentThreads

export async function fetchCommentInbox(input: {
  project_slug: string
  account_id: string
  video_ids: string[]
  /** Total comments to gather before stopping. */
  limit?: number
  /**
   * The channel this project publishes to. Required, not optional: it is the
   * only way to tell OUR reply from anyone else's, and an absent one silently
   * marked every comment unanswered. The caller refuses before this point when
   * no channel is assigned.
   */
  channel_id: string
  /**
   * The listing seam, injected in tests. Same shape the OAuth flow and the
   * YouTube transport already use — an ESM export cannot be redefined, so a
   * provider-free test needs the seam rather than a mock.
   */
  listThreads?: ListThreads
  /**
   * Where each video's sweep resumes, from the last sweep. A cursor issued
   * under a different channel is discarded rather than used - see
   * `cursorDecision`.
   */
  cursors?: Record<string, PageCursor>
}): Promise<CommentInbox> {
  const listThreads = input.listThreads ?? listVideoCommentThreads
  const limit = Math.min(Math.max(1, input.limit ?? 200), 500)
  const comments: InboxComment[] = []
  const commentsDisabled: string[] = []
  let partial = false
  let partialReason: CommentInbox['partial_reason']
  let index = 0
  // Which video the sweep stopped ON. Only set when the sweep actually stops.
  let unreachedFrom: number | undefined
  // Videos that answered, but had more than one call could return.
  const overflowed: string[] = []
  // Where each video resumes next time, and which cursors were thrown away.
  const nextCursors: Record<string, PageCursor> = {}
  const restarted: string[] = []

  for (; index < input.video_ids.length; index++) {
    if (comments.length >= limit) {
      partial = true
      partialReason = 'limit_reached'
      unreachedFrom = index
      break
    }
    const videoId = input.video_ids[index]!
    // A cursor from a departed channel does not resume: it would page through
    // a stranger's list under this project's name. Restarting is named, not
    // silent - "we started over" and "we continued" are different facts.
    const decision = cursorDecision(input.cursors?.[cursorKey('comments', videoId)], input.channel_id)
    if (!decision.resume && decision.reason === 'channel_changed') restarted.push(videoId)
    let result
    try {
      result = await listThreads(input.project_slug, input.account_id, videoId, {
        maxResults: Math.min(100, limit - comments.length),
        ...(decision.resume ? { pageToken: decision.token } : {}),
      })
    } catch (error) {
      partial = true
      partialReason = isQuotaError(error) ? 'quota_exhausted' : 'provider_error'
      unreachedFrom = index
      break
    }

    // "Nobody has commented" and "comments are off" are different facts, and
    // only the second explains why replying is impossible.
    if (result.comments_disabled) {
      commentsDisabled.push(videoId)
      continue
    }

    for (const thread of result.threads) {
      if (comments.length >= limit) break
      comments.push(toInboxComment(thread, input.channel_id))
    }

    // YouTube has more on THIS video than one call returned. That is one
    // video's overflow, not a reason to abandon the sweep: `break` here stopped
    // every remaining video and reported them all unreached while the numeric
    // limit was nowhere near spent. Name the video and keep going; only the
    // limit itself ends the sweep.
    if (result.has_more) {
      partial = true
      partialReason = partialReason ?? 'limit_reached'
      overflowed.push(videoId)
      // Only when there IS a next page. A finished video keeps no cursor, so
      // the next sweep reads its newest batch rather than resuming past the end.
      if (result.next_page_token) {
        nextCursors[cursorKey('comments', videoId)] = {
          channel_id: input.channel_id,
          token: result.next_page_token,
          issued_at: result.fetched_at,
        }
      }
    }
  }

  return {
    fetched_at: new Date().toISOString(),
    comments,
    partial,
    ...(partialReason ? { partial_reason: partialReason } : {}),
    // Two different facts, kept apart. A video the sweep never opened and a
    // video whose first hundred comments are on screen are not the same thing,
    // and merging them told the operator a video they can read was "not
    // reached". Both mean "not fully read"; only one means "nothing was seen".
    unreached_video_ids: unreachedFrom === undefined ? [] : input.video_ids.slice(unreachedFrom),
    partially_read_video_ids: overflowed,
    next_cursors: nextCursors,
    restarted_video_ids: restarted,
    comments_disabled_video_ids: commentsDisabled,
  }
}

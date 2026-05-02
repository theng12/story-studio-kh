/**
 * YouTube comments client.
 *
 *   - listVideoCommentThreads — fetch top-level comments + first-level
 *     replies for a single video. One page (up to 100 threads) per call.
 *     Quota: 1 unit / call.
 *   - postCommentReply — post a reply under a top-level comment using
 *     comments.insert. Quota: 50 units / call.
 *
 * Auth: existing `youtube` scope is sufficient — no new scope needed.
 *
 * v1 scope:
 *   - one video at a time (no all-channel aggregation)
 *   - top-level threads + first-level replies only (no nested threading)
 *   - no edits, deletes, or moderation actions
 *
 * Caching is handled in the route layer via the existing in-memory
 * pattern; this module is stateless.
 */

import { fetchWithAuthRetry } from './youtube-client.js'
import { checkQuota, recordQuotaUsage, friendlyQuotaErrorMessage } from '../services/upload-quota.js'
import type { CommentThread, CommentThreadsResult, CommentReply } from '../models/types.js'

const COMMENT_THREADS_URL = 'https://www.googleapis.com/youtube/v3/commentThreads'
const COMMENTS_URL = 'https://www.googleapis.com/youtube/v3/comments'

class CommentsApiError extends Error {
  readonly statusCode: number
  constructor(status: number, raw: string) {
    const trimmed = raw.length > 400 ? raw.slice(0, 400) + '…' : raw
    super(`YouTube comments API error (${status}): ${trimmed}`)
    this.name = 'CommentsApiError'
    this.statusCode = status >= 400 && status < 600 ? status : 502
  }
}

/** Normalize a single YouTube `comment.snippet` payload to our flat shape. */
function toCommentReply(item: any): CommentReply {
  const s = item?.snippet || {}
  return {
    id: String(item?.id || ''),
    author: String(s.authorDisplayName || ''),
    author_avatar: s.authorProfileImageUrl ? String(s.authorProfileImageUrl) : undefined,
    // textOriginal is the raw user input. textDisplay is HTML-escaped + auto-linked
    // by YouTube — fine for a viewer, but bad for an LLM prompt or a textarea.
    text: String(s.textOriginal ?? s.textDisplay ?? ''),
    like_count: Number(s.likeCount || 0),
    published_at: String(s.publishedAt || ''),
    updated_at: String(s.updatedAt || ''),
  }
}

export interface ListCommentThreadsOptions {
  /** 'time' (newest first) or 'relevance' (YouTube's relevance ranking). */
  order?: 'time' | 'relevance'
  /** Total threads to return across all pages. Caps at 500 (5 pages × 100). */
  maxResults?: number
  /** Per-page size. API hard-caps at 100; we default to 100 to minimize
   *  pagination round-trips. */
  pageSize?: number
}

/**
 * List comment threads for a single video. Pages through nextPageToken
 * up to `maxResults` total threads (default 50, max 500). Disabled-
 * comments errors map to an empty result rather than a thrown error
 * so the UI can show "Comments disabled on this video" calmly.
 */
export async function listVideoCommentThreads(
  slug: string,
  accountId: string,
  videoId: string,
  options: ListCommentThreadsOptions = {},
): Promise<CommentThreadsResult> {
  if (!videoId) {
    return { fetched_at: new Date().toISOString(), video_id: '', threads: [], has_more: false }
  }
  const maxResults = Math.min(Math.max(options.maxResults || 50, 1), 500)
  const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 100)
  const order = options.order || 'time'

  const threads: CommentThread[] = []
  let pageToken: string | undefined = undefined
  let hasMore = false

  while (threads.length < maxResults) {
    await checkQuota(slug, 'comment_threads_list')
    const url = new URL(COMMENT_THREADS_URL)
    url.searchParams.set('part', 'snippet,replies')
    url.searchParams.set('videoId', videoId)
    url.searchParams.set('maxResults', String(Math.min(pageSize, maxResults - threads.length)))
    url.searchParams.set('order', order)
    url.searchParams.set('textFormat', 'plainText')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const resp = await fetchWithAuthRetry(slug, accountId, (token) =>
      fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } }),
    )

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      if (resp.status === 403 && /commentsDisabled/.test(text)) {
        return { fetched_at: new Date().toISOString(), video_id: videoId, threads: [], has_more: false }
      }
      const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
      throw new CommentsApiError(resp.status, quotaMsg || text)
    }

    await recordQuotaUsage(slug, 'comment_threads_list').catch(() => {})

    const data = await resp.json() as any
    for (const item of (data.items || [])) {
      const s = item?.snippet || {}
      const top = s.topLevelComment
      if (!top) continue
      const replies: CommentReply[] = []
      for (const r of (item?.replies?.comments || [])) {
        replies.push(toCommentReply(r))
        if (replies.length >= 5) break
      }
      threads.push({
        id: String(item.id),
        video_id: String(s.videoId || videoId),
        top_comment: toCommentReply(top),
        reply_count: Number(s.totalReplyCount || 0),
        replies,
        can_reply: s.canReply !== false,
        is_public: s.isPublic !== false,
      })
      if (threads.length >= maxResults) break
    }

    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined
    if (!pageToken) {
      hasMore = false
      break
    }
    if (threads.length >= maxResults) {
      // Capped — there ARE more on YouTube but we stopped paging.
      hasMore = true
      break
    }
  }

  return {
    fetched_at: new Date().toISOString(),
    video_id: videoId,
    threads,
    has_more: hasMore,
  }
}

/**
 * Post a reply under the given parent comment. The parent must be a
 * top-level comment id (not a reply id) — replies-to-replies aren't a
 * thing in YouTube; they're flattened into the same thread.
 *
 * Returns the created comment in our normalized shape so the UI can
 * append it to the thread without a refetch.
 */
export async function postCommentReply(
  slug: string,
  accountId: string,
  parentCommentId: string,
  textOriginal: string,
): Promise<CommentReply> {
  if (!parentCommentId) throw new Error('parentCommentId is required')
  if (!textOriginal || !textOriginal.trim()) throw new Error('reply text is required')

  await checkQuota(slug, 'comments_insert')
  const url = new URL(COMMENTS_URL)
  url.searchParams.set('part', 'snippet')
  const body = {
    snippet: {
      parentId: parentCommentId,
      textOriginal: textOriginal.trim(),
    },
  }
  const resp = await fetchWithAuthRetry(slug, accountId, (token) =>
    fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const quotaMsg = friendlyQuotaErrorMessage(resp.status, text)
    throw new CommentsApiError(resp.status, quotaMsg || text)
  }

  await recordQuotaUsage(slug, 'comments_insert').catch(() => {})

  const data = await resp.json() as any
  return toCommentReply(data)
}

/**
 * Tests for the YouTube comments client (lib/youtube-comments.ts).
 *
 * Coverage:
 *   - parses commentThreads.list response into normalized CommentThread shape
 *   - drops malformed thread items (missing topLevelComment) without throwing
 *   - caps replies at 5 per thread (we slice to keep prompts + UI tight)
 *   - prefers textOriginal over textDisplay (raw, not HTML-escaped)
 *   - 403 + commentsDisabled error returns empty result, not a throw
 *   - other 4xx errors throw with statusCode set
 *   - empty videoId returns empty result without API call
 *   - postCommentReply happy path returns normalized comment + posts JSON body
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let mod: typeof import('../lib/youtube-comments.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const fetchQueue: Array<{ status: number; body: any; assertUrl?: (url: string) => void; assertBody?: (body: any) => void }> = []
const originalFetch = globalThis.fetch

before(async () => {
  tmp = await useTempDataDir()
  mod = await import('../lib/youtube-comments.js')
  pm = await import('../services/project-manager.js')
  await pm.createProject({ name: 'Comments Test', episode_prefix: 'CT' } as any)
  const { writeTokens } = await import('../services/upload-store.js')
  await writeTokens('comments-test', 'youtube', 'acct-1', {
    access_token: 'fake', refresh_token: 'r', expires_at: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube',
  })
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.toString()
    const next = fetchQueue.shift()
    if (!next) throw new Error(`unexpected fetch: ${url}`)
    next.assertUrl?.(url)
    if (next.assertBody && init?.body) {
      next.assertBody(JSON.parse(init.body))
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
})

after(async () => {
  globalThis.fetch = originalFetch
  await tmp.cleanup()
})

beforeEach(() => {
  fetchQueue.length = 0
})

describe('youtube-comments — listVideoCommentThreads', () => {
  test('parses threads + replies into normalized shape', async () => {
    fetchQueue.push({
      status: 200,
      assertUrl: (u) => {
        assert.match(u, /commentThreads/)
        assert.match(u, /videoId=vid-1/)
        assert.match(u, /textFormat=plainText/)
        assert.match(u, /order=time/)
      },
      body: {
        items: [
          {
            id: 'thread-1',
            snippet: {
              videoId: 'vid-1',
              totalReplyCount: 2,
              canReply: true,
              isPublic: true,
              topLevelComment: {
                id: 'c-top-1',
                snippet: {
                  authorDisplayName: 'Alice',
                  authorProfileImageUrl: 'https://example.com/alice.jpg',
                  textOriginal: 'This was lovely!',
                  textDisplay: '<b>This was lovely!</b>',
                  likeCount: 12,
                  publishedAt: '2026-04-30T00:00:00Z',
                  updatedAt: '2026-04-30T00:00:00Z',
                },
              },
            },
            replies: {
              comments: [
                {
                  id: 'c-reply-1',
                  snippet: {
                    authorDisplayName: 'Channel',
                    textOriginal: 'Thanks Alice!',
                    likeCount: 0,
                    publishedAt: '2026-04-30T01:00:00Z',
                    updatedAt: '2026-04-30T01:00:00Z',
                  },
                },
              ],
            },
          },
        ],
      },
    })

    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'vid-1')
    assert.equal(result.video_id, 'vid-1')
    assert.equal(result.threads.length, 1)
    const t = result.threads[0]!
    assert.equal(t.id, 'thread-1')
    assert.equal(t.reply_count, 2)
    assert.equal(t.can_reply, true)
    assert.equal(t.is_public, true)
    assert.equal(t.top_comment.id, 'c-top-1')
    assert.equal(t.top_comment.author, 'Alice')
    assert.equal(t.top_comment.text, 'This was lovely!', 'should prefer textOriginal over textDisplay')
    assert.equal(t.top_comment.author_avatar, 'https://example.com/alice.jpg')
    assert.equal(t.top_comment.like_count, 12)
    assert.equal(t.replies.length, 1)
    assert.equal(t.replies[0]!.id, 'c-reply-1')
  })

  test('caps replies at 5 per thread', async () => {
    const replies = Array.from({ length: 8 }).map((_, i) => ({
      id: `reply-${i}`,
      snippet: { authorDisplayName: `R${i}`, textOriginal: `r${i}`, likeCount: 0, publishedAt: '', updatedAt: '' },
    }))
    fetchQueue.push({
      status: 200,
      body: {
        items: [{
          id: 't1',
          snippet: {
            videoId: 'v1', totalReplyCount: 8, canReply: true, isPublic: true,
            topLevelComment: { id: 'top', snippet: { authorDisplayName: 'A', textOriginal: 'top', likeCount: 0, publishedAt: '', updatedAt: '' } },
          },
          replies: { comments: replies },
        }],
      },
    })
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'v1')
    assert.equal(result.threads[0]!.replies.length, 5)
    assert.equal(result.threads[0]!.reply_count, 8, 'reply_count is the YouTube total, not the slice')
  })

  test('drops items missing topLevelComment without throwing', async () => {
    fetchQueue.push({
      status: 200,
      body: {
        items: [
          { id: 'malformed-1', snippet: { videoId: 'v1' } },                // no topLevelComment
          { id: 'good-1', snippet: { videoId: 'v1', topLevelComment: { id: 'c-good', snippet: { authorDisplayName: 'B', textOriginal: 'hi', likeCount: 0, publishedAt: '', updatedAt: '' } } } },
        ],
      },
    })
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'v1')
    assert.equal(result.threads.length, 1)
    assert.equal(result.threads[0]!.id, 'good-1')
  })

  test('commentsDisabled 403 returns empty result (no throw)', async () => {
    fetchQueue.push({
      status: 403,
      body: {
        error: {
          code: 403,
          errors: [{ reason: 'commentsDisabled', message: 'Comments are disabled for this video.' }],
        },
      },
    })
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'vid-locked')
    assert.deepEqual(result.threads, [])
    assert.equal(result.has_more, false)
    assert.equal(result.video_id, 'vid-locked')
  })

  test('other 4xx errors throw with statusCode', async () => {
    fetchQueue.push({ status: 404, body: { error: { message: 'Video not found' } } })
    await assert.rejects(
      () => mod.listVideoCommentThreads('comments-test', 'acct-1', 'no-such-video'),
      (err: any) => {
        assert.equal(err.statusCode, 404)
        return true
      },
    )
  })

  test('empty videoId returns empty result without an API call', async () => {
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', '')
    assert.deepEqual(result.threads, [])
    assert.equal(fetchQueue.length, 0, 'no fetch issued')
  })

  test('has_more true when YouTube returns nextPageToken AND we hit the cap', async () => {
    // Two pages, each with one thread. Cap at 1 to force has_more=true.
    fetchQueue.push({
      status: 200,
      body: {
        items: [{ id: 't1', snippet: { videoId: 'v1', totalReplyCount: 0, canReply: true, isPublic: true,
          topLevelComment: { id: 'c1', snippet: { authorDisplayName: 'A', textOriginal: 'a', likeCount: 0, publishedAt: '', updatedAt: '' } } } }],
        nextPageToken: 'page2',
      },
    })
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'v1', { maxResults: 1 })
    assert.equal(result.threads.length, 1)
    assert.equal(result.has_more, true, 'cap reached but more pages exist')
  })

  test('has_more false when last page has no nextPageToken', async () => {
    fetchQueue.push({
      status: 200,
      body: {
        items: [{ id: 't1', snippet: { videoId: 'v1', totalReplyCount: 0, canReply: true, isPublic: true,
          topLevelComment: { id: 'c1', snippet: { authorDisplayName: 'A', textOriginal: 'a', likeCount: 0, publishedAt: '', updatedAt: '' } } } }],
      },
    })
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'v1', { maxResults: 50 })
    assert.equal(result.has_more, false)
    assert.equal(result.threads.length, 1)
  })

  test('paginates through nextPageToken until cap reached', async () => {
    // Three pages, one thread each, no cap reached
    for (let i = 0; i < 3; i++) {
      fetchQueue.push({
        status: 200,
        body: {
          items: [{
            id: `t${i}`,
            snippet: {
              videoId: 'v1', totalReplyCount: 0, canReply: true, isPublic: true,
              topLevelComment: { id: `c${i}`, snippet: { authorDisplayName: 'A', textOriginal: `a${i}`, likeCount: 0, publishedAt: '', updatedAt: '' } },
            },
          }],
          ...(i < 2 ? { nextPageToken: `page-${i + 1}` } : {}),
        },
      })
    }
    const result = await mod.listVideoCommentThreads('comments-test', 'acct-1', 'v1', { maxResults: 100, pageSize: 1 })
    assert.equal(result.threads.length, 3)
    assert.deepEqual(result.threads.map(t => t.id), ['t0', 't1', 't2'])
    assert.equal(result.has_more, false)
    assert.equal(fetchQueue.length, 0, 'all 3 pages consumed')
  })
})

describe('youtube-comments — postCommentReply', () => {
  test('posts the right JSON body and returns the normalized comment', async () => {
    fetchQueue.push({
      status: 200,
      assertUrl: (u) => assert.match(u, /\/comments\?/),
      assertBody: (body) => {
        assert.equal(body.snippet.parentId, 'c-top-1')
        assert.equal(body.snippet.textOriginal, 'Thanks for watching!')
      },
      body: {
        id: 'c-new-1',
        snippet: {
          authorDisplayName: 'Channel',
          textOriginal: 'Thanks for watching!',
          likeCount: 0,
          publishedAt: '2026-05-02T00:00:00Z',
          updatedAt: '2026-05-02T00:00:00Z',
        },
      },
    })
    const reply = await mod.postCommentReply('comments-test', 'acct-1', 'c-top-1', 'Thanks for watching!')
    assert.equal(reply.id, 'c-new-1')
    assert.equal(reply.author, 'Channel')
    assert.equal(reply.text, 'Thanks for watching!')
  })

  test('rejects empty parentCommentId', async () => {
    await assert.rejects(
      () => mod.postCommentReply('comments-test', 'acct-1', '', 'hi'),
      /parentCommentId is required/,
    )
    assert.equal(fetchQueue.length, 0)
  })

  test('rejects empty / whitespace-only text', async () => {
    await assert.rejects(
      () => mod.postCommentReply('comments-test', 'acct-1', 'c-1', '   '),
      /reply text is required/,
    )
    assert.equal(fetchQueue.length, 0)
  })

  test('throws with statusCode on API error', async () => {
    fetchQueue.push({ status: 400, body: { error: { message: 'Bad parent' } } })
    await assert.rejects(
      () => mod.postCommentReply('comments-test', 'acct-1', 'bad-parent', 'hi'),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      },
    )
  })
})

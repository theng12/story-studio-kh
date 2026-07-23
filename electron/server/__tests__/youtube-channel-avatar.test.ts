import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  _clearYouTubeChannelAvatarCacheForTests,
  fetchYouTubeChannelAvatar,
} from '../lib/youtube-channel-avatar.js'

const ICON_URL = 'https://yt3.ggpht.com/channel-icon=s88-c-k-c0x00ffffff-no-rj'

afterEach(() => {
  _clearYouTubeChannelAvatarCacheForTests()
})

describe('YouTube channel avatar delivery', () => {
  test('loads and caches a verified Google-hosted image', async () => {
    let calls = 0
    const mockFetch = async () => {
      calls += 1
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' },
      })
    }

    const first = await fetchYouTubeChannelAvatar(ICON_URL, mockFetch as typeof fetch)
    const second = await fetchYouTubeChannelAvatar(ICON_URL, mockFetch as typeof fetch)

    assert.equal(first.contentType, 'image/jpeg')
    assert.deepEqual(first.bytes, Buffer.from([1, 2, 3]))
    assert.deepEqual(second.bytes, first.bytes)
    assert.equal(calls, 1)
  })

  test('rejects unapproved hosts before making a request', async () => {
    let called = false
    await assert.rejects(
      fetchYouTubeChannelAvatar('https://example.com/icon.jpg', async () => {
        called = true
        return new Response()
      }),
      /approved Google image host/,
    )
    assert.equal(called, false)
  })

  test('rejects redirects away from approved image hosts', async () => {
    await assert.rejects(
      fetchYouTubeChannelAvatar(ICON_URL, async () => new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/private' },
      })),
      /approved Google image host/,
    )
  })

  test('rejects non-image and oversized responses', async () => {
    await assert.rejects(
      fetchYouTubeChannelAvatar(ICON_URL, async () => new Response('not an image', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })),
      /not a supported image/,
    )

    await assert.rejects(
      fetchYouTubeChannelAvatar(ICON_URL, async () => new Response('large', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(3 * 1024 * 1024) },
      })),
      /larger than the allowed size/,
    )
  })
})

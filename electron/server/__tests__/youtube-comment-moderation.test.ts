import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  setCommentModerationStatus,
} from '../lib/youtube-client.js'
import { createProject } from '../services/project-manager.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

async function connected(): Promise<{ slug: string; accountId: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Moderation Project' })
  await configureYouTubeApplication({ client_id: 'mod-client', client_secret: 'mod-secret-value' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'UC-mod', title: 'Mod Channel', granted_scopes: ['youtube.force-ssl'] },
    tokens: { access_token: 'mod-access', refresh_token: 'mod-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: 'UC-mod', expected_previous_channel_id: null,
  })
  return { slug: project.slug, accountId: 'registry:UC-mod' }
}

const PATH = (id: string, status: string, ban = false) =>
  `/youtube/v3/comments/setModerationStatus?id=${id}&moderationStatus=${status}${ban ? '&banAuthor=true' : ''}`

describe('comment moderation transport', () => {
  test('sends the exact comment id and status', async () => {
    const { slug, accountId } = await connected()
    const fake = new FakeYouTube()
    fake.respond({ method: 'POST', path: PATH('comment-1', 'rejected'), body: {} })
    __setYouTubeTransportForTests(fake.transport())

    await setCommentModerationStatus({ slug, accountId, commentId: 'comment-1', status: 'rejected' })

    assert.equal(fake.calls.length, 1)
    assert.match(fake.calls[0]!.path, /id=comment-1/)
    assert.match(fake.calls[0]!.path, /moderationStatus=rejected/)
    // Never banned unless asked in so many words.
    assert.doesNotMatch(fake.calls[0]!.path, /banAuthor/)
  })

  test('bans only when explicitly asked', async () => {
    const { slug, accountId } = await connected()
    const fake = new FakeYouTube()
    fake.respond({ method: 'POST', path: PATH('comment-2', 'rejected', true), body: {} })
    __setYouTubeTransportForTests(fake.transport())

    await setCommentModerationStatus({
      slug, accountId, commentId: 'comment-2', status: 'rejected', banAuthor: true,
    })
    assert.match(fake.calls[0]!.path, /banAuthor=true/)
  })

  test('refuses to ban alongside anything but a rejection', async () => {
    const { slug, accountId } = await connected()
    const fake = new FakeYouTube()
    __setYouTubeTransportForTests(fake.transport())

    // Silently dropping the ban would tell the owner someone was banned when
    // they were not.
    await assert.rejects(
      setCommentModerationStatus({
        slug, accountId, commentId: 'comment-3', status: 'published', banAuthor: true,
      }),
      /only be banned while rejecting/,
    )
    assert.equal(fake.calls.length, 0, 'refused before any request')
  })

  test('a provider refusal is an error, never a silent success', async () => {
    const { slug, accountId } = await connected()
    const fake = new FakeYouTube()
    fake.rejectNext({ method: 'POST', path: PATH('comment-4', 'rejected'), status: 403, body: { error: { message: 'no' } } })
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(
      setCommentModerationStatus({ slug, accountId, commentId: 'comment-4', status: 'rejected' }),
      /setModerationStatus failed|quota/i,
    )
  })

  test('there is no comment deletion anywhere in the client', async () => {
    // Spec section 14 gives approve, reject and ban. Rejection HIDES. A delete
    // path would be an unrequested capability on unrecoverable data.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(new URL('../lib/youtube-client.ts', import.meta.url)), 'utf8',
    )
    assert.doesNotMatch(source, /comments\.delete|method: 'DELETE'[\s\S]{0,200}comments/i)
  })
})

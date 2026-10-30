/**
 * Still Posts → Facebook photo, and the refusals that must never read as a post.
 *
 * No network: every platform call is a queued fake response. The rules pinned
 * here are the ones the owner asked for: off by default, never a silent skip,
 * never a double post of the same image, and Instagram refused in plain words
 * because it needs a public image address this app does not have.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { FakeSocial } from './fixtures/fake-social.js'
import { __resetSocialTransportForTests, __setSocialTransportForTests } from '../lib/social-publish/types.js'
import { createProject, updateConfig } from '../services/project-manager.js'
import { configureSocialApplication, saveSocialAccountGrant } from '../services/social-connection-store.js'
import { postDir, writePost } from '../services/still-posts.js'
import { publishStillPost, readStillPostPublishes } from '../services/still-post-publish.js'
import { SocialError } from '../contracts/social-publishing.js'
import type { StillPost } from '../contracts/still-posts.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetSocialTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const META_APP_ID = 'meta:meta-client-id'
const PAGE_ID = 'page-123'
const POST_ID = 'post-0001'
const ASPECT = '1:1'

function postRecord(overrides: Partial<StillPost> = {}): StillPost {
  return {
    id: POST_ID,
    batch_id: 'batch-0001',
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    format_id: 'clean-quote',
    option_id: 'single',
    language: 'en',
    character_ids: [],
    caption: 'A quiet thought #one',
    panels: [{
      id: 'panel-1', role: 'single', text: 'A quiet thought', scene_prompt: 'a quiet field', image: null,
    }],
    finals: [{
      aspect: ASPECT, panel_id: 'panel-1', filename: 'final-p0-1x1.png',
      rendered_at: '2026-10-30T00:00:00.000Z', text: 'A quiet thought',
      style_hash: 'style', font_id: 'inter',
    }],
    aspects: [ASPECT],
    ...overrides,
  }
}

/** A PNG-shaped file the app's own header check accepts, with a different body per fill. */
function pngBytes(fill: number): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2040, fill)])
}

async function setUp(options: { rendered?: boolean, platforms?: string[], connected?: boolean } = {}): Promise<{ slug: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Still Posts Channel' })
  const slug = project.slug

  const post = postRecord()
  await writePost(slug, post)
  if (options.rendered !== false) {
    await fs.writeFile(path.join(postDir(slug, POST_ID), 'final-p0-1x1.png'), pngBytes(9))
  }
  if (options.platforms) await updateConfig(slug, { social_platforms: options.platforms } as never)

  if (options.connected !== false) {
    await configureSocialApplication({
      provider: 'meta',
      client_id: 'meta-client-id',
      client_secret: 'test-secret',
      redirect_uri: 'http://127.0.0.1:41234/callback',
    })
    await saveSocialAccountGrant({
      platform: 'facebook',
      application_id: META_APP_ID,
      remote_id: PAGE_ID,
      remote_name: 'Test Page',
      page_id: PAGE_ID,
      tokens: {
        application_id: META_APP_ID,
        access_token: 'test-user-token',
        refresh_token: '',
        expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
        page_token: 'test-page-token',
      },
    })
    await updateConfig(slug, { social_accounts: { facebook: PAGE_ID } } as never)
  }
  return { slug }
}

async function refusal(promise: Promise<unknown>): Promise<SocialError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected a SocialError, got ${String(error)}`)
    return error
  }
  assert.fail('expected a refusal')
}

test('a channel that has not turned posting on posts nothing', async () => {
  const { slug } = await setUp()
  const fake = new FakeSocial()
  __setSocialTransportForTests(fake.transport)

  const error = await refusal(publishStillPost(slug, POST_ID, 'facebook'))
  assert.equal(error.code, 'SOCIAL_POST_NOT_ENABLED')
  assert.match(error.detail, /Settings → Publishing/)
  assert.equal(fake.calls.length, 0)
  assert.deepEqual(await readStillPostPublishes(slug), {})
})

test('Instagram is refused because it needs a public image address, not half-posted', async () => {
  const { slug } = await setUp({ platforms: ['instagram'] })
  const fake = new FakeSocial()
  __setSocialTransportForTests(fake.transport)

  const error = await refusal(publishStillPost(slug, POST_ID, 'instagram'))
  assert.equal(error.code, 'SOCIAL_IMAGE_URL_REQUIRED')
  assert.match(error.detail, /public/)
  assert.equal(fake.calls.length, 0)
})

test('an unrendered post is refused before any request', async () => {
  const { slug } = await setUp({ platforms: ['facebook'], rendered: false })
  const fake = new FakeSocial()
  __setSocialTransportForTests(fake.transport)

  const error = await refusal(publishStillPost(slug, POST_ID, 'facebook'))
  assert.equal(error.code, 'SOCIAL_IMAGE_NOT_RENDERED')
  assert.equal(fake.calls.length, 0)
})

test('a connected Page posts the image once, records the receipt, and never double-posts the same file', async () => {
  const { slug } = await setUp({ platforms: ['facebook'] })
  const fake = new FakeSocial()
  fake.respond({ method: 'POST', url: `/${PAGE_ID}/photos`, body: { id: 'photo-9', post_id: 'page-123_photo-9' } })
  __setSocialTransportForTests(fake.transport)

  const first = await publishStillPost(slug, POST_ID, 'facebook')
  assert.equal(first.already, false)
  assert.equal(first.receipt.post_id, 'page-123_photo-9')
  assert.equal(first.receipt.file, 'final-p0-1x1.png')
  assert.match(first.receipt.file_sha256, /^[0-9a-f]{64}$/)
  assert.equal(fake.callsTo(`/${PAGE_ID}/photos`).length, 1)

  const second = await publishStillPost(slug, POST_ID, 'facebook')
  assert.equal(second.already, true, 'the same image is not posted twice')
  assert.equal(second.receipt.post_id, 'page-123_photo-9')
  assert.equal(fake.callsTo(`/${PAGE_ID}/photos`).length, 1, 'the retry sent nothing')

  const stored = await readStillPostPublishes(slug)
  assert.equal(stored[POST_ID]?.facebook?.post_id, 'page-123_photo-9')
})

test('a re-rendered image is a new post, not a skipped retry', async () => {
  const { slug } = await setUp({ platforms: ['facebook'] })
  const fake = new FakeSocial()
  fake.respond({ method: 'POST', url: `/${PAGE_ID}/photos`, body: { post_id: 'page-123_photo-9' } })
  fake.respond({ method: 'POST', url: `/${PAGE_ID}/photos`, body: { post_id: 'page-123_photo-10' } })
  __setSocialTransportForTests(fake.transport)

  await publishStillPost(slug, POST_ID, 'facebook')
  await fs.writeFile(path.join(postDir(slug, POST_ID), 'final-p0-1x1.png'), pngBytes(3))
  const again = await publishStillPost(slug, POST_ID, 'facebook')
  assert.equal(again.already, false)
  assert.equal(again.receipt.post_id, 'page-123_photo-10')
  assert.equal(fake.callsTo(`/${PAGE_ID}/photos`).length, 2)
})

test('a platform failure is recorded and never reported as posted', async () => {
  const { slug } = await setUp({ platforms: ['facebook'] })
  const fake = new FakeSocial()
  fake.respond({ method: 'POST', url: `/${PAGE_ID}/photos`, status: 500, body: { error: { message: 'Please reduce the amount of data' } } })
  __setSocialTransportForTests(fake.transport)

  const error = await refusal(publishStillPost(slug, POST_ID, 'facebook'))
  assert.equal(error.code, 'SOCIAL_PLATFORM_REFUSED')
  assert.match(error.detail, /reduce the amount of data/)
  const stored = await readStillPostPublishes(slug)
  assert.equal(stored[POST_ID]?.facebook, undefined, 'nothing is recorded as posted')
  assert.match(stored[POST_ID]?.last_failure?.facebook?.message || '', /reduce the amount of data/)
})

test('a corrupt posting record refuses to post rather than risking a duplicate', async () => {
  const { slug } = await setUp({ platforms: ['facebook'] })
  await fs.writeFile(path.join(postDir(slug, POST_ID), 'publish.json'), '{not json')
  const fake = new FakeSocial()
  __setSocialTransportForTests(fake.transport)

  await assert.rejects(
    () => publishStillPost(slug, POST_ID, 'facebook'),
    /cannot tell whether this image was already posted/,
  )
  assert.equal(fake.calls.length, 0)
})

test('an opted-in channel with no connected Page is refused by name', async () => {
  const { slug } = await setUp({ platforms: ['facebook'], connected: false })
  const fake = new FakeSocial()
  __setSocialTransportForTests(fake.transport)

  const error = await refusal(publishStillPost(slug, POST_ID, 'facebook'))
  assert.equal(error.code, 'SOCIAL_ACCOUNT_NOT_CONNECTED')
  assert.equal(fake.calls.length, 0)
})

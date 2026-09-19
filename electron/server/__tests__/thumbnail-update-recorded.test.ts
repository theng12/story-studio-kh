/**
 * `youtube-thumbnail-refresh` declared `{ expected: 1, completed: 1 }` — a
 * tautology that certifies a thumbnail update on the strength of reaching a line
 * of code. The audit missed this one; it named the identical shape in
 * `contextual-cues.ts`.
 *
 * The declaration now reads the operation record back. These tests pin that the
 * three ways the evidence can be absent all yield "not recorded" — because each
 * of them would otherwise be reported as a successful thumbnail update:
 *
 *   - the record does not exist
 *   - it exists but carries no `thumbnail_update` action
 *   - it carries one, but in a state other than `succeeded`
 *
 * They exercise the predicate rather than the generator, which uploads to
 * YouTube.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let connections: typeof import('../services/youtube-connection-store.js')
let store: typeof import('../services/youtube-operation-store.js')
let thumbnails: typeof import('../generators/youtube-thumbnail-refresh.js')
let cleanup: (() => Promise<void>) | undefined

const NOW = '2026-09-19T12:00:00.000Z'
const PAYLOAD = {
  snippet_json: JSON.stringify({ title: 'Episode 1', description: '', tags: [], categoryId: '24' }),
  status_json: JSON.stringify({ privacyStatus: 'private' }),
  source_sha256: 'a'.repeat(64),
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  connections = await import('../services/youtube-connection-store.js')
  store = await import('../services/youtube-operation-store.js')
  thumbnails = await import('../generators/youtube-thumbnail-refresh.js')
  await connections.configureYouTubeApplication({ client_id: 'client-id-1', client_secret: 'client-secret-1' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: 'channel-1', title: 'Channel 1', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1_900_000_000_000 },
  })
})

after(async () => { await cleanup?.(); cleanup = undefined })

/** The channel may be assigned ONCE — a second assignment 409s. */
let sharedSlug = ''

async function projectWithOperation() {
  const { createProject } = await import('../services/project-manager.js')
  if (!sharedSlug) {
    const created = await createProject({ name: 'Thumbnail Record Project' })
    sharedSlug = created.slug
    await connections.assignProjectYouTubeChannel({
      project_slug: sharedSlug, channel_id: 'channel-1', expected_previous_channel_id: null,
    })
  }
  const created = { slug: sharedSlug }
  const operation = await store.createYouTubeOperation({
    project_slug: created.slug, episode_code: `EP${String(Math.floor(Math.random() * 9000) + 1000)}`,
    channel_id: 'channel-1',
    source_revision: `source-${Math.random()}`, metadata_revision: `metadata-${Math.random()}`,
    final_payload: PAYLOAD, origin: 'manual', final_action: 'manual_upload',
  })
  return { slug: created.slug, operationId: operation.operation_id }
}

describe('a thumbnail update counts as done only when the record says so', () => {
  test('a succeeded thumbnail_update action ⇒ recorded', async () => {
    const { slug, operationId } = await projectWithOperation()
    await store.updatePinnedYouTubeOperation({
      project_slug: slug, operation_id: operationId, expected_revision: 1, expected_channel_id: 'channel-1',
      mutate(current) {
        current.actions.push({
          action_id: 'action_thumb_ok', action: 'thumbnail_update',
          classification: 'independent_post_accept', state: 'succeeded', occurred_at: NOW,
        })
      },
    })
    assert.equal(await thumbnails.thumbnailUpdateWasRecorded(slug, operationId), true)
  })

  test('no thumbnail_update action at all ⇒ NOT recorded', async () => {
    // The state the tautology certified: the upload path was reached, but
    // nothing durable says a thumbnail update succeeded.
    const { slug, operationId } = await projectWithOperation()
    assert.equal(await thumbnails.thumbnailUpdateWasRecorded(slug, operationId), false)
  })

  test('a FAILED thumbnail_update action ⇒ NOT recorded', async () => {
    const { slug, operationId } = await projectWithOperation()
    await store.updatePinnedYouTubeOperation({
      project_slug: slug, operation_id: operationId, expected_revision: 1, expected_channel_id: 'channel-1',
      mutate(current) {
        current.actions.push({
          action_id: 'action_thumb_fail', action: 'thumbnail_update',
          classification: 'independent_post_accept', state: 'failed', occurred_at: NOW,
        })
      },
    })
    assert.equal(await thumbnails.thumbnailUpdateWasRecorded(slug, operationId), false)
  })

  test('an unknown operation id ⇒ NOT recorded, and does not throw', async () => {
    const { slug } = await projectWithOperation()
    assert.equal(await thumbnails.thumbnailUpdateWasRecorded(slug, 'no-such-operation'), false)
  })
})

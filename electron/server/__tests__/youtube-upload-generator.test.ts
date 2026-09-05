import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
} from '../lib/youtube-client.js'
import { generateYoutubeUpload } from '../generators/youtube-upload.js'
import { createProject } from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import * as store from '../services/upload-store.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
} from '../services/youtube-connection-store.js'
import { listYouTubeOperations } from '../services/youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from '../services/youtube-project-publishing-store.js'
import { recordYouTubeQuotaAttempt } from '../services/youtube-quota-ledger.js'
import { readYouTubeConnectionRegistry } from '../services/youtube-connection-store.js'
import { buildYouTubeMetadataPackage, resolveYouTubeUploadSettings } from '../services/youtube-metadata-package.js'
import { resolveSourceRevision } from '../services/youtube-operation-recorder.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

const CODE = 'EP0001'
const TITLE = 'Generator Episode'
const CHANNEL = 'UC-generator'
const SESSION = 'https://upload.youtube.test/resumable/session-abc'

async function setUp(assign: boolean): Promise<{ slug: string; accountId: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Generator Project' })
  const slug = project.slug
  const projectDir = path.join(temp.dir, 'projects', slug)

  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', episode_code: CODE, title: TITLE, status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))

  const paths = await resolveEpisodePaths(slug, CODE, TITLE)
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'A Real Episode Title', description: 'A real description.', tags: ['alpha', 'beta'],
  }))
  await fs.mkdir(paths.video_dir, { recursive: true })
  await fs.writeFile(path.join(paths.video_dir, `${CODE}_final_video.mp4`), tinyVideoBytes())

  if (assign) {
    await configureYouTubeApplication({ client_id: 'generator-client', client_secret: 'generator-secret-value' })
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: CHANNEL, title: 'Generator Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'generator-access', refresh_token: 'generator-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({ project_slug: slug, channel_id: CHANNEL, expected_previous_channel_id: null })
  }
  return { slug, accountId: `registry:${CHANNEL}` }
}

function fakeAcceptingUpload(videoId: string): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respond({
    method: 'POST',
    path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    body: {},
    headers: { Location: SESSION },
  })
  fake.respond({ method: 'PUT', path: '/resumable/session-abc', body: { id: videoId } })
  return fake
}

function job(slug: string, accountId: string): any {
  return {
    job_id: `job-${Math.random().toString(16).slice(2)}`,
    project_slug: slug,
    episode_id: CODE,
    output_lines: [] as string[],
    params: { episode_id: CODE, account_id: accountId },
  }
}

describe('youtube upload generator', () => {
  test('an assigned project gets a durable accepted operation and episode link', async () => {
    const { slug, accountId } = await setUp(true)
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-generated').transport())

    const running = job(slug, accountId)
    await generateYoutubeUpload(running)

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations.length, 1, 'exactly one durable operation')
    const record = operations[0]!
    assert.equal(record.lifecycle, 'accepted')
    assert.equal(record.video_id, 'video-generated')
    assert.equal(record.channel_id, CHANNEL)
    assert.equal(record.episode_code, CODE)
    // The accepted payload is the canonical package, so preview/upload
    // equality is checkable from the record alone.
    assert.equal(JSON.parse(record.final_payload!.snippet_json).title, 'A Real Episode Title')

    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links[CODE]?.video_id, 'video-generated')


    // No credential ever reaches the job log the operator reads.
    const log = running.output_lines.join('\n')
    assert.equal(log.includes(SESSION), false, 'the resumable session URL is a credential')
    assert.equal(log.includes('generator-access-token'), false)
    assert.equal(log.includes('generator-secret-value'), false)
  })

  test('provider acceptance is checkpointed to the pinned channel across an in-flight reassignment', async () => {
    const { slug, accountId } = await setUp(true)
    const secondChannel = 'UC-generator-2'
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: secondChannel, title: 'Second Channel', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'second-access', refresh_token: 'second-refresh', expires_at: Date.now() + 3_600_000 },
    })
    let providerCalls = 0
    __setYouTubeTransportForTests((async (input, init) => {
      providerCalls++
      const url = String(input)
      if ((init?.method || 'GET') === 'POST' && url.includes('/upload/youtube/v3/videos')) {
        return new Response('', { status: 200, headers: { Location: SESSION } })
      }
      if ((init?.method || 'GET') === 'PUT' && url === SESSION) {
        await assignProjectYouTubeChannel({
          project_slug: slug, channel_id: secondChannel, expected_previous_channel_id: CHANNEL,
        })
        return new Response(JSON.stringify({ id: 'video-pinned-channel' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url}`)
    }) as typeof fetch)

    const originalJob = job(slug, accountId)
    await generateYoutubeUpload(originalJob)
    const [record] = await listYouTubeOperations(slug)
    assert.equal(record?.lifecycle, 'accepted')
    assert.equal(record?.video_id, 'video-pinned-channel')
    assert.equal(record?.channel_id, CHANNEL)
    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links[CODE]?.channel_id, CHANNEL)
    assert.equal((await readYouTubeConnectionRegistry()).assignments[slug]?.channel_id, secondChannel)

    const beforeRetryCalls = providerCalls
    await assert.rejects(generateYoutubeUpload(originalJob), /Reconnect|assigned|not found/i)
    assert.equal(providerCalls, beforeRetryCalls, 'retry under the stale channel never reaches YouTube')
    assert.equal((await listYouTubeOperations(slug)).length, 1)
  })

  test('the legacy private-first upload mode records but never qualifies', async () => {
    // Regression: this was first written as "privacyStatus is private", which
    // is true of EVERY Story Studio upload — so nothing could ever qualify.
    // `private_upload` is the legacy per-platform upload MODE.
    const { slug, accountId } = await setUp(true)
    await store.setUploadMode(slug, 'youtube', 'private')
    __setYouTubeTransportForTests(fakeAcceptingUpload('video-private-mode').transport())

    await generateYoutubeUpload(job(slug, accountId))

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations[0]?.final_action, 'private_upload')
    assert.equal(operations[0]?.lifecycle, 'accepted')
  })

  test('an unassigned project refuses before provider work or an operation record', async () => {
    const { slug, accountId } = await setUp(false)
    const fake = fakeAcceptingUpload('video-legacy')
    __setYouTubeTransportForTests(fake.transport())

    const running = job(slug, accountId)
    await assert.rejects(
      generateYoutubeUpload(running),
      /Reconnect it in Settings → YouTube|not found/,
    )

    assert.equal(await listYouTubeOperations(slug).then(o => o.length), 0, 'no durable record without an assignment')
    assert.equal(fake.calls.length, 0)
  })

  test('a rendered video changed after admission is refused before provider work', async () => {
    const { slug, accountId } = await setUp(true)
    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    const sourcePath = path.join(paths.video_dir, `${CODE}_final_video.mp4`)
    const settings = await resolveYouTubeUploadSettings(slug)
    const approved = await buildYouTubeMetadataPackage({
      project_slug: slug,
      episode_code: CODE,
      privacy_status: 'private',
      mark_as_ai_generated: settings.mark_as_ai_generated,
      ...(settings.category_id !== undefined ? { category_id: settings.category_id } : {}),
      fallback_title: TITLE,
    })
    const admittedRevision = await resolveSourceRevision(sourcePath)
    const changedAt = new Date(Date.now() + 2_000)
    await fs.utimes(sourcePath, changedAt, changedAt)
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())
    const running = job(slug, accountId)
    running.params = {
      ...running.params,
      expected_channel_id: CHANNEL,
      expected_package_revision: approved.package_revision,
      approved_final_payload: approved.final_payload,
      expected_source_revision: admittedRevision,
    }

    await assert.rejects(generateYoutubeUpload(running), /rendered video changed after confirmation/i)

    assert.equal(fake.calls.length, 0)
    assert.equal((await listYouTubeOperations(slug)).length, 0)
  })

  test('the operation record is opened before the upload, so an interrupted attempt leaves evidence', async () => {
    const { slug, accountId } = await setUp(true)
    const fake = new FakeYouTube()
    fake.respond({
      method: 'POST',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      body: {},
      headers: { Location: SESSION },
    })
    // The PUT is never answered: the upload fails after the record exists.
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)))

    const operations = await listYouTubeOperations(slug)
    assert.equal(operations.length, 1, 'the attempt left a record behind')
    assert.notEqual(operations[0]!.lifecycle, 'accepted')
    assert.equal(operations[0]!.video_id, undefined)
    // Nothing was linked on a failed attempt.
    const state = await readYouTubeProjectPublishingState(slug)
    assert.equal(state.episode_video_links[CODE], undefined)
  })

  test('a corrupt operation index fails closed before any provider request', async () => {
    const { slug, accountId } = await setUp(true)
    const projectDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug)
    const operationsDir = path.join(projectDir, 'youtube', 'operations')
    await fs.mkdir(operationsDir, { recursive: true })
    await fs.writeFile(path.join(operationsDir, 'index.json'), '{broken')
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /operation|corrupt/i)
    assert.equal(fake.calls.length, 0)
  })

  test('a quota refusal closes its pre-session operation and a later upload can retry', async () => {
    const { slug, accountId } = await setUp(true)
    const applicationId = (await readYouTubeConnectionRegistry()).application!.application_id
    await recordYouTubeQuotaAttempt({
      application_id: applicationId, channel_id: CHANNEL,
      bucket: 'video_uploads', operation: 'videos_insert', amount: 100,
    })
    const fake = fakeAcceptingUpload('must-not-upload')
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /quota/i)
    assert.equal(fake.calls.length, 0)
    assert.equal((await listYouTubeOperations(slug))[0]?.lifecycle, 'failed')
  })

  test('a restart resumes the same session and operation with its original init payload', async () => {
    const { slug, accountId } = await setUp(true)
    let initCount = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        initCount += 1
        return new Response('{}', { status: 200, headers: { Location: SESSION } })
      }
      if (url === SESSION) throw new DOMException('simulated process interruption', 'AbortError')
      throw new Error(`Unexpected request: ${init?.method} ${url}`)
    }) as typeof fetch)

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)), /cancelled|interruption/i)
    const interrupted = await listYouTubeOperations(slug)
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0]?.lifecycle, 'uploading')
    assert.ok(interrupted[0]?.resumable?.session_url_hash)
    const originalPayload = interrupted[0]!.final_payload!

    const paths = await resolveEpisodePaths(slug, CODE, TITLE)
    await fs.writeFile(paths.metadata_json, JSON.stringify({
      title: 'Changed After Interruption', description: 'new', tags: ['new'],
    }))
    let probeCount = 0
    let chunkCount = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        initCount += 1
        throw new Error('resume must not create a second session')
      }
      if (url !== SESSION) throw new Error(`Unexpected request: ${url}`)
      const headers = new Headers(init?.headers)
      if (headers.get('Content-Range')?.startsWith('bytes */')) {
        probeCount += 1
        return new Response(null, { status: 308 })
      }
      chunkCount += 1
      return new Response(JSON.stringify({ id: 'video-resumed' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    await generateYoutubeUpload(job(slug, accountId))
    const completed = await listYouTubeOperations(slug)
    assert.equal(initCount, 1)
    assert.equal(probeCount, 1)
    assert.equal(chunkCount, 1)
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.operation_id, interrupted[0]?.operation_id)
    assert.equal(completed[0]?.lifecycle, 'accepted')
    assert.deepEqual(completed[0]?.final_payload, originalPayload)
    assert.equal(JSON.parse(completed[0]!.final_payload!.snippet_json).title, 'A Real Episode Title')
  })

  test('a restart repairs the sidecar-to-operation hash crash window before any byte PUT', async () => {
    const { slug, accountId } = await setUp(true)
    const operationsDir = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'projects', slug, 'youtube', 'operations')
    let initCount = 0
    let bytePuts = 0
    __setYouTubeTransportForTests((async (input) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) {
        initCount += 1
        // The operation exists and is uploading now. Prevent the atomic
        // session-hash checkpoint while leaving the credential sidecar path
        // writable, reproducing the exact crash window after init.
        await fs.chmod(operationsDir, 0o500)
        return new Response('{}', { status: 200, headers: { Location: SESSION } })
      }
      if (url === SESSION) {
        bytePuts += 1
        throw new Error('bytes must not be sent until the operation hash is durable')
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch)

    await assert.rejects(generateYoutubeUpload(job(slug, accountId)))
    await fs.chmod(operationsDir, 0o700)
    const interrupted = await listYouTubeOperations(slug)
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0]?.lifecycle, 'uploading')
    assert.equal(interrupted[0]?.resumable, undefined)
    const originalPayload = interrupted[0]!.final_payload
    assert.equal(bytePuts, 0)

    let probes = 0
    __setYouTubeTransportForTests((async (input, init) => {
      const url = String(input)
      if (url.includes('/upload/youtube/v3/videos')) throw new Error('must reuse the saved session')
      if (url !== SESSION) throw new Error(`Unexpected request: ${url}`)
      const headers = new Headers(init?.headers)
      if (headers.get('Content-Range')?.startsWith('bytes */')) {
        probes += 1
        const repaired = (await listYouTubeOperations(slug))[0]
        assert.ok(repaired?.resumable?.session_url_hash, 'hash is durable before the provider probe')
        return new Response(null, { status: 308 })
      }
      bytePuts += 1
      return new Response(JSON.stringify({ id: 'video-recovered-window' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    await generateYoutubeUpload(job(slug, accountId))
    const completed = (await listYouTubeOperations(slug))[0]!
    assert.equal(initCount, 1)
    assert.equal(probes, 1)
    assert.equal(bytePuts, 1)
    assert.equal(completed.operation_id, interrupted[0]?.operation_id)
    assert.equal(completed.video_id, 'video-recovered-window')
    assert.deepEqual(completed.final_payload, originalPayload)
  })

})

describe('the manual upload job never edits a video that is already published', () => {
  test('it refuses rather than PATCHing when a legacy sidecar names a video', async () => {
    // The fourth review's defect, at the layer that actually talks to YouTube.
    // With a sidecar present the generator's `shouldUpdateOnly` branch PATCHes
    // the LIVE video's title, description and tags and sends no status block at
    // all - while the owner has been told an upload started. The manual route
    // asks `remoteVideoFor` before it does anything, and this is the tripwire
    // that proves the refusal is real.
    const { slug, accountId } = await setUp(true)
    const { writeSidecar } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'already-live-42', account_id: accountId,
      channel_id: CHANNEL, uploaded_at: new Date().toISOString(), last_sync_at: new Date().toISOString(),
      scheduled_for: null, privacy_status: 'public', title: TITLE, description: 'd', tags: [],
      thumbnail_set: false,
    })

    // A fake that would ACCEPT a PATCH. If the branch is reachable, the test
    // fails by succeeding - which is the point: asserting "no error" here would
    // have proved nothing.
    const fake = new FakeYouTube()
    fake.respondMatching({ method: 'PUT', match: /\/youtube\/v3\/videos/, body: { id: 'already-live-42' } })
    __setYouTubeTransportForTests(fake.transport())

    const running = job(slug, accountId)
    await assert.rejects(
      () => generateYoutubeUpload(running),
      /already on YouTube as already-live-42/,
      'the manual job refuses instead of editing a published video',
    )
    assert.equal(fake.calls.length, 0, 'and YouTube was never contacted at all')
  })
})

describe('a fresh upload carries nothing forward from a previous video', () => {
  test('re-uploading after a takedown does not re-tombstone the new video', async () => {
    // `existing` used to be null on this path, so the spread was dead. Removing
    // the update branch made it LIVE — and the new sidecar inherited the old
    // video's `deleted_at`, so the takedown fix produced a video that was born
    // tombstoned: invisible to `remoteVideoFor` and immediately re-uploadable.
    const { slug, accountId } = await setUp(true)
    const { writeSidecar, readSidecarRaw } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'taken-down-1', account_id: accountId,
      channel_id: CHANNEL, uploaded_at: '2026-01-01T00:00:00.000Z',
      last_sync_at: '2026-01-01T00:00:00.000Z', scheduled_for: null,
      privacy_status: 'public', title: TITLE, description: 'old description',
      tags: ['old'], thumbnail_set: true, deleted_at: '2026-02-01T00:00:00.000Z',
      deleted_reason: 'takedown',
    })

    __setYouTubeTransportForTests(fakeAcceptingUpload('video-after-takedown').transport())
    await generateYoutubeUpload(job(slug, accountId))

    const after = await readSidecarRaw(slug, CODE, TITLE, 'youtube')
    assert.equal(after!.video_id, 'video-after-takedown')
    assert.equal(after!.deleted_at, undefined, 'the new video is not born tombstoned')
    assert.equal(after!.deleted_reason, undefined)
    assert.equal(after!.thumbnail_set, false, 'the old video\'s thumbnail state is not claimed')
    assert.notEqual(after!.uploaded_at, '2026-01-01T00:00:00.000Z', 'uploaded_at is this upload')

    // The outcome that matters: the new video is visible as published.
    const { remoteVideoFor } = await import('../services/youtube-remote-video.js')
    const seen = await remoteVideoFor(slug, CODE, TITLE, CHANNEL)
    assert.equal(seen?.video_id, 'video-after-takedown')
  })

  test('uploading to a different channel refuses rather than erasing the old link', async () => {
    // One sidecar per episode. Uploading to a second channel would overwrite
    // the only local record of the video on the first — the guard the deleted
    // update branch carried, restored for the upload path.
    const { slug, accountId } = await setUp(true)
    const { writeSidecar } = await import('../services/upload-sidecar.js')
    await writeSidecar(slug, CODE, TITLE, {
      platform: 'youtube', video_id: 'on-old-channel', account_id: accountId,
      channel_id: 'UC-a-different-channel', uploaded_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(), scheduled_for: null,
      privacy_status: 'public', title: TITLE, description: 'd', tags: [], thumbnail_set: false,
    })

    const fake = fakeAcceptingUpload('should-never-happen')
    __setYouTubeTransportForTests(fake.transport())
    await assert.rejects(
      () => generateYoutubeUpload(job(slug, accountId)),
      /was uploaded to channel UC-a-different-channel as on-old-channel/,
    )
    assert.equal(fake.calls.length, 0, 'YouTube was never contacted')
  })
})

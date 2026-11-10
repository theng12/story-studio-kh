import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { diagnosticEvent, diagnosticPhase, installDiagnosticHooks } from './_diagnostic-phases.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  uploadVideo,
} from '../lib/youtube-client.js'
import { createProject } from '../services/project-manager.js'
import {
  assignProjectYouTubeChannel,
  configureYouTubeApplication,
  readYouTubeConnectionRegistry,
} from '../services/youtube-connection-store.js'
import { readYouTubeQuota } from '../services/youtube-quota-ledger.js'

let cleanup: (() => Promise<void>) | undefined

const INIT_PATH = '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'
const SESSION = 'https://upload.youtube.test/resumable/startup-session'

installDiagnosticHooks('youtube-upload-startup.test.ts')
afterEach(async () => {
  diagnosticEvent('transport-reset:start')
  __resetYouTubeTransportForTests()
  diagnosticEvent('transport-reset:end')
  await diagnosticPhase('fixture-cleanup', () => cleanup?.())
  cleanup = undefined
})

async function setUp(label: string): Promise<{ slug: string; accountId: string; source: string }> {
  diagnosticEvent('fixture-setup:start')
  const temp = await diagnosticPhase('fixture-create', () => useTempDataDir())
  cleanup = temp.cleanup
  await configureYouTubeApplication({
    client_id: `startup-client-${label}`,
    client_secret: `startup-secret-${label}`,
  })

  const channelId = `UC-startup-${label}`
  const project = await createProject({ name: `YouTube startup ${label}` })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channelId, title: `Startup ${label}`, granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: `startup-access-${label}`,
      refresh_token: `startup-refresh-${label}`,
      expires_at: Date.now() + 3_600_000,
    },
  })
  await assignProjectYouTubeChannel({
    project_slug: project.slug,
    channel_id: channelId,
    expected_previous_channel_id: null,
  })

  const source = path.join(temp.dir, 'source.mp4')
  await fs.writeFile(source, tinyVideoBytes())
  diagnosticEvent('fixture-setup:end')
  return { slug: project.slug, accountId: `registry:${channelId}`, source }
}

function uploadArgs(
  fixture: { slug: string; accountId: string; source: string },
  extra: Record<string, unknown> = {},
): any {
  return {
    slug: fixture.slug,
    accountId: fixture.accountId,
    filePath: fixture.source,
    snippet: { title: 'Startup retry test' },
    status: { privacyStatus: 'private' },
    ...extra,
  }
}

async function videoUploadCount(): Promise<number> {
  const registry = await readYouTubeConnectionRegistry()
  const snapshot = await readYouTubeQuota(registry.application!.application_id)
  return snapshot.buckets.video_uploads.used
}

function initAndPutFake(videoId = 'startup-video'): FakeYouTube {
  const fake = new FakeYouTube()
  fake.respond({ method: 'POST', path: INIT_PATH, body: {}, headers: { Location: SESSION } })
  fake.respond({ method: 'PUT', path: '/resumable/startup-session', body: { id: videoId } })
  return fake
}

function methodOf(init?: RequestInit): string {
  return String(init?.method || 'GET').toUpperCase()
}

describe('YouTube upload session startup retry', () => {
  test('retries a transient connection failure, then sends bytes once and charges each init attempt', async () => {
    const fixture = await setUp('connection')
    const fake = initAndPutFake()
    const logLines: string[] = []
    let initAttempts = 0
    __setYouTubeTransportForTests((async (input, init) => {
      if (methodOf(init) === 'POST') {
        initAttempts++
        if (initAttempts === 1) {
          throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })
        }
      }
      return fake.transport()(input, init)
    }) as typeof fetch)

    await uploadVideo(uploadArgs(fixture, { logLines }))

    assert.equal(initAttempts, 2)
    assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 1)
    assert.equal(await videoUploadCount(), 2)
    assert.ok(logLines.some(line => /connection interrupted.*Retrying session setup/i.test(line)))
  })

  test('exhausts three transient startup failures without sending video bytes or leaking transport details', async () => {
    const fixture = await setUp('exhausted')
    const logLines: string[] = []
    let initAttempts = 0
    __setYouTubeTransportForTests((async (_input, init) => {
      assert.equal(methodOf(init), 'POST')
      initAttempts++
      throw Object.assign(new TypeError('fetch failed'), {
        code: 'ECONNRESET',
        cause: new Error('secret-token https://user:secret@example.test/upload'),
      })
    }) as typeof fetch)

    await assert.rejects(
      uploadVideo(uploadArgs(fixture, { logLines })),
      (error: unknown) => {
        const failure = error as Error & { code?: string }
        assert.match(failure.message, /YouTube upload could not start: ECONNRESET/i)
        assert.match(failure.message, /No video bytes were sent/i)
        assert.doesNotMatch(failure.message, /secret-token|user:secret|example\.test/i)
        return true
      },
    )

    assert.equal(initAttempts, 3)
    assert.equal(await videoUploadCount(), 3)
    assert.equal(logLines.filter(line => /Retrying session setup/i.test(line)).length, 2)
  })

  test('does not retry a permanent 403 startup response', async () => {
    const fixture = await setUp('forbidden')
    const fake = new FakeYouTube()
    fake.rejectNext({ method: 'POST', path: INIT_PATH, status: 403, body: { error: { message: 'forbidden' } } })
    __setYouTubeTransportForTests(fake.transport())

    await assert.rejects(uploadVideo(uploadArgs(fixture)), /Upload init failed \(403\)/i)
    assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 0)
    assert.equal(await videoUploadCount(), 1)
  })

  test('does not retry an abort raised by the startup transport', async () => {
    const fixture = await setUp('abort')
    let requests = 0
    __setYouTubeTransportForTests((async (_input, init) => {
      requests++
      assert.equal(methodOf(init), 'POST')
      throw new DOMException('The operation was aborted', 'AbortError')
    }) as typeof fetch)

    await assert.rejects(
      uploadVideo(uploadArgs(fixture)),
      (error: unknown) => (error as DOMException).name === 'AbortError',
    )
    assert.equal(requests, 1)
    assert.equal(await videoUploadCount(), 1)
  })

  test('does not retry a TLS certificate failure and exposes only its safe code', async () => {
    const fixture = await setUp('tls')
    let requests = 0
    __setYouTubeTransportForTests((async (_input, init) => {
      requests++
      assert.equal(methodOf(init), 'POST')
      throw Object.assign(new TypeError('fetch failed'), {
        code: 'CERT_HAS_EXPIRED',
        cause: new Error('private certificate https://user:secret@example.test'),
      })
    }) as typeof fetch)

    await assert.rejects(
      uploadVideo(uploadArgs(fixture)),
      (error: unknown) => {
        const failure = error as Error
        assert.match(failure.message, /YouTube upload could not start: secure connection rejected \(CERT_HAS_EXPIRED\)/i)
        assert.doesNotMatch(failure.message, /private certificate|user:secret|example\.test/i)
        return true
      },
    )
    assert.equal(requests, 1)
    assert.equal(await videoUploadCount(), 1)
  })

  test('retries a transient HTTP 503 startup response before one PUT', async () => {
    const fixture = await setUp('http503')
    const fake = new FakeYouTube()
    fake.rejectNext({ method: 'POST', path: INIT_PATH, status: 503, body: { error: { message: 'busy' } } })
    fake.respond({ method: 'POST', path: INIT_PATH, body: {}, headers: { Location: SESSION } })
    fake.respond({ method: 'PUT', path: '/resumable/startup-session', body: { id: 'startup-503-video' } })
    const logLines: string[] = []
    __setYouTubeTransportForTests(fake.transport())

    await uploadVideo(uploadArgs(fixture, { logLines }))

    assert.equal(fake.calls.filter(call => call.method === 'POST').length, 2)
    assert.equal(fake.calls.filter(call => call.method === 'PUT').length, 1)
    assert.equal(await videoUploadCount(), 2)
    assert.ok(logLines.some(line => /HTTP 503.*Retrying/i.test(line)))
  })

  test('checks an already-aborted upload before any provider request', async () => {
    const fixture = await setUp('preaborted')
    const controller = new AbortController()
    controller.abort()
    let requests = 0
    __setYouTubeTransportForTests((async () => {
      requests++
      throw new Error('provider request should not start')
    }) as typeof fetch)

    await assert.rejects(uploadVideo(uploadArgs(fixture, { signal: controller.signal })), { name: 'AbortError' })
    assert.equal(requests, 0)
    assert.equal(await videoUploadCount(), 0)
  })
  test('honors a long Retry-After by stopping instead of retrying too early', async () => {
    const fixture = await setUp('retry-after')
    let requests = 0
    __setYouTubeTransportForTests((async () => {
      requests++
      return new Response('busy', { status: 429, headers: { 'Retry-After': '31' } })
    }) as typeof fetch)
    await assert.rejects(uploadVideo(uploadArgs(fixture)), /429|quota|rate/i)
    assert.equal(requests, 1)
    assert.equal(await videoUploadCount(), 1)
  })

  test('cancels during startup backoff without sending the next request', async () => {
    const fixture = await setUp('cancel-backoff')
    const controller = new AbortController()
    let requests = 0
    const logs: string[] = []
    logs.push = (...lines: string[]) => {
      const count = Array.prototype.push.apply(logs, lines)
      if (lines.some(line => line.includes('Retrying session setup'))) controller.abort()
      return count
    }
    __setYouTubeTransportForTests((async () => {
      requests++
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    }) as typeof fetch)
    await assert.rejects(uploadVideo(uploadArgs(fixture, { signal: controller.signal, logLines: logs })), { name: 'AbortError' })
    assert.equal(requests, 1)
    assert.equal(await videoUploadCount(), 1)
  })

})
